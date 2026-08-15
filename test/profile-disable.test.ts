import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadLedger } from '../src/profile/ledger.js'
import { profileDir } from '../src/profile/paths.js'
import { disableBundle, reenableBundle } from '../src/profile/disable.js'
import { listSnapshots } from '../src/profile/snapshot.js'
import { installFakeDsh, profilePackageJson } from './profile-helpers.js'
import type { DisableOptions } from '../src/profile/disable.js'
import type { CommandRunner } from '../src/profile/runner.js'

const NOW = new Date('2026-08-16T04:15:00.000Z')
const DIGEST = 'a'.repeat(64)

function initialLedgerJson(): string {
  return `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      schemaVersion: '1.0.0',
      version: 1,
      action: 'install',
      packageName: 'trust-demo',
      spec: 'trust-demo@1.2.3',
      passportDigest: DIGEST,
      profile: 'trust-test',
      installedAt: '2026-08-16T03:00:00.000Z',
    }],
  })}\n`
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-trust-disable-'))
}

async function setupProfile(home: string, profile: string, bundles: string[], withLedger = true): Promise<string> {
  const dir = profileDir(home, profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), profilePackageJson(bundles, {
    'trust-demo': '1.2.3',
    'other-pkg': '2.0.0',
  }))
  if (withLedger) await writeFile(join(dir, 'trust-ledger.json'), initialLedgerJson())
  return dir
}

function baseDisableOptions(dshPath: string, runner: CommandRunner, home: string): DisableOptions {
  return {
    home,
    profile: 'trust-test',
    dshPath,
    runner,
    now: NOW,
    bundle: {
      packageName: 'trust-demo',
      spec: 'trust-demo@1.2.3',
      passportDigest: DIGEST,
    },
  }
}

