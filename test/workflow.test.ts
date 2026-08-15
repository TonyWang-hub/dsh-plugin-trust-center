import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

async function workflow(name: string): Promise<Record<string, unknown>> {
  return parse(await readFile(`.github/workflows/${name}`, 'utf8')) as Record<string, unknown>
}

describe('GitHub workflows', () => {
  it('keeps CI least-privilege and runs the complete acceptance surface', async () => {
    const document = await workflow('ci.yml')
    expect(document.permissions).toEqual({ contents: 'read' })
    expect(JSON.stringify(document)).not.toMatch(/secrets\./)
    expect(JSON.stringify(document)).toContain('pnpm lint')
    expect(JSON.stringify(document)).toContain('pnpm typecheck')
    expect(JSON.stringify(document)).toContain('pnpm test')
    expect(JSON.stringify(document)).toContain('pnpm build')
    expect(JSON.stringify(document)).toContain('pnpm registry:build')
    expect(JSON.stringify(document)).toContain('pnpm site:check')
    expect(JSON.stringify(document)).toContain('pnpm pack')
  })

  it('makes third-party execution manual, explicit, secret-free, and time-bounded', async () => {
    const document = await workflow('verify-plugin.yml')
    const serialized = JSON.stringify(document)
    expect(document.permissions).toEqual({})
    expect(serialized).toContain('workflow_dispatch')
    expect(serialized).not.toContain('pull_request')
    expect(serialized).not.toMatch(/secrets\./)
    expect(serialized).toContain('allow_execute')
    expect(serialized).toContain('timeout-minutes')
    expect(serialized).toContain("inputs.allow_execute == true")
    expect(serialized).not.toContain('actions/checkout')
    expect(serialized).toContain('git clone --depth 1 https://github.com/${{ github.repository }}.git .')
    expect(serialized).not.toContain('inspect \\"${{ inputs.source }}\\"')
    expect(serialized).toContain('DSH_TRUST_SOURCE')
    expect(serialized).toContain('2) exit 0')
    expect(serialized).toContain('3) exit 3')
    expect(serialized).toContain('DSH_TRUST_RESOLVED')
    expect(serialized).toContain('verify-import \\"$DSH_TRUST_RESOLVED\\"')
    expect(serialized).toContain('npm:*|github:*')
  })

  it('refreshes only static evidence on scheduled or manual runs', async () => {
    const document = await workflow('registry.yml')
    const serialized = JSON.stringify(document)
    expect(document.permissions).toEqual({ contents: 'write' })
    expect(serialized).toContain('schedule')
    expect(serialized).toContain('workflow_dispatch')
    expect(serialized).not.toContain('pull_request')
    expect(serialized).not.toContain('verify-import')
    expect(serialized).not.toMatch(/secrets\./)
    expect(serialized).toContain('pnpm registry:build')
    expect(serialized).toContain('pnpm site:check')
    expect(serialized).toContain('registry-data')
    expect(serialized).toContain('git fetch origin registry-data')
    expect(serialized).not.toContain('push --force')
  })

  it('deploys the generated branch to Pages with only Pages permissions', async () => {
    const document = await workflow('pages.yml')
    const serialized = JSON.stringify(document)
    expect(document.permissions).toEqual({ contents: 'read', pages: 'write', 'id-token': 'write' })
    expect(serialized).toContain('workflow_run')
    expect(serialized).toContain('registry-data')
    expect(serialized).toContain('actions/upload-pages-artifact')
    expect(serialized).toContain('actions/deploy-pages')
    expect(serialized).not.toMatch(/secrets\./)
  })

  it('publishes tested, checksummed assets only from version tags', async () => {
    const document = await workflow('release.yml')
    const serialized = JSON.stringify(document)
    expect(document.permissions).toEqual({ contents: 'write' })
    expect(serialized).toContain('v*')
    expect(serialized).toContain('pnpm test')
    expect(serialized).toContain('pnpm registry:build')
    expect(serialized).toContain('pnpm site:check')
    expect(serialized).toContain('pnpm pack')
    expect(serialized).toContain('registry-snapshot')
    expect(serialized).toContain('SHA256SUMS.txt')
    expect(serialized).toContain('gh release create')
    expect(serialized).not.toMatch(/secrets\./)
  })
})
