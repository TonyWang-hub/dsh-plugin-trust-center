import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profileDir } from '../src/profile/paths.js'
import {
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_TRACKED_FILES,
  captureSnapshot,
  formatSnapshotId,
  listSnapshots,
  readSnapshotManifest,
  restoreSnapshot,
} from '../src/profile/snapshot.js'

function ledgerJson(): string {
  return `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      schemaVersion: '1.0.0',
      version: 1,
      action: 'install',
      packageName: 'trust-demo',
      spec: 'trust-demo@1.2.3',
      passportDigest: `ab${'c'.repeat(62)}`,
      profile: 'trust-test',
      installedAt: '2026-08-16T03:00:00.000Z',
    }],
  })}\n`
}

const LEDGER = ledgerJson()

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-trust-snapshot-'))
}

async function makeProfile(home: string, profile: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = profileDir(home, profile)
  await mkdir(dir, { recursive: true })
  const files: Record<string, string> = {
    'package.json': '{"name":"trust-app","version":"1.0.0"}\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'cordis.patch.yml': 'patch:\n  - op: add\n',
    'trust-ledger.json': LEDGER,
    ...extra,
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content)
  }
  return dir
}

describe('formatSnapshotId', () => {
  it('renders a filesystem-safe timestamp id', () => {
    expect(formatSnapshotId(new Date('2026-08-16T04:15:00.000Z'))).toBe('2026-08-16T04-15-00-000Z')
  })
})

