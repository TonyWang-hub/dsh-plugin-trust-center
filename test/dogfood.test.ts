import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dogfoodOptionsFromEnvironment, runDogfood } from '../src/dogfood.js'
import type { CommandRunner } from '../src/profile/runner.js'

const temporaryRoots: string[] = []
const SOURCE = 'github:BotonJ/dsh-plugin-sentinel#3dcff7a125d7151f2b75a8962c65425d0d9aa0b8'

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-trust-dogfood-'))
  temporaryRoots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('bounded dogfood orchestration', () => {
  it('derives a deterministic CLI configuration from pnpm environment metadata', () => {
    expect(dogfoodOptionsFromEnvironment('/repo', {
      npm_execpath: '/absolute/pnpm.cjs',
      DSH_DOGFOOD_ARTIFACTS: '/artifacts',
    }, '/absolute/node')).toEqual({
      cwd: '/repo',
      registryPath: '/repo/registry/sources.json',
      artifactsDirectory: '/artifacts',
      sourceSlug: 'dsh-plugin-sentinel',
      dshPath: '/repo/node_modules/.bin/dsh',
      nodePath: '/absolute/node',
      packageManagerPath: '/absolute/pnpm.cjs',
    })
  })

  it('removes its temporary root when artifact-directory setup fails', async () => {
    const cwd = await root()
    const temporaryRoot = await root()
    const registryPath = join(cwd, 'sources.json')
    const artifactsFile = join(cwd, 'not-a-directory')
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: '1.0.0',
      sources: [{
        slug: 'dsh-plugin-sentinel', source: SOURCE, name: 'Sentinel',
        category: 'security-observability', testedDshVersions: [],
      }],
    }))
    await writeFile(artifactsFile, 'occupied')

    await expect(runDogfood({
      cwd,
      registryPath,
      artifactsDirectory: artifactsFile,
      sourceSlug: 'dsh-plugin-sentinel',
      dshPath: '/absolute/dsh',
      nodePath: '/absolute/node',
      packageManagerPath: '/absolute/pnpm.cjs',
      makeTemporaryRoot: async () => temporaryRoot,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })).rejects.toThrow()

    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the immutable registry source without dynamically executing community code', async () => {
    const cwd = await root()
    const registryPath = join(cwd, 'sources.json')
    const artifactsDirectory = join(cwd, 'artifacts')
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: '1.0.0',
      sources: [{
        slug: 'dsh-plugin-sentinel', source: SOURCE, name: 'Sentinel',
        category: 'security-observability', testedDshVersions: [],
      }],
    }))
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = []
    const run: CommandRunner = async (command, args, options = {}) => {
      calls.push({ command, args, env: options.env })
      if (args.includes('inspect')) {
        const output = args.at(args.indexOf('--output') + 1)
        if (output === undefined) throw new Error('missing Passport output path')
        await writeFile(output, JSON.stringify({
          schemaVersion: '1.0.0',
          subject: { source: SOURCE, resolved: SOURCE, digest: 'a'.repeat(64), name: 'sentinel' },
          verdict: { status: 'review' },
        }))
        return { exitCode: 2, stdout: '', stderr: '' }
      }
      if (args.includes('install')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            receipt: {
              schemaVersion: '1.0.0', id: 'dogfood-receipt', quarantineProfile: 'trust-quarantine-dogfood-receipt',
              targetProfile: 'dogfood', source: SOURCE, immutableSource: SOURCE, installSpec: SOURCE,
              packageName: 'sentinel', passportDigest: 'a'.repeat(64), verdict: 'review', executed: false,
              createdAt: '2026-08-16T00:00:00.000Z', receiptDigest: 'b'.repeat(64),
            },
            receiptPath: '/private/temporary/receipt.json',
          }),
          stderr: '',
        }
      }
      if (args.includes('promote')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            profile: 'dogfood', snapshotId: null, installSpec: SOURCE, dryRun: true,
            commands: [['dsh', 'plugin', '--profile', 'dogfood', 'add', SOURCE]],
          }),
          stderr: '',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const result = await runDogfood({
      cwd,
      registryPath,
      artifactsDirectory,
      sourceSlug: 'dsh-plugin-sentinel',
      dshPath: '/absolute/dsh',
      nodePath: '/absolute/node',
      packageManagerPath: '/absolute/pnpm.cjs',
      run,
    })

    expect(result).toEqual({
      schemaVersion: '1.0.0',
      sourceSlug: 'dsh-plugin-sentinel',
      immutableSource: SOURCE,
      passportDigest: 'a'.repeat(64),
      verdict: 'review',
      receiptId: 'dogfood-receipt',
      receiptDigest: 'b'.repeat(64),
      executed: false,
      isolatedInstall: 'passed',
      promotionDryRun: 'passed',
      officialBundle: 'passed',
      regressionTests: 'passed',
    })
    expect(calls.map(call => call.args)).toEqual([
      ['/absolute/pnpm.cjs', 'test:dsh-bundle'],
      [join(cwd, 'dist/cli.js'), 'inspect', SOURCE, '--format', 'json', '--output', join(artifactsDirectory, 'passport.json')],
      [join(cwd, 'dist/cli.js'), 'quarantine', 'install', SOURCE, '--target', 'dogfood'],
      [join(cwd, 'dist/cli.js'), 'quarantine', 'promote', 'dogfood-receipt', '--target', 'dogfood', '--dry-run'],
      [
        '/absolute/pnpm.cjs', 'vitest', 'run',
        'test/profile-runner.test.ts', 'test/profile-ledger.test.ts', 'test/profile-transaction.test.ts',
        'test/profile-restore.test.ts', 'test/profile-snapshot.test.ts', 'test/quarantine.test.ts',
        'test/plugin.test.ts', 'test/cli.test.ts',
      ],
    ])
    expect(calls.every(call => call.command === '/absolute/node')).toBe(true)
    expect(calls.slice(1, 4).every(call => call.env?.DSH_PATH === '/absolute/dsh')).toBe(true)
    expect(calls.slice(1, 4).every(call => call.env?.npm_config_ignore_scripts === 'true')).toBe(true)
    const serializedCalls = JSON.stringify(calls)
    expect(serializedCalls).not.toContain('verify-import')
    expect(serializedCalls).not.toContain('allow-execute')
    expect(serializedCalls).not.toContain('DSH_TRUST_ALLOW_EXECUTION')

    const receiptArtifact = await readFile(join(artifactsDirectory, 'receipt.json'), 'utf8')
    const promotionArtifact = await readFile(join(artifactsDirectory, 'promotion-plan.json'), 'utf8')
    const summaryArtifact = await readFile(join(artifactsDirectory, 'summary.json'), 'utf8')
    expect(JSON.parse(receiptArtifact)).toMatchObject({ id: 'dogfood-receipt', executed: false })
    expect(JSON.parse(promotionArtifact)).toMatchObject({ profile: 'dogfood', dryRun: true })
    expect(JSON.parse(summaryArtifact)).toEqual(result)
    expect(`${receiptArtifact}${promotionArtifact}${summaryArtifact}`).not.toContain('/private/temporary')

    const isolatedHome = calls[2]?.env?.DSH_HOME
    expect(isolatedHome).toBeTypeOf('string')
    if (isolatedHome !== undefined) await expect(stat(isolatedHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
