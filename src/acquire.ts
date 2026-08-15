import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { t as list, x as extract } from 'tar'

export type SourceSpec =
  | { kind: 'local'; path: string }
  | { kind: 'npm'; name: string; version: string }
  | { kind: 'github'; owner: string; repo: string; ref: string }

export interface ArchiveLimits {
  maxArchiveBytes?: number
  maxEntries?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export interface AcquireOptions extends ArchiveLimits {
  fetch?: typeof globalThis.fetch
  extractTarball?: (body: Uint8Array, destination: string) => Promise<void>
}

export interface AcquiredSource {
  kind: SourceSpec['kind']
  requested: string
  resolved: string
  root: string
  cleanup(): Promise<void>
}

const SAFE_ARCHIVE_TYPES = new Set([
  'File',
  'OldFile',
  'ContiguousFile',
  'Directory',
  'GNUDumpDir',
  'ExtendedHeader',
  'GlobalExtendedHeader',
])

const defaults = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxEntries: 5_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const

export function parseSourceSpec(input: string): SourceSpec {
  if (input.startsWith('npm:')) {
    const raw = input.slice(4)
    if (raw.length === 0) throw new Error('invalid npm source: package name is required')
    const versionAt = raw.startsWith('@') ? raw.lastIndexOf('@') : raw.indexOf('@')
    const hasVersion = versionAt > (raw.startsWith('@') ? raw.indexOf('/') : 0)
    const name = hasVersion ? raw.slice(0, versionAt) : raw
    const version = hasVersion ? raw.slice(versionAt + 1) : 'latest'
    if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) || version.length === 0) {
      throw new Error(`invalid npm source: ${input}`)
    }
    return { kind: 'npm', name, version }
  }

  if (input.startsWith('github:')) {
    const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:#([^\s]+))?$/.exec(input)
    if (match?.[1] === undefined || match[2] === undefined
      || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
      throw new Error(`invalid GitHub source: ${input}`)
    }
    return { kind: 'github', owner: match[1], repo: match[2], ref: match[3] ?? 'HEAD' }
  }

  return { kind: 'local', path: input }
}

export function validateArchiveEntry(
  path: string,
  type: string,
  size: number,
  limits: ArchiveLimits = {},
): void {
  const maxFileBytes = limits.maxFileBytes ?? defaults.maxFileBytes
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) throw new Error(`archive entry uses an absolute path: ${path}`)
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.includes('..')) throw new Error(`archive entry escapes extraction root: ${path}`)
  if (type === 'SymbolicLink' || type === 'Link') throw new Error(`archive links are not allowed: ${path}`)
  if (!SAFE_ARCHIVE_TYPES.has(type)) throw new Error(`archive entry type is not allowed: ${type}`)
  if (size > maxFileBytes) throw new Error(`archive entry exceeds file limit: ${path}`)
}

async function defaultExtractTarball(
  body: Uint8Array,
  destination: string,
  limits: ArchiveLimits,
): Promise<void> {
  const archivePath = `${destination}.tgz`
  await writeFile(archivePath, body)
  let entries = 0
  let totalBytes = 0
  let validationError: Error | undefined
  try {
    await list({
      file: archivePath,
      strict: true,
      onentry: entry => {
        if (validationError !== undefined) return
        try {
          validateArchiveEntry(entry.path, entry.type, entry.size, limits)
          entries += 1
          totalBytes += entry.size
          if (entries > (limits.maxEntries ?? defaults.maxEntries)) throw new Error('archive exceeds entry limit')
          if (totalBytes > (limits.maxTotalBytes ?? defaults.maxTotalBytes)) throw new Error('archive exceeds total size limit')
        } catch (error) {
          validationError = error instanceof Error ? error : new Error(String(error))
        }
      },
    })
    if (validationError !== undefined) throw validationError
    await extract({
      cwd: destination,
      file: archivePath,
      strip: 1,
      strict: true,
      preservePaths: false,
    })
  } finally {
    await rm(archivePath, { force: true })
  }
}

