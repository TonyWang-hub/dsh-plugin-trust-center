import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEDGER_SCHEMA_VERSION, loadLedger } from '../src/profile/ledger.js'
import { profileDir } from '../src/profile/paths.js'
import { CommandFailedError, dshRunOptions, runMutation } from '../src/profile/transaction.js'
import type { MutationApi } from '../src/profile/transaction.js'
import { dshRemoveCommand } from '../src/profile/runner.js'
import { listSnapshots } from '../src/profile/snapshot.js'
import { installFakeDsh, profilePackageJson } from './profile-helpers.js'
import type { CommandRunner } from '../src/profile/runner.js'

const NOW = new Date('2026-08-16T04:15:00.000Z')
const NOW_ISO = '2026-08-16T04:15:00.000Z'

function initialLedgerJson(spec: string, digest = 'a'.repeat(64)): string {
  return `${JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [{
      schemaVersion: '1.0.0',
      version: 1,
      action: 'install',
      packageName: 'trust-demo',
      spec,
      passportDigest: digest,
      profile: 'trust-test',
      installedAt: '2026-08-16T03:00:00.000Z',
    }],
  })}\n`
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-trust-transaction-'))
}

async function setupProfile(home: string, profile: string, bundles: string[], ledgerText: string): Promise<string> {
  const dir = profileDir(home, profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), profilePackageJson(bundles, {
    'trust-demo': '1.2.3',
    'other-pkg': '2.0.0',
  }))
  await writeFile(join(dir, 'trust-ledger.json'), ledgerText)
  return dir
}

async function removeSteps(api: MutationApi): Promise<void> {
  await api.appendLedger({
    action: 'remove',
    packageName: 'trust-demo',
    spec: 'trust-demo@1.2.3',
    passportDigest: 'a'.repeat(64),
    profile: 'trust-test',
  })
  await api.exec(dshRemoveCommand('trust-test', 'trust-demo'))
}

