import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'

describe('Stage 3 public API', () => {
  it('exports quarantine and transactional profile primitives', () => {
    for (const name of [
      'installQuarantine',
      'promoteQuarantine',
      'defaultDshHome',
      'validateProfileName',
      'writeFileAtomic',
      'appendLedger',
      'loadLedger',
      'captureSnapshot',
      'listSnapshots',
      'readSnapshotManifest',
      'restoreSnapshot',
      'restoreProfile',
      'runCommand',
      'runMutation',
      'disableBundle',
      'reenableBundle',
    ]) {
      expect(api, name).toHaveProperty(name)
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function')
    }
  })
})
