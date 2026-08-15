import { readFile } from 'node:fs/promises'
import Ajv2020Import from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { inspectSource } from '../src/index.js'

const Ajv2020 = Ajv2020Import as unknown as new (options?: { allErrors?: boolean }) => {
  compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown }
}

async function schema(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile('schemas/passport.schema.json', 'utf8')) as Record<string, unknown>
}

describe('Passport JSON Schema', () => {
  it('accepts generated Passports and rejects unknown fields', async () => {
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile(await schema())
    const passport = await inspectSource('test/fixtures/safe-bundle')

    expect(validate(passport), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ ...passport, unexpected: true })).toBe(false)
  })

  it('accepts review and fail Passports, including normalized client evidence', async () => {
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile(await schema())
    for (const fixture of ['risky-bundle', 'invalid-bundle', 'duplicate-client', 'no-manifest']) {
      const passport = await inspectSource(`test/fixtures/${fixture}`)
      expect(validate(passport), `${fixture}: ${JSON.stringify(validate.errors)}`).toBe(true)
    }
  })

  it('exports every published schema from the package', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      exports: Record<string, unknown>
    }

    expect(manifest.exports).toMatchObject({
      './schema': './schemas/passport.schema.json',
      './schema/passport': './schemas/passport.schema.json',
      './schema/registry-source': './schemas/registry-source.schema.json',
      './schema/registry-report': './schemas/registry-report.schema.json',
    })
  })

  it('publishes a stable identity and version', async () => {
    const document = await schema()

    expect(document.$id).toBe('https://tonywang-hub.github.io/dsh-plugin-trust-center/schemas/passport.schema.json')
    expect(document.title).toBe('DSH Plugin Passport 1.0.0')
  })
})
