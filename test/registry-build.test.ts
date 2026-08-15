import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRegistry, runRegistryBuildCli, validateOutputDirectory } from '../src/registry/build.js'
import { checkSite } from '../src/site/check.js'

async function setup(): Promise<{ root: string; sources: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trust-registry-build-'))
  const sources = join(root, 'sources.json')
  const output = join(root, 'public')
  await writeFile(sources, JSON.stringify({
    schemaVersion: '1.0.0',
    sources: [
      {
        slug: 'available',
        source: 'test/fixtures/safe-bundle',
        name: 'Available Bundle',
        description: 'A deterministic local acceptance fixture.',
        category: 'bundle',
        testedDshVersions: ['0.0.1-rc.1'],
      },
      {
        slug: 'unavailable',
        source: 'test/fixtures/does-not-exist',
        name: 'Unavailable Bundle',
        category: 'candidate',
      },
    ],
  }))
  return { root, sources, output }
}

describe('buildRegistry', () => {
  it('refuses destructive output roots before collection starts', () => {
    expect(() => validateOutputDirectory(parse(process.cwd()).root)).toThrow('unsafe registry output')
    expect(() => validateOutputDirectory(process.cwd())).toThrow('unsafe registry output')
    expect(() => validateOutputDirectory(join(process.cwd(), '..'))).toThrow('unsafe registry output')
  })

  it('writes reports, badges, schemas, assets, index, and detail evidence pages', async () => {
    const fixture = await setup()
    try {
      const result = await buildRegistry({ sourcePath: fixture.sources, outputDir: fixture.output })
      const index = JSON.parse(await readFile(join(fixture.output, 'index.json'), 'utf8')) as {
        entries: Array<{
          slug: string
          status: string
          declarationTypes: string[]
          maintenance: { provider: string; project: string }
        }>
      }
      const available = JSON.parse(await readFile(join(fixture.output, 'reports/available.json'), 'utf8')) as {
        status: string
        passport: { verdict: { status: string } }
      }
      const unavailable = JSON.parse(await readFile(join(fixture.output, 'reports/unavailable.json'), 'utf8')) as {
        status: string
        error: string
      }

      expect(result.reports.map(report => report.status)).toEqual(['verified-package', 'unavailable'])
      expect(index.entries.map(entry => entry.slug)).toEqual(['available', 'unavailable'])
      expect(index.entries[0]?.declarationTypes).toEqual(['bundle'])
      expect(index.entries[0]?.maintenance).toEqual({ provider: 'local', project: 'safe-bundle' })
      expect(available).toMatchObject({ status: 'verified-package', passport: { verdict: { status: 'pass' } } })
      expect(unavailable.status).toBe('unavailable')
      expect(unavailable.error).not.toContain(fixture.root)
      await expect(readFile(join(fixture.output, 'badges/available.svg'), 'utf8')).resolves.toContain('>pass<')
      await expect(readFile(join(fixture.output, 'detail/available.html'), 'utf8')).resolves.toContain('Available Bundle')
      await expect(readFile(join(fixture.output, 'schemas/registry-report.schema.json'), 'utf8')).resolves.toContain('Registry Report')
      await expect(checkSite(fixture.output)).resolves.toMatchObject({ files: result.files })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('is byte-identical across repeated builds', async () => {
    const fixture = await setup()
    try {
      await buildRegistry({ sourcePath: fixture.sources, outputDir: fixture.output })
      const first = await checkSite(fixture.output)
      await buildRegistry({ sourcePath: fixture.sources, outputDir: fixture.output })
      const second = await checkSite(fixture.output)

      expect(second).toEqual(first)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('exposes a zero-exit CLI wrapper with build evidence', async () => {
    const fixture = await setup()
    const stdout: string[] = []
    try {
      const code = await runRegistryBuildCli([fixture.sources, fixture.output], {
        stdout: line => stdout.push(line),
        stderr: () => {},
      })

      expect(code).toBe(0)
      expect(JSON.parse(stdout.join(''))).toMatchObject({ reports: 2 })
      await expect(checkSite(fixture.output)).resolves.toMatchObject({ files: expect.any(Number) })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})
