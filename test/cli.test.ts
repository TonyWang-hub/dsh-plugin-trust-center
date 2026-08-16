import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDirectInvocation, runCli, type CliIo } from '../src/cli.js'
import type { Passport } from '../src/model.js'

function quarantinePassport(): Passport {
  return {
    schemaVersion: '1.0.0',
    subject: {
      kind: 'npm', source: 'npm:demo-bundle@1.2.3', resolved: 'npm:demo-bundle@1.2.3',
      digest: 'a'.repeat(64), name: 'demo-bundle', version: '1.2.3',
    },
    verdict: { status: 'pass' },
  } as Passport
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: text => stdout.push(text),
      stderr: text => stderr.push(text),
    },
  }
}

describe('runCli', () => {
  it('recognizes direct invocation through a filesystem symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-'))
    try {
      const target = join(root, 'cli.js')
      const link = join(root, 'dsh-trust')
      await writeFile(target, '')
      await symlink(target, link)

      expect(isDirectInvocation(link, pathToFileURL(await realpath(target)).href)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints a schema-valid JSON passport and returns the verdict exit code', async () => {
    const output = capture()

    const code = await runCli([
      'inspect',
      'test/fixtures/safe-bundle',
      '--format',
      'json',
    ], output.io)

    expect(code).toBe(0)
    expect(output.stderr).toEqual([])
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      schemaVersion: '1.0.0',
      verdict: { status: 'pass' },
    })
  })

  it('writes SARIF and returns 2 for a review verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-output-'))
    try {
      const path = join(root, 'report.sarif')
      const output = capture()
      const code = await runCli([
        'inspect',
        'test/fixtures/risky-bundle',
        '--format',
        'sarif',
        '--output',
        path,
      ], output.io)

      expect(code).toBe(2)
      expect(output.stdout).toEqual([])
      expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('2.1.0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes JSON and returns 3 for a fail verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-output-'))
    try {
      const path = join(root, 'passport.json')
      const output = capture()
      const code = await runCli([
        'inspect',
        'test/fixtures/invalid-bundle',
        '--format',
        'json',
        '--output',
        path,
      ], output.io)

      expect(code).toBe(3)
      expect(JSON.parse(await readFile(path, 'utf8')).verdict.status).toBe('fail')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints the normative schema without inspecting a package', async () => {
    const output = capture()

    const code = await runCli(['schema'], output.io)

    expect(code).toBe(0)
    expect(JSON.parse(output.stdout.join('')).$id).toContain('passport.schema.json')
  })

  it('lists stable rules for external tooling', async () => {
    const output = capture()

    const code = await runCli(['rules'], output.io)

    expect(code).toBe(0)
    expect(JSON.parse(output.stdout.join(''))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'DSH-SCRIPT-001' }),
    ]))
  })

  it('lists profiles and snapshots without exposing the DSH home path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-profile-'))
    try {
      await mkdir(join(home, 'profiles', 'work'), { recursive: true })
      await writeFile(join(home, 'profiles', 'work', 'package.json'), JSON.stringify({
        dsh: { profile: { bundles: ['bundle-b', 'bundle-a'] } },
      }))
      await mkdir(join(home, 'snapshots', 'work', 'snapshot-1', 'files'), { recursive: true })
      await writeFile(join(home, 'snapshots', 'work', 'snapshot-1', 'manifest.json'), JSON.stringify({
        schemaVersion: '1.0.0', snapshotId: 'snapshot-1', profile: 'work',
        createdAt: '2026-08-16T00:00:00.000Z', retention: 5, files: {},
      }))
      const output = capture()

      const code = await runCli(['profile', 'list'], output.io, { home })

      expect(code).toBe(0)
      const text = output.stdout.join('')
      expect(JSON.parse(text)).toEqual({
        profiles: [{ name: 'work', bundles: ['bundle-a', 'bundle-b'], snapshots: ['snapshot-1'] }],
      })
      expect(text).not.toContain(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('captures and reports an explicit profile snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-snapshot-'))
    try {
      await mkdir(join(home, 'profiles', 'work'), { recursive: true })
      await writeFile(join(home, 'profiles', 'work', 'package.json'), '{"name":"work"}\n')
      const output = capture()

      const code = await runCli(['profile', 'snapshot', 'work'], output.io, {
        home,
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      })

      expect(code).toBe(0)
      expect(JSON.parse(output.stdout.join(''))).toEqual({
        profile: 'work', snapshotId: '2026-08-16T00-00-00-000Z',
      })
      expect(await readFile(join(home, 'snapshots', 'work', '2026-08-16T00-00-00-000Z', 'files', 'package.json'), 'utf8'))
        .toBe('{"name":"work"}\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('plans profile restore without mutation on dry run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-restore-'))
    try {
      const profileRoot = join(home, 'profiles', 'work')
      await mkdir(profileRoot, { recursive: true })
      const path = join(profileRoot, 'package.json')
      await writeFile(path, '{"state":"before"}\n')
      await runCli(['profile', 'snapshot', 'work'], capture().io, {
        home,
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      })
      await writeFile(path, '{"state":"after"}\n')
      const output = capture()

      const code = await runCli([
        'profile', 'restore', 'work', '2026-08-16T00-00-00-000Z', '--dry-run',
      ], output.io, { home })

      expect(code).toBe(0)
      expect(JSON.parse(output.stdout.join(''))).toEqual({
        dryRun: true,
        profile: 'work',
        snapshotId: '2026-08-16T00-00-00-000Z',
        files: ['package.json'],
        rollbackSnapshotId: null,
        commands: [['--profile', 'work', '--dump-config']],
      })
      expect(await readFile(path, 'utf8')).toBe('{"state":"after"}\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('plans official profile disable from the immutable ledger on dry run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-disable-'))
    try {
      const root = join(home, 'profiles', 'work')
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'package.json'), JSON.stringify({
        dsh: { profile: { bundles: ['demo-bundle'] } },
        dependencies: { 'demo-bundle': '1.2.3' },
      }))
      await writeFile(join(root, 'trust-ledger.json'), JSON.stringify({
        schemaVersion: '1.0.0',
        entries: [{
          schemaVersion: '1.0.0', version: 1, action: 'install', packageName: 'demo-bundle',
          spec: 'demo-bundle@1.2.3', passportDigest: 'a'.repeat(64), profile: 'work',
          installedAt: '2026-08-15T00:00:00.000Z',
        }],
      }))
      const output = capture()
      let commands = 0

      const code = await runCli([
        'profile', 'disable', 'work', 'demo-bundle', '--dry-run',
      ], output.io, {
        home,
        dshPath: '/absolute/dsh',
        runner: async () => { commands += 1; return { exitCode: 0, stdout: '', stderr: '' } },
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      })

      expect(code).toBe(0)
      expect(commands).toBe(0)
      expect(JSON.parse(output.stdout.join(''))).toMatchObject({
        dryRun: true,
        commands: [
          ['plugin', '--profile', 'work', 'remove', 'demo-bundle'],
          ['--profile', 'work', '--dump-config'],
        ],
        ledgerEntry: { spec: 'demo-bundle@1.2.3', passportDigest: 'a'.repeat(64) },
      })
      expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual(['demo-bundle'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('installs quarantine evidence for an explicit target through injected official commands', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-quarantine-'))
    const isolated = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-isolated-'))
    try {
      const calls: string[][] = []
      const output = capture()
      const code = await runCli([
        'quarantine', 'install', 'npm:demo-bundle@1.2.3', '--target', 'work',
      ], output.io, {
        home,
        inspect: async () => quarantinePassport(),
        runner: async (_command, args) => {
          calls.push(args)
          return { exitCode: 0, stdout: '{}', stderr: '' }
        },
        dshPath: '/absolute/dsh',
        makeTempHome: async () => isolated,
        id: () => 'q-cli',
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      })

      expect(code).toBe(0)
      expect(calls).toEqual([
        ['plugin', '--profile', 'trust-quarantine-q-cli', 'add', 'demo-bundle@1.2.3'],
        ['--profile', 'trust-quarantine-q-cli', '--dump-config'],
      ])
      expect(JSON.parse(output.stdout.join('')).receipt).toMatchObject({
        id: 'q-cli', targetProfile: 'work', installSpec: 'demo-bundle@1.2.3', executed: false,
      })
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(isolated, { recursive: true, force: true })
    }
  })

  it('plans target-bound quarantine promotion without mutation on dry run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-promote-'))
    const isolated = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-promote-isolated-'))
    try {
      const dependencies = {
        home,
        inspect: async () => quarantinePassport(),
        runner: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
        dshPath: '/absolute/dsh',
        makeTempHome: async () => isolated,
        id: () => 'q-promote',
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      }
      expect(await runCli([
        'quarantine', 'install', 'npm:demo-bundle@1.2.3', '--target', 'work',
      ], capture().io, dependencies)).toBe(0)
      const output = capture()

      const code = await runCli([
        'quarantine', 'promote', 'q-promote', '--target', 'work', '--dry-run',
      ], output.io, dependencies)

      expect(code).toBe(0)
      expect(JSON.parse(output.stdout.join(''))).toEqual({
        profile: 'work', snapshotId: null, installSpec: 'demo-bundle@1.2.3', dryRun: true,
        commands: [
          ['dsh', 'plugin', '--profile', 'work', 'add', 'demo-bundle@1.2.3'],
          ['dsh', '--profile', 'work', '--dump-config'],
        ],
      })
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(isolated, { recursive: true, force: true })
    }
  })

  it('reports an incomplete promotion rollback when official remove fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-promote-rollback-'))
    const isolated = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-promote-rollback-isolated-'))
    try {
      const baseDependencies = {
        home,
        inspect: async () => quarantinePassport(),
        dshPath: '/absolute/dsh',
        makeTempHome: async () => isolated,
        id: () => 'q-rollback',
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      }
      expect(await runCli([
        'quarantine', 'install', 'npm:demo-bundle@1.2.3', '--target', 'work',
      ], capture().io, {
        ...baseDependencies,
        runner: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }),
      })).toBe(0)
      const profileRoot = join(home, 'profiles', 'work')
      const original = `${JSON.stringify({
        name: 'work', version: '0.0.0', dependencies: {}, dsh: { profile: { bundles: [] } },
      }, null, 2)}\n`
      await mkdir(profileRoot, { recursive: true })
      await writeFile(join(profileRoot, 'package.json'), original)
      const calls: string[][] = []
      const output = capture()

      const code = await runCli([
        'quarantine', 'promote', 'q-rollback', '--target', 'work',
      ], output.io, {
        ...baseDependencies,
        runner: async (_command, args) => {
          calls.push(args)
          if (args.includes('add')) return { exitCode: 1, stdout: '', stderr: 'add failed' }
          if (args.includes('remove')) return { exitCode: 1, stdout: '', stderr: 'remove failed' }
          return { exitCode: 0, stdout: '{}', stderr: '' }
        },
      })

      expect(code).toBe(1)
      expect(calls).toEqual([
        ['plugin', '--profile', 'work', 'add', 'demo-bundle@1.2.3'],
        ['plugin', '--profile', 'work', 'remove', 'demo-bundle'],
      ])
      expect(output.stderr.join('')).toContain('rollback was incomplete')
      expect(await readFile(join(profileRoot, 'package.json'), 'utf8')).toBe(original)
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(isolated, { recursive: true, force: true })
    }
  })

  it('returns an operational error without a stack or environment disclosure', async () => {
    const output = capture()

    const code = await runCli(['inspect', 'test/fixtures/does-not-exist'], output.io)

    expect(code).toBe(1)
    expect(output.stdout).toEqual([])
    expect(output.stderr.join('')).toContain('inspection failed')
    expect(output.stderr.join('')).not.toContain('node:internal')
  })
})
