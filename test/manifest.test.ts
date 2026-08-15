import { describe, expect, it } from 'vitest'
import { inspectManifest, parseCordisPatch } from '../src/manifest.js'
import type { WalkedFile } from '../src/model.js'

const FIXTURES = 'test/fixtures'

const inventory = (paths: string[]): WalkedFile[] =>
  paths.map(path => ({ path, bytes: 1, sha256: 'x', content: '' }))

describe('inspectManifest', () => {
  it('parses Cordis !!js values as inert strings', () => {
    const patch = parseCordisPatch('- insert:\n    - id: tagged\n      value: !!js process.env.SECRET\n')

    expect(patch).toEqual([{ insert: [{ id: 'tagged', value: 'process.env.SECRET' }] }])
  })

  it('captures identity, scripts, dependencies and DSH declarations for a valid bundle', async () => {
    const m = await inspectManifest(`${FIXTURES}/safe-bundle`)

    expect(m.packageName).toBe('safe-bundle')
    expect(m.packageVersion).toBe('1.0.0')
    expect(m.license).toBe('MIT')
    expect(m.scripts).toEqual({})
    expect(m.dependencies).toEqual({ runtime: {}, dev: {}, optional: {}, peer: {} })
    expect(m.dsh.bundle).toEqual({ patch: 'cordis.patch.yml', exists: true })
    expect(m.findings).toEqual([])
  })

  it('normalizes a leading ./ on the bundle patch', async () => {
    const m = await inspectManifest(`${FIXTURES}/safe-bundle`)

    expect(m.dsh.bundle?.patch).toBe('cordis.patch.yml')
  })

  it('reports a missing package.json as a critical manifest finding', async () => {
    const m = await inspectManifest(`${FIXTURES}/no-manifest`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-001', severity: 'critical', category: 'manifest' }),
    )
    expect(m.scripts).toEqual({})
  })

  it('reports an unparseable package.json as a critical manifest finding', async () => {
    const m = await inspectManifest(`${FIXTURES}/invalid-json`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-001', severity: 'critical' }),
    )
  })

  it('reports a bundle patch that escapes the package root as critical', async () => {
    const m = await inspectManifest(`${FIXTURES}/invalid-bundle`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-003', severity: 'critical' }),
    )
    expect(m.dsh.bundle?.exists).toBe(false)
  })

  it('reports an absolute bundle patch as escaping', async () => {
    const m = await inspectManifest(`${FIXTURES}/absolute-patch-bundle`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-003', severity: 'critical' }),
    )
  })

  it('reports a declared bundle patch that does not exist as critical', async () => {
    const m = await inspectManifest(`${FIXTURES}/missing-patch-bundle`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-004', severity: 'critical' }),
    )
    expect(m.dsh.bundle?.exists).toBe(false)
  })

  it('reports a patch whose YAML root is not an operation array', async () => {
    const m = await inspectManifest(`${FIXTURES}/invalid-patch-schema`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-008', severity: 'critical' }),
    )
  })

  it('reports an empty bundle patch as critical', async () => {
    const m = await inspectManifest(`${FIXTURES}/empty-patch-bundle`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-002', severity: 'critical' }),
    )
  })

  it('reports a non-object dsh.bundle as critical', async () => {
    const m = await inspectManifest(`${FIXTURES}/malformed-bundle`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-002', severity: 'critical' }),
    )
  })

  it('reports a dsh.client without a platform as critical', async () => {
    const m = await inspectManifest(`${FIXTURES}/invalid-client`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-005', severity: 'critical' }),
    )
  })

  it('reports a valid dsh.client without exports["./client"] as critical', async () => {
    const m = await inspectManifest(`${FIXTURES}/missing-client-export`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-006', severity: 'critical' }),
    )
    expect(m.dsh.client?.exportExists).toBe(false)
  })

  it('reports and normalizes duplicate client injection paths', async () => {
    const m = await inspectManifest(`${FIXTURES}/duplicate-client`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-005', severity: 'critical' }),
    )
    expect(m.dsh.client?.inject).toEqual(['index.js'])
  })

  it('captures a valid dsh.client shape and profile bundles', async () => {
    const m = await inspectManifest(`${FIXTURES}/client-bundle`)

    expect(m.dsh.client).toEqual({ platform: 'node', inject: ['index.js'], immediately: true, exportExists: true })
    expect(m.dsh.profile).toEqual({ bundles: ['cordis.patch.yml'] })
    expect(m.findings).toEqual([])
  })

  it('reports a non-object top-level dsh declaration precisely', async () => {
    const m = await inspectManifest(`${FIXTURES}/invalid-dsh`)

    expect(m.findings.map(finding => finding.ruleId)).toEqual(['DSH-MANIFEST-010'])
  })

  it('reports an invalid dsh.profile bundles shape', async () => {
    const m = await inspectManifest(`${FIXTURES}/invalid-profile`)

    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-009', severity: 'critical' }),
    )
  })

  it('checks patch existence against a provided file inventory', async () => {
    const m = await inspectManifest(`${FIXTURES}/safe-bundle`, {
      files: inventory(['package.json']),
    })

    expect(m.dsh.bundle?.exists).toBe(false)
    expect(m.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-MANIFEST-004', severity: 'critical' }),
    )
  })

  it('confirms patch existence against a provided file inventory', async () => {
    const m = await inspectManifest(`${FIXTURES}/safe-bundle`, {
      files: inventory(['package.json', 'cordis.patch.yml']),
    })

    expect(m.dsh.bundle?.exists).toBe(true)
  })
})
