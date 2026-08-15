import { access, readFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  DependencyGroup,
  DependencyMap,
  DshEvidence,
  Finding,
  ManifestEvidence,
  WalkedFile,
} from './model.js'

export interface InspectManifestOptions {
  /** Optional walked file inventory used for patch existence checks. */
  files?: WalkedFile[]
}

const CORDIS_JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string): string => value,
}

const DEPENDENCY_GROUPS: DependencyGroup[] = ['runtime', 'dev', 'optional', 'peer']
const PACKAGE_JSON_KEY: Record<DependencyGroup, string> = {
  runtime: 'dependencies',
  dev: 'devDependencies',
  optional: 'optionalDependencies',
  peer: 'peerDependencies',
}

const emptyManifest = (findings: Finding[]): ManifestEvidence => ({
  scripts: {},
  dependencies: { runtime: {}, dev: {}, optional: {}, peer: {} },
  dsh: {},
  findings,
})

export function parseCordisPatch(source: string): unknown[] {
  const document = parseYaml(source, { customTags: [CORDIS_JS_TAG] }) as unknown
  if (!Array.isArray(document)) throw new Error('Cordis patch root must be an array')
  return document
}

/**
 * Reads and validates `package.json` plus the DSH declarations
 * (`dsh.bundle`, `dsh.client`, `dsh.profile`) for a package root.
 */
export async function inspectManifest(
  root: string,
  options: InspectManifestOptions = {},
): Promise<ManifestEvidence> {
  const findings: Finding[] = []
  let raw: string
  try {
    raw = await readFile(resolve(root, 'package.json'), 'utf8')
  } catch {
    findings.push({
      ruleId: 'DSH-MANIFEST-001',
      severity: 'critical',
      category: 'manifest',
      title: 'Missing or invalid package manifest',
      message: 'package.json is missing or cannot be read.',
      evidence: [{ file: 'package.json' }],
      remediation: 'Add a valid package.json at the package root.',
    })
    return emptyManifest(findings)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    findings.push({
      ruleId: 'DSH-MANIFEST-001',
      severity: 'critical',
      category: 'manifest',
      title: 'Missing or invalid package manifest',
      message: 'package.json is not valid JSON.',
      evidence: [{ file: 'package.json' }],
      remediation: 'Fix package.json so it parses as valid JSON.',
    })
    return emptyManifest(findings)
  }

  const pkg = asRecord(parsed)
  if (pkg === null) {
    findings.push({
      ruleId: 'DSH-MANIFEST-001',
      severity: 'critical',
      category: 'manifest',
      title: 'Missing or invalid package manifest',
      message: 'package.json must contain a JSON object.',
      evidence: [{ file: 'package.json' }],
      remediation: 'Fix package.json so it parses as a JSON object.',
    })
    return emptyManifest(findings)
  }

  const scripts = stringRecord(pkg['scripts'])
  const dependencies = collectDependencies(pkg)
  const dsh = await inspectDsh(pkg, root, options.files ?? null, findings)
  const declaredDsh = asRecord(pkg['dsh'])
  const declaresCapability = declaredDsh !== null
    && ['bundle', 'client', 'profile'].some(key => Object.prototype.hasOwnProperty.call(declaredDsh, key))
  if (dsh.bundle === undefined && dsh.client === undefined && dsh.profile === undefined
    && (pkg['dsh'] === undefined || (declaredDsh !== null && !declaresCapability))) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-007',
      'No DSH package declaration',
      'The package declares none of dsh.bundle, dsh.client, or dsh.profile.',
    ))
  }

  return {
    ...(typeof pkg['name'] === 'string' ? { packageName: pkg['name'] } : {}),
    ...(typeof pkg['version'] === 'string' ? { packageVersion: pkg['version'] } : {}),
    ...(typeof pkg['license'] === 'string' ? { license: pkg['license'] } : {}),
    scripts,
    dependencies,
    dsh,
    findings,
  }
}

async function inspectDsh(
  pkg: Record<string, unknown>,
  root: string,
  files: WalkedFile[] | null,
  findings: Finding[],
): Promise<DshEvidence> {
  const dsh: DshEvidence = {}
  const rawDsh = pkg['dsh']
  if (rawDsh === undefined) return dsh
  const dshObj = asRecord(rawDsh)
  if (dshObj === null) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-010',
      'Invalid top-level dsh declaration',
      'package.json dsh must be an object.',
    ))
    return dsh
  }

  await inspectBundle(dshObj, root, files, findings, dsh)
  inspectClient(dshObj, pkg, findings, dsh)
  inspectProfile(dshObj, findings, dsh)
  return dsh
}

