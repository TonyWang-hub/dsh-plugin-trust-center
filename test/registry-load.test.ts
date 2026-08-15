import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020Import from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { loadRegistrySources, validateRegistrySourceSpec } from '../src/registry/load.js'
import type { RegistryDocument } from '../src/registry/model.js'

const Ajv2020 = Ajv2020Import as unknown as new (options?: { allErrors?: boolean }) => {
  compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown }
}

const SEED_PATH = 'test/fixtures/registry/sources.json'
const SCHEMA_PATH = 'schemas/registry-source.schema.json'

const VALID_SPECS = [
  'test/fixtures/registry/example-bundle',
  './relative/path',
  '/absolute/path',
  'npm:lodash@4.17.21',
  'npm:@scope/pkg@1.2.3',
  'npm:pkg@1.2.3-beta.1+build.5',
  'github:owner/repo#0123456789abcdef0123456789abcdef01234567',
  'github:TonyWang-hub/dsh-plugin-trust-center#ABCDEF0123456789abcdef0123456789abcdef01',
] as const

const INVALID_SPECS = [
  'local:test/fixtures/registry/example-bundle',
  'local:',
  'local:with space',
  'with space',
  'npm:pkg',
  'npm:pkg@latest',
  'npm:pkg@^1.2.3',
  'npm:pkg@~1.2.3',
  'npm:pkg@1.2.x',
  'npm:PKG@1.2.3',
  'npm:@scope@1.2.3',
  'github:owner/repo',
  'github:owner/repo#main',
  'github:owner/repo#v1.2.3',
  'github:owner/repo#abcd',
  'github:owner/repo#not-a-sha-not-a-sha-not-a-sha-',
  'https://example.com/x',
] as const

function documentWithSources(sources: unknown[]): RegistryDocument {
  return { schemaVersion: '1.0.0', sources: sources as RegistryDocument['sources'] }
}

