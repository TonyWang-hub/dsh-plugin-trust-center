import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultDshHome,
  ledgerPath,
  profileDir,
  profilesRoot,
  snapshotDir,
  snapshotPath,
  validateProfileName,
  validateSnapshotId,
} from '../src/profile/paths.js'

const PREVIOUS_DSH_HOME = process.env.DSH_HOME

afterEach(() => {
  if (PREVIOUS_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_DSH_HOME
})

describe('validateProfileName', () => {
  it('accepts a plain lowercase name', () => {
    expect(validateProfileName('trust-test')).toBe('trust-test')
  })

  it('accepts names with digits, dots, underscores, and dashes', () => {
    expect(validateProfileName('v1.2_stable-x')).toBe('v1.2_stable-x')
  })

  it('accepts a scoped-style name', () => {
    expect(validateProfileName('team-alpha')).toBe('team-alpha')
  })

  it('rejects an empty or whitespace-only name', () => {
    expect(() => validateProfileName('')).toThrow(/profile name/)
    expect(() => validateProfileName('   ')).toThrow(/profile name/)
  })

  it('rejects dot and dot-dot names', () => {
    expect(() => validateProfileName('.')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('..')).toThrow(/invalid profile name/)
  })

  it('rejects path traversal names', () => {
    expect(() => validateProfileName('../evil')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('a/b')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('a\\b')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('/etc/passwd')).toThrow(/invalid profile name/)
  })

  it('rejects hidden, spaced, globbed, and overlong names', () => {
    expect(() => validateProfileName('.hidden')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('has space')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('a*b')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('-leading-dash')).toThrow(/invalid profile name/)
    expect(() => validateProfileName('x'.repeat(65))).toThrow(/too long/)
  })
})

describe('path derivation', () => {
  it('derives profile paths under $DSH_HOME/profiles', () => {
    const home = '/tmp/dsh-home'
    expect(profilesRoot(home)).toBe(resolve(home, 'profiles'))
    expect(profileDir(home, 'trust-test')).toBe(resolve(home, 'profiles', 'trust-test'))
  })

  it('keeps profile paths lexically under the profiles root for any name', () => {
    const home = '/tmp/dsh-home'
    const root = profilesRoot(home)
    const dir = profileDir(home, 'nested.name_1')
    expect(dir.startsWith(`${root}${sep}`)).toBe(true)
  })

  it('derives the Trust Center ledger inside the profile directory', () => {
    expect(ledgerPath('/tmp/dsh-home', 'trust-test'))
      .toBe(resolve('/tmp/dsh-home', 'profiles', 'trust-test', 'trust-ledger.json'))
  })

  it('derives snapshot directories under $DSH_HOME/snapshots per profile', () => {
    const home = '/tmp/dsh-home'
    expect(snapshotDir(home, 'trust-test')).toBe(resolve(home, 'snapshots', 'trust-test'))
    expect(snapshotPath(home, 'trust-test', '2026-08-16T04-15-00-000Z'))
      .toBe(resolve(home, 'snapshots', 'trust-test', '2026-08-16T04-15-00-000Z'))
  })

  it('validates the profile name inside derived paths', () => {
    expect(() => profileDir('/tmp/dsh-home', '../evil')).toThrow(/invalid profile name/)
    expect(() => ledgerPath('/tmp/dsh-home', 'a/b')).toThrow(/invalid profile name/)
    expect(() => snapshotDir('/tmp/dsh-home', '..')).toThrow(/invalid profile name/)
  })

  it('validates snapshot ids before joining', () => {
    expect(() => snapshotPath('/tmp/dsh-home', 'trust-test', '../steal')).toThrow(/snapshot id/)
    expect(() => snapshotPath('/tmp/dsh-home', 'trust-test', 'a/b')).toThrow(/snapshot id/)
    expect(() => snapshotPath('/tmp/dsh-home', 'trust-test', '..')).toThrow(/snapshot id/)
  })

  it('accepts the canonical timestamp snapshot id format', () => {
    expect(validateSnapshotId('2026-08-16T04-15-00-000Z')).toBe('2026-08-16T04-15-00-000Z')
    expect(validateSnapshotId('2026-08-16T04-15-00-000Z-2')).toBe('2026-08-16T04-15-00-000Z-2')
  })
})

describe('defaultDshHome', () => {
  it('honors the DSH_HOME override', () => {
    process.env.DSH_HOME = '/tmp/override-home'
    expect(defaultDshHome()).toBe(resolve('/tmp/override-home'))
  })

  it('falls back to ~/.dsh when DSH_HOME is unset', () => {
    delete process.env.DSH_HOME
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('resolves a relative DSH_HOME override to an absolute path', () => {
    process.env.DSH_HOME = 'relative-home'
    expect(defaultDshHome()).toBe(resolve('relative-home'))
  })
})
