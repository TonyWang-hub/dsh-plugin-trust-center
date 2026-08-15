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

export { buildRegistry } from './registry/build.js'
export type { BuildRegistryOptions, BuildRegistryResult } from './registry/build.js'
export { collectRegistry } from './registry/collect.js'
export type { CollectOptions, RegistryMaintenance, RegistryReport, RegistryStatus } from './registry/collect.js'
export { loadRegistrySources } from './registry/load.js'
export type { RegistryDocument, RegistrySource } from './registry/model.js'
export { buildSite } from './site/generate.js'
export type { BuildSiteOptions, RegistryEntry, RegistryFinding } from './site/generate.js'
export { checkSite } from './site/check.js'
export type { SiteCheckResult } from './site/check.js'

export { installQuarantine, promoteQuarantine } from './quarantine.js'
export type {
  InstallQuarantineOptions,
  InstallQuarantineResult,
  PromoteQuarantineOptions,
  PromotionResult,
  QuarantineCommand,
  QuarantineCommandResult,
  QuarantineReceipt,
} from './quarantine.js'

export {
  MAX_PROFILE_NAME_LENGTH,
  PROFILE_NAME_PATTERN,
  SNAPSHOT_ID_PATTERN,
  TRUST_LEDGER_FILE,
  assertUnderRoot,
  defaultDshHome,
  ledgerPath,
  profileDir,
  profilesRoot,
  snapshotDir,
  snapshotPath,
  snapshotsRoot,
  validateProfileName,
  validateSnapshotId,
} from './profile/paths.js'
export { writeFileAtomic } from './profile/atomic.js'
export type { AtomicWriteOptions } from './profile/atomic.js'
export {
  LEDGER_SCHEMA_VERSION,
  appendLedger,
  findLatestEntry,
  loadLedger,
  parseLedger,
  validateImmutableInstallSpec,
} from './profile/ledger.js'
export type { LedgerAction, LedgerEntry, LedgerEntryInput, LedgerFile } from './profile/ledger.js'
export {
  DEFAULT_SNAPSHOT_RETENTION,
  MAX_SNAPSHOT_RETENTION,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_TRACKED_FILES,
  captureSnapshot,
  formatSnapshotId,
  listSnapshots,
  parseSnapshotManifest,
  readSnapshotManifest,
  restoreSnapshot,
} from './profile/snapshot.js'
export type {
  CaptureSnapshotOptions,
  SnapshotManifest,
  SnapshotSummary,
  SnapshotTrackedFile,
} from './profile/snapshot.js'
export {
  dshAddCommand,
  dshDumpConfigCommand,
  dshPathFromEnv,
  dshRemoveCommand,
  runCommand,
} from './profile/runner.js'
export type { CommandResult, CommandRunner, RunOptions } from './profile/runner.js'
export {
  CommandFailedError,
  dshRunOptions,
  resolveDshPath,
  runMutation,
} from './profile/transaction.js'
export type { MutationApi, MutationSummary, RunMutationOptions } from './profile/transaction.js'
export { restoreProfile } from './profile/restore.js'
export type { RestoreProfileOptions, RestoreProfileResult } from './profile/restore.js'
export { disableBundle, reenableBundle, validateBundleName } from './profile/disable.js'
export type {
  BundleDescriptor,
  DisableOptions,
  DisableResult,
  ProfileMutationBase,
  ReenableOptions,
  ReenableResult,
} from './profile/disable.js'
