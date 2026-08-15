import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { SkippedEntry, WalkLimits, WalkResult, WalkedFile } from './model.js'

export const DEFAULT_LIMITS: WalkLimits = {
  maxFiles: 1_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
}

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn'])

/**
 * Walks a package root and returns a bounded, deterministically ordered
 * inventory of files. Symlinks are never followed; VCS and dependency
 * directories are ignored; per-file, file-count, and total-size limits
 * stop the walk early and are recorded in `skipped`/`truncated`.
 */
export async function walkPackage(root: string, limits: WalkLimits = DEFAULT_LIMITS): Promise<WalkResult> {
  const files: WalkedFile[] = []
  const skipped: SkippedEntry[] = []
  let truncated = false
  let totalBytes = 0

  async function visit(dir: string): Promise<void> {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`cannot walk ${root}: ${message}`)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      if (truncated) return
      const fullPath = join(dir, entry.name)
      const relPath = toPosix(relative(root, fullPath))

      if (entry.isSymbolicLink()) {
        skipped.push({ path: relPath, reason: 'symbolic-link' })
        continue
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue

      if (files.length >= limits.maxFiles) {
        truncated = true
        skipped.push({ path: relPath, reason: 'file-count' })
        return
      }

      const info = await stat(fullPath)
      if (info.size > limits.maxFileBytes) {
        skipped.push({ path: relPath, reason: 'file-size' })
        continue
      }
      if (totalBytes + info.size > limits.maxTotalBytes) {
        truncated = true
        skipped.push({ path: relPath, reason: 'total-size' })
        return
      }

      const buffer = await readFile(fullPath)
      if (buffer.length > limits.maxFileBytes) {
        skipped.push({ path: relPath, reason: 'file-size' })
        continue
      }
      totalBytes += buffer.length
      files.push({
        path: relPath,
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        content: buffer.toString('utf8'),
      })
    }
  }

  await visit(root)
  files.sort((a, b) => comparePath(a.path, b.path))
  return { files, skipped, truncated }
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
