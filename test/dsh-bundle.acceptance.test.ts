import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { t as listTar } from 'tar'
import { captureSnapshot } from '../src/profile/snapshot.js'
import { restoreProfile } from '../src/profile/restore.js'
import { runCommand } from '../src/profile/runner.js'
import { installQuarantine } from '../src/quarantine.js'
import type { Passport } from '../src/model.js'

const runReal = process.env.DSH_REAL_BUNDLE === '1'

interface Result {
  code: number
  stdout: string
  stderr: string
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000): Promise<Result> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      clearTimeout(timer)
      resolveResult({ code: code ?? 1, stdout, stderr })
    })
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe.skipIf(!runReal)('packed DSH bundle acceptance', () => {
  it('adds the packed bundle to pinned official DSH and composes dump-config without changing DSH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-real-bundle-'))
    const home = join(root, 'home')
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
    const officialManifestPath = resolve('node_modules/@deepseek-ai/dsh/package.json')
    const before = sha256(await readFile(officialManifestPath, 'utf8'))
    try {
      const pack = await run('pnpm', ['pack', '--pack-destination', root], process.env)
      expect(pack.code, pack.stderr).toBe(0)
      const tarball = join(root, `dsh-plugin-trust-center-${manifest.version}.tgz`)
      const entries: string[] = []
      await listTar({ file: tarball, onentry: entry => { entries.push(entry.path) } })
      expect(entries).toEqual(expect.arrayContaining([
        'package/package.json',
        'package/cordis.patch.yml',
        'package/dist/plugin.js',
        'package/dist/plugin.d.ts',
      ]))
      expect(entries.some(entry => entry.startsWith('package/src/')
        || entry.startsWith('package/test/')
        || entry.startsWith('package/.github/')
        || entry.startsWith('package/dogfood-artifacts/'))).toBe(false)
      const env = {
        ...process.env,
        DSH_HOME: home,
        npm_config_ignore_scripts: 'true',
        PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
        CI: '1',
      }
      const added = await run(resolve('node_modules/.bin/dsh'), [
        'plugin', '--profile', 'trust-test', 'add', tarball,
      ], env)
      expect(added.code, `${added.stdout}\n${added.stderr}`).toBe(0)

      const dumped = await run(resolve('node_modules/.bin/dsh'), [
        '--profile', 'trust-test', '--dump-config',
      ], env)
      expect(dumped.code, `${dumped.stdout}\n${dumped.stderr}`).toBe(0)
      expect(dumped.stderr).toBe('')
      expect(dumped.stdout).toContain('dsh-plugin-trust-center')

      const snapshotId = await captureSnapshot({
        home,
        profile: 'trust-test',
        now: new Date('2026-08-16T00:00:00.000Z'),
      })
      const restorePlan = await restoreProfile({
        home,
        profile: 'trust-test',
        snapshotId,
        dshPath: resolve('node_modules/.bin/dsh'),
        runner: runCommand,
        dryRun: true,
      })
      expect(restorePlan.commands).toEqual([['--profile', 'trust-test', '--dump-config']])

      const quarantineHome = join(root, 'quarantine-home')
      const quarantined = await installQuarantine('npm:@deepseek-ai/dsh@0.1.0-rc.6', {
        inspect: async () => ({
          subject: {
            kind: 'npm',
            source: 'npm:@deepseek-ai/dsh@0.1.0-rc.6',
            resolved: 'npm:@deepseek-ai/dsh@0.1.0-rc.6',
            digest: 'b'.repeat(64),
            name: '@deepseek-ai/dsh',
            version: '0.1.0-rc.6',
          },
          verdict: { status: 'pass' },
        } as Passport),
        run: async command => {
          const result = await runCommand(resolve('node_modules/.bin/dsh'), command.args, {
            env: { ...process.env, ...command.env },
            timeoutMs: command.timeoutMs,
          })
          return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
        },
        makeTempHome: async () => { await mkdir(quarantineHome, { recursive: true }); return quarantineHome },
        receiptRoot: join(root, 'receipts'),
        id: () => 'real-dsh',
        now: () => '2026-08-16T00:00:00.000Z',
        targetProfile: 'trust-test',
      })
      expect(quarantined.receipt.installSpec).toBe('@deepseek-ai/dsh@0.1.0-rc.6')
      await expect(stat(quarantineHome)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(sha256(await readFile(officialManifestPath, 'utf8'))).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
