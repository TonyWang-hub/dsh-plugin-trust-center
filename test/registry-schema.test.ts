import { readFile } from 'node:fs/promises'
import Ajv2020Import from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { collectRegistry } from '../src/registry/collect.js'
import type { RegistrySource } from '../src/registry/model.js'

const Ajv2020 = Ajv2020Import as unknown as new (options: { allErrors: boolean; schemas: unknown[] }) => {
  compile(schema: unknown): ((value: unknown) => boolean) & { errors?: unknown }
}

function source(slug: string, path: string): RegistrySource {
  return { slug, source: path, name: slug }
}

describe('registry report schema', () => {
  it('validates successful and unavailable records and rejects ambiguous records', async () => {
    const schema = JSON.parse(await readFile('schemas/registry-report.schema.json', 'utf8')) as unknown
    const passportSchema = JSON.parse(await readFile('schemas/passport.schema.json', 'utf8')) as unknown
    const validate = new Ajv2020({ allErrors: true, schemas: [passportSchema] }).compile(schema)
    const reports = await collectRegistry([
      source('available', 'test/fixtures/safe-bundle'),
      source('unavailable', 'missing-registry-source'),
    ])

    for (const report of reports) {
      expect(validate(report), `${report.slug}: ${JSON.stringify(validate.errors)}`).toBe(true)
    }
    expect(validate({
      ...reports[0],
      status: 'unavailable',
      error: 'failed',
    })).toBe(false)
  })
})
