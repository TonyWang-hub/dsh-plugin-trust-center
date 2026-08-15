import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_SCHEMA_VERSION,
  appendLedger,
  findLatestEntry,
  loadLedger,
  parseLedger,
} from '../src/profile/ledger.js'

const NOW = '2026-08-16T04:15:00.000Z'

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-trust-ledger-'))
}

describe('appendLedger', () => {
  it('creates a versioned 0600 ledger file with schema and entry fields', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      const entry = await appendLedger(path, {
        action: 'install',
        packageName: 'trust-demo',
        spec: 'trust-demo@1.2.3',
        passportDigest: 'a'.repeat(64),
        profile: 'trust-test',
      }, new Date(NOW))

      expect(entry.schemaVersion).toBe(LEDGER_SCHEMA_VERSION)
      expect(entry.version).toBe(1)
      expect(entry.action).toBe('install')
      expect(entry.packageName).toBe('trust-demo')
      expect(entry.spec).toBe('trust-demo@1.2.3')
      expect(entry.passportDigest).toBe('a'.repeat(64))
      expect(entry.profile).toBe('trust-test')
      expect(entry.installedAt).toBe(NOW)

      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('increments entry versions monotonically across appends', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      const first = await appendLedger(path, {
        action: 'install', packageName: 'a', spec: 'a@1.0.0',
        passportDigest: 'b'.repeat(64), profile: 'p1',
      }, new Date(NOW))
      const second = await appendLedger(path, {
        action: 'remove', packageName: 'a', spec: 'a@1.0.0',
        passportDigest: 'b'.repeat(64), profile: 'p1',
      }, new Date('2026-08-16T05:00:00.000Z'))

      expect(first.version).toBe(1)
      expect(second.version).toBe(2)

      const ledger = await loadLedger(path)
      expect(ledger.entries.map(entry => entry.version)).toEqual([1, 2])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is append-only: prior entries are preserved byte-for-byte', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      await appendLedger(path, {
        action: 'install', packageName: 'a', spec: 'a@1.0.0',
        passportDigest: 'c'.repeat(64), profile: 'p1',
      }, new Date(NOW))
      const before = await readFile(path, 'utf8')
      await appendLedger(path, {
        action: 'install', packageName: 'b', spec: 'b@2.0.0',
        passportDigest: 'd'.repeat(64), profile: 'p1',
      }, new Date('2026-08-16T06:00:00.000Z'))

      const ledger = await loadLedger(path)
      expect(ledger.entries).toHaveLength(2)
      expect(ledger.entries[0]).toEqual(JSON.parse(before).entries[0])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses mutable install specs before writing the ledger', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      await expect(appendLedger(path, {
        action: 'install', packageName: 'a', spec: 'a@latest',
        passportDigest: 'c'.repeat(64), profile: 'p1',
      }, new Date(NOW))).rejects.toThrow('immutable spec')
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses entries with an invalid profile name', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      await expect(appendLedger(path, {
        action: 'install', packageName: 'a', spec: 'a@1.0.0',
        passportDigest: 'c'.repeat(64), profile: '../escape',
      }, new Date(NOW))).rejects.toThrow(/profile name/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('loadLedger', () => {
  it('returns an empty ledger when the file does not exist', async () => {
    const dir = await root()
    try {
      const ledger = await loadLedger(join(dir, 'missing.json'))
      expect(ledger.schemaVersion).toBe(LEDGER_SCHEMA_VERSION)
      expect(ledger.entries).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed JSON', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      await writeFile(path, '{not json', { mode: 0o600 })
      await expect(loadLedger(path)).rejects.toThrow(/ledger/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a wrong schema version', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      await writeFile(path, JSON.stringify({ schemaVersion: '9.9.9', entries: [] }), { mode: 0o600 })
      await expect(loadLedger(path)).rejects.toThrow(/schema/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects tampered entries with non-increasing versions', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      const entry = (version: number) => ({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        version,
        action: 'install',
        packageName: 'a',
        spec: 'a@1.0.0',
        passportDigest: 'e'.repeat(64),
        profile: 'p1',
        installedAt: NOW,
      })
      await writeFile(path, JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, entries: [entry(1), entry(1)] }), { mode: 0o600 })
      await expect(loadLedger(path)).rejects.toThrow(/version/)

      await writeFile(path, JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, entries: [entry(2), entry(1)] }), { mode: 0o600 })
      await expect(loadLedger(path)).rejects.toThrow(/version/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects entries with missing or invalid fields', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      const base = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        version: 1,
        action: 'install',
        packageName: 'a',
        spec: 'a@1.0.0',
        passportDigest: 'e'.repeat(64),
        profile: 'p1',
        installedAt: NOW,
      }
      for (const tampered of [
        { ...base, packageName: '' },
        { ...base, spec: '' },
        { ...base, passportDigest: 'not-a-digest' },
        { ...base, action: 'upgrade' },
        { ...base, profile: '../escape' },
        { ...base, installedAt: 'yesterday' },
      ]) {
        await writeFile(path, JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, entries: [tampered] }), { mode: 0o600 })
        await expect(loadLedger(path), JSON.stringify(tampered)).rejects.toThrow()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('parseLedger validates the digest format', () => {
    expect(() => parseLedger(JSON.stringify({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      entries: [{
        schemaVersion: LEDGER_SCHEMA_VERSION,
        version: 1,
        action: 'install',
        packageName: 'a',
        spec: 'a@1.0.0',
        passportDigest: 'ZZZ',
        profile: 'p1',
        installedAt: NOW,
      }],
    }))).toThrow(/digest/)
  })
})

describe('findLatestEntry', () => {
  it('returns the most recent entry for a package', async () => {
    const dir = await root()
    try {
      const path = join(dir, 'trust-ledger.json')
      await appendLedger(path, {
        action: 'install', packageName: 'a', spec: 'a@1.0.0',
        passportDigest: 'f'.repeat(64), profile: 'p1',
      }, new Date(NOW))
      await appendLedger(path, {
        action: 'remove', packageName: 'a', spec: 'a@1.0.0',
        passportDigest: 'f'.repeat(64), profile: 'p1',
      }, new Date('2026-08-16T07:00:00.000Z'))

      const ledger = await loadLedger(path)
      expect(findLatestEntry(ledger, 'a')?.action).toBe('remove')
      expect(findLatestEntry(ledger, 'a')?.version).toBe(2)
      expect(findLatestEntry(ledger, 'missing')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
