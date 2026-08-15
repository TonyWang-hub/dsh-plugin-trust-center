import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Finding, ManifestEvidence, WalkedFile } from '../src/model.js'
import {
  canonicalJson,
  computePackageDigest,
  deriveVerdict,
  inspectSource,
} from '../src/passport.js'
import { buildSbom } from '../src/sbom.js'

const FIXTURES = 'test/fixtures'

function finding(severity: 'high' | 'critical'): Finding {
  return {
    ruleId: 'DSH-TEST-001',
    severity,
    category: 'code',
    title: 'test',
    message: 'test finding',
    evidence: [],
    remediation: 'none',
  }
}

function walkedFile(path: string, content: string): WalkedFile {
  return { path, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), content }
}

function sbomManifest(): ManifestEvidence {
  return {
    packageName: 'app',
    packageVersion: '0.1.0',
    scripts: {},
    dependencies: {
      runtime: { a: '1.0.0', '@scope/b': '2.0.0' },
      dev: { c: '3.0.0' },
      optional: { d: '4.0.0' },
      peer: { e: '5.0.0' },
    },
    dsh: {},
    findings: [],
  }
}

describe('inspectSource', () => {
  it('produces a pass passport for the safe bundle', async () => {
    const passport = await inspectSource(`${FIXTURES}/safe-bundle`)

    expect(passport.verdict.status).toBe('pass')
    expect(passport.schemaVersion).toBe('1.0.0')
    expect(passport.dsh.bundle?.patch).toBe('cordis.patch.yml')
    expect(passport.subject.kind).toBe('local')
    expect(passport.subject.resolved).toBe('local:safe-bundle')
    expect(passport.subject.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(passport.subject)).not.toContain(process.cwd())
    expect(passport.findings).toEqual([])
    expect(passport.compatibility.method).toBe('declaration-only')
  })

  it('fails closed when static inspection limits truncate evidence', async () => {
    const passport = await inspectSource(`${FIXTURES}/safe-bundle`, {
      limits: { maxFiles: 1 },
    })

    expect(passport.verdict.status).toBe('fail')
    expect(passport.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'DSH-SCAN-001', severity: 'critical' }),
    )
  })

  it('fails closed when a symlink is skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-symlink-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: 'symlink-bundle',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      await writeFile(join(root, 'cordis.patch.yml'), '[]\n')
      await writeFile(join(root, 'index.js'), 'export const value = 1\n')
      await symlink('index.js', join(root, 'linked.js'))

      const passport = await inspectSource(root)

      expect(passport.verdict.status).toBe('fail')
      expect(passport.findings).toContainEqual(
        expect.objectContaining({ ruleId: 'DSH-SCAN-001', severity: 'critical' }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is deterministic across repeated inspections', async () => {
    const first = await inspectSource(`${FIXTURES}/safe-bundle`)
    const second = await inspectSource(`${FIXTURES}/safe-bundle`)

    expect(first.subject.digest).toBe(second.subject.digest)
    expect(canonicalJson(first)).toBe(canonicalJson(second))
  })

  it('returns review for a bundle with lifecycle scripts and risky source', async () => {
    const passport = await inspectSource(`${FIXTURES}/risky-bundle`)

    expect(passport.verdict.status).toBe('review')
    const ruleIds = passport.findings.map(f => f.ruleId)
    expect(ruleIds).toContain('DSH-SCRIPT-001')
    expect(ruleIds).toContain('DSH-CODE-001')
    expect(ruleIds).toContain('DSH-CODE-002')
    expect(ruleIds).toContain('DSH-CODE-003')
    expect(ruleIds).toContain('DSH-CODE-004')
    expect(ruleIds).toContain('DSH-CODE-005')
    expect(ruleIds).toContain('DSH-DEP-001')
    expect(passport.findings.every(f => f.severity === 'high')).toBe(true)
  })

  it('fails a bundle whose declared patch is missing', async () => {
    const passport = await inspectSource(`${FIXTURES}/missing-patch-bundle`)

    expect(passport.verdict.status).toBe('fail')
    expect(passport.findings.some(f => f.ruleId === 'DSH-MANIFEST-004')).toBe(true)
  })

  it('fails a bundle whose patch escapes the package root', async () => {
    const passport = await inspectSource(`${FIXTURES}/invalid-bundle`)

    expect(passport.verdict.status).toBe('fail')
    expect(passport.findings.some(f => f.ruleId === 'DSH-MANIFEST-003')).toBe(true)
  })

  it('fails a package without a manifest', async () => {
    const passport = await inspectSource(`${FIXTURES}/no-manifest`)

    expect(passport.verdict.status).toBe('fail')
    expect(passport.findings.some(f => f.ruleId === 'DSH-MANIFEST-001')).toBe(true)
  })

  it('fails a plain package with no DSH declaration', async () => {
    const passport = await inspectSource(`${FIXTURES}/plain-package`)

    expect(passport.verdict.status).toBe('fail')
    expect(passport.findings.some(f => f.ruleId === 'DSH-MANIFEST-007')).toBe(true)
  })

  it('fails a package with an invalid dsh.client declaration', async () => {
    const passport = await inspectSource(`${FIXTURES}/invalid-client`)

    expect(passport.verdict.status).toBe('fail')
    expect(passport.findings.some(f => f.ruleId === 'DSH-MANIFEST-005')).toBe(true)
  })

  it('rejects a source directory that does not exist', async () => {
    await expect(inspectSource(`${FIXTURES}/does-not-exist`)).rejects.toThrow()
  })
})

