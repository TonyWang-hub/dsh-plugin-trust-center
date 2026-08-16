import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isDirectInvocation } from './cli.js'
import { canonicalJson } from './passport.js'
import { writeFileAtomic } from './profile/atomic.js'
import { runCommand } from './profile/runner.js'
import type { CommandResult, CommandRunner } from './profile/runner.js'
import { loadRegistrySources } from './registry/load.js'

const DOGFOOD_PROFILE = 'dogfood'
const REGRESSION_FILES = [
  'test/profile-runner.test.ts',
  'test/profile-ledger.test.ts',
  'test/profile-transaction.test.ts',
  'test/profile-restore.test.ts',
  'test/profile-snapshot.test.ts',
  'test/quarantine.test.ts',
  'test/plugin.test.ts',
  'test/cli.test.ts',
]

export interface DogfoodOptions {
  cwd: string
  registryPath: string
  artifactsDirectory: string
  sourceSlug: string
  dshPath: string
  nodePath: string
  packageManagerPath: string
  makeTemporaryRoot?(): Promise<string>
  run?: CommandRunner
}

export interface DogfoodSummary {
  schemaVersion: '1.0.0'
  sourceSlug: string
  immutableSource: string
  passportDigest: string
  verdict: 'pass' | 'review'
  receiptId: string
  receiptDigest: string
  executed: false
  isolatedInstall: 'passed'
  promotionDryRun: 'passed'
  officialBundle: 'passed'
  regressionTests: 'passed'
}

export function dogfoodOptionsFromEnvironment(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  nodePath: string = process.execPath,
): DogfoodOptions {
  const packageManagerPath = env.npm_execpath
  if (packageManagerPath === undefined || packageManagerPath === '') {
    throw new Error('dogfood must run through pnpm so npm_execpath identifies the pinned package manager')
  }
  return {
    cwd,
    registryPath: join(cwd, 'registry', 'sources.json'),
    artifactsDirectory: env.DSH_DOGFOOD_ARTIFACTS ?? join(cwd, 'dogfood-artifacts'),
    sourceSlug: 'dsh-plugin-sentinel',
    dshPath: join(cwd, 'node_modules', '.bin', 'dsh'),
    nodePath,
    packageManagerPath,
  }
}

