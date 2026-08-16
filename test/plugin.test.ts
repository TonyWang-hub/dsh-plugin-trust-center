import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import YAML from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/plugin.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('DSH bundle declaration', () => {
  it('ships a bundle patch that inserts only the Trust Center read-only plugin', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      dsh?: unknown
      exports: Record<string, unknown>
      version: string
      files: string[]
      peerDependencies?: Record<string, string>
      devDependencies: Record<string, string>
      scripts: Record<string, string>
      publishConfig?: Record<string, unknown>
      bin?: Record<string, string>
      repository?: unknown
    }
    const patch = YAML.parse(await readFile('cordis.patch.yml', 'utf8')) as unknown
    const workspace = YAML.parse(await readFile('pnpm-workspace.yaml', 'utf8')) as {
      allowBuilds?: Record<string, boolean>
    }

    expect(manifest.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    expect(manifest.exports['./plugin']).toEqual({
      types: './dist/plugin.d.ts',
      default: './dist/plugin.js',
    })
    expect(manifest.version).toBe('0.3.2')
    expect(manifest.publishConfig).toEqual({
      access: 'public',
      registry: 'https://registry.npmjs.org/',
    })
    expect(manifest.bin).toEqual({ 'dsh-trust': 'dist/cli.js' })
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/TonyWang-hub/dsh-plugin-trust-center.git',
    })
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/cordis': '^4.0.1',
      '@deepseek-ai/dsh-tools': '0.1.0-rc.6',
    })
    expect(manifest.devDependencies['@deepseek-ai/dsh']).toBe('0.1.0-rc.6')
    expect(manifest.scripts['test:dsh-bundle']).toBe('DSH_REAL_BUNDLE=1 vitest run test/dsh-bundle.acceptance.test.ts')
    expect(manifest.scripts.dogfood).toBe('pnpm build && node dist/dogfood.js')
    expect(workspace.allowBuilds).toEqual({
      '@deepseek-ai/dsh-subprocess-local': false,
      '@google/genai': false,
      koffi: false,
      'node-pty': false,
      protobufjs: false,
    })
    expect(patch).toEqual([{ insert: [{ id: 'dsh-plugin-trust-center', name: 'dsh-plugin-trust-center/plugin' }] }])
  })
})

describe('DSH plugin lifecycle', () => {
  it('registers only bounded read-only inspect and profile-status tools', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-trust-plugin-'))
    temporaryRoots.push(home)
    await mkdir(join(home, 'profiles', 'work'), { recursive: true })
    await writeFile(join(home, 'profiles', 'work', 'package.json'), JSON.stringify({
      dependencies: { '@scope/example': '1.2.3' },
    }), 'utf8')
    await mkdir(join(home, 'snapshots', 'work', 'snapshot-1'), { recursive: true })
    await mkdir(join(home, 'profiles', 'broken'), { recursive: true })
    await writeFile(join(home, 'profiles', 'broken', 'package.json'), '{not-json', 'utf8')
    await mkdir(join(home, 'profiles', 'nullish'), { recursive: true })
    await writeFile(join(home, 'profiles', 'nullish', 'package.json'), 'null', 'utf8')

    interface Tool {
      name: string
      execute(args: Record<string, unknown>, execution: unknown): Promise<string> | string
    }
    const tools: Tool[] = []
    const disposed: string[] = []
    const context = {
      tools: {
        register(tool: Tool) {
          tools.push(tool)
          return () => { disposed.push(tool.name) }
        },
      },
    }

    const dispose = apply(context as never, {
      dshHome: home,
      allowedLocalRoots: [resolve('test/fixtures')],
      maxOutputBytes: 16_384,
    })

    expect(tools.map(tool => tool.name)).toEqual(['trust_inspect', 'trust_profile_status'])
    expect(tools.some(tool => /install|disable|restore|promote/.test(tool.name))).toBe(false)

    const inspectTool = tools.find(tool => tool.name === 'trust_inspect')
    const statusTool = tools.find(tool => tool.name === 'trust_profile_status')
    expect(inspectTool).toBeDefined()
    expect(statusTool).toBeDefined()
    if (inspectTool === undefined || statusTool === undefined) throw new Error('missing Trust Center tools')

    const inspection = JSON.parse(await inspectTool.execute({ source: 'test/fixtures/safe-bundle' }, {})) as {
      subject: { name?: string }
      verdict: { status: string }
    }
    expect(inspection.subject.name).toBe('safe-bundle')
    expect(inspection.verdict.status).toBe('pass')

    const statusText = await statusTool.execute({}, {})
    const status = JSON.parse(statusText) as {
      profiles: Array<{ name: string; bundles: string[]; snapshots: string[] }>
    }
    expect(status.profiles).toEqual([
      { name: 'broken', bundles: [], snapshots: [] },
      { name: 'nullish', bundles: [], snapshots: [] },
      { name: 'work', bundles: ['@scope/example'], snapshots: ['snapshot-1'] },
    ])
    expect(statusText).not.toContain(home)

    dispose()
    expect(disposed).toEqual(['trust_profile_status', 'trust_inspect'])
  })

  it('truncates inspection evidence to the configured byte bound', async () => {
    interface Tool {
      name: string
      execute(args: Record<string, unknown>, execution: unknown): Promise<string> | string
    }
    const tools: Tool[] = []
    apply({ tools: { register(tool: Tool) { tools.push(tool) } } } as never, {
      allowedLocalRoots: [resolve('test/fixtures')],
      maxOutputBytes: 1_024,
    })
    const inspectTool = tools.find(tool => tool.name === 'trust_inspect')
    if (inspectTool === undefined) throw new Error('missing trust_inspect')

    const output = await inspectTool.execute({ source: 'test/fixtures/risky-bundle' }, {})
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1_024)
    const summary = JSON.parse(output) as { truncated?: boolean; findingCount?: number }
    expect(summary.truncated).toBe(true)
    expect(summary.findingCount).toBeGreaterThan(0)
  })
})
