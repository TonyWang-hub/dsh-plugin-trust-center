import { createHash } from 'node:crypto'
import { acquireSource } from './acquire.js'
import { inspectManifest } from './manifest.js'
import type {
  Finding,
  InspectSourceOptions,
  Passport,
  PassportSubject,
  Verdict,
  WalkLimits,
} from './model.js'
import { PASSPORT_SCHEMA_VERSION } from './model.js'
import { evaluateRules } from './rules.js'
import { buildSbom } from './sbom.js'
import { DEFAULT_LIMITS, walkPackage } from './walk.js'

/**
 * Derives the deterministic verdict from findings: any critical finding
 * fails, otherwise any high finding reviews, otherwise the package passes.
 */
export function deriveVerdict(findings: Finding[]): Verdict {
  if (findings.some(finding => finding.severity === 'critical')) return { status: 'fail' }
  if (findings.some(finding => finding.severity === 'high')) return { status: 'review' }
  return { status: 'pass' }
}

/**
 * SHA-256 digest of the canonical, sorted package file inventory.
 */
export function computePackageDigest(files: { path: string; sha256: string }[]): string {
  const inventory = [...files]
    .sort(comparePath)
    .map(file => ({ path: file.path, sha256: file.sha256 }))
  return createHash('sha256').update(canonicalJson(inventory)).digest('hex')
}

/**
 * JSON serialization with recursively sorted object keys, so identical
 * semantic content always serializes identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/**
 * Acquires a local, npm, or GitHub package and returns a deterministic Passport.
 * Acquisition is static-only and never executes target package code.
 */
export async function inspectSource(source: string, options: InspectSourceOptions = {}): Promise<Passport> {
  const acquired = await acquireSource(source, options.acquisition)
  try {
    const limits: WalkLimits = { ...DEFAULT_LIMITS, ...options.limits }
    const walked = await walkPackage(acquired.root, limits)
    const manifest = await inspectManifest(acquired.root, { files: walked.files })
    const findings = [...manifest.findings, ...evaluateRules({ files: walked.files, manifest })]
    if (walked.truncated || walked.skipped.length > 0) {
      findings.push({
        ruleId: 'DSH-SCAN-001',
        severity: 'critical',
        category: 'code',
        title: 'Static inspection was incomplete',
        message: 'One or more package entries were not inspected because they were links or exceeded a configured scan limit.',
        evidence: walked.skipped.slice(0, 20).map(item => ({ file: item.path, snippet: item.reason })),
        remediation: 'Reduce package size or rerun with explicitly reviewed higher scan limits.',
      })
    }
    findings.sort((a, b) => a.ruleId.localeCompare(b.ruleId)
      || (a.evidence[0]?.file ?? '').localeCompare(b.evidence[0]?.file ?? ''))
    const digest = computePackageDigest(walked.files)

    const subject: PassportSubject = {
      kind: acquired.kind,
      source,
      resolved: acquired.resolved,
      digest,
      ...(manifest.packageName !== undefined ? { name: manifest.packageName } : {}),
      ...(manifest.packageVersion !== undefined ? { version: manifest.packageVersion } : {}),
    }

    return {
      schemaVersion: PASSPORT_SCHEMA_VERSION,
      subject,
      dsh: manifest.dsh,
      scripts: manifest.scripts,
      dependencies: manifest.dependencies,
      findings,
      sbom: buildSbom(manifest),
      compatibility: { method: 'declaration-only', dynamicImportVerified: false },
      verdict: deriveVerdict(findings),
    }
  } finally {
    await acquired.cleanup()
  }
}

function comparePath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key])
    return out
  }
  return value
}