describe('runMutation', () => {
  it('pins DSH_HOME after merging injected environment values', () => {
    const options = dshRunOptions('/safe/dsh-home', {
      DSH_HOME: '/attacker/home', CUSTOM: 'kept', npm_config_ignore_scripts: 'false',
    })
    expect(options.env?.DSH_HOME).toBe('/safe/dsh-home')
    expect(options.env?.CUSTOM).toBe('kept')
    expect(options.env?.npm_config_ignore_scripts).toBe('true')
    expect(options.env?.PNPM_CONFIG_IGNORE_SCRIPTS).toBe('true')
  })

  it('captures a pre snapshot, runs steps, records commands, and validates config', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'], initialLedgerJson('trust-demo@1.2.3'))
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      let rollbackCalled = false

      const summary = await runMutation({
        home,
        profile,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        now: NOW,
        rollback: async () => { rollbackCalled = true },
      }, removeSteps)

      expect(summary.dryRun).toBe(false)
      expect(summary.snapshotId).toBe('2026-08-16T04-15-00-000Z')
      expect(summary.commands).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
        ['--profile', 'trust-test', '--dump-config'],
      ])
      expect(fixture.calls).toEqual(summary.commands)
      expect(rollbackCalled).toBe(false)

      // Pre-mutation snapshot exists.
      const snapshots = await listSnapshots(home, profile)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.snapshotId).toBe('2026-08-16T04-15-00-000Z')

      // Official remove touched only the named package.
      const after = JSON.parse(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8'))
      expect(after.dsh.profile.bundles).toEqual(['other-pkg'])
      expect(after.dependencies).toEqual({ 'other-pkg': '2.0.0' })
      expect(after).not.toEqual(JSON.parse(originalPackageJson))

      // Ledger entry appended with the immutable spec, 0600 mode.
      const ledger = await loadLedger(join(profileDir(home, profile), 'trust-ledger.json'))
      expect(ledger.entries).toHaveLength(2)
      expect(ledger.entries[1]).toMatchObject({
        version: 2,
        action: 'remove',
        packageName: 'trust-demo',
        spec: 'trust-demo@1.2.3',
        profile: 'trust-test',
      })
      expect((await stat(join(profileDir(home, profile), 'trust-ledger.json'))).mode & 0o777).toBe(0o600)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rolls back the snapshot and runs the rollback hook when dump-config fails', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'], initialLedgerJson('trust-demo@1.2.3'))
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      const originalLedger = await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')
      let rollbackCalled = false

      let thrown: unknown
      try {
        await runMutation({
          home,
          profile,
          dshPath: fixture.dshPath,
          runner: (command, args, options) => fixture.runner(command, args, {
            ...options,
            env: { ...(options?.env ?? process.env), FAKE_DSH_FAIL_DUMP: '1' },
          }),
          now: NOW,
          rollback: async () => { rollbackCalled = true },
        }, removeSteps)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(CommandFailedError)
      if (thrown instanceof CommandFailedError) {
        expect(thrown.args).toEqual(['--profile', 'trust-test', '--dump-config'])
        expect(thrown.result.exitCode).toBe(1)
      }
      expect(rollbackCalled).toBe(true)

      // Exact snapshot restore: profile files and ledger are byte-identical.
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(originalPackageJson)
      expect(await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')).toBe(originalLedger)
      // Pre-mutation snapshot retained as the failure record.
      expect(await listSnapshots(home, profile)).toHaveLength(1)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('preserves the original failure when the rollback hook also fails', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo'], initialLedgerJson('trust-demo@1.2.3'))

      let thrown: unknown
      try {
        await runMutation({
          home,
          profile,
          dshPath: fixture.dshPath,
          runner: (command, args, options) => fixture.runner(command, args, {
            ...options,
            env: { ...(options?.env ?? process.env), FAKE_DSH_FAIL_DUMP: '1' },
          }),
          now: NOW,
          rollback: async () => { throw new Error('rollback hook failed') },
        }, removeSteps)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(AggregateError)
      if (thrown instanceof AggregateError) {
        expect(thrown.errors).toHaveLength(2)
        expect(thrown.errors[0]).toBeInstanceOf(CommandFailedError)
        expect(thrown.errors[1]).toMatchObject({ message: 'rollback hook failed' })
        expect(thrown.cause).toBe(thrown.errors[0])
      }
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rolls back when a step command exits nonzero after mutating', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'], initialLedgerJson('trust-demo@1.2.3'))
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      const originalLedger = await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')

      let thrown: unknown
      try {
        await runMutation({
          home,
          profile,
          dshPath: fixture.dshPath,
          runner: (command, args, options) => fixture.runner(command, args, {
            ...options,
            env: { ...(options?.env ?? process.env), FAKE_DSH_FAIL_REMOVE: 'trust-demo' },
          }),
          now: NOW,
        }, removeSteps)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(CommandFailedError)
      if (thrown instanceof CommandFailedError) {
        expect(thrown.args).toEqual(['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'])
      }
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(originalPackageJson)
      expect(await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')).toBe(originalLedger)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('dry-run executes nothing and reports the exact plan', async () => {
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'], initialLedgerJson('trust-demo@1.2.3'))
      const originalPackageJson = await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')
      const runner: CommandRunner = async () => {
        throw new Error('dry-run must never execute a command')
      }

      const summary = await runMutation({
        home,
        profile,
        dshPath: '/unused/dsh',
        runner,
        now: NOW,
        dryRun: true,
      }, removeSteps)

      expect(summary.dryRun).toBe(true)
      expect(summary.snapshotId).toBe('2026-08-16T04-15-00-000Z')
      expect(summary.commands).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
        ['--profile', 'trust-test', '--dump-config'],
      ])

      // Nothing was written and nothing was executed.
      await expect(readdir(join(home, 'snapshots'))).rejects.toThrow()
      expect(await readFile(join(profileDir(home, profile), 'package.json'), 'utf8')).toBe(originalPackageJson)
      expect(await readFile(join(profileDir(home, profile), 'trust-ledger.json'), 'utf8')).toBe(initialLedgerJson('trust-demo@1.2.3'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects an invalid profile before any command or snapshot', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      let called = false
      const runner: CommandRunner = async () => {
        called = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      await expect(runMutation({
        home,
        profile: '../escape',
        dshPath: fixture.dshPath,
        runner,
      }, removeSteps)).rejects.toThrow(/invalid profile name/)

      expect(called).toBe(false)
      await expect(readdir(join(home, 'snapshots'))).rejects.toThrow()
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('skips config validation when explicitly disabled', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo', 'other-pkg'], initialLedgerJson('trust-demo@1.2.3'))

      const summary = await runMutation({
        home,
        profile,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        now: NOW,
        validateConfig: false,
      }, removeSteps)

      expect(summary.commands).toEqual([
        ['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'],
      ])
      expect(fixture.calls).toEqual(summary.commands)
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('records a deterministic ledger entry through the mutation api', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const profile = 'trust-test'
      await setupProfile(home, profile, ['trust-demo'], initialLedgerJson('trust-demo@1.2.3'))

      let entry: unknown
      await runMutation({
        home,
        profile,
        dshPath: fixture.dshPath,
        runner: fixture.runner,
        now: NOW,
      }, async api => {
        entry = await api.appendLedger({
          action: 'remove',
          packageName: 'trust-demo',
          spec: 'trust-demo@1.2.3',
          passportDigest: 'a'.repeat(64),
          profile: 'trust-test',
        })
      })

      expect(entry).toMatchObject({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        version: 2,
        action: 'remove',
        installedAt: NOW_ISO,
        profile: 'trust-test',
      })
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })
})
