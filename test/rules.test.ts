import { describe, expect, it } from 'vitest'
import type { ManifestEvidence, WalkedFile } from '../src/model.js'
import { evaluateRules } from '../src/rules.js'

const EMPTY_MANIFEST: ManifestEvidence = {
  scripts: {},
  dependencies: { runtime: {}, dev: {}, optional: {}, peer: {} },
  dsh: {},
  findings: [],
}

function file(path: string, content = ''): WalkedFile {
  return { path, bytes: Buffer.byteLength(content), sha256: 'x', content }
}

function manifest(overrides: Partial<ManifestEvidence> = {}): ManifestEvidence {
  return {
    ...EMPTY_MANIFEST,
    ...overrides,
    dependencies: {
      ...EMPTY_MANIFEST.dependencies,
      ...overrides.dependencies,
    },
  }
}

const ids = (findings: ReturnType<typeof evaluateRules>) => findings.map(f => f.ruleId)

describe('evaluateRules', () => {
  it('reports install lifecycle scripts with a stable rule id', () => {
    const findings = evaluateRules({
      files: [],
      manifest: manifest({ scripts: { install: 'node install.js', postinstall: 'node x.js' } }),
    })

    expect(findings.filter(f => f.ruleId === 'DSH-SCRIPT-001')).toHaveLength(2)
    for (const finding of findings) {
      expect(finding.ruleId).toBe('DSH-SCRIPT-001')
      expect(finding.severity).toBe('high')
      expect(finding.category).toBe('lifecycle')
      expect(finding.evidence[0]?.file).toBe('package.json')
    }
  })

  it('ignores non-install scripts', () => {
    const findings = evaluateRules({
      files: [],
      manifest: manifest({ scripts: { start: 'node start.js', test: 'vitest run' } }),
    })

    expect(ids(findings)).not.toContain('DSH-SCRIPT-001')
  })

  it('flags dynamic code execution', () => {
    const files = [
      file('eval.js', 'const result = eval("1 + 1")'),
      file('fn.js', 'const f = new Function("return 1")'),
      file('vm.js', "import { runInNewContext } from 'node:vm'"),
    ]

    const findings = evaluateRules({ files, manifest: EMPTY_MANIFEST })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-001')).toHaveLength(3)
    expect(findings.find(f => f.ruleId === 'DSH-CODE-001')?.severity).toBe('high')
  })

  it('flags process execution', () => {
    const files = [
      file('proc.js', "require('child_process').execSync('ls')"),
      file('spawn.js', 'spawn("node", ["x.js"])'),
    ]

    const findings = evaluateRules({ files, manifest: EMPTY_MANIFEST })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-002')).toHaveLength(2)
  })

  it('flags environment and credential access', () => {
    const files = [
      file('env.js', 'const token = process.env.API_TOKEN'),
      file('cred.js', 'const apiKey = "abc"'),
    ]

    const findings = evaluateRules({ files, manifest: EMPTY_MANIFEST })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-003')).toHaveLength(2)
  })

  it('flags network clients', () => {
    const files = [
      file('fetch.js', 'await fetch("https://example.com")'),
      file('https.js', "import { request } from 'node:https'"),
    ]

    const findings = evaluateRules({ files, manifest: EMPTY_MANIFEST })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-004')).toHaveLength(2)
  })

  it('flags native binaries and build tooling', () => {
    const files = [file('build/addon.node', 'binary'), file('binding.gyp', '# gyp')]
    const withTool = manifest({
      scripts: { postinstall: 'node-gyp rebuild' },
    })

    const findings = evaluateRules({ files, manifest: withTool })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-005')).toHaveLength(3)
  })

  it('flags oversized source files', () => {
    const big = 'x'.repeat(1024 * 1024 + 10)
    const findings = evaluateRules({ files: [file('huge.js', big)], manifest: EMPTY_MANIFEST })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-006')).toHaveLength(1)
    expect(findings.find(f => f.ruleId === 'DSH-CODE-006')?.evidence[0]?.file).toBe('huge.js')
  })

  it('flags obfuscated single-line source', () => {
    const minified = `var a=${'x'.repeat(2500)};`
    const findings = evaluateRules({ files: [file('min.js', minified)], manifest: EMPTY_MANIFEST })

    expect(findings.filter(f => f.ruleId === 'DSH-CODE-007')).toHaveLength(1)
  })

  it('flags mutable and unpinned dependency specs', () => {
    const findings = evaluateRules({
      files: [],
      manifest: manifest({
        dependencies: {
          runtime: { dep: 'github:someone/dep' },
          dev: { local: 'file:../local' },
          optional: { tarball: 'https://example.com/a.tgz' },
          peer: { branch: 'git+ssh://git@example.com/u/r.git#main' },
        },
      }),
    })

    expect(findings.filter(f => f.ruleId === 'DSH-DEP-001')).toHaveLength(4)
    for (const finding of findings) {
      expect(finding.severity).toBe('high')
      expect(finding.category).toBe('dependency')
      expect(finding.evidence[0]?.file).toBe('package.json')
    }
  })

  it('accepts commit-pinned git refs and semver ranges', () => {
    const findings = evaluateRules({
      files: [],
      manifest: manifest({
        dependencies: {
          runtime: {
            pinned: 'github:someone/dep#0123456789abcdef0123456789abcdef01234567',
            ranged: '^1.2.3',
          },
          dev: {},
          optional: {},
          peer: {},
        },
      }),
    })

    expect(ids(findings)).not.toContain('DSH-DEP-001')
  })

  it('produces no findings for a clean source tree', () => {
    const files = [file('index.js', 'export const name = "safe"\n')]

    const findings = evaluateRules({ files, manifest: EMPTY_MANIFEST })

    expect(findings).toEqual([])
  })

  it('binds evidence to a file, line, column and a bounded snippet', () => {
    const longLine = `eval("${'x'.repeat(200)}")`
    const findings = evaluateRules({
      files: [file('x.js', `const a = 1\n${longLine}\n`)],
      manifest: EMPTY_MANIFEST,
    })

    const evidence = findings.find(f => f.ruleId === 'DSH-CODE-001')?.evidence[0]
    expect(evidence?.file).toBe('x.js')
    expect(evidence?.line).toBe(2)
    expect(evidence?.column).toBe(1)
    expect(evidence?.snippet?.length).toBeLessThanOrEqual(120)
  })

  it('returns findings sorted by rule id', () => {
    const findings = evaluateRules({
      files: [file('x.js', 'exec("ls")'), file('y.js', 'eval("1")')],
      manifest: manifest({ scripts: { install: 'node i.js' } }),
    })

    const ruleIds = ids(findings)
    expect(ruleIds).toEqual([...ruleIds].sort())
  })

  it('only scans source extensions', () => {
    const findings = evaluateRules({
      files: [file('readme.md', 'eval("1")'), file('data.json', 'exec("ls")')],
      manifest: EMPTY_MANIFEST,
    })

    expect(findings).toEqual([])
  })
})
