/**
 * Stage 2 static-site generator: composes deterministic, byte-identical output
 * maps (HTML index, per-plugin detail pages, index.json, and badges) from
 * minimal registry records. It never writes files itself and contains no
 * timestamps or environment-derived content.
 */

import {
  badgeStatusForVerdict,
  renderBadgeSvg,
  renderShieldsEndpoint,
} from '../registry/badges.js'
import {
  jsonForScript,
  renderDetailPage,
  renderFilterData,
  renderIndexPage,
} from './templates.js'
import type { RegistryEntry } from './templates.js'

export type { RegistryEntry, RegistryFinding } from './templates.js'

export interface BuildSiteOptions {
  /** Static assets (e.g. `style.css`, `filter.js`) copied verbatim into the map. */
  assets?: Record<string, string>
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Builds the complete site artifact map for the given registry entries.
 * Identical inputs always produce byte-identical output.
 */
export function buildSite(entries: RegistryEntry[], options: BuildSiteOptions = {}): Record<string, string> {
  const normalized = entries.map(normalizeEntry)
  validateSlugs(normalized)
  const sorted = [...normalized].sort((a, b) => a.slug.localeCompare(b.slug))
  const filterData = renderFilterData(sorted)

  const pairs: Array<[string, string]> = sorted.flatMap(entry => {
    const badgeOptions = entry.digest === undefined ? {} : { digest: entry.digest }
    const verdict = entry.verdict === undefined ? undefined : { status: entry.verdict }
    const status = badgeStatusForVerdict(verdict)
    return [
      [`detail/${entry.slug}.html`, renderDetailPage(entry)],
      [`badges/${entry.slug}.svg`, renderBadgeSvg(status, badgeOptions)],
      [`badges/${entry.slug}.shields.json`, renderShieldsEndpoint(status, badgeOptions)],
    ]
  })

  const files: Record<string, string> = {
    'index.html': renderIndexPage({ entries: sorted, filterData: jsonForScript(filterData) }),
    'index.json': `${filterData}\n`,
    ...Object.fromEntries(pairs),
    ...options.assets,
  }
  return files
}

function normalizeEntry(entry: RegistryEntry): RegistryEntry {
  return {
    ...entry,
    declarationTypes: entry.declarationTypes ?? [],
    testedDshVersions: entry.testedDshVersions ?? [],
    findings: entry.findings ?? [],
  }
}

function validateSlugs(entries: RegistryEntry[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!SLUG_PATTERN.test(entry.slug)) {
      throw new Error(`invalid registry slug: ${entry.slug}`)
    }
    if (seen.has(entry.slug)) {
      throw new Error(`duplicate registry slug: ${entry.slug}`)
    }
    seen.add(entry.slug)
  }
}
