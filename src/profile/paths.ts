import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * Trust Center ledger file name inside each profile directory. Official DSH
 * ignores this file; it is owned exclusively by Trust Center.
 */
export const TRUST_LEDGER_FILE = 'trust-ledger.json' as const

/**
 * Allowed profile name shape: an ASCII letter or digit first, then letters,
 * digits, dots, underscores, and dashes. Rejects separators, hidden names,
 * control characters, whitespace, and `.`/`..`.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Same character class for snapshot ids, which are timestamp-based. */
export const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const MAX_PROFILE_NAME_LENGTH = 64

/**
 * Resolves the DSH home directory. `DSH_HOME` overrides the default
 * `~/.dsh`; a relative override is resolved against the process cwd.
 */
export function defaultDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DSH_HOME
  if (value !== undefined && value.trim() !== '') return resolve(value)
  return join(homedir(), '.dsh')
}

/**
 * Validates a profile name and returns it trimmed. Every mutating operation
 * must run its profile name through this gate before touching the filesystem.
 */
export function validateProfileName(name: string): string {
  if (typeof name !== 'string') throw new Error('profile name must be a string')
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('profile name must not be empty')
  if (trimmed.length > MAX_PROFILE_NAME_LENGTH) throw new Error(`profile name is too long: ${trimmed}`)
  if (trimmed === '.' || trimmed === '..' || !PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new Error(`invalid profile name: ${trimmed}`)
  }
  return trimmed
}

/**
 * Validates a snapshot id and returns it. Snapshot ids are timestamp-derived
 * and must not escape the snapshot directory.
 */
export function validateSnapshotId(snapshotId: string): string {
  if (typeof snapshotId !== 'string') throw new Error('snapshot id must be a string')
  const trimmed = snapshotId.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || !SNAPSHOT_ID_PATTERN.test(trimmed)) {
    throw new Error(`invalid snapshot id: ${trimmed}`)
  }
  return trimmed
}

/** Root directory holding every official profile: `$DSH_HOME/profiles`. */
export function profilesRoot(home: string): string {
  return resolve(home, 'profiles')
}

/**
 * Resolves the official profile directory and verifies it stays under
 * `$DSH_HOME/profiles` even if the home path is unusual.
 */
export function profileDir(home: string, profile: string): string {
  const name = validateProfileName(profile)
  const root = profilesRoot(home)
  return assertUnderRoot(root, join(root, name))
}

/** Trust Center immutable-spec ledger path for a profile. */
export function ledgerPath(home: string, profile: string): string {
  return join(profileDir(home, profile), TRUST_LEDGER_FILE)
}

/** Root directory holding Trust Center snapshots: `$DSH_HOME/snapshots`. */
export function snapshotsRoot(home: string): string {
  return resolve(home, 'snapshots')
}

/** Snapshot directory for one profile: `$DSH_HOME/snapshots/<profile>`. */
export function snapshotDir(home: string, profile: string): string {
  const name = validateProfileName(profile)
  const root = snapshotsRoot(home)
  return assertUnderRoot(root, join(root, name))
}

/** Resolves one snapshot directory by id, validating the id. */
export function snapshotPath(home: string, profile: string, snapshotId: string): string {
  const id = validateSnapshotId(snapshotId)
  return join(snapshotDir(home, profile), id)
}

/**
 * Defense-in-depth containment check: the candidate must resolve to the root
 * or to a path strictly inside it.
 */
export function assertUnderRoot(root: string, candidate: string): string {
  const rootResolved = resolve(root)
  const candidateResolved = resolve(candidate)
  if (candidateResolved !== rootResolved && !candidateResolved.startsWith(`${rootResolved}${sep}`)) {
    throw new Error(`path escapes ${rootResolved}: ${candidateResolved}`)
  }
  return candidateResolved
}
