import { LEDGER_SCHEMA_VERSION, appendLedger, loadLedger } from './ledger.js'
import type { LedgerEntry, LedgerEntryInput } from './ledger.js'
import { ledgerPath, validateProfileName } from './paths.js'
import { dshDumpConfigCommand, dshPathFromEnv } from './runner.js'
import type { CommandResult, CommandRunner, RunOptions } from './runner.js'
import { captureSnapshot, formatSnapshotId, restoreSnapshot } from './snapshot.js'

/** Thrown when an official `dsh` command exits nonzero inside a mutation. */
export class CommandFailedError extends Error {
  constructor(
    readonly args: string[],
    readonly result: CommandResult,
  ) {
    const detail = result.stderr.trim() === '' ? '' : ` — ${result.stderr.trim()}`
    super(`command failed with exit code ${result.exitCode}: ${args.join(' ')}${detail}`)
    this.name = 'CommandFailedError'
  }
}

export interface MutationApi {
  /** Runs an official dsh command; throws {@link CommandFailedError} on nonzero exit. */
  exec(args: string[]): Promise<CommandResult>
  /** Appends an immutable ledger entry (atomic, 0600). */
  appendLedger(input: LedgerEntryInput): Promise<LedgerEntry>
  /** Runs `dsh --profile <profile> --dump-config` with failure checking. */
  dumpConfig(): Promise<CommandResult>
}

export interface RunMutationOptions {
  home: string
  profile: string
  /** Absolute path to the official `dsh` binary; never resolved via PATH. */
  dshPath: string
  /** Injected process runner (real or fake). */
  runner: CommandRunner
  /** Timestamp used for the snapshot id and ledger entries. */
  now?: Date
  /** Snapshot ring retention for the pre-mutation capture. */
  retention?: number
  /** Print the exact commands and touch nothing when true. */
  dryRun?: boolean
  /** Validate with `--dump-config` after the steps (default true). */
  validateConfig?: boolean
  /** Per-command timeout passed to the runner. */
  timeoutMs?: number
  /** Extra environment merged over the process environment. */
  env?: NodeJS.ProcessEnv
  /** Executed after a failed mutation restores the pre snapshot. */
  rollback?: () => Promise<void>
}

export interface MutationSummary {
  dryRun: boolean
  snapshotId: string
  /** Exact dsh argument arrays that ran (or would run) in order. */
  commands: string[][]
}

/**
 * Runs one profile mutation as a transaction: a snapshot is captured before
 * the steps, every official command runs through the injected runner, the
 * config is re-validated afterwards, and any failure restores the exact
 * snapshot before the error propagates. In dry-run mode nothing is written or
 * executed and the exact command plan is returned instead.
 */
export async function runMutation(
  options: RunMutationOptions,
  steps: (api: MutationApi) => Promise<void>,
): Promise<MutationSummary> {
  const profile = validateProfileName(options.profile)
  const now = options.now ?? new Date()
  const commands: string[][] = []
  const runOptions = dshRunOptions(options.home, options.env, options.timeoutMs)
  const dryRun = options.dryRun === true

  let snapshotId: string
  if (dryRun) {
    snapshotId = formatSnapshotId(now)
  } else {
    snapshotId = await captureSnapshot({
      home: options.home,
      profile,
      now,
      ...(options.retention === undefined ? {} : { retention: options.retention }),
    })
  }

  const api: MutationApi = {
    exec: async (args) => {
      commands.push(args)
      if (dryRun) return { exitCode: 0, stdout: '', stderr: '' }
      const result = await options.runner(options.dshPath, args, runOptions)
      if (result.exitCode !== 0) throw new CommandFailedError(args, result)
      return result
    },
    appendLedger: async (input) => {
      if (dryRun) {
        const existing = await loadLedger(ledgerPath(options.home, profile))
        const version = (existing.entries[existing.entries.length - 1]?.version ?? 0) + 1
        return {
          schemaVersion: LEDGER_SCHEMA_VERSION,
          version,
          action: input.action,
          packageName: input.packageName,
          spec: input.spec,
          passportDigest: input.passportDigest,
          profile,
          installedAt: now.toISOString(),
        }
      }
      return appendLedger(ledgerPath(options.home, profile), input, now)
    },
    dumpConfig: () => api.exec(dshDumpConfigCommand(profile)),
  }

  try {
    await steps(api)
    if (options.validateConfig !== false) {
      const args = dshDumpConfigCommand(profile)
      commands.push(args)
      if (!dryRun) {
        const result = await options.runner(options.dshPath, args, runOptions)
        if (result.exitCode !== 0) throw new CommandFailedError(args, result)
      }
    }
    return { dryRun, snapshotId, commands }
  } catch (error) {
    if (!dryRun && snapshotId !== '') {
      await restoreSnapshot({ home: options.home, profile, snapshotId })
      if (options.rollback !== undefined) await options.rollback()
    }
    throw error
  }
}

/**
 * Builds the runner options for official dsh commands: cwd is the DSH home
 * and `DSH_HOME` is pinned into the environment so the binary targets the
 * exact home this mutation operates on.
 */
export function dshRunOptions(
  home: string,
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): RunOptions {
  const runOptions: RunOptions = {
    cwd: home,
    env: {
      ...process.env,
      ...extraEnv,
      DSH_HOME: home,
      npm_config_ignore_scripts: 'true',
      PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
    },
  }
  if (timeoutMs !== undefined) runOptions.timeoutMs = timeoutMs
  return runOptions
}

/** Resolves the dsh binary for transactions, honoring DSH_PATH/DSH_BIN. */
export function resolveDshPath(env: NodeJS.ProcessEnv = process.env): string {
  return dshPathFromEnv(env)
}
