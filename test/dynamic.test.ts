import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDependencyInstall, verifyDynamicImport } from '../src/dynamic.js'

describe('verifyDynamicImport', () => {
  it('default dependency installation disables lifecycle scripts', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-trust-install-'))
    const root = join(parent, 'package')
    try {
      await cp('test/fixtures/failing-install-script', root, { recursive: true })
      await expect(runDependencyInstall(root)).resolves.toBeUndefined()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 30_000)

  it('installs production dependencies without scripts in an isolated copy before import', async () => {
    let install: { command: string; args: string[]; cwd: string } | undefined
    const evidence = await verifyDynamicImport('test/fixtures/safe-bundle', {
      runInstall: async request => { install = request },
    })

    expect(install).toMatchObject({
      command: 'pnpm',
      args: ['install', '--ignore-scripts', '--prod', '--frozen-lockfile=false'],
    })
    expect(install?.cwd).not.toContain('test/fixtures/safe-bundle')
    expect(evidence).toEqual({
      source: 'local:safe-bundle',
      executed: true,
      entry: 'index.js',
      exports: ['apply', 'name'],
      installation: {
        manager: 'pnpm',
        productionOnly: true,
        lifecycleScripts: false,
      },
      disclaimer: 'Execution evidence is not a security guarantee.',
    })
    expect(JSON.stringify(evidence)).not.toContain(process.cwd())
  })

  it('stops before import when dependency installation fails', async () => {
    await expect(verifyDynamicImport('test/fixtures/safe-bundle', {
      runInstall: async () => { throw new Error('dependency install failed') },
    })).rejects.toThrow('dependency install failed')
  })

  it('refuses all source symlinks before dependency install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-dynamic-link-'))
    let installed = false
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'linked',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
      }))
      await writeFile(join(root, 'index.js'), 'export const value = 1\n')
      await symlink('index.js', join(root, 'linked.js'))

      await expect(verifyDynamicImport(root, {
        runInstall: async () => { installed = true },
      })).rejects.toThrow('incomplete static file inventory')
      expect(installed).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an entry path outside the acquired package', async () => {
    await expect(verifyDynamicImport('test/fixtures/invalid-entry', {
      runInstall: async () => {},
    })).rejects.toThrow('entry escapes')
  })
})