async function inspectBundle(
  dshObj: Record<string, unknown>,
  root: string,
  files: WalkedFile[] | null,
  findings: Finding[],
  dsh: DshEvidence,
): Promise<void> {
  const rawBundle = dshObj['bundle']
  if (rawBundle === undefined) return
  const bundleObj = asRecord(rawBundle)
  if (bundleObj === null) {
    findings.push(manifestFinding('DSH-MANIFEST-002', 'Invalid dsh.bundle declaration', 'dsh.bundle must be an object with a patch path.'))
    return
  }
  const patch = bundleObj['patch']
  if (typeof patch !== 'string' || patch.trim() === '') {
    findings.push(manifestFinding('DSH-MANIFEST-002', 'Invalid dsh.bundle declaration', 'dsh.bundle.patch must be a non-empty string.'))
    return
  }
  const normalized = patch.replace(/^\.\//, '')
  const escapes = patchEscapesRoot(root, patch)
  if (escapes) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-003',
      'Bundle patch escapes the package root',
      `dsh.bundle.patch "${patch}" resolves outside the package root.`,
    ))
    dsh.bundle = { patch: normalized, exists: false }
    return
  }
  const exists = files === null
    ? await pathExists(resolve(root, normalized))
    : files.some(f => f.path === normalized)
  if (!exists) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-004',
      'Declared bundle patch is missing',
      `The declared patch "${normalized}" does not exist in the package.`,
    ))
  } else {
    try {
      parseCordisPatch(await readFile(resolve(root, normalized), 'utf8'))
    } catch {
      findings.push(manifestFinding(
        'DSH-MANIFEST-008',
        'Invalid Cordis patch structure',
        'The declared patch must be valid YAML with a top-level operation array.',
      ))
    }
  }
  dsh.bundle = { patch: normalized, exists }
}

function inspectClient(
  dshObj: Record<string, unknown>,
  pkg: Record<string, unknown>,
  findings: Finding[],
  dsh: DshEvidence,
): void {
  const rawClient = dshObj['client']
  if (rawClient === undefined) return
  const clientObj = asRecord(rawClient)
  if (clientObj === null) {
    findings.push(manifestFinding('DSH-MANIFEST-005', 'Invalid dsh.client declaration', 'dsh.client must be an object.'))
    return
  }

  const platform = clientObj['platform']
  const platformValid = typeof platform === 'string' && platform !== ''
  const inject = clientObj['inject']
  const injectStrings = Array.isArray(inject) ? inject.filter(item => typeof item === 'string') : []
  const normalizedInject = [...new Set(injectStrings)]
  const injectValid = inject === undefined
    || (Array.isArray(inject)
      && injectStrings.length === inject.length
      && normalizedInject.length === inject.length)
  const immediately = clientObj['immediately']
  const immediatelyValid = immediately === undefined || typeof immediately === 'boolean'
  const shapeValid = platformValid && injectValid && immediatelyValid

  if (!shapeValid) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-005',
      'Invalid dsh.client shape',
      'dsh.client requires a string platform; inject must contain unique string paths and immediately must be a boolean.',
    ))
  }

  const exportExists = exportsClient(pkg)
  if (shapeValid && !exportExists) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-006',
      'Missing dsh client export',
      'dsh.client is declared but package.json exports does not expose "./client".',
    ))
  }

  dsh.client = {
    platform: platformValid ? platform : 'unknown',
    ...(Array.isArray(inject) ? { inject: normalizedInject } : {}),
    ...(immediatelyValid && typeof immediately === 'boolean' ? { immediately } : {}),
    exportExists,
  }
}

function inspectProfile(
  dshObj: Record<string, unknown>,
  findings: Finding[],
  dsh: DshEvidence,
): void {
  const rawProfile = dshObj['profile']
  if (rawProfile === undefined) return
  const profileObj = asRecord(rawProfile)
  const bundles = profileObj?.['bundles']
  const valid = profileObj !== null
    && Array.isArray(bundles)
    && bundles.every(item => typeof item === 'string')
  if (!valid) {
    findings.push(manifestFinding(
      'DSH-MANIFEST-009',
      'Invalid dsh.profile declaration',
      'dsh.profile must be an object whose bundles property is an array of strings.',
    ))
  }
  dsh.profile = {
    bundles: Array.isArray(bundles) ? bundles.filter(item => typeof item === 'string') : [],
  }
}

function collectDependencies(pkg: Record<string, unknown>): DependencyMap {
  const dependencies = { runtime: {}, dev: {}, optional: {}, peer: {} } as DependencyMap
  for (const group of DEPENDENCY_GROUPS) {
    const source = pkg[PACKAGE_JSON_KEY[group]]
    if (source === undefined) continue
    const record = asRecord(source)
    if (record === null) continue
    for (const [name, spec] of Object.entries(record)) {
      if (typeof spec === 'string') dependencies[group][name] = spec
    }
  }
  return dependencies
}

function exportsClient(pkg: Record<string, unknown>): boolean {
  const exportsValue = pkg['exports']
  if (exportsValue === undefined || typeof exportsValue !== 'object' || exportsValue === null) return false
  if (Array.isArray(exportsValue)) return false
  return Object.prototype.hasOwnProperty.call(exportsValue, './client')
}

function patchEscapesRoot(root: string, patch: string): boolean {
  if (isAbsolute(patch) || /^[a-zA-Z]:[\\/]/.test(patch)) return true
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, patch)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`
  return target !== rootAbs && !target.startsWith(rootPrefix)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function manifestFinding(ruleId: string, title: string, message: string): Finding {
  return {
    ruleId,
    severity: 'critical',
    category: 'manifest',
    title,
    message,
    evidence: [{ file: 'package.json' }],
    remediation: 'Fix the DSH declaration in package.json.',
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === null) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item
  }
  return out
}
