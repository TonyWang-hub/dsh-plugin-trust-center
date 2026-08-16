import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Passport, VerdictStatus } from './model.js'
import { canonicalJson } from './passport.js'
import { parseSourceSpec } from './acquire.js'
import { validateRegistrySourceSpec } from './registry/load.js'
import { validateProfileName } from './profile/paths.js'
import { writeFileAtomic } from './profile/atomic.js'

export interface QuarantineCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface QuarantineCommand {
  command: string
  args: string[]
  env: Record<string, string>
  timeoutMs: number
}

export interface QuarantineReceipt {
  schemaVersion: '1.0.0'
  id: string
  quarantineProfile: string
  targetProfile: string
  source: string
  immutableSource: string
  installSpec: string
  packageName: string
  passportDigest: string
  verdict: Exclude<VerdictStatus, 'fail'>
  executed: boolean
  createdAt: string
  receiptDigest: string
}

export interface InstallQuarantineResult {
  receipt: QuarantineReceipt
  receiptPath: string
}

export interface InstallQuarantineOptions {
  inspect(source: string): Promise<Passport>
  run(command: QuarantineCommand): Promise<QuarantineCommandResult>
  makeTempHome(): Promise<string>
  receiptRoot: string
  id(): string
  now(): string
  targetProfile: string
  allowExecute?: boolean
  verifyDynamic?(immutableSource: string): Promise<void>
}

export async function installQuarantine(
  source: string,
  options: InstallQuarantineOptions,
): Promise<InstallQuarantineResult> {
  const passport = await options.inspect(source)
  if (passport.verdict.status === 'fail') throw new Error('quarantine install refused a failed Passport')
  validateRegistrySourceSpec(passport.subject.resolved)
  const immutable = parseSourceSpec(passport.subject.resolved)
  if (immutable.kind === 'local') throw new Error('quarantine install requires an immutable npm or GitHub source')
  if (passport.subject.name === undefined) throw new Error('quarantine install requires a declared package name')
  if (!/^[a-f0-9]{64}$/.test(passport.subject.digest)) throw new Error('quarantine install requires a valid Passport digest')
  if (immutable.kind === 'npm' && passport.subject.name !== immutable.name) {
    throw new Error('quarantine install package name does not match immutable source')
  }

  const id = options.id()
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(id)) throw new Error('invalid quarantine id')
  const quarantineProfile = `trust-quarantine-${id}`
  const targetProfile = validateProfileName(options.targetProfile)
  const createdAt = options.now()
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('invalid quarantine receipt timestamp')
  const installSpec = immutable.kind === 'npm'
    ? `${immutable.name}@${immutable.version}`
    : `github:${immutable.owner}/${immutable.repo}#${immutable.ref}`
  const preparedReceipt = await prepareReceiptDirectory(options.receiptRoot, id)
  const receiptDirectory = preparedReceipt.path
  let home: string | undefined
  let receiptWritten = false
  try {
    home = await options.makeTempHome()
    const env = {
      DSH_HOME: home,
      npm_config_ignore_scripts: 'true',
      PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
    }
    await checkedRun(options.run, { command: 'dsh', args: ['plugin', '--profile', quarantineProfile, 'add', installSpec], env, timeoutMs: 120_000 })
    await checkedRun(options.run, { command: 'dsh', args: ['--profile', quarantineProfile, '--dump-config'], env, timeoutMs: 60_000 })

    if (options.allowExecute === true) {
      if (options.verifyDynamic === undefined) throw new Error('dynamic verification runner is unavailable')
      await options.verifyDynamic(passport.subject.resolved)
    }

    const unsigned = {
      schemaVersion: '1.0.0' as const,
      id,
      quarantineProfile,
      targetProfile,
      source,
      immutableSource: passport.subject.resolved,
      installSpec,
      packageName: passport.subject.name,
      passportDigest: passport.subject.digest,
      verdict: passport.verdict.status,
      executed: options.allowExecute === true,
      createdAt,
    }
    const receipt: QuarantineReceipt = {
      ...unsigned,
      receiptDigest: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
    }
    const receiptPath = join(receiptDirectory, 'receipt.json')
    await writeFileAtomic(receiptPath, `${canonicalJson(receipt)}\n`)
    receiptWritten = true
    return { receipt, receiptPath }
  } finally {
    // The receipt retains all promotable evidence; the isolated install tree is disposable.
    if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => undefined)
    if (!receiptWritten && preparedReceipt.created) {
      await rmdir(receiptDirectory).catch(() => undefined)
    }
  }
}

export interface PromotionResult {
  profile: string
  snapshotId: string | null
  installSpec: string
  dryRun: boolean
  commands: string[][]
}

export interface PromoteQuarantineOptions {
  inspect(source: string): Promise<Passport>
  run(command: QuarantineCommand): Promise<QuarantineCommandResult>
  snapshotTarget(profile: string): Promise<string>
  restoreTarget(profile: string, snapshotId: string, packageName: string): Promise<void>
  recordInstall(profile: string, receipt: QuarantineReceipt): Promise<void>
  dshHome: string
  dryRun?: boolean
}

