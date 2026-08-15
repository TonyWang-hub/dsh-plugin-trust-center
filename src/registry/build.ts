import { realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSourceSpec } from '../acquire.js'
import { canonicalJson } from '../passport.js'
import { buildSite } from '../site/generate.js'
import type { RegistryEntry } from '../site/generate.js'
import { checkSite } from '../site/check.js'
import { collectRegistry } from './collect.js'
import type { CollectOptions, RegistryReport } from './collect.js'
import { loadRegistrySources } from './load.js'
import type { RegistrySource } from './model.js'

export interface BuildRegistryOptions {
  sourcePath?: string
  outputDir?: string
  concurrency?: number
  inspect?: CollectOptions['inspect']
}

export interface BuildRegistryResult {
  reports: RegistryReport[]
  files: number
  digest: string
}

export interface RegistryBuildIo {
  stdout(line: string): void
  stderr(line: string): void
}

export function validateOutputDirectory(path: string): string {
  const output = resolve(path)
  if (output === parse(output).root || output === process.cwd() || process.cwd().startsWith(`${output}${sep}`)) {
    throw new Error(`unsafe registry output directory: ${output}`)
  }
  return output
}

export async function buildRegistry(options: BuildRegistryOptions = {}): Promise<BuildRegistryResult> {
  const sourcePath = options.sourcePath ?? 'registry/sources.json'
  const outputDir = validateOutputDirectory(options.outputDir ?? 'public')

  const sources = await loadRegistrySources(sourcePath)
  const collectOptions: CollectOptions = {
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
  }
  const reports = await collectRegistry(sources, collectOptions)
  const entries = reports.map(report => toSiteEntry(sourceFor(report.slug, sources), report))
  const assets = {
    'style.css': await readFile(new URL('../../site/style.css', import.meta.url), 'utf8'),
    'filter.js': await readFile(new URL('../../site/filter.js', import.meta.url), 'utf8'),
  }
  const output: Record<string, string> = {
    ...buildSite(entries, { assets }),
    ...Object.fromEntries(reports.map(report => [`reports/${report.slug}.json`, `${canonicalJson(report)}\n`])),
    'schemas/passport.schema.json': await readFile(new URL('../../schemas/passport.schema.json', import.meta.url), 'utf8'),
    'schemas/registry-source.schema.json': await readFile(new URL('../../schemas/registry-source.schema.json', import.meta.url), 'utf8'),
    'schemas/registry-report.schema.json': await readFile(new URL('../../schemas/registry-report.schema.json', import.meta.url), 'utf8'),
    '.nojekyll': '',
  }

  await rm(outputDir, { recursive: true, force: true })
  for (const path of Object.keys(output).sort()) {
    const target = join(outputDir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, output[path] ?? '')
  }

  const checked = await checkSite(outputDir)
  return { reports, files: checked.files, digest: checked.digest }
}

export async function runRegistryBuildCli(
  args: string[],
  io: RegistryBuildIo = {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  try {
    const result = await buildRegistry({
      ...(args[0] === undefined ? {} : { sourcePath: args[0] }),
      ...(args[1] === undefined ? {} : { outputDir: args[1] }),
    })
    io.stdout(JSON.stringify({ reports: result.reports.length, files: result.files, digest: result.digest }))
    return 0
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function sourceFor(slug: string, sources: RegistrySource[]): RegistrySource {
  const source = sources.find(candidate => candidate.slug === slug)
  if (source === undefined) throw new Error(`registry report has no source declaration: ${slug}`)
  return source
}

function toSiteEntry(source: RegistrySource, report: RegistryReport): RegistryEntry {
  const subjectKind = report.passport?.subject.kind ?? parseSourceSpec(source.source).kind
  const revision = revisionFromResolved(report.resolved)
  const declarationTypes = report.passport === undefined
    ? []
    : (['bundle', 'client', 'profile'] as const).filter(key => report.passport?.dsh[key] !== undefined)
  return {
    slug: source.slug,
    name: source.name,
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.category === undefined ? {} : { category: source.category }),
    source: source.source,
    sourceKind: subjectKind,
    maintenance: report.maintenance,
    ...(revision === undefined ? {} : { revision }),
    status: report.status,
    ...(report.passport === undefined ? {} : { verdict: report.passport.verdict.status }),
    ...(report.digest === undefined ? {} : { digest: report.digest }),
    declarationTypes,
    testedDshVersions: report.testedDshVersions,
    findings: report.passport?.findings ?? [],
    reportPath: `reports/${source.slug}.json`,
  }
}

function revisionFromResolved(resolved: string | undefined): string | undefined {
  if (resolved === undefined) return undefined
  const spec = parseSourceSpec(resolved)
  if (spec.kind === 'npm') return spec.version
  if (spec.kind === 'github') return spec.ref
  return undefined
}

function isDirectInvocation(argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false
  try {
    return pathToFileURL(realpathSync(argvPath)).href === import.meta.url
  } catch {
    return false
  }
}

if (isDirectInvocation(process.argv[1])) {
  void runRegistryBuildCli(process.argv.slice(2)).then(code => { process.exitCode = code })
}
