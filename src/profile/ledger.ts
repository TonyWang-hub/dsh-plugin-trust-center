import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { validateProfileName } from './paths.js'
import { writeFileAtomic } from './atomic.js'

export const LEDGER_SCHEMA_VERSION = '1.0.0' as const

export type LedgerAction = 'install' | 'remove'

export interface LedgerEntry {
  schemaVersion: '1.0.0'
  /** Monotonically increasing entry version within one ledger file. */
  version: number
  action: LedgerAction
  packageName: string
  /** Immutable install spec (exact version, commit, or digest-pinned tarball). */
  spec: string
  /** SHA-256 subject digest from the Stage 1 Passport. */
  passportDigest: string
  /** Target profile the entry belongs to. */
  profile: string
  /** ISO-8601 UTC install/removal time. */
  installedAt: string
}

export interface LedgerFile {
  schemaVersion: '1.0.0'
  entries: LedgerEntry[]
}

export interface LedgerEntryInput {
  action: LedgerAction
  packageName: string
  spec: string
  passportDigest: string
  profile: string
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NPM_NAME_PATTERN = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/
const GITHUB_SPEC_PATTERN = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9a-fA-F]{40}$/

/** Refuses mutable tags/ranges before a spec enters the recovery ledger. */
export function validateImmutableInstallSpec(spec: string, packageName?: string): string {
  if (GITHUB_SPEC_PATTERN.test(spec)) return spec
  const versionAt = spec.startsWith('@') ? spec.lastIndexOf('@') : spec.indexOf('@')
  const slashAt = spec.indexOf('/')
  if (versionAt > (spec.startsWith('@') ? slashAt : -1)) {
    const name = spec.slice(0, versionAt)
    const version = spec.slice(versionAt + 1)
    if (NPM_NAME_PATTERN.test(name) && SEMVER_PATTERN.test(version)) {
      if (packageName !== undefined && name !== packageName) {
        throw new Error('ledger immutable spec package does not match package name')
      }
      return spec
    }
  }
  throw new Error('ledger entry requires an immutable spec')
}

/**
 * Appends one immutable entry to the profile ledger and writes the file with
 * atomic 0600 semantics. Existing entries are never rewritten: the ledger is
 * append-only in normal operation.
 */
