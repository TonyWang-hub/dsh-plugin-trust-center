export { acquireSource, parseSourceSpec, validateArchiveEntry } from './acquire.js'
export type { AcquiredSource, AcquireOptions, ArchiveLimits, SourceSpec } from './acquire.js'
export { runDependencyInstall, verifyDynamicImport } from './dynamic.js'
export type { DynamicImportEvidence, DynamicVerifyOptions, InstallRequest } from './dynamic.js'
export { canonicalJson, computePackageDigest, deriveVerdict, inspectSource } from './passport.js'
export { renderHuman, renderJson, renderSarif } from './render.js'
export { RULE_CATALOG } from './rule-catalog.js'
export type { RuleMetadata } from './rule-catalog.js'
export { inspectManifest } from './manifest.js'
export type { InspectManifestOptions } from './manifest.js'
export { evaluateRules } from './rules.js'
export { buildSbom } from './sbom.js'
export { DEFAULT_LIMITS, walkPackage } from './walk.js'

export type {
  CompatibilityEvidence,
  DependencyGroup,
  DependencyMap,
  DshBundleEvidence,
  DshClientEvidence,
  DshEvidence,
  DshProfileEvidence,
  EvidenceLocation,
  Finding,
  FindingCategory,
  InspectSourceOptions,
  ManifestEvidence,
  Passport,
  PassportSubject,
  RuleContext,
  SbomComponent,
  SbomDependency,
  SbomDocument,
  SbomScope,
  Severity,
  SkippedEntry,
  Verdict,
  VerdictStatus,
  WalkLimits,
  WalkResult,
  WalkedFile,
} from './model.js'

export { PASSPORT_SCHEMA_VERSION } from './model.js'
