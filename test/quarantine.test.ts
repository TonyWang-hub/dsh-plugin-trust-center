import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Passport, VerdictStatus } from '../src/model.js'
import { installQuarantine, promoteQuarantine } from '../src/quarantine.js'
import { canonicalJson } from '../src/passport.js'

const temporaryRoots: string[] = []

function passport(status: VerdictStatus, resolved = 'npm:@scope/plugin@1.2.3'): Passport {
  return {
    schemaVersion: '1.0.0',
    subject: {
      kind: 'npm',
      source: 'npm:@scope/plugin@1.2.3',
      resolved,
      digest: 'a'.repeat(64),
      name: '@scope/plugin',
      version: '1.2.3',
    },
    dsh: { bundle: { patch: 'cordis.patch.yml', exists: true } },
    scripts: {},
    dependencies: { runtime: {}, optional: {}, peer: {}, dev: {} },
    findings: [],
    sbom: {
      bomFormat: 'CycloneDX', specVersion: '1.6',
      version: 1, metadata: { component: { type: 'library', name: '@scope/plugin', version: '1.2.3', purl: 'pkg:npm/%40scope%2Fplugin@1.2.3' } },
      components: [], dependencies: [{ ref: 'pkg:npm/%40scope%2Fplugin@1.2.3', dependsOn: [] }],
    },
    compatibility: { method: 'declaration-only', dynamicImportVerified: false },
    verdict: { status },
  }
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-trust-quarantine-test-'))
  temporaryRoots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('installQuarantine', () => {
  it('refuses a failed Passport before creating a profile or running DSH', async () => {
    let commands = 0
    let homes = 0

    await expect(installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('fail'),
      run: async () => { commands += 1; return { code: 0, stdout: '', stderr: '' } },
      makeTempHome: async () => { homes += 1; return root() },
      receiptRoot: await root(),
      id: () => 'q1',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })).rejects.toThrow('failed Passport')

    expect(commands).toBe(0)
    expect(homes).toBe(0)
  })

  it('rejects an unsafe quarantine id before any profile mutation', async () => {
    let commands = 0
    let homes = 0
    await expect(installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => { commands += 1; return { code: 0, stdout: '', stderr: '' } },
      makeTempHome: async () => { homes += 1; return root() },
      receiptRoot: await root(),
      id: () => '../../escape',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })).rejects.toThrow('invalid quarantine id')
    expect(commands).toBe(0)
    expect(homes).toBe(0)
  })

  it('refuses a symlinked receipt root before running official commands', async () => {
    const container = await root()
    const outside = await root()
    const receiptRoot = join(container, 'receipts')
    await symlink(outside, receiptRoot)
    let commands = 0

    await expect(installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => { commands += 1; return { code: 0, stdout: '', stderr: '' } },
      makeTempHome: root,
      receiptRoot,
      id: () => 'q-link',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })).rejects.toThrow('symbolic link')

    expect(commands).toBe(0)
    expect(await readdir(outside)).toEqual([])
  })

  it('executes dynamic verification only behind the explicit allow gate', async () => {
    const receiptRoot = await root()
    const isolatedHome = await root()
    const verified: string[] = []
    const result = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
      makeTempHome: async () => isolatedHome,
      receiptRoot,
      id: () => 'q-exec',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
      allowExecute: true,
      verifyDynamic: async source => { verified.push(source) },
    })

    expect(verified).toEqual(['npm:@scope/plugin@1.2.3'])
    expect(result.receipt.executed).toBe(true)
  })

  it('installs an immutable spec in an isolated profile with scripts disabled and writes a digest receipt', async () => {
    const receiptRoot = await root()
    const isolatedHome = await root()
    const commands: Array<{ command: string; args: string[]; env: Record<string, string> }> = []

    const result = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('review'),
      run: async command => {
        commands.push(command)
        return { code: 0, stdout: '{}', stderr: 'dsh: initialized profile trust-quarantine-q1\n' }
      },
      makeTempHome: async () => isolatedHome,
      receiptRoot,
      id: () => 'q1',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })

    expect(commands.map(command => [command.command, command.args])).toEqual([
      ['dsh', ['plugin', '--profile', 'trust-quarantine-q1', 'add', '@scope/plugin@1.2.3']],
      ['dsh', ['--profile', 'trust-quarantine-q1', '--dump-config']],
    ])
    expect(commands.every(command => command.env.DSH_HOME === isolatedHome)).toBe(true)
    expect(commands[0]?.env.npm_config_ignore_scripts).toBe('true')
    expect(commands[0]?.env.PNPM_CONFIG_IGNORE_SCRIPTS).toBe('true')
    expect(result.receipt).toMatchObject({
      schemaVersion: '1.0.0',
      id: 'q1',
      quarantineProfile: 'trust-quarantine-q1',
      targetProfile: 'work',
      source: 'npm:@scope/plugin@1.2.3',
      immutableSource: 'npm:@scope/plugin@1.2.3',
      installSpec: '@scope/plugin@1.2.3',
      packageName: '@scope/plugin',
      passportDigest: 'a'.repeat(64),
      verdict: 'review',
      executed: false,
      createdAt: '2026-08-16T00:00:00.000Z',
    })
    expect(result.receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(result.receiptPath, 'utf8'))).toEqual(result.receipt)
    expect((await stat(result.receiptPath)).mode & 0o777).toBe(0o600)
    await expect(stat(isolatedHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('promoteQuarantine', () => {
  it('re-inspects the immutable source, snapshots the target, and promotes with official commands', async () => {
    const receiptRoot = await root()
    const installed = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
      makeTempHome: root,
      receiptRoot,
      id: () => 'promote',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })
    const events: string[] = []
    const commands: Array<{ command: string; args: string[]; env: Record<string, string> }> = []
    const targetHome = await root()

    const result = await promoteQuarantine(installed.receiptPath, 'work', {
      inspect: async source => { events.push(`inspect:${source}`); return passport('pass') },
      snapshotTarget: async profile => { events.push(`snapshot:${profile}`); return 'snapshot-1' },
      restoreTarget: async () => { throw new Error('unexpected restore') },
      recordInstall: async (profile, receipt) => { events.push(`ledger:${profile}:${receipt.installSpec}`) },
      run: async command => {
        events.push(`run:${command.args.join(' ')}`)
        commands.push(command)
        return { code: 0, stdout: '{}', stderr: '' }
      },
      dshHome: targetHome,
    })

    expect(events).toEqual([
      'inspect:npm:@scope/plugin@1.2.3',
      'snapshot:work',
      'run:plugin --profile work add @scope/plugin@1.2.3',
      'run:--profile work --dump-config',
      'ledger:work:@scope/plugin@1.2.3',
    ])
    expect(commands.every(command => command.env.DSH_HOME === targetHome)).toBe(true)
    expect(commands[0]?.env.npm_config_ignore_scripts).toBe('true')
    expect(result).toEqual({
      profile: 'work',
      snapshotId: 'snapshot-1',
      installSpec: '@scope/plugin@1.2.3',
      dryRun: false,
      commands: [
        ['dsh', 'plugin', '--profile', 'work', 'add', '@scope/plugin@1.2.3'],
        ['dsh', '--profile', 'work', '--dump-config'],
      ],
    })
  })

  it('returns the exact promotion plan without snapshotting or mutating on dry run', async () => {
    const installed = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
      makeTempHome: root,
      receiptRoot: await root(),
      id: () => 'dry-run',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })
    let mutations = 0

    const result = await promoteQuarantine(installed.receiptPath, 'work', {
      inspect: async () => passport('pass'),
      snapshotTarget: async () => { mutations += 1; return 'unexpected' },
      restoreTarget: async () => { mutations += 1 },
      recordInstall: async () => { mutations += 1 },
      run: async () => { mutations += 1; return { code: 0, stdout: '', stderr: '' } },
      dshHome: await root(),
      dryRun: true,
    })

    expect(mutations).toBe(0)
    expect(result).toEqual({
      profile: 'work',
      snapshotId: null,
      installSpec: '@scope/plugin@1.2.3',
      dryRun: true,
      commands: [
        ['dsh', 'plugin', '--profile', 'work', 'add', '@scope/plugin@1.2.3'],
        ['dsh', '--profile', 'work', '--dump-config'],
      ],
    })
  })

  it('restores the target snapshot when an official promotion command fails', async () => {
    const installed = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
      makeTempHome: root,
      receiptRoot: await root(),
      id: () => 'rollback',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })
    const events: string[] = []

    await expect(promoteQuarantine(installed.receiptPath, 'work', {
      inspect: async () => passport('pass'),
      snapshotTarget: async () => { events.push('snapshot'); return 'snapshot-1' },
      restoreTarget: async (profile, snapshotId) => { events.push(`restore:${profile}:${snapshotId}`) },
      recordInstall: async () => { events.push('unexpected-ledger') },
      run: async () => { events.push('run'); return { code: 9, stdout: '', stderr: 'failed' } },
      dshHome: await root(),
    })).rejects.toThrow('exit 9')

    expect(events).toEqual(['snapshot', 'run', 'restore:work:snapshot-1'])
  })

  it('refuses a recomputed receipt whose install spec disagrees with its immutable source', async () => {
    const installed = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
      makeTempHome: root,
      receiptRoot: await root(),
      id: () => 'inconsistent',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })
    const { receiptDigest: _oldDigest, ...unsigned } = installed.receipt
    const changed = { ...unsigned, installSpec: 'attacker@9.9.9' }
    const recomputed = {
      ...changed,
      receiptDigest: createHash('sha256').update(canonicalJson(changed)).digest('hex'),
    }
    await writeFile(installed.receiptPath, JSON.stringify(recomputed), 'utf8')
    let activity = 0

    await expect(promoteQuarantine(installed.receiptPath, 'work', {
      inspect: async () => { activity += 1; return passport('pass') },
      run: async () => { activity += 1; return { code: 0, stdout: '', stderr: '' } },
      snapshotTarget: async () => { activity += 1; return 'snapshot-1' },
      restoreTarget: async () => { activity += 1 },
      recordInstall: async () => { activity += 1 },
      dshHome: await root(),
    })).rejects.toThrow('inconsistent quarantine receipt')
    expect(activity).toBe(0)
  })

  it('refuses a tampered receipt before inspection, snapshot, or mutation', async () => {
    const receiptRoot = await root()
    const installed = await installQuarantine('npm:@scope/plugin@1.2.3', {
      inspect: async () => passport('pass'),
      run: async () => ({ code: 0, stdout: '{}', stderr: '' }),
      makeTempHome: root,
      receiptRoot,
      id: () => 'tamper',
      now: () => '2026-08-16T00:00:00.000Z',
      targetProfile: 'work',
    })
    const tampered = { ...installed.receipt, installSpec: 'attacker@9.9.9' }
    await writeFile(installed.receiptPath, JSON.stringify(tampered), 'utf8')
    let activity = 0

    await expect(promoteQuarantine(installed.receiptPath, 'target', {
      inspect: async () => { activity += 1; return passport('pass') },
      run: async () => { activity += 1; return { code: 0, stdout: '', stderr: '' } },
      snapshotTarget: async () => { activity += 1; return 'snapshot-1' },
      restoreTarget: async () => { activity += 1 },
      recordInstall: async () => { activity += 1 },
      dshHome: await root(),
    })).rejects.toThrow('receipt digest mismatch')
    expect(activity).toBe(0)
  })
})