describe('deriveVerdict', () => {
  it('passes when there are no findings', () => {
    expect(deriveVerdict([]).status).toBe('pass')
  })

  it('reviews when only high findings exist', () => {
    expect(deriveVerdict([finding('high')]).status).toBe('review')
  })

  it('fails when a critical finding exists', () => {
    expect(deriveVerdict([finding('critical')]).status).toBe('fail')
  })

  it('fails on critical even alongside high findings', () => {
    expect(deriveVerdict([finding('high'), finding('critical')]).status).toBe('fail')
  })
})

describe('computePackageDigest', () => {
  it('is independent of input order', () => {
    const files = [walkedFile('b.js', 'b'), walkedFile('a.js', 'a')]

    expect(computePackageDigest(files)).toBe(computePackageDigest([...files].reverse()))
  })

  it('equals sha256 of the canonical path/hash inventory', () => {
    const files = [walkedFile('b.js', 'b'), walkedFile('a.js', 'a')]
    const payload = canonicalJson([
      { path: 'a.js', sha256: files[1]?.sha256 },
      { path: 'b.js', sha256: files[0]?.sha256 },
    ])

    expect(computePackageDigest(files)).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('changes when file content changes', () => {
    const before = computePackageDigest([walkedFile('a.js', 'one')])
    const after = computePackageDigest([walkedFile('a.js', 'two')])

    expect(before).not.toBe(after)
  })
})

describe('canonicalJson', () => {
  it('recursively sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: [3, 1, 2] } })).toBe('{"a":{"c":[3,1,2],"d":4},"b":1}')
  })
})

describe('buildSbom', () => {
  it('emits a deterministic CycloneDX 1.6 direct-dependency document', () => {
    const sbom = buildSbom(sbomManifest())

    expect(sbom.bomFormat).toBe('CycloneDX')
    expect(sbom.specVersion).toBe('1.6')
    expect(sbom.version).toBe(1)
    expect(sbom.components.map(c => c.name)).toEqual(['@scope/b', 'a', 'c', 'd', 'e'])
    expect(sbom.components[1]?.purl).toBe('pkg:npm/a@1.0.0')
    expect(sbom.components[0]?.purl).toBe('pkg:npm/%40scope/b@2.0.0')
    expect(sbom.dependencies).toEqual([
      {
        ref: 'pkg:npm/app@0.1.0',
        dependsOn: [
          'pkg:npm/%40scope/b@2.0.0',
          'pkg:npm/a@1.0.0',
          'pkg:npm/c@3.0.0',
          'pkg:npm/d@4.0.0',
          'pkg:npm/e@5.0.0',
        ],
      },
    ])
  })

  it('percent-encodes mutable dependency specs in package URLs', () => {
    const manifest = sbomManifest()
    manifest.dependencies.runtime['range'] = '^1.0.0 || 2.x'

    const sbom = buildSbom(manifest)

    expect(sbom.components.find(component => component.name === 'range')?.purl)
      .toBe('pkg:npm/range@%5E1.0.0%20%7C%7C%202.x')
  })

  it('maps dependency scopes deterministically', () => {
    const sbom = buildSbom(sbomManifest())

    const scopeOf = (name: string) => sbom.components.find(c => c.name === name)?.scope
    expect(scopeOf('a')).toBe('required')
    expect(scopeOf('c')).toBe('excluded')
    expect(scopeOf('d')).toBe('optional')
    expect(scopeOf('e')).toBe('required')
  })

  it('contains no timestamp or serial number', () => {
    const serialized = JSON.stringify(buildSbom(sbomManifest()))

    expect(serialized).not.toContain('serialNumber')
    expect(serialized).not.toContain('timestamp')
  })

  it('dedupes components shared across dependency groups', () => {
    const manifest = sbomManifest()
    manifest.dependencies.dev['a'] = '1.0.0'

    const sbom = buildSbom(manifest)

    expect(sbom.components.filter(c => c.name === 'a')).toHaveLength(1)
  })

  it('omits root metadata when the package has no name', () => {
    const manifest = sbomManifest()
    delete manifest.packageName

    const sbom = buildSbom(manifest)

    expect(sbom.metadata.component).toBeUndefined()
    expect(sbom.dependencies).toEqual([])
  })
})
