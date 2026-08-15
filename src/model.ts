import type { AcquireOptions } from './acquire.js'

export const PASSPORT_SCHEMA_VERSION = '1.0.0' as const

export type VerdictStatus = 'pass' | 'review' | 'fail'
export type Severity = 'critical' | 'high'

export type FindingCategory = 'manifest' | 'lifecycle' | 'code' | 'dependency'

export interface EvidenceLocation {
  file: string
  line?: number
  column?: number
  snippet?: string
}

export interface Finding {
  ruleId: string
  severity: Severity
  category: FindingCategory
  title: string
  message: string
  evidence: EvidenceLocation[]
  remediation: string
}

export interface Verdict {
  status: VerdictStatus
}

export interface WalkLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export interface WalkedFile {
  /** Relative POSIX path from the package root. */
  path: string
  bytes: number
  sha256: string
  /** UTF-8 decoded content, bounded by the walk limits. */
  content: string
}

export interface SkippedEntry {
  path: string
  reason: string
}

export interface WalkResult {
  files: WalkedFile[]
  skipped: SkippedEntry[]
  truncated: boolean
}

export interface DshBundleEvidence {
  /** Normalized relative path without a leading `./`. */
  patch: string
  exists: boolean
}

export interface DshClientEvidence {
  platform: string
  inject?: string[]
  immediately?: boolean
  exportExists: boolean
}

export interface DshProfileEvidence {
  bundles: string[]
}

export interface DshEvidence {
  bundle?: DshBundleEvidence
  client?: DshClientEvidence
  profile?: DshProfileEvidence
}

export type DependencyGroup = 'runtime' | 'dev' | 'optional' | 'peer'

export type DependencyMap = Record<DependencyGroup, Record<string, string>>

export interface ManifestEvidence {
  packageName?: string
  packageVersion?: string
  license?: string
  scripts: Record<string, string>
  dependencies: DependencyMap
  dsh: DshEvidence
  findings: Finding[]
}

export type SbomScope = 'required' | 'optional' | 'excluded'

export interface SbomComponent {
  type: 'library' | 'application'
  name: string
  version?: string
  scope?: SbomScope
  purl?: string
}

export interface SbomDependency {
  ref: string
  dependsOn: string[]
}

export interface SbomDocument {
  bomFormat: 'CycloneDX'
  specVersion: '1.6'
  version: 1
  metadata: {
    component?: SbomComponent
  }
  components: SbomComponent[]
  dependencies: SbomDependency[]
}

export interface PassportSubject {
  kind: 'local' | 'npm' | 'github'
  /** The source string exactly as requested. */
  source: string
  /** Immutable network identity or a non-sensitive local basename. */
  resolved: string
  name?: string
  version?: string
  /** SHA-256 content digest of the walked package. */
  digest: string
}

export interface CompatibilityEvidence {
  method: 'declaration-only'
  dynamicImportVerified: false
}

export interface Passport {
  schemaVersion: '1.0.0'
  subject: PassportSubject
  dsh: DshEvidence
  scripts: Record<string, string>
  dependencies: DependencyMap
  findings: Finding[]
  sbom: SbomDocument
  compatibility: CompatibilityEvidence
  verdict: Verdict
}

export interface InspectSourceOptions {
  limits?: Partial<WalkLimits>
  acquisition?: AcquireOptions
}

export interface RuleContext {
  files: WalkedFile[]
  manifest: ManifestEvidence
}
