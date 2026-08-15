import type {
  EvidenceLocation,
  Finding,
  ManifestEvidence,
  RuleContext,
  WalkedFile,
} from './model.js'

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])

const LIFECYCLE_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

const MAX_SNIPPET_CHARS = 120
const OVERSIZED_SOURCE_BYTES = 1024 * 1024
const OBFUSCATED_LINE_CHARS = 2_000

const NATIVE_BUILD_TOOLS = ['node-gyp', 'node-pre-gyp', 'prebuild-install']

interface TextPatternRule {
  ruleId: string
  title: string
  message: string
  remediation: string
  patterns: RegExp[]
}

const CODE_RULES: TextPatternRule[] = [
  {
    ruleId: 'DSH-CODE-001',
    title: 'Dynamic code execution',
    message: 'Source contains dynamic code execution (eval, new Function, or node:vm).',
    remediation: 'Replace dynamic evaluation with explicit, static code paths.',
    patterns: [
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /node:vm/,
      /require\(\s*['"]vm['"]\s*\)/,
    ],
  },
  {
    ruleId: 'DSH-CODE-002',
    title: 'Process execution',
    message: 'Source invokes child processes or a shell.',
    remediation: 'Avoid spawning processes from plugin code.',
    patterns: [
      /node:child_process/,
      /\bchild_process\b/,
      /\bexec(?:Sync)?\s*\(/,
      /\bexecFile(?:Sync)?\s*\(/,
      /\bspawn(?:Sync)?\s*\(/,
      /\bfork\s*\(/,
    ],
  },
  {
    ruleId: 'DSH-CODE-003',
    title: 'Environment or credential access',
    message: 'Source reads environment variables or references credential material.',
    remediation: 'Do not read secrets or environment state from plugin code.',
    patterns: [
      /process\.env/,
      /\b(?:api[_-]?key|secret|token|password|credential|private[_-]?key)\b/i,
    ],
  },
  {
    ruleId: 'DSH-CODE-004',
    title: 'Network access',
    message: 'Source performs network I/O.',
    remediation: 'Avoid outbound network calls from plugin code.',
    patterns: [
      /node:(?:http|https|net|dns)\b/,
      /\b(?:http|https)\.request\s*\(/,
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bnet\.(?:connect|createConnection)\s*\(/,
    ],
  },
]

/**
 * Evaluates the stable static rule set over a walked package and its
 * manifest. Findings report evidence; they never infer malicious intent.
 */
export function evaluateRules(context: RuleContext): Finding[] {
  const findings: Finding[] = []
  findings.push(...lifecycleFindings(context.manifest))
  findings.push(...codeFindings(context.files))
  findings.push(...nativeBinaryFindings(context.files, context.manifest))
  findings.push(...oversizedSourceFindings(context.files))
  findings.push(...obfuscatedSourceFindings(context.files))
  findings.push(...dependencyFindings(context.manifest))
  findings.sort(compareFindings)
  return findings
}

function lifecycleFindings(manifest: ManifestEvidence): Finding[] {
  const findings: Finding[] = []
  for (const key of LIFECYCLE_SCRIPT_KEYS) {
    const script = manifest.scripts[key]
    if (script === undefined) continue
    findings.push({
      ruleId: 'DSH-SCRIPT-001',
      severity: 'high',
      category: 'lifecycle',
      title: `Install lifecycle script: ${key}`,
      message: `The package declares a ${key} lifecycle script that runs during install.`,
      evidence: [{ file: 'package.json', snippet: `${key}: ${clip(script)}` }],
      remediation: 'Remove install-time lifecycle scripts or move work to explicit commands.',
    })
  }
  return findings
}

function codeFindings(files: WalkedFile[]): Finding[] {
  const findings: Finding[] = []
  for (const walked of files) {
    if (!isSourceFile(walked.path)) continue
    for (const rule of CODE_RULES) {
      for (const pattern of rule.patterns) {
        const match = pattern.exec(walked.content)
        if (match !== null) {
          const { line, column } = locate(walked.content, match.index)
          findings.push({
            ruleId: rule.ruleId,
            severity: 'high',
            category: 'code',
            title: rule.title,
            message: rule.message,
            evidence: [{ file: walked.path, line, column, snippet: clipLine(walked.content, line) }],
            remediation: rule.remediation,
          })
          break
        }
      }
    }
  }
  return findings
}

function nativeBinaryFindings(files: WalkedFile[], manifest: ManifestEvidence): Finding[] {
  const findings: Finding[] = []
  for (const walked of files) {
    if (walked.path.endsWith('.node') || walked.path === 'binding.gyp' || walked.path.endsWith('/binding.gyp')) {
      findings.push({
        ruleId: 'DSH-CODE-005',
        severity: 'high',
        category: 'code',
        title: 'Native binary or addon',
        message: 'The package ships a native addon binary or gyp build descriptor.',
        evidence: [{ file: walked.path }],
        remediation: 'Prefer pure-JavaScript implementations or document the native requirement.',
      })
    }
  }
  for (const script of Object.values(manifest.scripts)) {
    if (NATIVE_BUILD_TOOLS.some(tool => script.includes(tool))) {
      findings.push({
        ruleId: 'DSH-CODE-005',
        severity: 'high',
        category: 'code',
        title: 'Native binary or addon',
        message: 'A lifecycle script invokes native build tooling.',
        evidence: [{ file: 'package.json', snippet: clip(script) }],
        remediation: 'Prefer pure-JavaScript implementations or document the native requirement.',
      })
    }
  }
  return findings
}

function oversizedSourceFindings(files: WalkedFile[]): Finding[] {
  const findings: Finding[] = []
  for (const walked of files) {
    if (!isSourceFile(walked.path)) continue
    if (walked.bytes > OVERSIZED_SOURCE_BYTES) {
      findings.push({
        ruleId: 'DSH-CODE-006',
        severity: 'high',
        category: 'code',
        title: 'Oversized source file',
        message: `Source file exceeds ${OVERSIZED_SOURCE_BYTES} bytes and resists review.`,
        evidence: [{ file: walked.path, snippet: `${walked.bytes} bytes` }],
        remediation: 'Split the file into reviewable modules.',
      })
    }
  }
  return findings
}

function obfuscatedSourceFindings(files: WalkedFile[]): Finding[] {
  const findings: Finding[] = []
  for (const walked of files) {
    if (!isSourceFile(walked.path)) continue
    const lines = walked.content.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line !== undefined && line.length > OBFUSCATED_LINE_CHARS) {
        findings.push({
          ruleId: 'DSH-CODE-007',
          severity: 'high',
          category: 'code',
          title: 'Obfuscated or minified source',
          message: `A single line exceeds ${OBFUSCATED_LINE_CHARS} characters and resists review.`,
          evidence: [{ file: walked.path, line: index + 1, snippet: clip(line) }],
          remediation: 'Ship readable source instead of minified or obfuscated bundles.',
        })
        break
      }
    }
  }
  return findings
}

function dependencyFindings(manifest: ManifestEvidence): Finding[] {
  const findings: Finding[] = []
  const groups = [
    ['runtime', manifest.dependencies.runtime],
    ['dev', manifest.dependencies.dev],
    ['optional', manifest.dependencies.optional],
    ['peer', manifest.dependencies.peer],
  ] as const
  for (const [, group] of groups) {
    for (const [name, spec] of Object.entries(group)) {
      if (!isMutableSpec(spec)) continue
      findings.push({
        ruleId: 'DSH-DEP-001',
        severity: 'high',
        category: 'dependency',
        title: `Mutable dependency spec: ${name}`,
        message: `${name} uses a mutable or unpinned dependency spec.`,
        evidence: [{ file: 'package.json', snippet: `"${name}": "${clip(spec)}"` }],
        remediation: 'Pin dependencies to immutable versions or full commit SHAs.',
      })
    }
  }
  return findings
}

function isMutableSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === '') return false
  if (/^(?:file|link|workspace|portal):/i.test(trimmed)) return true
  if (/^https?:\/\//i.test(trimmed)) return true
  if (/^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:)/i.test(trimmed)) {
    const hashIndex = trimmed.indexOf('#')
    if (hashIndex === -1) return true
    const ref = trimmed.slice(hashIndex + 1)
    return !/^[0-9a-f]{40}$/i.test(ref)
  }
  return false
}

function locate(content: string, index: number): { line: number; column: number } {
  const before = content.slice(0, index)
  const lastNewline = before.lastIndexOf('\n')
  return { line: before.split('\n').length, column: before.length - lastNewline }
}

function clipLine(content: string, line: number): string {
  const raw = content.split('\n')[line - 1] ?? ''
  return clip(raw.trim())
}

function clip(value: string): string {
  if (value.length <= MAX_SNIPPET_CHARS) return value
  return `${value.slice(0, MAX_SNIPPET_CHARS - 1)}…`
}

function isSourceFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return SOURCE_EXTENSIONS.has(path.slice(dot))
}

function compareFindings(a: Finding, b: Finding): number {
  return compare(a.ruleId, b.ruleId)
    || compare(a.evidence[0]?.file ?? '', b.evidence[0]?.file ?? '')
    || compare(a.evidence[0]?.line ?? 0, b.evidence[0]?.line ?? 0)
}

function compare(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Reference kept for evidence typing parity with the model.
export type { EvidenceLocation }
