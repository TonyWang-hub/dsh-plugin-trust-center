import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { acquireSource, type AcquireOptions } from './acquire.js'
import { walkPackage } from './walk.js'

const execFileAsync = promisify(execFile)
const INSTALL_ARGS = ['install', '--ignore-scripts', '--prod', '--frozen-lockfile=false'] as const
const IGNORED_COPY_ROOTS = new Set(['.git', '.hg', '.svn', 'node_modules'])

export interface DynamicImportEvidence {
  source: string
  executed: true
  entry: string
  exports: string[]
  installation: {
    manager: 'pnpm'
    productionOnly: true
    lifecycleScripts: false
  }
  disclaimer: 'Execution evidence is not a security guarantee.'
}

export interface InstallRequest {
  command: 'pnpm'
  args: string[]
  cwd: string
}

export interface DynamicVerifyOptions {
  acquisition?: AcquireOptions
  runInstall?: (request: InstallRequest) => Promise<void>
}

export async function runDependencyInstall(cwd: string): Promise<void> {
  const binary = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  await execFileAsync(binary, [...INSTALL_ARGS], {
    cwd,
    env: dependencyInstallEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: 5 * 60 * 1000,
    windowsHide: true,
  })
}

export async function verifyDynamicImport(
  source: string,
  options: DynamicVerifyOptions = {},
): Promise<DynamicImportEvidence> {
  const acquired = await acquireSource(source, options.acquisition)
  const executionParent = await mkdtemp(join(tmpdir(), 'dsh-trust-execute-'))
  try {
    const walked = await walkPackage(acquired.root)
    if (walked.truncated || walked.skipped.length > 0) {
      throw new Error('dynamic verification refuses an incomplete static file inventory')
    }

    const executionRoot = join(executionParent, 'package')
    await cp(acquired.root, executionRoot, {
      recursive: true,
      dereference: false,
      filter: path => shouldCopy(acquired.root, path),
    })

    const raw = JSON.parse(await readFile(resolve(executionRoot, 'package.json'), 'utf8')) as {
      main?: unknown
      exports?: unknown
    }
    const entry = packageEntry(raw)
    const { root, target } = await validatedEntry(executionRoot, entry)
    const request: InstallRequest = {
      command: 'pnpm',
      args: [...INSTALL_ARGS],
      cwd: executionRoot,
    }
    await (options.runInstall ?? (item => runDependencyInstall(item.cwd)))(request)

    const loaded = await import(pathToFileURL(target).href) as Record<string, unknown>
    return {
      source: acquired.resolved,
      executed: true,
      entry: relative(root, target).replaceAll('\\', '/'),
      exports: Object.keys(loaded).sort(),
      installation: {
        manager: 'pnpm',
        productionOnly: true,
        lifecycleScripts: false,
      },
      disclaimer: 'Execution evidence is not a security guarantee.',
    }
  } finally {
    try {
      await acquired.cleanup()
    } finally {
      await rm(executionParent, { recursive: true, force: true })
    }
  }
}

async function validatedEntry(executionRoot: string, entry: string): Promise<{ root: string; target: string }> {
  if (isAbsolute(entry)) throw new Error('package entry escapes the acquired package')
  const root = await realpath(executionRoot)
  const unresolvedTarget = resolve(root, entry)
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (unresolvedTarget !== root && !unresolvedTarget.startsWith(rootPrefix)) {
    throw new Error('package entry escapes the acquired package')
  }
  const info = await lstat(unresolvedTarget)
  if (info.isSymbolicLink()) throw new Error('package entry links are not allowed')
  const target = await realpath(unresolvedTarget)
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new Error('package entry escapes the acquired package')
  }
  return { root, target }
}

function shouldCopy(root: string, path: string): boolean {
  const item = relative(root, path).replaceAll('\\', '/').split('/')[0] ?? ''
  return item === '' || !IGNORED_COPY_ROOTS.has(item)
}

function dependencyInstallEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: 'true',
    npm_config_ignore_scripts: 'true',
  }
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC', 'COREPACK_HOME']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function packageEntry(pkg: { main?: unknown; exports?: unknown }): string {
  if (typeof pkg.main === 'string' && pkg.main !== '') return pkg.main
  if (typeof pkg.exports === 'string' && pkg.exports !== '') return pkg.exports
  if (pkg.exports !== null && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
    const rootExport = (pkg.exports as Record<string, unknown>)['.']
    if (typeof rootExport === 'string' && rootExport !== '') return rootExport
    if (rootExport !== null && typeof rootExport === 'object' && !Array.isArray(rootExport)) {
      const conditions = rootExport as Record<string, unknown>
      for (const key of ['import', 'default']) {
        if (typeof conditions[key] === 'string' && conditions[key] !== '') return conditions[key]
      }
    }
  }
  return 'index.js'
}