describe('captureSnapshot', () => {
  it('captures the tracked profile files with a SHA-256 manifest', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      const manifest = await readSnapshotManifest(home, profile, id)
      expect(manifest.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
      expect(manifest.snapshotId).toBe(id)
      expect(manifest.profile).toBe(profile)
      expect(manifest.createdAt).toBe('2026-08-16T04:15:00.000Z')

      expect(Object.keys(manifest.files).sort()).toEqual([...SNAPSHOT_TRACKED_FILES].sort())
      for (const name of SNAPSHOT_TRACKED_FILES) {
        const digest = manifest.files[name]
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
        const captured = await readFile(join(profileDir(home, profile), name))
        expect(digest).toBe(sha256(captured))
      }

      const filesDir = join(home, 'snapshots', profile, id, 'files')
      expect((await readdir(filesDir)).sort()).toEqual([...SNAPSHOT_TRACKED_FILES].sort())
      for (const name of SNAPSHOT_TRACKED_FILES) {
        const original = await readFile(join(profileDir(home, profile), name))
        const copy = await readFile(join(filesDir, name))
        expect(copy.equals(original)).toBe(true)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('never copies node_modules or credential files', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile, {
        '.npmrc': '//registry.example.com/:_authToken=super-secret\n',
      })
      await mkdir(join(profileDir(home, profile), 'node_modules', 'big-dep'), { recursive: true })
      await writeFile(join(profileDir(home, profile), 'node_modules', 'big-dep', 'index.js'), 'secret payload')

      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })
      const manifest = await readSnapshotManifest(home, profile, id)

      expect(Object.keys(manifest.files).sort()).toEqual([...SNAPSHOT_TRACKED_FILES].sort())
      const filesDir = join(home, 'snapshots', profile, id, 'files')
      expect(await readdir(filesDir)).not.toContain('node_modules')
      expect(await readdir(filesDir)).not.toContain('.npmrc')
      expect(JSON.stringify(manifest)).not.toContain('super-secret')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('records optional files as absent when the profile lacks them', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      const dir = profileDir(home, profile)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), '{"name":"minimal"}\n')

      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })
      const manifest = await readSnapshotManifest(home, profile, id)

      expect(manifest.files['package.json']).toMatch(/^[0-9a-f]{64}$/)
      expect(manifest.files['pnpm-lock.yaml']).toBeUndefined()
      expect(manifest.files['pnpm-workspace.yaml']).toBeUndefined()
      expect(manifest.files['cordis.patch.yml']).toBeUndefined()
      expect(manifest.files['trust-ledger.json']).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps only the newest snapshots under ring retention', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const ids: string[] = []
      for (let minute = 0; minute < 6; minute += 1) {
        const id = await captureSnapshot({
          home,
          profile,
          now: new Date(`2026-08-16T04:${String(15 + minute).padStart(2, '0')}:00.000Z`),
        })
        ids.push(id)
      }

      const summaries = await listSnapshots(home, profile)
      expect(summaries.map(summary => summary.snapshotId).sort()).toEqual(ids.slice(1).sort())
      expect(summaries).toHaveLength(5)
      expect(ids[0]).not.toBe(summaries[0]?.snapshotId)
      expect(summaries[summaries.length - 1]?.snapshotId).toBe(ids[ids.length - 1])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses zero retention so a transaction cannot delete its own rollback point', async () => {
    const home = await root()
    try {
      await makeProfile(home, 'trust-test')
      await expect(captureSnapshot({ home, profile: 'trust-test', retention: 0 })).rejects.toThrow('retention')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('honors an explicit retention cap', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      for (let minute = 0; minute < 3; minute += 1) {
        await captureSnapshot({
          home,
          profile,
          retention: 2,
          now: new Date(`2026-08-16T04:${String(15 + minute).padStart(2, '0')}:00.000Z`),
        })
      }

      expect(await listSnapshots(home, profile)).toHaveLength(2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked snapshots root instead of writing outside DSH_HOME', async () => {
    const home = await root()
    const outside = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      await symlink(outside, join(home, 'snapshots'))

      await expect(captureSnapshot({ home, profile })).rejects.toThrow('symbolic link')
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses symlinked tracked files instead of reading outside the profile', async () => {
    const home = await root()
    const outside = join(home, 'outside-package.json')
    try {
      const profile = 'trust-test'
      const dir = await makeProfile(home, profile)
      await writeFile(outside, '{"secret":"outside"}\n')
      await rm(join(dir, 'package.json'))
      await symlink(outside, join(dir, 'package.json'))

      await expect(captureSnapshot({ home, profile })).rejects.toThrow('symbolic link')
      await expect(readdir(join(home, 'snapshots', profile))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('disambiguates ids captured within the same millisecond', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const now = new Date('2026-08-16T04:15:00.000Z')
      const first = await captureSnapshot({ home, profile, now })
      const second = await captureSnapshot({ home, profile, now })

      expect(first).toBe('2026-08-16T04-15-00-000Z')
      expect(second).toBe('2026-08-16T04-15-00-000Z-2')
      expect(await listSnapshots(home, profile)).toHaveLength(2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('restoreSnapshot', () => {
  it('restores every captured file to its exact original bytes', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const original = new Map<string, Buffer>()
      for (const name of SNAPSHOT_TRACKED_FILES) {
        original.set(name, await readFile(join(profileDir(home, profile), name)))
      }

      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      // Mutate everything after the snapshot.
      for (const name of SNAPSHOT_TRACKED_FILES) {
        await writeFile(join(profileDir(home, profile), name), `${name}:tampered-after\n`)
      }

      await restoreSnapshot({ home, profile, snapshotId: id })

      for (const name of SNAPSHOT_TRACKED_FILES) {
        const restored = await readFile(join(profileDir(home, profile), name))
        expect(restored.equals(original.get(name) ?? Buffer.alloc(0)), name).toBe(true)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes files that were absent at capture time', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      const dir = profileDir(home, profile)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), '{"name":"minimal"}\n')

      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
      await restoreSnapshot({ home, profile, snapshotId: id })

      await expect(readFile(join(dir, 'pnpm-workspace.yaml'))).rejects.toThrow()
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('{"name":"minimal"}\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses symlinked snapshot files before touching the live profile', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      const dir = await makeProfile(home, profile)
      const original = await readFile(join(dir, 'package.json'))
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })
      const snapshotFile = join(home, 'snapshots', profile, id, 'files', 'package.json')
      const outside = join(home, 'outside-snapshot-package.json')
      await writeFile(outside, original)
      await rm(snapshotFile)
      await symlink(outside, snapshotFile)
      await writeFile(join(dir, 'package.json'), '{"state":"current"}\n')

      await expect(restoreSnapshot({ home, profile, snapshotId: id })).rejects.toThrow('symbolic link')
      expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('{"state":"current"}\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a snapshot whose captured file was tampered', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      await writeFile(join(home, 'snapshots', profile, id, 'files', 'package.json'), '{"tampered":true}\n')

      await expect(restoreSnapshot({ home, profile, snapshotId: id })).rejects.toThrow(/digest|tamper/i)
      // Refusal must leave the live profile untouched.
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe('{"name":"trust-app","version":"1.0.0"}\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a snapshot whose manifest profile does not match the target', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      const manifestPath = join(home, 'snapshots', profile, id, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.profile = 'other-profile'
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

      await expect(restoreSnapshot({ home, profile, snapshotId: id })).rejects.toThrow(/profile/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a snapshot whose embedded ledger targets another profile', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      const ledgerCopy = join(home, 'snapshots', profile, id, 'files', 'trust-ledger.json')
      const ledger = JSON.parse(await readFile(ledgerCopy, 'utf8'))
      ledger.entries[0].profile = 'other-profile'
      await writeFile(ledgerCopy, JSON.stringify(ledger, null, 2))

      await expect(restoreSnapshot({ home, profile, snapshotId: id })).rejects.toThrow(/ledger|profile/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a missing snapshot id', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      await expect(restoreSnapshot({ home, profile, snapshotId: '2026-01-01T00-00-00-000Z' }))
        .rejects.toThrow(/not found/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a symlinked snapshot manifest', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })
      const manifestPath = join(home, 'snapshots', profile, id, 'manifest.json')
      const outside = join(home, 'outside-manifest.json')
      await writeFile(outside, await readFile(manifestPath))
      await rm(manifestPath)
      await symlink(outside, manifestPath)

      await expect(readSnapshotManifest(home, profile, id)).rejects.toThrow('symbolic link')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a corrupt manifest', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await makeProfile(home, profile)
      const id = await captureSnapshot({ home, profile, now: new Date('2026-08-16T04:15:00.000Z') })

      await writeFile(join(home, 'snapshots', profile, id, 'manifest.json'), '{corrupt')

      await expect(restoreSnapshot({ home, profile, snapshotId: id })).rejects.toThrow(/manifest/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses traversal-shaped snapshot ids', async () => {
    const home = await root()
    try {
      await expect(restoreSnapshot({ home, profile: 'trust-test', snapshotId: '../escape' }))
        .rejects.toThrow(/snapshot id/)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
