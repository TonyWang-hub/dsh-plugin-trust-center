/**
 * Stage 2 static-site templates: semantic, accessible, serverless HTML with
 * progressive filter data. Every untrusted value is escaped on output and the
 * embedded filter JSON is made inert inside a `<script>` element.
 */

import { parseSourceSpec } from '../acquire.js'
import type { SourceSpec } from '../acquire.js'
import type { RegistryMaintenance } from '../registry/collect.js'

export type RegistryVerdict = 'pass' | 'review' | 'fail'
export type RegistrySeverity = 'critical' | 'high'
export type RegistrySourceKind = 'github' | 'npm' | 'local'
export type RegistryStatus = 'verified-package' | 'candidate' | 'incompatible' | 'unavailable'

export interface RegistryFinding {
  ruleId: string
  severity: RegistrySeverity
  category: string
  title: string
  message: string
  evidence: Array<{ file: string; line?: number; snippet?: string }>
}

/**
 * Minimal registry record consumed by the site generator. The collector
 * (Stage 2 Task 2) is responsible for mapping its own model onto this shape.
 */
export interface RegistryEntry {
  slug: string
  name: string
  description?: string
  category?: string
  source: string
  sourceKind: RegistrySourceKind
  maintenance?: RegistryMaintenance
  /** Immutable resolved revision (GitHub commit SHA or npm version). */
  revision?: string
  status: RegistryStatus
  verdict?: RegistryVerdict
  digest?: string
  declarationTypes: string[]
  testedDshVersions: string[]
  findings: RegistryFinding[]
  /** Canonical, stable report path; defaults to `reports/<slug>.json`. */
  reportPath?: string
}

