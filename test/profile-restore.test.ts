import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profileDir } from '../src/profile/paths.js'
import { captureSnapshot } from '../src/profile/snapshot.js'
import { restoreProfile } from '../src/profile/restore.js'
import { installFakeDsh, profilePackageJson } from './profile-helpers.js'

const DIGEST = 'a'.repeat(64)

function ledger(action: 'install' | 'remove' = 'install'): string {
  return `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      schemaVersion: '1.0.0', version: 1, action, packageName: 'trust-demo',
      spec: 'trust-demo@1.2.3', passportDigest: DIGEST, profile: 'work',
      installedAt: '2026-08-15T00:00:00.000Z',
    }],
  }, null, 2)}\n`
}

async function setupTarget(home: string): Promise<{ id: string; packageJson: string; trustLedger: string }> {
  const root = profileDir(home, 'work')
  await mkdir(root, { recursive: true })
  const packageJson = profilePackageJson(['@deepseek-ai/dsh-base', 'trust-demo'], {
    '@deepseek-ai/dsh-base': '0.1.0-rc.6',
    'trust-demo': '1.2.3',
  })
  const trustLedger = ledger()
  await writeFile(join(root, 'package.json'), packageJson)
  await writeFile(join(root, 'trust-ledger.json'), trustLedger)
  const id = await captureSnapshot({ home, profile: 'work', now: new Date('2026-08-15T00:00:00.000Z') })
  return { id, packageJson, trustLedger }
}

describe('restoreProfile', () => {
  it('reinstalls immutable ledger specs through official dsh and preserves exact snapshot bytes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-restore-'))
    const fixture = await installFakeDsh()
    try {
      const target = await setupTarget(home)
      const root = profileDir(home, 'work')
      await writeFile(join(root, 'package.json'), profilePackageJson([], {}))
      await writeFile(join(root, 'trust-ledger.json'), ledger('remove'))

      const result = await restoreProfile({
        home,
        profile: 'work',
        snapshotId: target.id,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        now: new Date('2026-08-16T00:00:00.000Z'),
      })

      expect(result.commands).toEqual([
        ['plugin', '--profile', 'work', 'add', 'trust-demo@1.2.3'],
        ['--profile', 'work', '--dump-config'],
      ])
      expect(fixture.calls).toEqual(result.commands)
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(target.packageJson)
      expect(await readFile(join(root, 'trust-ledger.json'), 'utf8')).toBe(target.trustLedger)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses digest-mismatched snapshot control files during dry run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-restore-digest-'))
    const fixture = await installFakeDsh()
    try {
      const target = await setupTarget(home)
      const packagePath = join(home, 'snapshots', 'work', target.id, 'files', 'package.json')
      await writeFile(packagePath, `${target.packageJson} `)

      await expect(restoreProfile({
        home,
        profile: 'work',
        snapshotId: target.id,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        dryRun: true,
      })).rejects.toThrow('digest mismatch')
      expect(fixture.calls).toEqual([])
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses symlinked snapshot control files even during dry run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-restore-link-'))
    const fixture = await installFakeDsh()
    try {
      const target = await setupTarget(home)
      const ledgerPath = join(home, 'snapshots', 'work', target.id, 'files', 'trust-ledger.json')
      const outside = join(home, 'outside-ledger.json')
      await writeFile(outside, await readFile(ledgerPath))
      await rm(ledgerPath)
      await symlink(outside, ledgerPath)

      await expect(restoreProfile({
        home,
        profile: 'work',
        snapshotId: target.id,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        dryRun: true,
      })).rejects.toThrow('symbolic link')
      expect(fixture.calls).toEqual([])
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('removes partial installs and restores the pre-restore snapshot when official add fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-restore-fail-'))
    const fixture = await installFakeDsh()
    try {
      const target = await setupTarget(home)
      const root = profileDir(home, 'work')
      const beforePackage = profilePackageJson([], {})
      const beforeLedger = ledger('remove')
      await writeFile(join(root, 'package.json'), beforePackage)
      await writeFile(join(root, 'trust-ledger.json'), beforeLedger)

      await expect(restoreProfile({
        home,
        profile: 'work',
        snapshotId: target.id,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        now: new Date('2026-08-16T00:00:00.000Z'),
        env: { FAKE_DSH_FAIL_ADD: 'trust-demo' },
      })).rejects.toThrow(/add failed/)

      expect(fixture.calls).toEqual([
        ['plugin', '--profile', 'work', 'add', 'trust-demo@1.2.3'],
        ['plugin', '--profile', 'work', 'remove', 'trust-demo'],
      ])
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(beforePackage)
      expect(await readFile(join(root, 'trust-ledger.json'), 'utf8')).toBe(beforeLedger)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })
})
