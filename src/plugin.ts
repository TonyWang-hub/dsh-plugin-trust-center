import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { inspectSource } from './passport.js'
import { canonicalJson } from './passport.js'
import { parseSourceSpec } from './acquire.js'
import { validateRegistrySourceSpec } from './registry/load.js'

export const name = 'dsh-plugin-trust-center'
export const inject = ['tools']

export interface Config {
  dshHome?: string
  allowedLocalRoots?: string[]
  maxOutputBytes?: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const maxOutputBytes = resolveOutputLimit(config.maxOutputBytes)
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const allowedLocalRoots = (config.allowedLocalRoots ?? []).map(root => resolve(root))

  const disposeInspect = ctx.tools.register(defineTool({
    name: 'trust_inspect',
    description: 'Statically inspect one immutable public DSH package source or an explicitly allowed local package directory.',
    parameters: {
      source: { type: 'string', required: true, description: 'Exact npm:/github: source, or an allowed local directory.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async args => {
      await assertInspectableSource(args.source, allowedLocalRoots)
      const passport = await inspectSource(args.source)
      const full = `${canonicalJson(passport)}\n`
      if (Buffer.byteLength(full) <= maxOutputBytes) return full
      const summary = `${canonicalJson({
        truncated: true,
        subject: passport.subject,
        dsh: passport.dsh,
        verdict: passport.verdict,
        findingCount: passport.findings.length,
      })}\n`
      if (Buffer.byteLength(summary) > maxOutputBytes) throw new Error('trust_inspect output exceeds configured byte limit')
      return summary
    },
  }))

  let disposeStatus: (() => void) | undefined
  try {
    disposeStatus = ctx.tools.register(defineTool({
      name: 'trust_profile_status',
      description: 'List DSH profile names, installed dependency names, and Trust Center snapshot ids without mutating profiles.',
      parameters: {},
      output: TEXT_OUTPUT,
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      execute: async () => {
        const profiles = await readProfileStatus(dshHome)
        const output = `${canonicalJson({ profiles })}\n`
        if (Buffer.byteLength(output) > maxOutputBytes) throw new Error('trust_profile_status output exceeds configured byte limit')
        return output
      },
    }))
  } catch (error) {
    disposeInspect()
    throw error
  }
  return () => {
    disposeStatus?.()
    disposeInspect()
  }
}

async function assertInspectableSource(source: string, allowedLocalRoots: string[]): Promise<void> {
  const spec = parseSourceSpec(source)
  if (spec.kind !== 'local') {
    validateRegistrySourceSpec(source)
    return
  }
  if (!isAbsolute(spec.path) && spec.path.trim() === '') throw new Error('local source path is empty')
  const target = await realpath(resolve(spec.path))
  for (const configuredRoot of allowedLocalRoots) {
    const root = await realpath(configuredRoot)
    const child = relative(root, target)
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) return
  }
  throw new Error('local source is outside configured allowed roots')
}

interface ProfileStatus {
  name: string
  bundles: string[]
  snapshots: string[]
}

async function readProfileStatus(dshHome: string): Promise<ProfileStatus[]> {
  const profilesRoot = join(dshHome, 'profiles')
  const entries = await safeDirectories(profilesRoot)
  const profiles: ProfileStatus[] = []
  for (const profile of entries.slice(0, 100)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) continue
    const manifestPath = join(profilesRoot, profile, 'package.json')
    const bundles = await readDependencyNames(manifestPath)
    const snapshots = (await safeDirectories(join(dshHome, 'snapshots', profile))).slice(0, 100)
    profiles.push({ name: profile, bundles, snapshots })
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

async function safeDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function readDependencyNames(path: string): Promise<string[]> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 1024 * 1024) return []
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const dependencies = (parsed as { dependencies?: unknown }).dependencies
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) return []
    return Object.keys(dependencies).sort().slice(0, 500)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return []
    throw error
  }
}

function resolveOutputLimit(value: number | undefined): number {
  if (value === undefined) return 64 * 1024
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 1024 * 1024) {
    throw new Error('maxOutputBytes must be an integer between 1024 and 1048576')
  }
  return value
}