export async function runDogfood(options: DogfoodOptions): Promise<DogfoodSummary> {
  assertAbsolute('DSH executable', options.dshPath)
  assertAbsolute('Node executable', options.nodePath)
  assertAbsolute('package manager entry', options.packageManagerPath)
  const source = (await loadRegistrySources(options.registryPath))
    .find(entry => entry.slug === options.sourceSlug)
  if (source === undefined) throw new Error(`dogfood source is not declared in the registry: ${options.sourceSlug}`)
  if (!source.source.startsWith('github:')) {
    throw new Error(`dogfood community source must be an immutable GitHub commit: ${source.source}`)
  }

  const run = options.run ?? runCommand
  let temporaryRoot: string | undefined
  try {
    const makeTemporaryRoot = options.makeTemporaryRoot ?? (() => mkdtemp(join(tmpdir(), 'dsh-trust-dogfood-')))
    temporaryRoot = await makeTemporaryRoot()
    const home = join(temporaryRoot, 'home')
    await mkdir(home, { recursive: true })
    await mkdir(options.artifactsDirectory, { recursive: true })
    const cliPath = join(options.cwd, 'dist/cli.js')
    const passportPath = join(options.artifactsDirectory, 'passport.json')
    const env = {
      ...process.env,
      CI: '1',
      DSH_HOME: home,
      DSH_PATH: options.dshPath,
      npm_config_ignore_scripts: 'true',
      PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
    }

    await requireExitZero(run, options.nodePath, [options.packageManagerPath, 'test:dsh-bundle'], options.cwd, env, 360_000)

    const inspected = await run(options.nodePath, [
      cliPath, 'inspect', source.source, '--format', 'json', '--output', passportPath,
    ], { cwd: options.cwd, env, timeoutMs: 180_000 })
    if (inspected.exitCode !== 0 && inspected.exitCode !== 2) {
      throw commandFailure('community static inspection', inspected)
    }
    const passport = object(JSON.parse(await readFile(passportPath, 'utf8')), 'Passport')
    const subject = object(passport.subject, 'Passport subject')
    const verdict = object(passport.verdict, 'Passport verdict')
    if (subject.resolved !== source.source) throw new Error('dogfood Passport did not preserve the immutable registry source')
    if (typeof subject.digest !== 'string' || !/^[a-f0-9]{64}$/.test(subject.digest)) {
      throw new Error('dogfood Passport digest is invalid')
    }
    if (verdict.status !== 'pass' && verdict.status !== 'review') {
      throw new Error(`dogfood Passport verdict is not promotable: ${String(verdict.status)}`)
    }
    if ((inspected.exitCode === 0) !== (verdict.status === 'pass')) {
      throw new Error('dogfood Passport verdict and inspection exit code disagree')
    }

    const installed = await requireExitZero(run, options.nodePath, [
      cliPath, 'quarantine', 'install', source.source, '--target', DOGFOOD_PROFILE,
    ], options.cwd, env, 360_000)
    const installResult = object(parseJsonOutput(installed.stdout, 'quarantine install'), 'quarantine install result')
    const receipt = object(installResult.receipt, 'quarantine receipt')
    if (receipt.source !== source.source || receipt.immutableSource !== source.source) {
      throw new Error('dogfood receipt source does not match the immutable registry source')
    }
    if (receipt.targetProfile !== DOGFOOD_PROFILE) throw new Error('dogfood receipt target profile is invalid')
    if (receipt.executed !== false) throw new Error('dogfood receipt indicates community code execution')
    if (typeof receipt.id !== 'string' || receipt.id.length === 0) throw new Error('dogfood receipt id is invalid')
    if (typeof receipt.receiptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.receiptDigest)) {
      throw new Error('dogfood receipt digest is invalid')
    }

    const promoted = await requireExitZero(run, options.nodePath, [
      cliPath, 'quarantine', 'promote', receipt.id, '--target', DOGFOOD_PROFILE, '--dry-run',
    ], options.cwd, env, 360_000)
    const promotion = object(parseJsonOutput(promoted.stdout, 'promotion dry-run'), 'promotion plan')
    if (promotion.dryRun !== true || promotion.profile !== DOGFOOD_PROFILE || promotion.installSpec !== source.source) {
      throw new Error('dogfood promotion dry-run does not match the isolated receipt')
    }

    await requireExitZero(run, options.nodePath, [
      options.packageManagerPath, 'vitest', 'run', ...REGRESSION_FILES,
    ], options.cwd, env, 240_000)

    const summary: DogfoodSummary = {
      schemaVersion: '1.0.0',
      sourceSlug: source.slug,
      immutableSource: source.source,
      passportDigest: subject.digest,
      verdict: verdict.status,
      receiptId: receipt.id,
      receiptDigest: receipt.receiptDigest,
      executed: false,
      isolatedInstall: 'passed',
      promotionDryRun: 'passed',
      officialBundle: 'passed',
      regressionTests: 'passed',
    }
    await writeFileAtomic(join(options.artifactsDirectory, 'receipt.json'), `${canonicalJson(receipt)}\n`)
    await writeFileAtomic(join(options.artifactsDirectory, 'promotion-plan.json'), `${canonicalJson(promotion)}\n`)
    await writeFileAtomic(join(options.artifactsDirectory, 'summary.json'), `${canonicalJson(summary)}\n`)
    return summary
  } finally {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function requireExitZero(
  run: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  const result = await run(command, args, { cwd, env, timeoutMs })
  if (result.exitCode !== 0) throw commandFailure(args.join(' '), result)
  return result
}

function parseJsonOutput(output: string, label: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`${label} did not emit valid JSON`)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function commandFailure(label: string, result: CommandResult): Error {
  const detail = result.stderr.trim().split('\n')[0]
  return new Error(`${label} failed with exit ${result.exitCode}${detail === undefined || detail === '' ? '' : `: ${detail}`}`)
}

function assertAbsolute(label: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`)
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  runDogfood(dogfoodOptionsFromEnvironment(process.cwd())).then(
    summary => { process.stdout.write(`${canonicalJson(summary)}\n`) },
    error => {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      process.stderr.write(`dogfood failed: ${message}\n`)
      process.exitCode = 1
    },
  )
}
