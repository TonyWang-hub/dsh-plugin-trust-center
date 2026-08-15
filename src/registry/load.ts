import { readFile } from 'node:fs/promises'
import type { RegistrySource } from './model.js'
import { REGISTRY_SCHEMA_VERSION } from './model.js'

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const DSH_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const NPM_NAME_PATTERN = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LOCAL_PATH_PATTERN = /^[^\s:]+$/
const GITHUB_SHA_PATTERN = /^[0-9a-fA-F]{40}$/

const KNOWN_FIELDS = new Set(['slug', 'source', 'name', 'description', 'category', 'testedDshVersions'])

/**
 * Validates a registry source spec. Registry declarations are stricter than
 * general Stage 1 acquisition specs: mutable npm ranges/dist-tags and GitHub
 * branch/tag refs are rejected so every declaration resolves deterministically.
 * Local sources use Stage 1's native bare-path form, which `inspectSource`
 * resolves directly.
 */
export function validateRegistrySourceSpec(input: string): void {
  if (input.startsWith('npm:')) {
    const rest = input.slice(4)
    const versionAt = rest.startsWith('@') ? rest.lastIndexOf('@') : rest.indexOf('@')
    const slashAt = rest.indexOf('/')
    if (versionAt <= (rest.startsWith('@') ? slashAt : -1)) {
      throw new Error(`registry npm source must pin an exact version: ${input}`)
    }
    const name = rest.slice(0, versionAt)
    const version = rest.slice(versionAt + 1)
    if (!NPM_NAME_PATTERN.test(name)) throw new Error(`registry npm source name is invalid: ${input}`)
    if (!SEMVER_PATTERN.test(version)) {
      throw new Error(`registry npm source must pin an exact version: ${input}`)
    }
    return
  }

  if (input.startsWith('github:')) {
    const rest = input.slice(7)
    const refAt = rest.indexOf('#')
    if (refAt < 0) {
      throw new Error(`registry GitHub source must pin an immutable 40-character commit SHA: ${input}`)
    }
    const repo = rest.slice(0, refAt)
    const ref = rest.slice(refAt + 1)
    if (!GITHUB_REPO_PATTERN.test(repo)) throw new Error(`registry GitHub source is invalid: ${input}`)
    if (!GITHUB_SHA_PATTERN.test(ref)) {
      throw new Error(`registry GitHub ref must be an immutable 40-character commit SHA: ${input}`)
    }
    return
  }

  if (!LOCAL_PATH_PATTERN.test(input)) {
    throw new Error(
      `registry source must be a local path, an exact npm version, or an immutable GitHub commit: ${input}`,
    )
  }
}

/**
 * Loads, validates, and normalizes a registry source document. Records are
 * returned sorted by slug so every consumer observes the same canonical
 * ordering. The document is validated structurally here and against the
 * published JSON Schema by the test suite; no fields are generated.
 */
export async function loadRegistrySources(path: string): Promise<RegistrySource[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read registry sources: ${error instanceof Error ? error.message : String(error)}`)
  }

  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`registry sources are not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`registry sources must be a document object: ${path}`)
  }
  const record = document as Record<string, unknown>
  const unknownDocumentFields = Object.keys(record).filter(key => key !== 'schemaVersion' && key !== 'sources')
  if (unknownDocumentFields.length > 0) {
    throw new Error(`registry sources document has unknown fields: ${unknownDocumentFields.join(', ')}`)
  }
  if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`unsupported registry schema version: ${String(record.schemaVersion)}`)
  }
  if (!Array.isArray(record.sources)) throw new Error('registry sources document is missing the sources array')
  if (record.sources.length > 500) throw new Error('registry sources document exceeds 500 entries')

  const normalized: RegistrySource[] = []
  const seenSlugs = new Set<string>()
  for (const entry of record.sources) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('registry source entry must be an object')
    }
    const source = entry as Record<string, unknown>
    const unknown = Object.keys(source).filter(key => !KNOWN_FIELDS.has(key))
    if (unknown.length > 0) {
      throw new Error(`registry source entry has unknown fields: ${unknown.join(', ')}`)
    }
    if (typeof source.slug !== 'string' || source.slug.length > 64 || !SLUG_PATTERN.test(source.slug)) {
      throw new Error(`registry source slug is invalid: ${String(source.slug)}`)
    }
    if (typeof source.source !== 'string') throw new Error('registry source spec must be a string')
    validateRegistrySourceSpec(source.source)
    if (typeof source.name !== 'string' || source.name.length === 0 || source.name.length > 200) {
      throw new Error('registry source name must be a non-empty string of at most 200 characters')
    }
    if (seenSlugs.has(source.slug)) throw new Error(`duplicate registry slug: ${source.slug}`)
    seenSlugs.add(source.slug)

    if (source.description !== undefined && (typeof source.description !== 'string'
      || source.description.length === 0 || source.description.length > 500)) {
      throw new Error('registry source description must be a non-empty string of at most 500 characters when present')
    }
    if (source.category !== undefined && (typeof source.category !== 'string'
      || source.category.length === 0 || source.category.length > 100)) {
      throw new Error('registry source category must be a non-empty string of at most 100 characters when present')
    }
    if (source.testedDshVersions !== undefined && !Array.isArray(source.testedDshVersions)) {
      throw new Error('registry source testedDshVersions must be an array when present')
    }
    if (Array.isArray(source.testedDshVersions) && source.testedDshVersions.length > 100) {
      throw new Error('registry source testedDshVersions exceeds 100 entries')
    }

    normalized.push({
      slug: source.slug,
      source: source.source,
      name: source.name,
      ...(source.description !== undefined ? { description: source.description } : {}),
      ...(source.category !== undefined ? { category: source.category } : {}),
      ...(Array.isArray(source.testedDshVersions)
        ? { testedDshVersions: normalizeTestedDshVersions(source.testedDshVersions, source.slug) }
        : {}),
    })
  }

  return normalized.sort(compareBySlug)
}

function normalizeTestedDshVersions(versions: unknown[], slug: string): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const version of versions) {
    if (typeof version !== 'string' || !DSH_VERSION_PATTERN.test(version)) {
      throw new Error(`registry source ${slug} has an invalid tested DSH version: ${String(version)}`)
    }
    if (seen.has(version)) throw new Error(`registry source ${slug} repeats a tested DSH version: ${version}`)
    seen.add(version)
    normalized.push(version)
  }
  return normalized
}

function compareBySlug(a: RegistrySource, b: RegistrySource): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
}