const DISCLAIMER_INDEX = 'The reports behind this site are automated evidence produced by static inspection. They are not endorsements and do not guarantee that any plugin is safe.'
const DISCLAIMER_DETAIL = 'This page is automated evidence, not an endorsement. It does not guarantee that this plugin is safe.'
const DISCLAIMER_FOOTER = 'Automated evidence, not an endorsement. This site is generated from static inspection reports and does not guarantee the safety of any plugin.'

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Escapes serialized JSON so it stays inert inside an HTML `<script>`. */
export function jsonForScript(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

/** Worst finding severity, matching the passport verdict derivation order. */
export function worstSeverity(findings: RegistryFinding[]): RegistrySeverity | undefined {
  if (findings.some(finding => finding.severity === 'critical')) return 'critical'
  if (findings.some(finding => finding.severity === 'high')) return 'high'
  return undefined
}

/**
 * Builds the immutable source URL from the requested source spec and the
 * resolved revision. Returns `undefined` when no immutable revision exists.
 */
export function immutableSourceUrl(entry: { source: string; revision?: string }): string | undefined {
  const spec = parseSourceSafe(entry.source)
  if (spec === undefined) return undefined
  if (spec.kind === 'github') {
    if (entry.revision === undefined || entry.revision === '') return undefined
    return `https://github.com/${spec.owner}/${spec.repo}/tree/${encodeURIComponent(entry.revision)}`
  }
  if (spec.kind === 'npm') {
    const version = entry.revision ?? spec.version
    if (version === '' || version === 'latest') return undefined
    const base = spec.name.includes('/') ? spec.name.slice(spec.name.lastIndexOf('/') + 1) : spec.name
    return `https://registry.npmjs.org/${spec.name}/-/${base}-${encodeURIComponent(version)}.tgz`
  }
  return undefined
}

export interface DocumentOptions {
  title: string
  description: string
  stylesheet: string
  body: string
}

export function renderDocument(options: DocumentOptions): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<meta name="description" content="${escapeHtml(options.description)}">`,
    `<link rel="stylesheet" href="${escapeHtml(options.stylesheet)}">`,
    '</head>',
    '<body>',
    options.body,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export function renderHeader(base: string): string {
  return [
    '<a class="skip-link" href="#main">Skip to content</a>',
    '<header class="site-header">',
    `<p class="site-name"><a href="${escapeHtml(`${base}index.html`)}">DSH Plugin Trust Center</a></p>`,
    '<nav aria-label="Primary">',
    `<a href="${escapeHtml(`${base}index.html`)}">Registry</a>`,
    '</nav>',
    '</header>',
  ].join('\n')
}

export function renderFooter(): string {
  return [
    '<footer class="site-footer">',
    `<p>${DISCLAIMER_FOOTER}</p>`,
    '</footer>',
  ].join('\n')
}

export interface IndexPageOptions {
  entries: RegistryEntry[]
  /** Serialized filter data, already made inert for a `<script>` element. */
  filterData: string
}

export function renderIndexPage(options: IndexPageOptions): string {
  const { entries, filterData } = options
  const body = [
    renderHeader(''),
    '<main id="main">',
    '<h1>Plugin registry</h1>',
    `<p class="disclaimer">${DISCLAIMER_INDEX}</p>`,
    renderFilterSection(entries),
    `<p id="results-count" aria-live="polite">Showing all ${entries.length} plugins</p>`,
    `<ul id="plugin-list" class="plugin-list">${entries.map(renderIndexItem).join('')}</ul>`,
    `<script type="application/json" id="trust-registry-data">${filterData}</script>`,
    '<script src="filter.js" defer></script>',
    '</main>',
    renderFooter(),
  ].join('\n')
  return renderDocument({
    title: 'DSH Plugin Trust Center — Registry',
    description: 'Automated evidence for DSH plugins: verdicts, digests, and findings. Reports are evidence, not endorsements.',
    stylesheet: 'style.css',
    body,
  })
}

export function renderDetailPage(entry: RegistryEntry): string {
  const verdict = entry.verdict ?? 'unavailable'
  const immutable = immutableSourceUrl(entry)
  const findingsList = entry.findings.length === 0
    ? '<p>No findings recorded for this plugin.</p>'
    : `<ul class="findings">${entry.findings.map(renderFinding).join('')}</ul>`
  const body = [
    renderHeader('../'),
    '<main id="main">',
    `<h1>${escapeHtml(entry.name)}</h1>`,
    `<p class="plugin-subtitle"><code>${escapeHtml(entry.slug)}</code> · <span class="status">${escapeHtml(entry.status)}</span> · verdict <span class="verdict verdict-${escapeHtml(verdict)}">${escapeHtml(verdict)}</span></p>`,
    `<p class="disclaimer">${DISCLAIMER_DETAIL}</p>`,
    `<p class="badge-note"><img class="badge" src="../badges/${escapeHtml(entry.slug)}.svg" alt="Trust badge for ${escapeHtml(entry.slug)}: ${escapeHtml(verdict)}"></p>`,
    '<section aria-labelledby="evidence-heading">',
    '<h2 id="evidence-heading">Evidence</h2>',
    '<dl class="evidence">',
    `<div><dt>Digest</dt><dd><code>${escapeHtml(entry.digest === undefined ? 'unavailable' : `sha256:${entry.digest}`)}</code></dd></div>`,
    `<div><dt>Source</dt><dd>${renderSource(entry)}</dd></div>`,
    `<div><dt>Maintenance coordinates</dt><dd>${entry.maintenance === undefined ? 'unavailable' : `<code>${escapeHtml(maintenanceLabel(entry.maintenance))}</code>`}</dd></div>`,
    `<div><dt>Immutable revision</dt><dd>${immutable === undefined ? 'unavailable' : `<a href="${escapeHtml(immutable)}" rel="noopener noreferrer">${escapeHtml(immutable)}</a>`}</dd></div>`,
    `<div><dt>Tested DSH versions</dt><dd>${renderInlineList(entry.testedDshVersions, 'None declared')}</dd></div>`,
    `<div><dt>Canonical report</dt><dd><a href="${escapeHtml(`../${reportPath(entry)}`)}" download>${escapeHtml(reportPath(entry))} (JSON)</a></dd></div>`,
    '</dl>',
    '</section>',
    '<section aria-labelledby="findings-heading">',
    '<h2 id="findings-heading">Findings</h2>',
    findingsList,
    '</section>',
    '</main>',
    renderFooter(),
  ].join('\n')
  return renderDocument({
    title: `${entry.name} — evidence`,
    description: `Automated inspection evidence for ${entry.slug}: status ${entry.status}, verdict ${verdict}.`,
    stylesheet: '../style.css',
    body,
  })
}

/** Canonical, stable filter/search data artifact (`index.json`). */
export function renderFilterData(entries: RegistryEntry[]): string {
  const body = {
    schemaVersion: 1,
    entries: entries.map(entry => {
      const severity = worstSeverity(entry.findings)
      return {
        slug: entry.slug,
        name: entry.name,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.category === undefined ? {} : { category: entry.category }),
        source: entry.source,
        sourceKind: entry.sourceKind,
        ...(entry.maintenance === undefined ? {} : { maintenance: entry.maintenance }),
        ...(entry.revision === undefined ? {} : { revision: entry.revision }),
        status: entry.status,
        ...(entry.verdict === undefined ? {} : { verdict: entry.verdict }),
        ...(entry.digest === undefined ? {} : { digest: entry.digest }),
        declarationTypes: entry.declarationTypes,
        ...(severity === undefined ? {} : { severity }),
        testedDshVersions: entry.testedDshVersions,
        reportPath: reportPath(entry),
        detailPath: `detail/${entry.slug}.html`,
      }
    }),
  }
  return JSON.stringify(body, null, 2)
}

function renderIndexItem(entry: RegistryEntry): string {
  const detailPath = `detail/${entry.slug}.html`
  const rows = [
    entry.category === undefined ? '' : `<div><dt>Category</dt><dd>${escapeHtml(entry.category)}</dd></div>`,
    `<div><dt>Status</dt><dd>${escapeHtml(entry.status)}</dd></div>`,
    `<div><dt>Verdict</dt><dd>${escapeHtml(entry.verdict ?? 'unavailable')}</dd></div>`,
    `<div><dt>Source</dt><dd>${escapeHtml(entry.sourceKind)}</dd></div>`,
    `<div><dt>Tested DSH</dt><dd>${renderInlineList(entry.testedDshVersions, 'None declared')}</dd></div>`,
  ].join('')
  return [
    `<li class="plugin" data-slug="${escapeHtml(entry.slug)}">`,
    '<article>',
    `<h2 class="plugin-name"><a href="${escapeHtml(detailPath)}">${escapeHtml(entry.name)}</a></h2>`,
    entry.description === undefined ? '' : `<p class="plugin-description">${escapeHtml(entry.description)}</p>`,
    `<dl class="plugin-meta">${rows}</dl>`,
    `<p class="plugin-links"><a href="${escapeHtml(detailPath)}">View evidence</a> · <a href="${escapeHtml(reportPath(entry))}">Report (JSON)</a></p>`,
    '</article>',
    '</li>',
  ].join('')
}

function renderFinding(finding: RegistryFinding): string {
  const location = finding.evidence[0]
  const where = location === undefined
    ? ''
    : ` <span class="finding-evidence">at ${escapeHtml(location.file)}${location.line === undefined ? '' : `:${String(location.line)}`}</span>`
  return [
    `<li class="finding finding-${escapeHtml(finding.severity)}">`,
    `<strong class="finding-severity">${escapeHtml(finding.severity)}</strong>`,
    ` <code>${escapeHtml(finding.ruleId)}</code>`,
    ` ${escapeHtml(finding.title)}`,
    ` — ${escapeHtml(finding.message)}`,
    where,
    '</li>',
  ].join('')
}

function maintenanceLabel(maintenance: RegistryMaintenance): string {
  const namespace = maintenance.namespace === undefined ? '' : `${maintenance.namespace}/`
  const revision = maintenance.revision === undefined ? '' : `@${maintenance.revision}`
  return `${maintenance.provider}:${namespace}${maintenance.project}${revision}`
}

function renderSource(entry: RegistryEntry): string {
  const spec = parseSourceSafe(entry.source)
  if (spec !== undefined && spec.kind === 'github') {
    const url = `https://github.com/${spec.owner}/${spec.repo}`
    return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>`
  }
  if (spec !== undefined && spec.kind === 'npm') {
    const url = `https://www.npmjs.com/package/${spec.name}`
    return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>`
  }
  return `<code>${escapeHtml(entry.source)}</code>`
}

function renderInlineList(values: string[], emptyLabel: string): string {
  if (values.length === 0) return escapeHtml(emptyLabel)
  return values.map(value => escapeHtml(value)).join(', ')
}

function renderFilterSection(entries: RegistryEntry[]): string {
  const options = filterOptions(entries)
  const select = (id: string, values: string[]): string => [
    `<select id="${id}" name="${id.replace(/^filter-/, '')}">`,
    '<option value="">All</option>',
    ...values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`),
    '</select>',
  ].join('')
  const field = (id: string, label: string, control: string): string =>
    `<div class="filter"><label for="${id}">${label}</label>${control}</div>`
  return [
    '<section class="filters" aria-labelledby="filters-heading">',
    '<h2 id="filters-heading">Filter plugins</h2>',
    '<div class="filter-grid">',
    field('filter-name', 'Search', '<input id="filter-name" name="name" type="search" placeholder="Name or description" autocomplete="off">'),
    field('filter-category', 'Category', select('filter-category', options.categories)),
    field('filter-declaration', 'Declaration type', select('filter-declaration', options.declarations)),
    field('filter-verdict', 'Verdict', select('filter-verdict', options.verdicts)),
    field('filter-severity', 'Severity', select('filter-severity', options.severities)),
    field('filter-source', 'Source kind', select('filter-source', options.sources)),
    field('filter-version', 'Tested DSH version', select('filter-version', options.versions)),
    '<div class="filter"><button type="button" id="filter-reset">Reset filters</button></div>',
    '</div>',
    '</section>',
  ].join('')
}

interface FilterOptions {
  categories: string[]
  declarations: string[]
  verdicts: string[]
  severities: string[]
  sources: string[]
  versions: string[]
}

function filterOptions(entries: RegistryEntry[]): FilterOptions {
  return {
    categories: uniqueSorted(entries.map(entry => entry.category)),
    declarations: uniqueSorted(entries.flatMap(entry => entry.declarationTypes)),
    verdicts: uniqueSorted(entries.map(entry => entry.verdict ?? 'unavailable')),
    severities: uniqueSorted(entries.map(entry => worstSeverity(entry.findings))),
    sources: uniqueSorted(entries.map(entry => entry.sourceKind)),
    versions: uniqueSorted(entries.flatMap(entry => entry.testedDshVersions)),
  }
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  const unique = new Set<string>()
  for (const value of values) if (value !== undefined && value !== '') unique.add(value)
  return [...unique].sort()
}

function reportPath(entry: RegistryEntry): string {
  return entry.reportPath ?? `reports/${entry.slug}.json`
}

function parseSourceSafe(source: string): SourceSpec | undefined {
  try {
    return parseSourceSpec(source)
  } catch {
    return undefined
  }
}