describe('disableBundle', () => {
  it('calls the official remove with exact args and affects only the named package', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])

      const result = await disableBundle(baseDisableOptions(fixture.dshPath, fixture.runner, home))

      expect(result.dryRun).toBe(false)
      expect(result.snapshotId).toBe('2026-08-16T04-15-00-000Z')
      expect(result.commands).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
        ['--profile', 'trust-test', '--dump-config'],
      ])
      expect(fixture.calls).toEqual(result.commands)

      const after = JSON.parse(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8'))
      expect(after.dsh.profile.bundles).toEqual(['other-pkg'])
      expect(after.dependencies).toEqual({ 'other-pkg': '2.0.0' })

      expect(await listSnapshots(home, profile)).toHaveLength(1)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('records the immutable spec in the ledger for exact re-enablement', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])

      const result = await disableBundle(baseDisableOptions(fixture.dshPath, fixture.runner, home))

      expect(result.ledgerEntry).toMatchObject({
        version: 2,
        action: 'remove',
        packageName: 'trust-demo',
        spec: 'trust-demo@1.2.3',
        passportDigest: DIGEST,
        profile: 'trust-test',
        installedAt: '2026-08-16T04:15:00.000Z',
      })

      const ledger = await loadLedger(join(profileDir(home, profile), 'trust-ledger.json'))
      expect(ledger.entries).toHaveLength(2)
      expect(ledger.entries[1]).toEqual(result.ledgerEntry)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a bundle that is not installed, without running any command', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      await setupProfile(home, 'trust-test', ['other-pkg'])

      await expect(disableBundle(baseDisableOptions(fixture.dshPath, fixture.runner, home)))
        .rejects.toThrow(/not installed/)
      expect(fixture.calls).toEqual([])
      await expect(readdir(join(home, 'snapshots'))).rejects.toThrow()
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('restores the snapshot, reinstalls the immutable spec, and propagates on remove failure', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      const originalLedger = await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')

      await expect(disableBundle({
        ...baseDisableOptions(fixture.dshPath, fixture.runner, home),
        env: { FAKE_DSH_FAIL_REMOVE: 'trust-demo' },
      })).rejects.toThrow(/remove failed/)

      // The failed remove was rolled back exactly, then the immutable spec
      // reinstalled so the bundle can never be left half-removed.
      expect(fixture.calls).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
        ['plugin', '--profile', 'trust-test', 'add', 'trust-demo@1.2.3'],
      ])
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(originalPackageJson)
      expect(await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')).toBe(originalLedger)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rolls back on config-dump failure after a successful remove', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      const originalLedger = await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')

      await expect(disableBundle({
        ...baseDisableOptions(fixture.dshPath, fixture.runner, home),
        env: { FAKE_DSH_FAIL_DUMP: '1' },
      })).rejects.toThrow(/dump-config failed/)

      expect(fixture.calls).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
        ['--profile', 'trust-test', '--dump-config'],
        ['plugin', '--profile', 'trust-test', 'add', 'trust-demo@1.2.3'],
      ])
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(originalPackageJson)
      expect(await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')).toBe(originalLedger)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('dry-run executes nothing and reports the exact commands', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      const originalLedger = await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')
      const runner: CommandRunner = async () => {
        throw new Error('dry-run must never execute a command')
      }

      const result = await disableBundle({
        ...baseDisableOptions('/unused/dsh', runner, home),
        dryRun: true,
      })

      expect(result.dryRun).toBe(true)
      expect(result.commands).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
        ['--profile', 'trust-test', '--dump-config'],
      ])
      expect(result.ledgerEntry.version).toBe(2)

      await expect(readdir(join(home, 'snapshots'))).rejects.toThrow()
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(originalPackageJson)
      expect(await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')).toBe(originalLedger)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects an invalid bundle name before any command', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      await setupProfile(home, 'trust-test', ['trust-demo'])
      await expect(disableBundle({
        ...baseDisableOptions(fixture.dshPath, fixture.runner, home),
        bundle: { packageName: '../evil', spec: 'x@1.0.0', passportDigest: DIGEST },
      })).rejects.toThrow(/invalid bundle name/)
      expect(fixture.calls).toEqual([])
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('reenableBundle', () => {
  it('reinstalls the exact immutable spec from the ledger', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])
      await disableBundle(baseDisableOptions(fixture.dshPath, fixture.runner, home))

      const result = await reenableBundle({
        home,
        profile,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        now: new Date('2026-08-16T05:00:00.000Z'),
        packageName: 'trust-demo',
      })

      expect(result.commands).toEqual([
        ['plugin', '--profile', 'trust-test', 'add', 'trust-demo@1.2.3'],
        ['--profile', 'trust-test', '--dump-config'],
      ])
      expect(result.ledgerEntry).toMatchObject({
        version: 3,
        action: 'install',
        spec: 'trust-demo@1.2.3',
        profile: 'trust-test',
      })

      const after = JSON.parse(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8'))
      expect(after.dsh.profile.bundles).toContain('trust-demo')
      expect(after.dependencies['trust-demo']).toBe('1.2.3')
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses re-enablement when no ledger record exists', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      await setupProfile(home, 'trust-test', ['trust-demo'], false)

      await expect(reenableBundle({
        home,
        profile: 'trust-test',
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        packageName: 'trust-demo',
      })).rejects.toThrow(/no ledger record/)
      expect(fixture.calls).toEqual([])
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rolls back when the reinstall add command fails', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'])
      await disableBundle(baseDisableOptions(fixture.dshPath, fixture.runner, home))
      const afterDisable = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')

      await expect(reenableBundle({
        home,
        profile,
        dshPath: fixture.dshPath,
        runner: (command, args, options) => fixture.runner(command, args, {
          ...options,
          env: { ...(options?.env ?? process.env), FAKE_DSH_FAIL_ADD: 'trust-demo' },
        }),
        now: new Date('2026-08-16T05:00:00.000Z'),
        packageName: 'trust-demo',
      })).rejects.toThrow(/add failed/)

      // Snapshot restore returns the profile to its disabled state.
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(afterDisable)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })
})
