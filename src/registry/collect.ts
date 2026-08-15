import { parseSourceSpec } from '../acquire.js'
import type { InspectSourceOptions, Passport } from '../model.js'
import { inspectSource } from '../passport.js'
import type { RegistrySource } from './model.js'

const DEFAULT_CONCURRENCY = 4

export type RegistryStatus = 'verified-package' | 'candidate' | 'incompatible' | 'unavailable'

export interface RegistryMaintenance {
  provider: 'github' | 'npm' | 'local'
  namespace?: string
  project: string
  revision?: string
}

/**
 * One collected registry record. Successful records pin the immutable
 * resolved revision, digest, and full Passport; failed scans become explicit
 * `unavailable` records carrying only the error. Records never label a plugin
 * `safe`.
 */
export interface RegistryReport {
  slug: string
  /** The declared source spec exactly as reviewed. */
  source: string
  /** Deterministic provider namespace/project coordinates, without popularity ranking. */
  maintenance: RegistryMaintenance
  status: RegistryStatus
  testedDshVersions: string[]
  /** Immutable resolved revision, present when acquisition resolved. */
  resolved?: string
  /** SHA-256 package digest, present when inspection succeeded. */
  digest?: string
  passport?: Passport
  error?: string
}

export interface CollectOptions {
  /** Maximum number of sources inspected concurrently. Defaults to 4. */
  concurrency?: number
  /** Stage 1 inspection API; defaults to `inspectSource`. Never a CLI subprocess. */
  inspect?: typeof inspectSource
  /** Options forwarded to the Stage 1 inspection API. */
  inspectOptions?: InspectSourceOptions
}

/**
 * Maps a Passport verdict to a registry status. `pass` becomes
 * `verified-package`, `review` becomes `candidate`, and `fail` becomes
 * `incompatible`; there is no `safe` label.
 */
export function deriveRegistryStatus(passport: Passport): Exclude<RegistryStatus, 'unavailable'> {
  switch (passport.verdict.status) {
    case 'pass':
      return 'verified-package'
    case 'review':
      return 'candidate'
    case 'fail':
      return 'incompatible'
  }
}

/**
 * Collects registry evidence for every source independently with bounded
 * concurrency. One failed source yields an explicit `unavailable` record and
 * never blocks the others. Reports are returned in canonical slug order with
 * no timestamps, so identical inputs always produce identical output.
 */
export async function collectRegistry(
  sources: RegistrySource[],
  options: CollectOptions = {},
): Promise<RegistryReport[]> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`registry collection concurrency must be a positive integer, got ${String(concurrency)}`)
  }
  const inspect = options.inspect ?? inspectSource
  const inspectOptions = options.inspectOptions

  const reports: RegistryReport[] = []
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= sources.length) return
      const record = sources[index]
      if (record === undefined) return
      reports.push(await collectOne(record, inspect, inspectOptions))
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, () => worker())
  await Promise.all(workers)

  return reports.sort(compareBySlug)
}

async function collectOne(
  source: RegistrySource,
  inspect: typeof inspectSource,
  inspectOptions: InspectSourceOptions | undefined,
): Promise<RegistryReport> {
  const testedDshVersions = source.testedDshVersions ?? []
  try {
    const passport = await inspect(source.source, inspectOptions)
    return {
      slug: source.slug,
      source: source.source,
      maintenance: deriveMaintenance(passport.subject.kind === 'local' ? source.source : passport.subject.resolved),
      status: deriveRegistryStatus(passport),
      resolved: passport.subject.resolved,
      digest: passport.subject.digest,
      testedDshVersions,
      passport,
    }
  } catch (error) {
    return {
      slug: source.slug,
      source: source.source,
      maintenance: deriveMaintenance(source.source),
      status: 'unavailable',
      testedDshVersions,
      error: publicErrorMessage(error),
    }
  }
}

function deriveMaintenance(source: string): RegistryMaintenance {
  const spec = parseSourceSpec(source)
  if (spec.kind === 'github') {
    return { provider: 'github', namespace: spec.owner, project: spec.repo, revision: spec.ref }
  }
  if (spec.kind === 'npm') {
    const slash = spec.name.indexOf('/')
    return {
      provider: 'npm',
      ...(slash < 0 ? {} : { namespace: spec.name.slice(0, slash) }),
      project: slash < 0 ? spec.name : spec.name.slice(slash + 1),
      revision: spec.version,
    }
  }
  const parts = spec.path.replaceAll('\\', '/').split('/').filter(part => part !== '')
  return { provider: 'local', project: parts.at(-1) ?? spec.path }
}

function publicErrorMessage(error: unknown): string {
  let message = (error instanceof Error ? error.message : String(error)).replaceAll(process.cwd(), '.')
  const home = process.env['HOME']
  if (home !== undefined) message = message.replaceAll(home, '~')
  const redacted = message.replace(/\/(?:private\/var|tmp)\/[^\s'"]+/g, '<temporary-path>')
  return redacted.length <= 1_000 ? redacted : `${redacted.slice(0, 999)}…`
}

function compareBySlug(a: RegistryReport, b: RegistryReport): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
}
