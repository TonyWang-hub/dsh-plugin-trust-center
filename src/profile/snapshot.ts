import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { parseLedger } from './ledger.js'
import {
  TRUST_LEDGER_FILE,
  profileDir,
  profilesRoot,
  snapshotPath,
  snapshotDir,
  snapshotsRoot,
  validateProfileName,
  validateSnapshotId,
} from './paths.js'

export const SNAPSHOT_SCHEMA_VERSION = '1.0.0' as const

/**
 * The only profile control files Trust Center ever snapshots: the official
 * manifest/lock/workspace/patch files plus the Trust Center ledger. Neither
 * `node_modules` nor credential files are ever captured.
 */
export const SNAPSHOT_TRACKED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  TRUST_LEDGER_FILE,
] as const

export type SnapshotTrackedFile = (typeof SNAPSHOT_TRACKED_FILES)[number]

export interface SnapshotManifest {
  schemaVersion: '1.0.0'
  snapshotId: string
  profile: string
  createdAt: string
  retention: number
  /** SHA-256 digest per captured file; absent keys were absent at capture. */
  files: Partial<Record<SnapshotTrackedFile, string>>
}

export interface CaptureSnapshotOptions {
  home: string
  profile: string
  now?: Date
  retention?: number
}

export interface SnapshotSummary {
  snapshotId: string
  profile: string
  createdAt: string
  files: number
}

export const DEFAULT_SNAPSHOT_RETENTION = 5
export const MAX_SNAPSHOT_RETENTION = 100

/**
 * Filesystem-safe timestamp id, e.g. `2026-08-16T04-15-00-000Z`; ids sort
 * lexicographically in capture order.
 */
export function formatSnapshotId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

/**
 * Captures the profile control files into a fresh timestamped snapshot
 * directory with a SHA-256 manifest, then enforces ring retention. Returns the
 * snapshot id actually used.
 */
export async function captureSnapshot(options: CaptureSnapshotOptions): Promise<string> {
  const profile = validateProfileName(options.profile)
  const now = options.now ?? new Date()
  const retention = options.retention ?? DEFAULT_SNAPSHOT_RETENTION
  if (!Number.isSafeInteger(retention) || retention < 1 || retention > MAX_SNAPSHOT_RETENTION) {
    throw new Error(`snapshot retention must be an integer between 1 and ${MAX_SNAPSHOT_RETENTION}`)
  }
  const root = snapshotDir(options.home, profile)
  const profileRoot = profileDir(options.home, profile)
  await assertSafeProfileDirectories(options.home, profileRoot)
  await assertSafeSnapshotDirectories(options.home, profile)
  const captured = new Map<SnapshotTrackedFile, Buffer>()
  for (const name of SNAPSHOT_TRACKED_FILES) {
    const content = await readTrackedFile(join(profileRoot, name))
    if (content !== undefined) captured.set(name, content)
  }

  const baseId = formatSnapshotId(now)
  let id = baseId
  for (let counter = 2; await exists(join(root, id)); counter += 1) id = `${baseId}-${counter}`

  const dir = snapshotPath(options.home, profile, id)
  const filesDir = join(dir, 'files')
  await mkdir(filesDir, { recursive: true })

  const files: Partial<Record<SnapshotTrackedFile, string>> = {}
  for (const [name, content] of captured) {
    files[name] = sha256(content)
    await writeFileAtomic(join(filesDir, name), content)
  }

  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: id,
    profile,
    createdAt: now.toISOString(),
    retention,
    files,
  }
  // Manifest last: a crash before this leaves no restorable snapshot.
  await writeFileAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await enforceRetention(root, retention)
  return id
}

/** Lists valid snapshots for a profile in lexical (chronological) order. */
export async function listSnapshots(home: string, profile: string): Promise<SnapshotSummary[]> {
  const normalizedProfile = validateProfileName(profile)
  await assertSafeSnapshotDirectories(home, normalizedProfile)
  const dir = snapshotDir(home, normalizedProfile)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
  const summaries: SnapshotSummary[] = []
  for (const name of names.sort()) {
    try {
      const manifest = await readSnapshotManifest(home, normalizedProfile, name)
      summaries.push({
        snapshotId: manifest.snapshotId,
        profile: manifest.profile,
        createdAt: manifest.createdAt,
        files: Object.keys(manifest.files).length,
      })
    } catch {
      // Corrupt or foreign entries are skipped in listings.
    }
  }
  return summaries
}

/**
 * Restores a snapshot exactly: every captured file is byte-for-byte rewritten
 * and every tracked file that was absent at capture is removed. Refuses any
 * snapshot whose captured digest, ledger, or target profile does not match,
 * before touching the live profile.
 */
