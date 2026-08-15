import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectSource } from '../src/index.js'
import { checkSite, runSiteCheckCli } from '../src/site/check.js'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trust-site-check-'))
  await mkdir(join(root, 'reports'))
  const passport = await inspectSource('test/fixtures/safe-bundle')
  await writeFile(join(root, 'index.html'), '<a href="reports/demo.json">report</a>')
  await writeFile(join(root, 'reports/demo.json'), JSON.stringify({ passport }))
  return root
}

describe('checkSite', () => {
  it('validates links, report Passports, secret/path policy, and a stable digest', async () => {
    const root = await fixture()
    try {
      const first = await checkSite(root)
      const second = await checkSite(root)

      expect(first.files).toBe(2)
      expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(second).toEqual(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an unavailable registry report without a Passport', async () => {
    const root = await fixture()
    try {
      await writeFile(join(root, 'index.html'), '<a href="reports/unavailable.json">report</a>')
      await writeFile(join(root, 'reports/unavailable.json'), JSON.stringify({
        slug: 'unavailable',
        source: 'npm:missing@1.0.0',
        maintenance: { provider: 'npm', project: 'missing', revision: '1.0.0' },
        status: 'unavailable',
        testedDshVersions: [],
        error: 'not found',
      }))

      await expect(checkSite(root)).resolves.toMatchObject({ files: 3 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects broken local links', async () => {
    const root = await fixture()
    try {
      await writeFile(join(root, 'index.html'), '<a href="missing.html">missing</a>')
      await expect(checkSite(root)).rejects.toThrow('broken link')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects leaked absolute paths and token-shaped content', async () => {
    const root = await fixture()
    try {
      await writeFile(join(root, 'leak.txt'), '/Users/example/plugin\nghp_abcdefghijklmnopqrstuvwxyz1234567890')
      await expect(checkSite(root)).rejects.toThrow('forbidden output')
      await writeFile(join(root, 'leak.txt'), '/private/var/folders/runtime/plugin')
      await expect(checkSite(root)).rejects.toThrow('forbidden output')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exposes a zero-exit CLI wrapper with machine-readable evidence', async () => {
    const root = await fixture()
    const stdout: string[] = []
    try {
      const code = await runSiteCheckCli([root], {
        stdout: line => stdout.push(line),
        stderr: () => {},
      })

      expect(code).toBe(0)
      expect(JSON.parse(stdout.join(''))).toEqual(await checkSite(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
