import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildSite } from '../src/site/generate.js'
import type { RegistryEntry } from '../src/site/generate.js'
import { escapeHtml, immutableSourceUrl } from '../src/site/templates.js'
import fixtureEntries from './fixtures/site/entries.json' with { type: 'json' }

const ENTRIES = fixtureEntries as unknown as RegistryEntry[]

const STUB_ASSETS = {
  'style.css': '.plugin-list { list-style: none; }\n',
  'filter.js': "'use strict';\n// stub\n",
}

const SAFE_DIGEST = '4444444444444444444444444444444444444444444444444444444444444444'
const SAFE_REVISION = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const SLUG_ORDER = ['logger-probe', 'native-bind', 'safe-cache', 'xss-decoy', 'z-orphan']

function entryBySlug(slug: string): RegistryEntry {
  const entry = ENTRIES.find(candidate => candidate.slug === slug)
  expect(entry).toBeDefined()
  return entry as RegistryEntry
}

function buildOnce(): Record<string, string> {
  return buildSite(ENTRIES, { assets: STUB_ASSETS })
}

function page(site: Record<string, string>, key: string): string {
  const value = site[key]
  if (value === undefined) throw new Error(`missing generated file: ${key}`)
  return value
}

describe('static site generation', () => {
  it('returns a deterministic map covering index, details, badges, and assets', () => {
    const site = buildOnce()
    const keys = Object.keys(site).sort()
    expect(keys).toEqual([
      'badges/logger-probe.shields.json',
      'badges/logger-probe.svg',
      'badges/native-bind.shields.json',
      'badges/native-bind.svg',
      'badges/safe-cache.shields.json',
      'badges/safe-cache.svg',
      'badges/xss-decoy.shields.json',
      'badges/xss-decoy.svg',
      'badges/z-orphan.shields.json',
      'badges/z-orphan.svg',
      'detail/logger-probe.html',
      'detail/native-bind.html',
      'detail/safe-cache.html',
      'detail/xss-decoy.html',
      'detail/z-orphan.html',
      'filter.js',
      'index.html',
      'index.json',
      'style.css',
    ])
    expect(page(site, 'style.css')).toBe(STUB_ASSETS['style.css'])
    expect(page(site, 'filter.js')).toBe(STUB_ASSETS['filter.js'])
    expect(site).toEqual(buildOnce())
  })

  it('publishes deterministic provider maintenance coordinates', () => {
    const entry = {
      ...entryBySlug('safe-cache'),
      maintenance: {
        provider: 'npm' as const,
        namespace: '@scope',
        project: 'safe-cache',
        revision: '1.2.3',
      },
    }
    const site = buildSite([entry], { assets: STUB_ASSETS })
    const index = JSON.parse(page(site, 'index.json')) as {
      entries: Array<{ maintenance?: unknown }>
    }

    expect(index.entries[0]?.maintenance).toEqual(entry.maintenance)
    expect(page(site, 'detail/safe-cache.html')).toContain('npm:@scope/safe-cache@1.2.3')
  })

  it('is byte-identical regardless of input order (sorts by slug)', () => {
    const reversed = [...ENTRIES].reverse()
    expect(buildSite(reversed, { assets: STUB_ASSETS })).toEqual(buildOnce())
  })

  it('index.html exposes semantic landmarks, headings, and no-JS core content', () => {
    const html = page(buildOnce(), 'index.html')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<h1>Plugin registry</h1>')
    expect(html).toContain('<main id="main">')
    expect(html).toContain('<nav aria-label="Primary">')
    expect(html).toContain('<footer')
    expect(html).toContain('href="style.css"')
    expect(html).toContain('<script src="filter.js" defer>')
    expect(html).toContain('Showing all 5 plugins')
  })

  it('index.html lists every plugin in slug order with stable links', () => {
    const html = page(buildOnce(), 'index.html')
    const slugs = [...html.matchAll(/data-slug="([^"]+)"/g)].map(match => match[1])
    expect(slugs).toEqual(SLUG_ORDER)
    expect(html).toContain('href="detail/safe-cache.html"')
    expect(html).toContain('href="reports/safe-cache.json"')
    expect(html).toContain('>Safe Cache</a>')
  })

  it('index.html provides progressive filter controls for all six dimensions', () => {
    const html = page(buildOnce(), 'index.html')
    expect(html).toContain('id="filter-name"')
    expect(html).toContain('id="filter-category"')
    expect(html).toContain('id="filter-declaration"')
    expect(html).toContain('id="filter-verdict"')
    expect(html).toContain('id="filter-severity"')
    expect(html).toContain('id="filter-source"')
    expect(html).toContain('id="filter-version"')
    expect(html).toContain('<option value="">All</option>')
    expect(html).toContain('<option value="cache">cache</option>')
    expect(html).toContain('<option value="bundle">bundle</option>')
    expect(html).toContain('<option value="client">client</option>')
    expect(html).toContain('<option value="pass">pass</option>')
    expect(html).toContain('<option value="unavailable">unavailable</option>')
    expect(html).toContain('<option value="critical">critical</option>')
    expect(html).toContain('<option value="github">github</option>')
    expect(html).toContain('<option value="0.6.0">0.6.0</option>')
  })

  it('index.json holds deterministic filter data with derived severity', () => {
    const site = buildOnce()
    const data = JSON.parse(page(site, 'index.json')) as {
      schemaVersion: number
      entries: Array<Record<string, unknown>>
    }
    expect(data.schemaVersion).toBe(1)
    expect(data.entries.map(entry => entry.slug)).toEqual(SLUG_ORDER)
    const safe = data.entries.find(entry => entry.slug === 'safe-cache')
    expect(safe).toMatchObject({
      verdict: 'pass',
      digest: SAFE_DIGEST,
      sourceKind: 'github',
      testedDshVersions: ['0.5.0', '0.6.0'],
      reportPath: 'reports/safe-cache.json',
      detailPath: 'detail/safe-cache.html',
    })
    expect('severity' in (safe as Record<string, unknown>)).toBe(false)
    const native = data.entries.find(entry => entry.slug === 'native-bind')
    expect(native?.severity).toBe('critical')
    const orphan = data.entries.find(entry => entry.slug === 'z-orphan')
    expect('verdict' in (orphan as Record<string, unknown>)).toBe(false)
    expect('severity' in (orphan as Record<string, unknown>)).toBe(false)
    expect(page(site, 'index.json')).toBe(page(buildOnce(), 'index.json'))
  })

  it('index.html embeds filter data that parses identically to index.json', () => {
    const site = buildOnce()
    const embedded = /<script type="application\/json" id="trust-registry-data">([\s\S]*?)<\/script>/
      .exec(page(site, 'index.html'))?.[1]
    expect(embedded).toBeDefined()
    const embeddedData = JSON.parse(embedded as string) as { entries: Array<{ slug: string }> }
    expect(embeddedData.entries.map(entry => entry.slug)).toEqual(SLUG_ORDER)
    expect(JSON.parse(embedded as string)).toEqual(JSON.parse(page(site, 'index.json')))
  })

  it('detail pages carry digest, immutable source link, report link, and landmarks', () => {
    const detail = page(buildOnce(), 'detail/safe-cache.html')
    expect(detail).toContain('<h1>Safe Cache</h1>')
    expect(detail).toContain('<main id="main">')
    expect(detail).toContain('<nav aria-label="Primary">')
    expect(detail).toContain('<footer')
    expect(detail).toContain(`<code>sha256:${SAFE_DIGEST}</code>`)
    expect(detail).toContain(`https://github.com/example/safe-cache/tree/${SAFE_REVISION}`)
    expect(detail).toContain('href="../reports/safe-cache.json"')
    expect(detail).toContain('href="../index.html"')
    expect(detail).toContain('src="../badges/safe-cache.svg"')
    expect(detail).toContain('alt="Trust badge for safe-cache: pass"')
    expect(detail).toContain('No findings recorded')
  })

  it('detail pages list findings with severity and evidence location', () => {
    const detail = page(buildOnce(), 'detail/logger-probe.html')
    expect(detail).toContain('<h2 id="findings-heading">Findings</h2>')
    expect(detail).toContain('DSH-SCRIPT-001')
    expect(detail).toContain('Lifecycle script detected')
    expect(detail).toContain('at package.json:7')
  })

  it('every page carries the evidence-not-endorsement disclaimer', () => {
    const site = buildOnce()
    for (const key of ['index.html', 'detail/safe-cache.html', 'detail/z-orphan.html']) {
      expect(page(site, key)).toContain('not an endorsement')
      expect(page(site, key)).toContain('automated evidence')
    }
  })

  it('badge files match the passport verdict and digest for every entry', () => {
    const site = buildOnce()
    expect(page(site, 'badges/safe-cache.svg')).toContain(`sha256:${SAFE_DIGEST}`)
    expect(page(site, 'badges/safe-cache.svg')).toContain('>pass<')
    expect(page(site, 'badges/native-bind.svg')).toContain('>fail<')
    expect(page(site, 'badges/logger-probe.svg')).toContain('>review<')
    expect(page(site, 'badges/z-orphan.svg')).toContain('>unavailable<')
    expect(page(site, 'badges/z-orphan.svg')).not.toContain('sha256:')
    expect(page(site, 'badges/safe-cache.shields.json')).toContain('"message": "pass"')
    expect(page(site, 'badges/safe-cache.shields.json')).toContain(`"digest": "sha256:${SAFE_DIGEST}"`)
    expect(page(site, 'badges/z-orphan.shields.json')).not.toContain('digest')
  })

  it('escapes every untrusted string in HTML output', () => {
    const site = buildOnce()
    const html = page(site, 'index.html')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<b>markup</b>')
    expect(html).not.toContain('</script><script')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;')
    expect(html).toContain('Description with &lt;/script&gt;&lt;script&gt; tags and &lt;b&gt;markup&lt;/b&gt;.')

    const detail = page(site, 'detail/xss-decoy.html')
    expect(detail).not.toContain('<em>title</em>')
    expect(detail).toContain('Tricky finding &lt;em&gt;title&lt;/em&gt;')
    expect(detail).toContain('Message with &quot;quotes&quot; and &lt;angle&gt; brackets &amp; ampersands.')
  })

  it('keeps the embedded filter data inert inside the script element', () => {
    const embedded = /<script type="application\/json" id="trust-registry-data">([\s\S]*?)<\/script>/
      .exec(page(buildOnce(), 'index.html'))?.[1]
    expect(embedded).toBeDefined()
    expect(embedded).not.toContain('</script>')
    expect(embedded).not.toContain('<script')
    expect(embedded).toContain('\\u003cscript\\u003e')
    expect(embedded).toContain('\\u003c/script\\u003e')
    expect(embedded).toContain('\\u0026')
  })

  it('rejects invalid and duplicate slugs', () => {
    expect(() => buildSite([{ ...entryBySlug('safe-cache'), slug: '../evil' }])).toThrow(/invalid registry slug/)
    expect(() => buildSite([entryBySlug('safe-cache'), entryBySlug('safe-cache')])).toThrow(/duplicate registry slug/)
  })

  it('defaults the canonical report path to reports/<slug>.json', () => {
    const minimal: RegistryEntry[] = [{
      slug: 'alpha',
      name: 'Alpha',
      source: 'local:./alpha',
      sourceKind: 'local',
      status: 'candidate',
      declarationTypes: [],
      testedDshVersions: [],
      findings: [],
    }]
    const site = buildSite(minimal)
    expect(page(site, 'detail/alpha.html')).toContain('href="../reports/alpha.json"')
    const data = JSON.parse(page(site, 'index.json')) as { entries: Array<{ reportPath: string }> }
    expect(data.entries[0]?.reportPath).toBe('reports/alpha.json')
  })

  it('builds stable immutable source links from source specs and revisions', () => {
    expect(immutableSourceUrl(entryBySlug('safe-cache')))
      .toBe(`https://github.com/example/safe-cache/tree/${SAFE_REVISION}`)
    expect(immutableSourceUrl(entryBySlug('logger-probe')))
      .toBe('https://registry.npmjs.org/logger-probe/-/logger-probe-1.2.3.tgz')
    expect(immutableSourceUrl(entryBySlug('xss-decoy'))).toBeUndefined()
    expect(immutableSourceUrl(entryBySlug('z-orphan'))).toBeUndefined()
    expect(immutableSourceUrl({ source: 'npm:@scope/pkg@2.0.0', revision: '2.0.0' }))
      .toBe('https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz')
    expect(immutableSourceUrl({ source: 'npm:broken' })).toBeUndefined()
  })

  it('escapeHtml escapes the five dangerous characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})

describe('static site assets', () => {
  it('filter.js hooks the generated filter controls and data element', async () => {
    const js = await readFile('site/filter.js', 'utf8')
    for (const id of [
      'trust-registry-data',
      'plugin-list',
      'results-count',
      'filter-name',
      'filter-category',
      'filter-declaration',
      'filter-verdict',
      'filter-severity',
      'filter-source',
      'filter-version',
      'filter-reset',
    ]) {
      expect(js).toContain(id)
    }
  })

  it('style.css covers the generated page hooks', async () => {
    const css = await readFile('site/style.css', 'utf8')
    for (const selector of [
      '.skip-link',
      '.site-header',
      '.disclaimer',
      '.filters',
      '.plugin-list',
      '.plugin-meta',
      '.findings',
      '.badge',
      '.site-footer',
    ]) {
      expect(css).toContain(selector)
    }
  })
})
