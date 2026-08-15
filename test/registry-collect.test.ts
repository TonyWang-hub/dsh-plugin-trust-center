import { describe, expect, it } from 'vitest'
import type { Passport, VerdictStatus } from '../src/model.js'
import { canonicalJson } from '../src/passport.js'
import { collectRegistry, deriveRegistryStatus } from '../src/registry/collect.js'
import { loadRegistrySources } from '../src/registry/load.js'
import type { RegistrySource } from '../src/registry/model.js'

const SEED_PATH = 'test/fixtures/registry/sources.json'

function source(slug: string, spec: string, extra: Partial<RegistrySource> = {}): RegistrySource {
  return { slug, source: spec, name: slug, ...extra }
}

function fakePassport(
  status: VerdictStatus,
  resolved = 'local:fake',
  digest = '0'.repeat(64),
  kind: Passport['subject']['kind'] = 'local',
): Passport {
  return {
    schemaVersion: '1.0.0',
    subject: { kind, source: 'local:fake', resolved, digest },
    dsh: {},
    scripts: {},
    dependencies: { runtime: {}, dev: {}, optional: {}, peer: {} },
    findings: [],
    sbom: { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: {}, components: [], dependencies: [] },
    compatibility: { method: 'declaration-only', dynamicImportVerified: false },
    verdict: { status },
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('deriveRegistryStatus', () => {
  it('maps pass/review/fail verdicts without a safe label', () => {
    expect(deriveRegistryStatus(fakePassport('pass'))).toBe('verified-package')
    expect(deriveRegistryStatus(fakePassport('review'))).toBe('candidate')
    expect(deriveRegistryStatus(fakePassport('fail'))).toBe('incompatible')
  })
})

describe('collectRegistry', () => {
  it('collects the shipped seed with the default Stage 1 inspectSource API', async () => {
    const sources = await loadRegistrySources(SEED_PATH)
    const reports = await collectRegistry(sources)

    expect(reports).toHaveLength(1)
    const report = reports[0]
    expect(report).toBeDefined()
    if (report === undefined) throw new Error('seed collection produced no reports')
    expect(Object.keys(report)).toEqual(['slug', 'source', 'maintenance', 'status', 'resolved', 'digest', 'testedDshVersions', 'passport'])
    expect(report.slug).toBe('example-bundle')
    expect(report.source).toBe('test/fixtures/registry/example-bundle')
    expect(report.status).toBe('verified-package')
    expect(report.resolved).toBe('local:example-bundle')
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(report.testedDshVersions).toEqual([])
    expect(report.passport?.schemaVersion).toBe('1.0.0')
  })

  it('emits verified-package, candidate, and incompatible from real local fixtures', async () => {
    const sources = [
      source('invalid-bundle', 'test/fixtures/invalid-bundle'),
      source('risky-bundle', 'test/fixtures/risky-bundle'),
      source('safe-bundle', 'test/fixtures/safe-bundle'),
    ]

    const reports = await collectRegistry(sources)

    expect(reports.map(report => report.slug)).toEqual(['invalid-bundle', 'risky-bundle', 'safe-bundle'])
    expect(reports[0]?.status).toBe('incompatible')
    expect(reports[1]?.status).toBe('candidate')
    expect(reports[2]?.status).toBe('verified-package')
    expect(reports.every(report => report.resolved?.startsWith('local:'))).toBe(true)
    expect(reports.every(report => /^[0-9a-f]{64}$/.test(report.digest ?? ''))).toBe(true)
  })

  it('passes inspection options through to the injected Stage 1 API', async () => {
    const reports = await collectRegistry([source('limited', 'test/fixtures/safe-bundle')], {
      inspectOptions: { limits: { maxFiles: 1 } },
    })

    expect(reports[0]?.status).toBe('incompatible')
    expect(reports[0]?.passport?.findings.some(f => f.ruleId === 'DSH-SCAN-001')).toBe(true)
  })

  it('derives deterministic maintenance coordinates from pinned providers', async () => {
    const sha = 'a'.repeat(40)
    const reports = await collectRegistry([
      source('github-plugin', `github:owner/repo#${sha}`),
      source('npm-plugin', 'npm:@scope/pkg@1.2.3'),
    ], {
      inspect: async spec => spec.startsWith('npm:')
        ? fakePassport('pass', spec, '1'.repeat(64), 'npm')
        : fakePassport('pass', spec, '2'.repeat(64), 'github'),
    })

    expect(reports.map(report => report.maintenance)).toEqual([
      { provider: 'github', namespace: 'owner', project: 'repo', revision: sha },
      { provider: 'npm', namespace: '@scope', project: 'pkg', revision: '1.2.3' },
    ])
  })

  it('uses the reviewed local path rather than a synthesized local subject', async () => {
    const reports = await collectRegistry([source('local-plugin', 'test/fixtures/safe-bundle')], {
      inspect: async () => fakePassport('pass', 'local:safe-bundle'),
    })

    expect(reports[0]?.maintenance).toEqual({ provider: 'local', project: 'safe-bundle' })
  })

  it('turns one acquisition failure into an unavailable record without blocking others', async () => {
    const sources = [source('broken', 'broken'), source('healthy', 'healthy')]
    const inspect = async (spec: string) => {
      if (spec === 'broken') throw new Error('acquisition failed')
      return fakePassport('pass', 'healthy')
    }

    const reports = await collectRegistry(sources, { inspect })

    expect(reports).toHaveLength(2)
    const broken = reports.find(report => report.slug === 'broken')
    const healthy = reports.find(report => report.slug === 'healthy')
    expect(broken).toBeDefined()
    expect(healthy).toBeDefined()
    expect(Object.keys(broken as object)).toEqual(['slug', 'source', 'maintenance', 'status', 'testedDshVersions', 'error'])
    expect(broken?.status).toBe('unavailable')
    expect(broken?.error).toBe('acquisition failed')
    expect(broken?.passport).toBeUndefined()
    expect(healthy?.status).toBe('verified-package')
    expect(healthy?.passport?.verdict.status).toBe('pass')
  })

  it('bounds unavailable error evidence to the report schema limit', async () => {
    const reports = await collectRegistry([source('broken', 'broken')], {
      inspect: async () => { throw new Error('x'.repeat(2_000)) },
    })

    const error = reports[0]?.error
    expect(error).toBeDefined()
    if (error === undefined) throw new Error('unavailable report omitted error evidence')
    expect(error).toHaveLength(1_000)
    expect(error.endsWith('…')).toBe(true)
  })

  it('redacts local absolute paths from unavailable evidence', async () => {
    const reports = await collectRegistry([source('missing', 'test/fixtures/does-not-exist')])

    expect(reports[0]?.status).toBe('unavailable')
    expect(reports[0]?.error).not.toContain(process.cwd())
    expect(reports[0]?.error).not.toMatch(/\/(?:Users|home)\//)
  })

  it('bounds concurrent inspection to the requested limit', async () => {
    const sources = ['a', 'b', 'c', 'd'].map(slug => source(slug, slug))
    let active = 0
    let maxActive = 0
    const inspect = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(15)
      active -= 1
      return fakePassport('pass')
    }

    const reports = await collectRegistry(sources, { concurrency: 2, inspect })

    expect(maxActive).toBe(2)
    expect(reports).toHaveLength(4)
  })

  it('runs strictly sequentially when concurrency is 1', async () => {
    const sources = ['a', 'b', 'c'].map(slug => source(slug, slug))
    let active = 0
    let maxActive = 0
    const inspect = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
      return fakePassport('pass')
    }

    const reports = await collectRegistry(sources, { concurrency: 1, inspect })

    expect(maxActive).toBe(1)
    expect(reports).toHaveLength(3)
  })

  it('returns records in canonical slug order even when inspection completes out of order', async () => {
    const sources = [
      source('alpha', 'alpha'),
      source('beta', 'beta'),
      source('gamma', 'gamma'),
    ]
    const latency: Record<string, number> = { alpha: 40, beta: 20, gamma: 5 }
    const completionOrder: string[] = []
    const inspect = async (spec: string) => {
      await delay(latency[spec] ?? 10)
      completionOrder.push(spec)
      return fakePassport('pass', spec)
    }

    const reports = await collectRegistry(sources, { concurrency: 3, inspect })

    expect(completionOrder).toEqual(['gamma', 'beta', 'alpha'])
    expect(reports.map(report => report.slug)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('propagates tested DSH versions from the declaration into every record', async () => {
    const sources = [
      source('tested', 'tested', { testedDshVersions: ['1.0.0', '1.1.0'] }),
      source('untested', 'untested'),
    ]
    const inspect = async () => fakePassport('pass')

    const reports = await collectRegistry(sources, { inspect })

    expect(reports.find(report => report.slug === 'tested')?.testedDshVersions).toEqual(['1.0.0', '1.1.0'])
    expect(reports.find(report => report.slug === 'untested')?.testedDshVersions).toEqual([])
  })

  it('rejects a non-positive or fractional concurrency without inspecting anything', async () => {
    const inspect = async () => fakePassport('pass')

    for (const concurrency of [0, -1, 1.5]) {
      await expect(collectRegistry([source('a', 'a')], { concurrency, inspect }))
        .rejects.toThrow(/concurrency/i)
    }
  })

  it('produces byte-identical canonical reports with no timestamps across runs', async () => {
    const sources = [
      source('invalid-bundle', 'test/fixtures/invalid-bundle'),
      source('safe-bundle', 'test/fixtures/safe-bundle'),
    ]

    const first = await collectRegistry(sources)
    const second = await collectRegistry(sources)

    expect(first.map(report => report.status)).toEqual(['incompatible', 'verified-package'])
    const firstJson = canonicalJson(first)
    const secondJson = canonicalJson(second)
    expect(secondJson).toBe(firstJson)
    expect(firstJson).not.toContain('timestamp')
    expect(firstJson).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})