async function withTempDocument(document: unknown, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-trust-registry-'))
  try {
    const path = join(dir, 'sources.json')
    await writeFile(path, JSON.stringify(document))
    await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function schema(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(SCHEMA_PATH, 'utf8')) as Record<string, unknown>
}

describe('validateRegistrySourceSpec', () => {
  it('accepts local, exact npm versions, and immutable 40-character GitHub refs', () => {
    for (const spec of VALID_SPECS) {
      expect(() => validateRegistrySourceSpec(spec), spec).not.toThrow()
    }
  })

  it('rejects mutable, malformed, or ambiguous source specs', () => {
    for (const spec of INVALID_SPECS) {
      expect(() => validateRegistrySourceSpec(spec), spec).toThrow()
    }
  })
})

describe('loadRegistrySources', () => {
  it('loads and normalizes the shipped seed file deterministically', async () => {
    const records = await loadRegistrySources(SEED_PATH)

    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record).toBeDefined()
    if (record === undefined) throw new Error('seed file produced no records')
    expect(Object.keys(record)).toEqual(['slug', 'source', 'name', 'description', 'category', 'testedDshVersions'])
    expect(record.slug).toBe('example-bundle')
    expect(record.source).toBe('test/fixtures/registry/example-bundle')
    expect(record.name).toBe('Example Bundle')
    expect(record.category).toBe('test')
    expect(record.testedDshVersions).toEqual([])
  })

  it('ships only immutable network declarations in the public registry', async () => {
    const records = await loadRegistrySources('registry/sources.json')

    expect(records.map(record => record.slug)).toEqual(['deepseek-ai-dsh-base', 'dsh-plugin-sentinel'])
    expect(records.every(record => record.source.startsWith('npm:') || record.source.startsWith('github:'))).toBe(true)
  })

  it('returns records sorted by slug regardless of declaration order', async () => {
    const document = documentWithSources([
      { slug: 'zulu', source: 'z', name: 'Zulu' },
      { slug: 'alpha', source: 'npm:alpha@1.0.0', name: 'Alpha' },
      { slug: 'bravo', source: 'b', name: 'Bravo' },
    ])

    await withTempDocument(document, async path => {
      const records = await loadRegistrySources(path)
      expect(records.map(record => record.slug)).toEqual(['alpha', 'bravo', 'zulu'])
    })
  })

  it('rejects duplicate slugs', async () => {
    const document = documentWithSources([
      { slug: 'dup', source: 'a', name: 'First' },
      { slug: 'dup', source: 'b', name: 'Second' },
    ])

    await withTempDocument(document, async path => {
      await expect(loadRegistrySources(path)).rejects.toThrow(/duplicate.*slug/i)
    })
  })

  it('rejects a record with an unknown field', async () => {
    const document = documentWithSources([
      { slug: 'a', source: 'a', name: 'A', generated: true },
    ])

    await withTempDocument(document, async path => {
      await expect(loadRegistrySources(path)).rejects.toThrow(/unknown field/i)
    })
  })

  it('rejects a record whose source spec is mutable or malformed', async () => {
    const document = documentWithSources([
      { slug: 'a', source: 'npm:pkg@latest', name: 'A' },
    ])

    await withTempDocument(document, async path => {
      await expect(loadRegistrySources(path)).rejects.toThrow(/exact/i)
    })
  })

  it('rejects documents without a recognized schema version or sources array', async () => {
    const documents: unknown[] = [
      { sources: [] },
      { schemaVersion: '9.9.9', sources: [] },
      { schemaVersion: '1.0.0' },
      { schemaVersion: '1.0.0', sources: {} },
      { schemaVersion: '1.0.0', sources: [{ slug: 'a', source: 'a' }] },
      { schemaVersion: '1.0.0', sources: [{ slug: 'Bad Slug', source: 'a', name: 'A' }] },
    ]

    for (const document of documents) {
      await withTempDocument(document, async path => {
        await expect(loadRegistrySources(path), JSON.stringify(document)).rejects.toThrow()
      })
    }
  })

  it('enforces the published schema bounds in the runtime loader', async () => {
    const documents: unknown[] = [
      { schemaVersion: '1.0.0', sources: [], extra: true },
      documentWithSources([{ slug: 'a'.repeat(65), source: 'a', name: 'A' }]),
      documentWithSources([{ slug: 'a', source: 'a', name: 'A'.repeat(201) }]),
      documentWithSources([{ slug: 'a', source: 'a', name: 'A', description: 'd'.repeat(501) }]),
      documentWithSources([{ slug: 'a', source: 'a', name: 'A', category: 'c'.repeat(101) }]),
      documentWithSources([{ slug: 'a', source: 'a', name: 'A', testedDshVersions: '1.0.0' }]),
      documentWithSources([{ slug: 'a', source: 'a', name: 'A', testedDshVersions: Array(101).fill('1.0.0') }]),
      documentWithSources(Array.from({ length: 501 }, (_, index) => ({
        slug: `plugin-${String(index)}`,
        source: `plugin-${String(index)}`,
        name: `Plugin ${String(index)}`,
      }))),
    ]

    for (const document of documents) {
      await withTempDocument(document, async path => {
        await expect(loadRegistrySources(path), JSON.stringify(document).slice(0, 200)).rejects.toThrow()
      })
    }
  })

  it('rejects invalid JSON with a descriptive error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-trust-registry-'))
    try {
      const path = join(dir, 'sources.json')
      await writeFile(path, '{ not json')
      await expect(loadRegistrySources(path)).rejects.toThrow(/not valid JSON/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('published registry-source JSON Schema', () => {
  it('accepts the shipped seed file and rejects unknown fields', async () => {
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile(await schema())
    const seed = JSON.parse(await readFile(SEED_PATH, 'utf8')) as unknown

    expect(validate(seed), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ schemaVersion: '1.0.0', sources: [{ slug: 'a', source: 'a', name: 'A' }], extra: true }))
      .toBe(false)
  })

  it('rejects duplicate and malformed declarations', async () => {
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile(await schema())
    const invalidDocuments = [
      documentWithSources([
        { slug: 'a', source: 'a', name: 'A' },
        { slug: 'a', source: 'a', name: 'A' },
      ]),
      documentWithSources([{ slug: 'a', source: 'npm:pkg@latest', name: 'A' }]),
      documentWithSources([{ slug: 'a', source: 'github:o/r#main', name: 'A' }]),
      documentWithSources([{ slug: 'a', source: 'a', name: 'A', unexpected: true }]),
    ]

    for (const document of invalidDocuments) {
      expect(validate(document), JSON.stringify(validate.errors)).toBe(false)
    }
  })

  it('publishes a stable identity and version', async () => {
    const document = await schema()

    expect(document.$id).toBe('https://tonywang-hub.github.io/dsh-plugin-trust-center/schemas/registry-source.schema.json')
    expect(document.title).toBe('DSH Community Registry Sources 1.0.0')
  })

  it('agrees with the code validator on every source spec', async () => {
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile(await schema())
    const allSpecs = [...VALID_SPECS, ...INVALID_SPECS]

    for (const spec of allSpecs) {
      const acceptedBySchema = validate(documentWithSources([{ slug: 'a', source: spec, name: 'A' }]))
      let acceptedByCode = true
      try {
        validateRegistrySourceSpec(spec)
      } catch {
        acceptedByCode = false
      }
      expect(acceptedByCode, `code disagrees with schema for ${spec}`).toBe(acceptedBySchema)
    }
  })
})