async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`download failed with HTTP ${String(response.status)}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('download exceeds archive limit')
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > maxBytes) {
        await reader.cancel('download exceeds archive limit')
        throw new Error('download exceeds archive limit')
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function verifyIntegrity(body: Uint8Array, integrity: unknown): void {
  if (integrity === undefined) return
  if (typeof integrity !== 'string') throw new Error('unsupported npm integrity metadata')
  const supported = new Set(['sha512', 'sha384', 'sha256', 'sha1'])
  const candidates = integrity.split(/\s+/).flatMap(token => {
    const match = /^([a-z0-9]+)-([^?]+)(?:\?.*)?$/i.exec(token)
    if (match?.[1] === undefined || match[2] === undefined || !supported.has(match[1])) return []
    return [{ algorithm: match[1], expected: match[2] }]
  })
  if (candidates.length === 0) throw new Error('unsupported npm integrity algorithm')
  for (const candidate of candidates) {
    const actual = createHash(candidate.algorithm).update(body).digest('base64')
    if (actual === candidate.expected) return
  }
  throw new Error('npm tarball integrity mismatch')
}

export async function acquireSource(input: string, options: AcquireOptions = {}): Promise<AcquiredSource> {
  const spec = parseSourceSpec(input)
  if (spec.kind === 'local') {
    const root = resolve(spec.path)
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error(`local source is not a directory: ${spec.path}`)
    return {
      kind: 'local',
      requested: input,
      resolved: `local:${basename(root)}`,
      root,
      async cleanup() {},
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  const destination = await mkdtemp(join(tmpdir(), 'dsh-trust-source-'))
  const cleanup = async () => rm(destination, { recursive: true, force: true })
  const extractTarball = options.extractTarball
    ?? ((body: Uint8Array, root: string) => defaultExtractTarball(body, root, options))

  try {
    if (spec.kind === 'github') {
      const commitResponse = await fetchImpl(
        `https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${encodeURIComponent(spec.ref)}`,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-plugin-trust-center' } },
      )
      if (!commitResponse.ok) throw new Error(`GitHub commit resolution failed with HTTP ${String(commitResponse.status)}`)
      const commit = await commitResponse.json() as { sha?: unknown }
      if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)) {
        throw new Error('GitHub commit resolution returned no immutable SHA')
      }
      const archiveResponse = await fetchImpl(
        `https://codeload.github.com/${spec.owner}/${spec.repo}/tar.gz/${commit.sha}`,
        { headers: { 'user-agent': 'dsh-plugin-trust-center' } },
      )
      const body = await responseBytes(archiveResponse, options.maxArchiveBytes ?? defaults.maxArchiveBytes)
      await extractTarball(body, destination)
      return {
        kind: 'github',
        requested: input,
        resolved: `github:${spec.owner}/${spec.repo}#${commit.sha}`,
        root: destination,
        cleanup,
      }
    }

    const encodedName = encodeURIComponent(spec.name).replace('%40', '@')
    const metadataResponse = await fetchImpl(
      `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(spec.version)}`,
      { headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-trust-center' } },
    )
    if (!metadataResponse.ok) throw new Error(`npm metadata resolution failed with HTTP ${String(metadataResponse.status)}`)
    const metadata = await metadataResponse.json() as {
      name?: unknown
      version?: unknown
      dist?: { tarball?: unknown; integrity?: unknown }
    }
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string'
      || typeof metadata.dist?.tarball !== 'string') {
      throw new Error('npm metadata did not contain a resolved package tarball')
    }
    const tarballUrl = new URL(metadata.dist.tarball)
    if (tarballUrl.protocol !== 'https:') throw new Error('npm tarball URL must use HTTPS')
    const archiveResponse = await fetchImpl(tarballUrl, {
      headers: { 'user-agent': 'dsh-plugin-trust-center' },
    })
    const body = await responseBytes(archiveResponse, options.maxArchiveBytes ?? defaults.maxArchiveBytes)
    verifyIntegrity(body, metadata.dist.integrity)
    await extractTarball(body, destination)
    return {
      kind: 'npm',
      requested: input,
      resolved: `npm:${metadata.name}@${metadata.version}`,
      root: destination,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
