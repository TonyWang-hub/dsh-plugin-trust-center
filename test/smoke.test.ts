import { describe, expect, it } from 'vitest'
import {
  buildRegistry,
  buildSite,
  checkSite,
  collectRegistry,
  inspectSource,
  loadRegistrySources,
} from '../src/index.js'

describe('inspectSource', () => {
  it('returns a pass passport for a minimal local DSH bundle', async () => {
    const passport = await inspectSource('test/fixtures/safe-bundle')

    expect(passport.verdict.status).toBe('pass')
    expect(passport.dsh.bundle?.patch).toBe('cordis.patch.yml')
  })

  it('exports the Stage Two registry and site APIs', () => {
    for (const api of [buildRegistry, buildSite, checkSite, collectRegistry, loadRegistrySources]) {
      expect(api).toBeTypeOf('function')
    }
  })
})
