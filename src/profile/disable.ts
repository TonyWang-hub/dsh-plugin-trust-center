import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findLatestEntry, loadLedger } from './ledger.js'
import type { LedgerEntry } from './ledger.js'
import { ledgerPath, profileDir, validateProfileName } from './paths.js'
import { dshAddCommand, dshRemoveCommand } from './runner.js'
import type { CommandRunner } from './runner.js'
import { CommandFailedError, dshRunOptions, runMutation } from './transaction.js'
import type { MutationSummary, RunMutationOptions } from './transaction.js'

export interface BundleDescriptor {
  packageName: string
  /** Immutable install spec (exact version, commit, or pinned tarball). */
  spec: string
  /** SHA-256 subject digest from the Stage 1 Passport. */
  passportDigest: string
}

export interface ProfileMutationBase {
  home: string
  profile: string
  /** Absolute path to the official `dsh` binary. */
  dshPath: string
  /** Injected process runner (real or fake). */
  runner: CommandRunner
  now?: Date
  retention?: number
  dryRun?: boolean
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface DisableOptions extends ProfileMutationBase {
  bundle: BundleDescriptor
}

export interface DisableResult extends MutationSummary {
  /** The remove entry recorded in the immutable-spec ledger. */
  ledgerEntry: LedgerEntry
}

export interface ReenableOptions extends ProfileMutationBase {
  packageName: string
}

export interface ReenableResult extends MutationSummary {
  /** The install entry recorded in the immutable-spec ledger. */
  ledgerEntry: LedgerEntry
}

const BUNDLE_NAME_PATTERN = /^[@A-Za-z0-9][A-Za-z0-9._@/-]*$/

/** Validates a bundle package name before it is passed to official dsh. */
export function validateBundleName(name: string): string {
  if (typeof name !== 'string') throw new Error('bundle name must be a string')
  const trimmed = name.trim()
  if (trimmed === '' || !BUNDLE_NAME_PATTERN.test(trimmed)) {
    throw new Error(`invalid bundle name: ${trimmed}`)
  }
  return trimmed
}

/**
 * Disables a bundle through the official `dsh plugin --profile <name>
 * remove <package>` path. Trust Center never edits `dsh.profile.bundles`
 * directly: official reconciliation would reactivate an installed dependency
 * that still declares `dsh.bundle`. The immutable spec is recorded in the
 * ledger before the remove, and any failure restores the exact snapshot and
 * reinstalls the spec so the bundle can never be left half-removed.
 */
export async function disableBundle(options: DisableOptions): Promise<DisableResult> {
  const profile = validateProfileName(options.profile)
  const packageName = validateBundleName(options.bundle.packageName)
  const spec = options.bundle.spec
  const passportDigest = options.bundle.passportDigest

  await assertInstalled(options.home, profile, packageName)

  let ledgerEntry: LedgerEntry | undefined
  const summary = await runMutation(
    buildMutationOptions(options, {
      rollback: async () => {
        // Reinstall the immutable spec after the snapshot restore.
        const args = dshAddCommand(profile, spec)
        const result = await options.runner(
          options.dshPath,
          args,
          dshRunOptions(options.home, options.env, options.timeoutMs),
        )
        if (result.exitCode !== 0) throw new CommandFailedError(args, result)
      },
    }),
    async api => {
      ledgerEntry = await api.appendLedger({
        action: 'remove',
        packageName,
        spec,
        passportDigest,
        profile,
      })
      await api.exec(dshRemoveCommand(profile, packageName))
    },
  )

  if (ledgerEntry === undefined) throw new Error('disable did not record a ledger entry')
  return { ...summary, ledgerEntry }
}

/**
 * Re-enables a bundle using the exact immutable spec preserved in the ledger,
 * through `dsh plugin --profile <name> add <spec>`. Refuses when no ledger
 * record exists, and rolls the profile back if the official add fails.
 */
export async function reenableBundle(options: ReenableOptions): Promise<ReenableResult> {
  const profile = validateProfileName(options.profile)
  const packageName = validateBundleName(options.packageName)

  const ledger = await loadLedger(ledgerPath(options.home, profile))
  const record = findLatestEntry(ledger, packageName)
  if (record === undefined) {
    throw new Error(`no ledger record for ${packageName} in profile ${profile}`)
  }

  let ledgerEntry: LedgerEntry | undefined
  const summary = await runMutation(
    buildMutationOptions(options, {}),
    async api => {
      ledgerEntry = await api.appendLedger({
        action: 'install',
        packageName,
        spec: record.spec,
        passportDigest: record.passportDigest,
        profile,
      })
      await api.exec(dshAddCommand(profile, record.spec))
    },
  )

  if (ledgerEntry === undefined) throw new Error('reenable did not record a ledger entry')
  return { ...summary, ledgerEntry }
}

/**
 * Read-only installed-bundle check against the official profile manifest.
 * This is the only profile file access disable performs: it never writes
 * `dsh.profile.bundles` itself.
 */
async function assertInstalled(home: string, profile: string, packageName: string): Promise<void> {
  const manifestPath = join(profileDir(home, profile), 'package.json')
  let text: string
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(`bundle ${packageName} is not installed in profile ${profile}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`profile ${profile} has an unreadable package.json`)
  }
  const bundles = installedBundles(parsed)
  if (!bundles.includes(packageName)) {
    throw new Error(`bundle ${packageName} is not installed in profile ${profile}`)
  }
}

function installedBundles(manifest: unknown): string[] {
  if (manifest === null || typeof manifest !== 'object') return []
  const dsh = (manifest as Record<string, unknown>).dsh
  if (dsh === null || typeof dsh !== 'object') return []
  const profile = (dsh as Record<string, unknown>).profile
  if (profile === null || typeof profile !== 'object') return []
  const bundles = (profile as Record<string, unknown>).bundles
  return Array.isArray(bundles) ? bundles.filter((bundle): bundle is string => typeof bundle === 'string') : []
}

/** Builds transaction options, carrying over every optional field present. */
function buildMutationOptions(
  options: ProfileMutationBase,
  extra: { rollback?: () => Promise<void> },
): RunMutationOptions {
  const result: RunMutationOptions = {
    home: options.home,
    profile: options.profile,
    dshPath: options.dshPath,
    runner: options.runner,
  }
  if (options.now !== undefined) result.now = options.now
  if (options.retention !== undefined) result.retention = options.retention
  if (options.dryRun !== undefined) result.dryRun = options.dryRun
  if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs
  if (options.env !== undefined) result.env = options.env
  if (extra.rollback !== undefined) result.rollback = extra.rollback
  return result
}
