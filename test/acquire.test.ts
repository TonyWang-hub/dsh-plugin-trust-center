import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireSource,
  parseSourceSpec,
  validateArchiveEntry,
  type AcquireOptions,
} from '../src/acquire.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('parseSourceSpec', () => {
  it('parses local, npm, and GitHub inputs without ambiguity', () => {
    expect(parseSourceSpec('./plugin')).toEqual({ kind: 'local', path: './plugin' })
    expect(parseSourceSpec('npm:demo@1.2.3')).toEqual({ kind: 'npm', name: 'demo', version: '1.2.3' })
    expect(parseSourceSpec('npm:@scope/demo@next')).toEqual({ kind: 'npm', name: '@scope/demo', version: 'next' })
    expect(parseSourceSpec('github:owner/repo#v1')).toEqual({ kind: 'github', owner: 'owner', repo: 'repo', ref: 'v1' })
  })

  it('rejects malformed network specifications', () => {
    expect(() => parseSourceSpec('npm:')).toThrow('invalid npm source')
    expect(() => parseSourceSpec('github:owner')).toThrow('invalid GitHub source')
    expect(() => parseSourceSpec('github:../repo')).toThrow('invalid GitHub source')
  })
})

describe('validateArchiveEntry', () => {
  it('rejects traversal, absolute paths, links, and oversized entries', () => {
    expect(() => validateArchiveEntry('../escape', 'File', 1)).toThrow('escapes')
    expect(() => validateArchiveEntry('/absolute', 'File', 1)).toThrow('absolute')
    expect(() => validateArchiveEntry('root/link', 'SymbolicLink', 0)).toThrow('links')
    expect(() => validateArchiveEntry('root/pipe', 'FIFO', 0)).toThrow('entry type')
    expect(() => validateArchiveEntry('root/huge.js', 'File', 11, { maxFileBytes: 10 })).toThrow('file limit')
  })
})

