import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { inspectSource } from '../src/index.js'
import { renderHuman, renderJson, renderSarif } from '../src/render.js'

describe('Passport renderers', () => {
  it('renders canonical JSON with one trailing newline', async () => {
    const passport = await inspectSource('test/fixtures/safe-bundle')
    const rendered = renderJson(passport)

    expect(rendered.endsWith('\n')).toBe(true)
    expect(rendered.endsWith('\n\n')).toBe(false)
    expect(JSON.parse(rendered).subject.resolved).toBe('local:safe-bundle')
  })

  it('renders a bounded human review summary', async () => {
    const passport = await inspectSource('test/fixtures/risky-bundle')
    const rendered = renderHuman(passport)

    expect(rendered).toContain('Verdict: REVIEW')
    expect(rendered).toContain('DSH-SCRIPT-001')
    expect(rendered).not.toContain(process.cwd())
  })

  it('renders findings as SARIF 2.1.0 rules and results', async () => {
    const passport = await inspectSource('test/fixtures/risky-bundle')
    const sarif = JSON.parse(renderSarif(passport))

    expect(sarif.version).toBe('2.1.0')
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
    expect(sarif.runs[0].tool.driver.name).toBe('DSH Plugin Trust Center')
    expect(sarif.runs[0].tool.driver.version).toBe(manifest.version)
    expect(sarif.runs[0].results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'DSH-SCRIPT-001', level: 'warning' }),
    ]))
  })
})
