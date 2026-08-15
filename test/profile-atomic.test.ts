import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/profile/atomic.js'

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-trust-atomic-'))
}

describe('writeFileAtomic', () => {
  it('writes the target with 0600 mode by default', async () => {
    const dir = await root()
    try {
      const target = join(dir, 'ledger.json')
      await writeFileAtomic(target, '{"entries":[]}\n')

      expect(await readFile(target, 'utf8')).toBe('{"entries":[]}\n')
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('honors an explicit mode', async () => {
    const dir = await root()
    try {
      const target = join(dir, 'config.json')
      await writeFileAtomic(target, '{}', { mode: 0o640 })

      expect((await stat(target)).mode & 0o777).toBe(0o640)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('atomically replaces an existing target and leaves no temp files', async () => {
    const dir = await root()
    try {
      const target = join(dir, 'state.json')
      await writeFileAtomic(target, '{"version":1}')
      await writeFileAtomic(target, '{"version":2}')

      expect(await readFile(target, 'utf8')).toBe('{"version":2}')
      expect(await readdir(dir)).toEqual(['state.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes a large binary payload completely', async () => {
    const dir = await root()
    try {
      const target = join(dir, 'blob.bin')
      const payload = Buffer.alloc(256 * 1024, 0xab)
      await writeFileAtomic(target, payload)

      expect((await readFile(target)).equals(payload)).toBe(true)
      expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cleans up the temp file and rethrows when the rename fails', async () => {
    const dir = await root()
    try {
      const targetDir = join(dir, 'target-dir')
      await mkdir(targetDir)
      await writeFile(join(targetDir, 'inside'), 'x')

      // rename(file, existingDir) fails on POSIX: the interrupted write must
      // throw and must not leave a stray temp file behind.
      await expect(writeFileAtomic(targetDir, 'boom')).rejects.toThrow()

      const leftovers = (await readdir(dir)).filter(name => name.includes('.tmp'))
      expect(leftovers).toEqual([])
      expect(await readFile(join(targetDir, 'inside'), 'utf8')).toBe('x')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects when the parent directory does not exist, without temp leftovers', async () => {
    const dir = await root()
    try {
      const target = join(dir, 'missing', 'file.json')
      await expect(writeFileAtomic(target, '{}')).rejects.toThrow()

      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