describe('acquireSource', () => {
  it('returns a local directory without executing package code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-trust-local-'))
    cleanup.push(dir)
    await writeFile(join(dir, 'package.json'), '{"name":"local"}')
    let fetched = false
    const options: AcquireOptions = {
      fetch: async () => {
        fetched = true
        throw new Error('unexpected network')
      },
    }

    const acquired = await acquireSource(dir, options)

    expect(acquired.kind).toBe('local')
    expect(await readFile(join(acquired.root, 'package.json'), 'utf8')).toContain('local')
    expect(fetched).toBe(false)
    await acquired.cleanup()
  })

  it('extracts a real tarball through the default bounded extractor', async () => {
    const body = tarGzip('package/package.json', '{"name":"real-archive"}')
    let requests = 0
    const acquired = await acquireSource('npm:real-archive@1.0.0', {
      fetch: async () => {
        requests += 1
        return requests === 1
          ? new Response(JSON.stringify({
              name: 'real-archive',
              version: '1.0.0',
              dist: { tarball: 'https://registry.npmjs.org/real-archive.tgz' },
            }))
          : new Response(body)
      },
    })

    expect(await readFile(join(acquired.root, 'package.json'), 'utf8')).toContain('real-archive')
    await acquired.cleanup()
  })

  it('rejects traversal in the real extractor without writing outside its root', async () => {
    const escapedName = `dsh-trust-escape-${String(process.pid)}.txt`
    const escapedPath = join(tmpdir(), escapedName)
    await rm(escapedPath, { force: true })
    const body = tarGzip(`package/../${escapedName}`, 'escaped')
    let requests = 0

    await expect(acquireSource('npm:escape@1.0.0', {
      fetch: async () => {
        requests += 1
        return requests === 1
          ? new Response(JSON.stringify({
              name: 'escape',
              version: '1.0.0',
              dist: { tarball: 'https://registry.npmjs.org/escape.tgz' },
            }))
          : new Response(body)
      },
    })).rejects.toThrow('escapes')
    await expect(readFile(escapedPath)).rejects.toThrow()
  })

  it('downloads an exact npm package and verifies its SHA-512 integrity', async () => {
    const body = new Uint8Array([1, 2, 3])
    const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
    const requests: string[] = []
    const options: AcquireOptions = {
      fetch: async input => {
        requests.push(String(input))
        if (requests.length === 1) {
          return new Response(JSON.stringify({
            name: '@scope/demo',
            version: '1.2.3',
            dist: { tarball: 'https://registry.npmjs.org/archive.tgz', integrity },
          }))
        }
        return new Response(body)
      },
      extractTarball: async (_archive, destination) => {
        await writeFile(join(destination, 'package.json'), '{"name":"@scope/demo"}')
      },
    }

    const acquired = await acquireSource('npm:@scope/demo@1.2.3', options)

    expect(acquired.resolved).toBe('npm:@scope/demo@1.2.3')
    expect(requests[0]).toContain('@scope%2Fdemo/1.2.3')
    expect(requests[1]).toBe('https://registry.npmjs.org/archive.tgz')
    expect(await readFile(join(acquired.root, 'package.json'), 'utf8')).toContain('@scope/demo')
    await acquired.cleanup()
  })

  it('fails closed when npm integrity does not match', async () => {
    let requests = 0
    const options: AcquireOptions = {
      fetch: async () => {
        requests += 1
        if (requests === 1) {
          return new Response(JSON.stringify({
            name: 'demo',
            version: '1.0.0',
            dist: {
              tarball: 'https://registry.npmjs.org/demo.tgz',
              integrity: 'sha512-not-the-digest',
            },
          }))
        }
        return new Response(new Uint8Array([1, 2, 3]))
      },
    }

    await expect(acquireSource('npm:demo@1.0.0', options)).rejects.toThrow('integrity mismatch')
  })

  it('verifies supported non-SHA-512 npm integrity algorithms', async () => {
    let requests = 0
    await expect(acquireSource('npm:demo@1.0.0', {
      fetch: async () => {
        requests += 1
        return requests === 1
          ? new Response(JSON.stringify({
              name: 'demo',
              version: '1.0.0',
              dist: {
                tarball: 'https://registry.npmjs.org/demo.tgz',
                integrity: 'sha1-not-the-digest',
              },
            }))
          : new Response(new Uint8Array([1, 2, 3]))
      },
      extractTarball: async () => {},
    })).rejects.toThrow('integrity mismatch')
  })

  it('rejects unsupported npm integrity algorithms', async () => {
    let requests = 0
    await expect(acquireSource('npm:demo@1.0.0', {
      fetch: async () => {
        requests += 1
        return requests === 1
          ? new Response(JSON.stringify({
              name: 'demo',
              version: '1.0.0',
              dist: {
                tarball: 'https://registry.npmjs.org/demo.tgz',
                integrity: 'md5-not-accepted',
              },
            }))
          : new Response(new Uint8Array([1, 2, 3]))
      },
      extractTarball: async () => {},
    })).rejects.toThrow('unsupported npm integrity')
  })

  it('rejects an npm tarball URL that is not HTTPS', async () => {
    const options: AcquireOptions = {
      fetch: async input => {
        if (String(input).startsWith('https://registry.npmjs.org/')) {
          return new Response(JSON.stringify({
            name: 'demo',
            version: '1.0.0',
            dist: { tarball: 'http://example.com/demo.tgz' },
          }))
        }
        throw new Error('insecure download was attempted')
      },
    }

    await expect(acquireSource('npm:demo@1.0.0', options)).rejects.toThrow('HTTPS')
  })

  it('cancels a streaming download as soon as the archive limit is crossed', async () => {
    let chunks = 0
    let thirdChunkPulled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1
        if (chunks === 1) controller.enqueue(new Uint8Array([1, 2]))
        else if (chunks === 2) controller.enqueue(new Uint8Array([3, 4]))
        else {
          thirdChunkPulled = true
          controller.enqueue(new Uint8Array([5, 6]))
          controller.close()
        }
      },
    }, { highWaterMark: 0 })
    let fetches = 0

    await expect(acquireSource('github:owner/repo#main', {
      maxArchiveBytes: 3,
      fetch: async () => {
        fetches += 1
        return fetches === 1
          ? new Response(JSON.stringify({ sha: 'a'.repeat(40) }))
          : new Response(stream)
      },
      extractTarball: async () => {},
    })).rejects.toThrow('archive limit')
    expect(thirdChunkPulled).toBe(false)
  })

  it('rejects a download that exceeds the compressed archive limit', async () => {
    let requests = 0
    const options: AcquireOptions = {
      maxArchiveBytes: 3,
      fetch: async () => {
        requests += 1
        return requests === 1
          ? new Response(JSON.stringify({ sha: 'a'.repeat(40) }))
          : new Response(new Uint8Array([1, 2, 3, 4]))
      },
      extractTarball: async () => {},
    }

    await expect(acquireSource('github:owner/repo#main', options)).rejects.toThrow('archive limit')
  })

  it('resolves a GitHub ref to an immutable commit before downloading', async () => {
    const requests: string[] = []
    const options: AcquireOptions = {
      fetch: async input => {
        requests.push(String(input))
        if (requests.length === 1) {
          return new Response(JSON.stringify({ sha: 'a'.repeat(40) }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(new Uint8Array(), { headers: { 'content-type': 'application/gzip' } })
      },
      extractTarball: async (_body, destination) => {
        await writeFile(join(destination, 'package.json'), '{"name":"github"}')
      },
    }

    const acquired = await acquireSource('github:owner/repo#main', options)
    cleanup.push(acquired.root)

    expect(acquired.resolved).toContain(`owner/repo#${'a'.repeat(40)}`)
    expect(requests[0]).toContain('/repos/owner/repo/commits/main')
    expect(requests[1]).toContain(`/tar.gz/${'a'.repeat(40)}`)
    await acquired.cleanup()
  })
})

function tarGzip(name: string, content: string): Uint8Array {
  const body = Buffer.from(content)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, body.length)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  const checksumText = checksum.toString(8).padStart(6, '0')
  header.write(`${checksumText}\0 `, 148, 8, 'ascii')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]))
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  buffer.write(`${text}\0`, offset, length, 'ascii')
}
