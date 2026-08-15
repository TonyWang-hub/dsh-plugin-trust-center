import type { ManifestEvidence, SbomComponent, SbomDocument, SbomScope } from './model.js'

const DIRECT_GROUPS = ['runtime', 'dev', 'optional', 'peer'] as const

/**
 * Builds a deterministic CycloneDX 1.6 document of the manifest's direct
 * dependencies. Output is stable: components are deduplicated by purl and
 * sorted, and no timestamps or serial numbers are emitted.
 */
export function buildSbom(manifest: ManifestEvidence): SbomDocument {
  const components: SbomComponent[] = []
  const seen = new Set<string>()

  for (const group of DIRECT_GROUPS) {
    const scope: SbomScope = group === 'optional' ? 'optional' : group === 'dev' ? 'excluded' : 'required'
    for (const [name, version] of Object.entries(manifest.dependencies[group])) {
      const purl = buildPurl(name, version)
      const key = purl ?? `${name}@${version}`
      if (seen.has(key)) continue
      seen.add(key)
      components.push({
        type: 'library',
        name,
        ...(version !== '' ? { version } : {}),
        scope,
        ...(purl !== null ? { purl } : {}),
      })
    }
  }
  components.sort(compareComponents)

  const rootPurl = manifest.packageName !== undefined
    ? buildPurl(manifest.packageName, manifest.packageVersion ?? '')
    : null
  const metadata: SbomDocument['metadata'] = manifest.packageName !== undefined
    ? {
        component: {
          type: 'application',
          name: manifest.packageName,
          ...(manifest.packageVersion !== undefined ? { version: manifest.packageVersion } : {}),
          ...(rootPurl !== null ? { purl: rootPurl } : {}),
        },
      }
    : {}
  const dependencies = rootPurl !== null
    ? [{ ref: rootPurl, dependsOn: components.map(c => c.purl ?? `${c.name}@${c.version ?? ''}`) }]
    : []

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata,
    components,
    dependencies,
  }
}

function buildPurl(name: string, version: string): string | null {
  if (name === '') return null
  const slash = name.startsWith('@') ? name.indexOf('/') : -1
  const encoded = slash > 1
    ? `%40${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(name.slice(slash + 1))}`
    : encodeURIComponent(name)
  return version === '' ? `pkg:npm/${encoded}` : `pkg:npm/${encoded}@${encodeURIComponent(version)}`
}

function compareComponents(a: SbomComponent, b: SbomComponent): number {
  return compare(a.name, b.name)
    || compare(a.version ?? '', b.version ?? '')
    || compare(a.purl ?? '', b.purl ?? '')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