export async function restoreSnapshot(options: { home: string; profile: string; snapshotId: string }): Promise<void> {
  const profile = validateProfileName(options.profile)
  const id = validateSnapshotId(options.snapshotId)
  const dir = snapshotPath(options.home, profile, id)
  const manifest = await readSnapshotManifest(options.home, profile, id)

  if (manifest.profile !== profile) {
    throw new Error(`snapshot ${id} targets profile ${manifest.profile}, not ${profile}`)
  }

  const filesDir = join(dir, 'files')
  const captured = new Map<SnapshotTrackedFile, Buffer>()
  for (const [name, digest] of Object.entries(manifest.files)) {
    const content = await readTrackedFile(join(filesDir, name))
    if (content === undefined || sha256(content) !== digest) {
      throw new Error(`snapshot ${id} is tampered: ${name} digest mismatch`)
    }
    captured.set(name as SnapshotTrackedFile, content)
  }

  const embeddedLedger = manifest.files[TRUST_LEDGER_FILE]
  if (embeddedLedger !== undefined) {
    const ledgerContent = captured.get(TRUST_LEDGER_FILE)
    if (ledgerContent === undefined) throw new Error(`snapshot ${id} is missing its ledger`)
    const ledger = parseLedger(ledgerContent.toString('utf8'))
    for (const entry of ledger.entries) {
      if (entry.profile !== profile) {
        throw new Error(`snapshot ${id} ledger entry targets ${entry.profile}, not ${profile}`)
      }
    }
  }

  const profileRoot = profileDir(options.home, profile)
  await assertSafeProfileDirectories(options.home, profileRoot)
  await mkdir(profileRoot, { recursive: true })
  for (const name of SNAPSHOT_TRACKED_FILES) {
    const target = join(profileRoot, name)
    const digest = manifest.files[name]
    if (digest === undefined) {
      await rm(target, { force: true })
    } else {
      const content = captured.get(name)
      if (content === undefined) throw new Error(`snapshot ${id} is missing ${name}`)
      await writeFileAtomic(target, content)
    }
  }
}

/** Reads and structurally validates a snapshot manifest. */
export async function readSnapshotManifest(home: string, profile: string, snapshotId: string): Promise<SnapshotManifest> {
  const normalizedProfile = validateProfileName(profile)
  const normalizedId = validateSnapshotId(snapshotId)
  await assertSafeSnapshotDirectories(home, normalizedProfile, normalizedId)
  const dir = snapshotPath(home, normalizedProfile, normalizedId)
  const content = await readTrackedFile(join(dir, 'manifest.json'))
  if (content === undefined) throw new Error(`snapshot not found: ${snapshotId}`)
  return parseSnapshotManifest(content.toString('utf8'))
}

/** Parses and validates a serialized snapshot manifest. */
export function parseSnapshotManifest(text: string): SnapshotManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid snapshot manifest: not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('invalid snapshot manifest: expected an object')
  }
  const manifest = parsed as Record<string, unknown>
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`invalid snapshot manifest: unsupported schema version ${String(manifest.schemaVersion)}`)
  }
  const snapshotId = manifest.snapshotId
  if (typeof snapshotId !== 'string') throw new Error('invalid snapshot manifest: missing snapshot id')
  validateSnapshotId(snapshotId)
  const profile = manifest.profile
  if (typeof profile !== 'string') throw new Error('invalid snapshot manifest: missing profile')
  validateProfileName(profile)
  const createdAt = manifest.createdAt
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error('invalid snapshot manifest: invalid createdAt timestamp')
  }
  const retention = manifest.retention
  if (typeof retention !== 'number' || !Number.isSafeInteger(retention)
    || retention < 1 || retention > MAX_SNAPSHOT_RETENTION) {
    throw new Error('invalid snapshot manifest: invalid retention')
  }
  const rawFiles = manifest.files
  if (rawFiles === null || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
    throw new Error('invalid snapshot manifest: files must be an object')
  }
  const files: Partial<Record<SnapshotTrackedFile, string>> = {}
  for (const [name, digest] of Object.entries(rawFiles as Record<string, unknown>)) {
    if (!(SNAPSHOT_TRACKED_FILES as readonly string[]).includes(name)) {
      throw new Error(`invalid snapshot manifest: unknown tracked file ${name}`)
    }
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`invalid snapshot manifest: bad digest for ${name}`)
    }
    files[name as SnapshotTrackedFile] = digest
  }
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshotId, profile, createdAt, retention, files }
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function assertSafeSnapshotDirectories(home: string, profile: string, snapshotId?: string): Promise<void> {
  const paths: Array<readonly [string, string]> = [
    ['snapshots root', snapshotsRoot(home)],
    ['profile snapshot directory', snapshotDir(home, profile)],
  ]
  if (snapshotId !== undefined) {
    const dir = snapshotPath(home, profile, snapshotId)
    paths.push(['snapshot directory', dir], ['snapshot files directory', join(dir, 'files')])
  }
  for (const [label, path] of paths) {
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
    if (!info.isDirectory()) throw new Error(`${label} must be a directory`)
  }
}

async function assertSafeProfileDirectories(home: string, profileRoot: string): Promise<void> {
  for (const [label, path] of [['profiles root', profilesRoot(home)], ['profile directory', profileRoot]] as const) {
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (isEnoent(error)) continue
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
    if (!info.isDirectory()) throw new Error(`${label} must be a directory`)
  }
}

async function readTrackedFile(path: string): Promise<Buffer | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isEnoent(error)) return undefined
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`tracked profile file must not be a symbolic link: ${path}`)
    }
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`tracked profile path must be a regular file: ${path}`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

/** Removes the oldest snapshot directories until `retention` remain. */
async function enforceRetention(snapRoot: string, retention: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(snapRoot)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  if (names.length <= retention) return
  const directories: string[] = []
  for (const name of names) {
    try {
      if ((await stat(join(snapRoot, name))).isDirectory()) directories.push(name)
    } catch {
      // Ignore entries that vanish between listing and stat.
    }
  }
  directories.sort()
  const excess = directories.length - retention
  for (const name of directories.slice(0, excess)) {
    await rm(join(snapRoot, name), { recursive: true, force: true })
  }
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}