export async function promoteQuarantine(
  receiptPath: string,
  target: string,
  options: PromoteQuarantineOptions,
): Promise<PromotionResult> {
  const parsed = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
  const { receiptDigest, ...unsigned } = parsed
  const expected = createHash('sha256').update(canonicalJson(unsigned)).digest('hex')
  if (typeof receiptDigest !== 'string' || receiptDigest !== expected) throw new Error('quarantine receipt digest mismatch')
  const receipt = validateReceipt(parsed)
  assertReceiptConsistency(receipt)
  const targetProfile = validateProfileName(target)
  if (receipt.targetProfile !== targetProfile) {
    throw new Error('promotion target does not match quarantine receipt')
  }

  const passport = await options.inspect(receipt.immutableSource)
  if (passport.verdict.status === 'fail') throw new Error('promotion refused a failed Passport')
  if (passport.subject.resolved !== receipt.immutableSource || passport.subject.digest !== receipt.passportDigest) {
    throw new Error('promotion Passport does not match quarantine receipt')
  }

  const commands = [
    ['dsh', 'plugin', '--profile', targetProfile, 'add', receipt.installSpec],
    ['dsh', '--profile', targetProfile, '--dump-config'],
  ]
  if (options.dryRun === true) {
    return { profile: targetProfile, snapshotId: null, installSpec: receipt.installSpec, dryRun: true, commands }
  }

  const snapshotId = await options.snapshotTarget(targetProfile)
  const env = {
    DSH_HOME: options.dshHome,
    npm_config_ignore_scripts: 'true',
    PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
  }
  try {
    await checkedRun(options.run, { command: 'dsh', args: ['plugin', '--profile', targetProfile, 'add', receipt.installSpec], env, timeoutMs: 120_000 })
    await checkedRun(options.run, { command: 'dsh', args: ['--profile', targetProfile, '--dump-config'], env, timeoutMs: 60_000 })
    await options.recordInstall(targetProfile, receipt)
  } catch (error) {
    try {
      await options.restoreTarget(targetProfile, snapshotId, receipt.packageName)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'quarantine promotion failed and rollback was incomplete',
        { cause: error },
      )
    }
    throw error
  }
  return { profile: targetProfile, snapshotId, installSpec: receipt.installSpec, dryRun: false, commands }
}

async function prepareReceiptDirectory(root: string, id: string): Promise<{ path: string; created: boolean }> {
  await mkdir(root, { recursive: true })
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink()) throw new Error('quarantine receipt root must not be a symbolic link')
  if (!rootInfo.isDirectory()) throw new Error('quarantine receipt root must be a directory')
  const directory = join(root, id)
  let created = false
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink()) throw new Error('quarantine receipt directory must not be a symbolic link')
    if (!info.isDirectory()) throw new Error('quarantine receipt directory must be a directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(directory)
    created = true
  }
  return { path: directory, created }
}

function assertReceiptConsistency(receipt: QuarantineReceipt): void {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(receipt.id)) throw new Error('inconsistent quarantine receipt')
  let immutable: ReturnType<typeof parseSourceSpec>
  try {
    validateRegistrySourceSpec(receipt.immutableSource)
    immutable = parseSourceSpec(receipt.immutableSource)
  } catch {
    throw new Error('inconsistent quarantine receipt')
  }
  if (immutable.kind === 'local') throw new Error('inconsistent quarantine receipt')
  const expectedSpec = immutable.kind === 'npm'
    ? `${immutable.name}@${immutable.version}`
    : `github:${immutable.owner}/${immutable.repo}#${immutable.ref}`
  if (receipt.installSpec !== expectedSpec) throw new Error('inconsistent quarantine receipt')
  if (immutable.kind === 'npm' && receipt.packageName !== immutable.name) {
    throw new Error('inconsistent quarantine receipt')
  }
  if (receipt.quarantineProfile !== `trust-quarantine-${receipt.id}`) {
    throw new Error('inconsistent quarantine receipt')
  }
  validateProfileName(receipt.targetProfile)
}

function validateReceipt(value: Record<string, unknown>): QuarantineReceipt {
  const requiredStrings = [
    'id', 'quarantineProfile', 'targetProfile', 'source', 'immutableSource', 'installSpec', 'packageName',
    'passportDigest', 'verdict', 'createdAt', 'receiptDigest',
  ] as const
  if (value.schemaVersion !== '1.0.0' || typeof value.executed !== 'boolean'
    || requiredStrings.some(key => typeof value[key] !== 'string')) {
    throw new Error('invalid quarantine receipt')
  }
  if (value.verdict !== 'pass' && value.verdict !== 'review') throw new Error('invalid quarantine receipt')
  if (!Number.isFinite(Date.parse(value.createdAt as string))) throw new Error('invalid quarantine receipt')
  if (!/^[a-f0-9]{64}$/.test(value.passportDigest as string) || !/^[a-f0-9]{64}$/.test(value.receiptDigest as string)) {
    throw new Error('invalid quarantine receipt')
  }
  return value as unknown as QuarantineReceipt
}

async function checkedRun(
  run: (command: QuarantineCommand) => Promise<QuarantineCommandResult>,
  command: QuarantineCommand,
): Promise<void> {
  const result = await run(command)
  // Official DSH emits fresh-profile initialization and package warnings on
  // stderr even when the operation succeeds; its exit code is authoritative.
  if (result.code !== 0) throw new Error(`quarantine DSH command failed with exit ${String(result.code)}`)
}
