import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, walkPackage } from '../src/walk.js'

let dirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-walk-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('walkPackage', () => {
  it('returns a deterministic sorted inventory regardless of creation order', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'b.js'), 'b')
    await writeFile(join(dir, 'c.js'), 'c')
    await writeFile(join(dir, 'a.js'), 'a')

    const result = await walkPackage(dir)

    expect(result.files.map(f => f.path)).toEqual(['a.js', 'b.js', 'c.js'])
  })

  it('uses posix relative paths for nested files', async () => {
    const dir = await tmp()
    await mkdir(join(dir, 'src', 'nested'), { recursive: true })
    await writeFile(join(dir, 'src', 'nested', 'deep.txt'), 'x')

    const result = await walkPackage(dir)

    expect(result.files.map(f => f.path)).toEqual(['src/nested/deep.txt'])
  })

  it('ignores VCS and dependency directories', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'package.json'), '{}')
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'dep', 'x.js'), 'x')
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, '.git', 'config'), 'cfg')
    await mkdir(join(dir, '.hg'))
    await writeFile(join(dir, '.hg', 'store'), 's')
    await mkdir(join(dir, '.svn'))
    await writeFile(join(dir, '.svn', 'entries'), 'e')

    const result = await walkPackage(dir)

    expect(result.files.map(f => f.path)).toEqual(['package.json'])
  })

  it('never follows symbolic links', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'real.js'), 'real')
    await symlink('real.js', join(dir, 'link-file.js'))
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'nested.js'), 'nested')
    await symlink('sub', join(dir, 'link-dir'))
    await symlink('..', join(dir, 'link-loop'))

    const result = await walkPackage(dir)
    const paths = result.files.map(f => f.path)

    expect(paths).toContain('real.js')
    expect(paths).toContain('sub/nested.js')
    expect(paths).not.toContain('link-file.js')
    expect(paths).not.toContain('link-dir/nested.js')
    expect(result.skipped.map(s => s.path)).toEqual(
      expect.arrayContaining(['link-file.js', 'link-dir', 'link-loop']),
    )
  })

  it('skips files larger than the per-file byte limit', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'small.js'), 'ok')
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(1024))

    const result = await walkPackage(dir, { maxFiles: 100, maxFileBytes: 512, maxTotalBytes: 10_000_000 })

    expect(result.files.map(f => f.path)).toEqual(['small.js'])
    expect(result.skipped).toContainEqual({ path: 'big.bin', reason: 'file-size' })
  })

  it('stops at the file count limit and marks the walk truncated', async () => {
    const dir = await tmp()
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}.js`), 'x')

    const result = await walkPackage(dir, { maxFiles: 3, maxFileBytes: 1024, maxTotalBytes: 10_000_000 })

    expect(result.files).toHaveLength(3)
    expect(result.truncated).toBe(true)
    expect(result.skipped.some(s => s.reason === 'file-count')).toBe(true)
  })

  it('stops once the total byte limit is reached', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'a.bin'), Buffer.alloc(600))
    await writeFile(join(dir, 'b.bin'), Buffer.alloc(600))

    const result = await walkPackage(dir, { maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 1000 })

    expect(result.truncated).toBe(true)
    expect(result.skipped.some(s => s.reason === 'total-size')).toBe(true)
    expect(result.files.reduce((sum, f) => sum + f.bytes, 0)).toBeLessThanOrEqual(1000)
  })

  it('computes a sha256 and text content for each walked file', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'hello.txt'), 'hello')

    const result = await walkPackage(dir)
    const file = result.files[0]

    expect(file?.path).toBe('hello.txt')
    expect(file?.bytes).toBe(5)
    expect(file?.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(file?.content).toBe('hello')
  })

  it('returns an empty inventory for an empty directory', async () => {
    const dir = await tmp()

    const result = await walkPackage(dir)

    expect(result.files).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('exposes sane default limits', () => {
    expect(DEFAULT_LIMITS.maxFiles).toBeGreaterThan(0)
    expect(DEFAULT_LIMITS.maxFileBytes).toBeGreaterThan(0)
    expect(DEFAULT_LIMITS.maxTotalBytes).toBeGreaterThan(DEFAULT_LIMITS.maxFileBytes)
  })
})