export async function appendLedger(
  path: string,
  input: LedgerEntryInput,
  now: Date = new Date(),
): Promise<LedgerEntry> {
  const profile = validateProfileName(input.profile)
  if (input.action !== 'install' && input.action !== 'remove') {
    throw new Error(`ledger entry requires a valid action, got: ${String(input.action)}`)
  }
  if (input.packageName.trim() === '') throw new Error('ledger entry requires a package name')
  validateImmutableInstallSpec(input.spec, input.packageName)
  if (!DIGEST_PATTERN.test(input.passportDigest)) {
    throw new Error('ledger entry requires a 64-hex passport digest')
  }

  return withLedgerLock(path, async () => {
    const existing = await loadLedger(path)
    const version = (existing.entries[existing.entries.length - 1]?.version ?? 0) + 1
    const entry: LedgerEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      version,
      action: input.action,
      packageName: input.packageName,
      spec: input.spec,
      passportDigest: input.passportDigest,
      profile,
      installedAt: now.toISOString(),
    }
    const file: LedgerFile = { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [...existing.entries, entry] }
    await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`)
    return entry
  })
}

/** Reads and validates the ledger; a missing file reads as an empty ledger. */
export async function loadLedger(path: string): Promise<LedgerFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: [] }
    throw error
  }
  return parseLedger(text)
}

/**
 * Parses and strictly validates a serialized ledger. Any structural problem,
 * schema mismatch, tampered field, or non-increasing version is refused.
 */
export function parseLedger(text: string): LedgerFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid Trust Center ledger: not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('invalid Trust Center ledger: expected an object')
  }
  const file = parsed as Record<string, unknown>
  if (file.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`invalid Trust Center ledger: unsupported schema version ${String(file.schemaVersion)}`)
  }
  if (!Array.isArray(file.entries)) {
    throw new Error('invalid Trust Center ledger: entries must be an array')
  }
  const entries: LedgerEntry[] = []
  let previousVersion = 0
  for (const raw of file.entries) {
    const entry = validateEntry(raw)
    if (entry.version <= previousVersion) {
      throw new Error(
        `invalid Trust Center ledger: entry versions must increase (${entry.version} after ${previousVersion})`,
      )
    }
    previousVersion = entry.version
    entries.push(entry)
  }
  return { schemaVersion: LEDGER_SCHEMA_VERSION, entries }
}

/** Returns the newest entry for a package, or undefined when absent. */
export function findLatestEntry(ledger: LedgerFile, packageName: string): LedgerEntry | undefined {
  let latest: LedgerEntry | undefined
  for (const entry of ledger.entries) {
    if (entry.packageName === packageName) latest = entry
  }
  return latest
}

function validateEntry(raw: unknown): LedgerEntry {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('invalid Trust Center ledger: entry is not an object')
  }
  const entry = raw as Record<string, unknown>
  if (entry.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error('invalid Trust Center ledger: unsupported entry schema version')
  }
  const version = entry.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('invalid Trust Center ledger: entry version must be a positive integer')
  }
  const action = entry.action
  if (action !== 'install' && action !== 'remove') {
    throw new Error('invalid Trust Center ledger: unknown action')
  }
  const packageName = entry.packageName
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    throw new Error('invalid Trust Center ledger: missing package name')
  }
  const spec = entry.spec
  if (typeof spec !== 'string') throw new Error('invalid Trust Center ledger: missing immutable spec')
  validateImmutableInstallSpec(spec, packageName)
  const passportDigest = entry.passportDigest
  if (typeof passportDigest !== 'string' || !DIGEST_PATTERN.test(passportDigest)) {
    throw new Error('invalid Trust Center ledger: passport digest must be 64 hex characters')
  }
  const profile = entry.profile
  if (typeof profile !== 'string') throw new Error('invalid Trust Center ledger: missing profile')
  validateProfileName(profile)
  const installedAt = entry.installedAt
  if (typeof installedAt !== 'string' || !Number.isFinite(Date.parse(installedAt))) {
    throw new Error('invalid Trust Center ledger: invalid installedAt timestamp')
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    version,
    action,
    packageName,
    spec,
    passportDigest,
    profile,
    installedAt,
  }
}

const LEDGER_LOCK_TIMEOUT_MS = 5_000
const LEDGER_LOCK_STALE_MS = 30_000
const LEDGER_LOCK_RETRY_MS = 10

async function withLedgerLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + LEDGER_LOCK_TIMEOUT_MS
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (handle === undefined) {
    let candidate: Awaited<ReturnType<typeof open>> | undefined
    try {
      candidate = await open(lockPath, 'wx', 0o600)
      await candidate.writeFile(`${String(process.pid)}\n`)
      await candidate.sync()
      handle = candidate
    } catch (error) {
      if (candidate !== undefined) {
        await candidate.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await lstat(lockPath)
        if (Date.now() - info.mtimeMs > LEDGER_LOCK_STALE_MS && !await lockOwnerIsAlive(lockPath)) {
          try {
            await unlink(lockPath)
            continue
          } catch (unlinkError) {
            const code = (unlinkError as NodeJS.ErrnoException).code
            if (code === 'ENOENT') continue
            if (code !== 'EPERM') throw unlinkError
          }
        }
      } catch (statError) {
        if (!isEnoent(statError)) throw statError
        continue
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ledger lock: ${lockPath}`)
      await new Promise(resolve => setTimeout(resolve, LEDGER_LOCK_RETRY_MS))
    }
  }
  try {
    return await operation()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

async function lockOwnerIsAlive(lockPath: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
