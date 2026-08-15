import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { findLatestEntry, parseLedger } from './ledger.js'
import { snapshotPath, validateProfileName, validateSnapshotId } from './paths.js'
import { dshAddCommand, dshDumpConfigCommand, dshRemoveCommand } from './runner.js'
import type { CommandRunner } from './runner.js'
import {
  DEFAULT_SNAPSHOT_RETENTION,
  captureSnapshot,
  listSnapshots,
  readSnapshotManifest,
  restoreSnapshot,
} from './snapshot.js'
import { CommandFailedError, dshRunOptions } from './transaction.js'

export interface RestoreProfileOptions {
  home: string
  profile: string
  snapshotId: string
  dshPath: string
  runner: CommandRunner
  now?: Date
  retention?: number
  dryRun?: boolean
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface RestoreProfileResult {
  dryRun: boolean
  profile: string
  snapshotId: string
  rollbackSnapshotId: string | null
  files: string[]
  commands: string[][]
}

/**
 * Restores a validated profile snapshot and reconciles every declared bundle
 * through official `dsh plugin add` commands using the snapshot ledger's exact
 * immutable specs. A pre-restore snapshot and best-effort official removes make
 * a failed reconciliation exactly reversible.
 */
export async function restoreProfile(options: RestoreProfileOptions): Promise<RestoreProfileResult> {
  const profile = validateProfileName(options.profile)
  const snapshotId = validateSnapshotId(options.snapshotId)
  const manifest = await readSnapshotManifest(options.home, profile, snapshotId)
  const files = Object.keys(manifest.files).sort()
  const snapshotFiles = join(snapshotPath(options.home, profile, snapshotId), 'files')
  const verified = new Map<string, string>()
  for (const [name, digest] of Object.entries(manifest.files)) {
    const content = await readOptional(join(snapshotFiles, name))
    if (content === undefined || createHash('sha256').update(content).digest('hex') !== digest) {
      throw new Error(`snapshot ${snapshotId} is tampered: ${name} digest mismatch`)
    }
    verified.set(name, content)
  }
  const packageJson = verified.get('package.json')
  const ledgerJson = verified.get('trust-ledger.json')
  const bundles = packageJson === undefined ? [] : installedBundles(packageJson)
  const ledger = ledgerJson === undefined
    ? { schemaVersion: '1.0.0' as const, entries: [] }
    : parseLedger(ledgerJson)
  const installs = bundles.flatMap(packageName => {
    const record = findLatestEntry(ledger, packageName)
    // Official/base bundles may predate Trust Center and have no ledger entry.
    // Reconcile only bundles whose exact spec Trust Center can prove.
    if (record === undefined) return []
    if (record.action !== 'install') {
      throw new Error(`snapshot ledger does not mark ${packageName} as installed`)
    }
    return [{ packageName, spec: record.spec }]
  })
  const commands = [
    ...installs.map(item => dshAddCommand(profile, item.spec)),
    dshDumpConfigCommand(profile),
  ]
  if (options.dryRun === true) {
    return { dryRun: true, profile, snapshotId, rollbackSnapshotId: null, files, commands }
  }

  const existing = await listSnapshots(options.home, profile)
  const retention = Math.max(options.retention ?? DEFAULT_SNAPSHOT_RETENTION, existing.length + 1)
  const rollbackSnapshotId = await captureSnapshot({
    home: options.home,
    profile,
    now: options.now ?? new Date(),
    retention,
  })
  const runOptions = dshRunOptions(options.home, {
    ...options.env,
    npm_config_ignore_scripts: 'true',
    PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
  }, options.timeoutMs)
  const attempted: string[] = []
  try {
    await restoreSnapshot({ home: options.home, profile, snapshotId })
    for (const install of installs) {
      attempted.push(install.packageName)
      const args = dshAddCommand(profile, install.spec)
      const result = await options.runner(options.dshPath, args, runOptions)
      if (result.exitCode !== 0) throw new CommandFailedError(args, result)
    }
    // Official add may normalize profile files. The snapshot is authoritative;
    // restore its verified bytes again before the final boot-free validation.
    await restoreSnapshot({ home: options.home, profile, snapshotId })
    const dumpArgs = dshDumpConfigCommand(profile)
    const dumped = await options.runner(options.dshPath, dumpArgs, runOptions)
    if (dumped.exitCode !== 0) throw new CommandFailedError(dumpArgs, dumped)
  } catch (error) {
    for (const packageName of attempted.reverse()) {
      await options.runner(options.dshPath, dshRemoveCommand(profile, packageName), runOptions).catch(() => undefined)
    }
    await restoreSnapshot({ home: options.home, profile, snapshotId: rollbackSnapshotId })
    throw error
  }

  return { dryRun: false, profile, snapshotId, rollbackSnapshotId, files, commands }
}

function installedBundles(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('snapshot package.json is invalid')
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const dsh = (parsed as Record<string, unknown>).dsh
  if (dsh === null || typeof dsh !== 'object') return []
  const profile = (dsh as Record<string, unknown>).profile
  if (profile === null || typeof profile !== 'object') return []
  const bundles = (profile as Record<string, unknown>).bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((item): item is string => typeof item === 'string').sort()
}

async function readOptional(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'ELOOP') throw new Error(`snapshot control file must not be a symbolic link: ${path}`)
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`snapshot control path must be a regular file: ${path}`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
