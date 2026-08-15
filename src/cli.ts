#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyDynamicImport } from './dynamic.js'
import { inspectSource } from './passport.js'
import { renderHuman, renderJson, renderSarif } from './render.js'
import { RULE_CATALOG } from './rule-catalog.js'
import { canonicalJson } from './passport.js'
import { defaultDshHome, ledgerPath, profileDir, validateProfileName } from './profile/paths.js'
import { captureSnapshot, listSnapshots, restoreSnapshot } from './profile/snapshot.js'
import { disableBundle } from './profile/disable.js'
import { restoreProfile } from './profile/restore.js'
import { appendLedger, findLatestEntry, loadLedger } from './profile/ledger.js'
import { dshPathFromEnv, runCommand } from './profile/runner.js'
import type { CommandRunner } from './profile/runner.js'
import { installQuarantine, promoteQuarantine } from './quarantine.js'
import type { Passport } from './model.js'

export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

interface CommonOptions {
  output?: string
}

interface InspectOptions extends CommonOptions {
  format: 'human' | 'json' | 'sarif'
}

export interface CliDependencies {
  home?: string
  now?(): Date
  dshPath?: string
  runner?: CommandRunner
  inspect?(source: string): Promise<Passport>
  makeTempHome?(): Promise<string>
  id?(): string
  verifyDynamic?(immutableSource: string): Promise<void>
}

const processIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

export async function runCli(
  argv: string[],
  io: CliIo = processIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const command = argv[0]
  try {
    switch (command) {
      case 'inspect': {
        const source = requiredSource(argv[1])
        const options = parseInspectOptions(argv.slice(2))
        const passport = await inspectSource(source)
        const rendered = options.format === 'json'
          ? renderJson(passport)
          : options.format === 'sarif'
            ? renderSarif(passport)
            : renderHuman(passport)
        await emit(rendered, options, io)
        return passport.verdict.status === 'pass' ? 0 : passport.verdict.status === 'review' ? 2 : 3
      }
      case 'schema': {
        rejectArguments(argv.slice(1))
        const schema = await readFile(new URL('../schemas/passport.schema.json', import.meta.url), 'utf8')
        io.stdout(`${canonicalJson(JSON.parse(schema))}\n`)
        return 0
      }
      case 'rules': {
        rejectArguments(argv.slice(1))
        io.stdout(`${canonicalJson(RULE_CATALOG)}\n`)
        return 0
      }
      case 'verify-import': {
        const source = requiredSource(argv[1])
        const options = parseCommonOptions(argv.slice(2))
        const evidence = await verifyDynamicImport(source)
        await emit(`${canonicalJson(evidence)}\n`, options, io)
        return 0
      }
      case 'profile': {
        const subcommand = argv[1]
        const home = dependencies.home ?? defaultDshHome()
        if (subcommand === 'list') {
          rejectArguments(argv.slice(2))
          const profiles = await listProfileEvidence(home)
          io.stdout(`${canonicalJson({ profiles })}\n`)
          return 0
        }
        if (subcommand === 'snapshot') {
          const profile = requiredProfile(argv[2])
          rejectArguments(argv.slice(3))
          const snapshotId = await captureSnapshot({
            home,
            profile,
            ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
          })
          io.stdout(`${canonicalJson({ profile, snapshotId })}\n`)
          return 0
        }
        if (subcommand === 'restore') {
          const profile = requiredProfile(argv[2])
          const snapshotId = requiredOptionValue('snapshot id', argv[3])
          const dryRun = parseDryRun(argv.slice(4))
          const result = await restoreProfile({
            home,
            profile,
            snapshotId,
            dshPath: dependencies.dshPath ?? dshPathFromEnv(),
            runner: dependencies.runner ?? runCommand,
            dryRun,
            ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
          })
          io.stdout(`${canonicalJson(result)}\n`)
          return 0
        }
        if (subcommand === 'disable') {
          const profile = requiredProfile(argv[2])
          const packageName = requiredOptionValue('bundle', argv[3])
          const dryRun = parseDryRun(argv.slice(4))
          const ledger = await loadLedger(ledgerPath(home, profile))
          const record = findLatestEntry(ledger, packageName)
          if (record === undefined) throw new Error(`no immutable ledger record for ${packageName}`)
          const result = await disableBundle({
            home,
            profile,
            dshPath: dependencies.dshPath ?? dshPathFromEnv(),
            runner: dependencies.runner ?? runCommand,
            bundle: { packageName, spec: record.spec, passportDigest: record.passportDigest },
            dryRun,
            ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
          })
          io.stdout(`${canonicalJson(result)}\n`)
          return 0
        }
        throw new Error(`unknown profile command: ${String(subcommand)}`)
      }
      case 'quarantine': {
        const subcommand = argv[1]
        const home = dependencies.home ?? defaultDshHome()
        const runner = dependencies.runner ?? runCommand
        const dshPath = dependencies.dshPath ?? dshPathFromEnv()
        const quarantineRunner = async (entry: { args: string[]; env: Record<string, string>; timeoutMs: number }) => {
          const executed = await runner(dshPath, entry.args, {
            cwd: home,
            env: { ...process.env, ...entry.env },
            timeoutMs: entry.timeoutMs,
          })
          return { code: executed.exitCode, stdout: executed.stdout, stderr: executed.stderr }
        }
        if (subcommand === 'install') {
          const source = requiredSource(argv[2])
          const options = parseQuarantineInstallOptions(argv.slice(3))
          const result = await installQuarantine(source, {
            inspect: dependencies.inspect ?? inspectSource,
            run: quarantineRunner,
            makeTempHome: dependencies.makeTempHome ?? (() => mkdtemp(join(tmpdir(), 'dsh-trust-quarantine-'))),
            receiptRoot: join(home, 'quarantine'),
            id: dependencies.id ?? (() => randomUUID().slice(0, 12)),
            now: () => (dependencies.now?.() ?? new Date()).toISOString(),
            targetProfile: options.target,
            allowExecute: options.allowExecute,
            verifyDynamic: dependencies.verifyDynamic ?? (async immutableSource => { await verifyDynamicImport(immutableSource) }),
          })
          io.stdout(`${canonicalJson(result)}\n`)
          return 0
        }
        if (subcommand === 'promote') {
          const id = requiredQuarantineId(argv[2])
          const options = parseQuarantinePromoteOptions(argv.slice(3))
          const result = await promoteQuarantine(join(home, 'quarantine', id, 'receipt.json'), options.target, {
            inspect: dependencies.inspect ?? inspectSource,
            run: quarantineRunner,
            snapshotTarget: profile => captureSnapshot({
              home,
              profile,
              ...(dependencies.now === undefined ? {} : { now: dependencies.now() }),
            }),
            restoreTarget: async (profile, snapshotId, packageName) => {
              await runner(dshPath, ['plugin', '--profile', profile, 'remove', packageName], {
                cwd: home,
                env: { ...process.env, DSH_HOME: home },
                timeoutMs: 120_000,
              })
              await restoreSnapshot({ home, profile, snapshotId })
            },
            recordInstall: async (profile, receipt) => {
              await appendLedger(ledgerPath(home, profile), {
                action: 'install',
                packageName: receipt.packageName,
                spec: receipt.installSpec,
                passportDigest: receipt.passportDigest,
                profile,
              }, dependencies.now?.() ?? new Date(receipt.createdAt))
            },
            dshHome: home,
            dryRun: options.dryRun,
          })
          io.stdout(`${canonicalJson(result)}\n`)
          return 0
        }
        throw new Error(`unknown quarantine command: ${String(subcommand)}`)
      }
      case '--help':
      case '-h':
      case undefined:
        io.stdout(helpText())
        return 0
      default:
        throw new Error(`unknown command: ${command}`)
    }
  } catch (error) {
    const prefix = command === 'inspect' ? 'inspection failed' : 'command failed'
    io.stderr(`${prefix}: ${errorMessage(error)}\n`)
    return 1
  }
}

function parseInspectOptions(args: string[]): InspectOptions {
  let format: InspectOptions['format'] = 'human'
  let output: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (item === '--format') {
      const value = args[index + 1]
      if (value !== 'human' && value !== 'json' && value !== 'sarif') {
        throw new Error('--format must be human, json, or sarif')
      }
      format = value
      index += 1
    } else if (item === '--output') {
      output = requiredOptionValue('--output', args[index + 1])
      index += 1
    } else {
      throw new Error(`unknown option: ${String(item)}`)
    }
  }
  return { format, ...(output === undefined ? {} : { output }) }
}

function parseQuarantineInstallOptions(args: string[]): { target: string; allowExecute: boolean } {
  let target: string | undefined
  let allowExecute = false
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (item === '--target') {
      if (target !== undefined) throw new Error('--target may be specified only once')
      target = requiredProfile(args[index + 1])
      index += 1
    } else if (item === '--allow-execute') {
      allowExecute = true
    } else {
      throw new Error(`unknown option: ${String(item)}`)
    }
  }
  if (target === undefined) throw new Error('--target is required')
  return { target, allowExecute }
}

function parseQuarantinePromoteOptions(args: string[]): { target: string; dryRun: boolean } {
  let target: string | undefined
  let dryRun = false
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (item === '--target') {
      if (target !== undefined) throw new Error('--target may be specified only once')
      target = requiredProfile(args[index + 1])
      index += 1
    } else if (item === '--dry-run') {
      dryRun = true
    } else {
      throw new Error(`unknown option: ${String(item)}`)
    }
  }
  if (target === undefined) throw new Error('--target is required')
  return { target, dryRun }
}

function parseDryRun(args: string[]): boolean {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--dry-run') return true
  throw new Error(`unknown option: ${String(args[0])}`)
}

function parseCommonOptions(args: string[]): CommonOptions {
  if (args.length === 0) return {}
  if (args.length === 2 && args[0] === '--output') return { output: requiredOptionValue('--output', args[1]) }
  throw new Error(`unknown option: ${String(args[0])}`)
}

async function emit(text: string, options: CommonOptions, io: CliIo): Promise<void> {
  if (options.output === undefined) {
    io.stdout(text)
    return
  }
  await writeFile(resolve(options.output), text, { encoding: 'utf8', mode: 0o600 })
}

function requiredQuarantineId(value: string | undefined): string {
  if (value === undefined || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(value)) throw new Error('invalid quarantine id')
  return value
}

function requiredProfile(value: string | undefined): string {
  if (value === undefined || value === '') throw new Error('profile is required')
  return validateProfileName(value)
}

function requiredSource(value: string | undefined): string {
  if (value === undefined || value === '') throw new Error('source is required')
  return value
}

function requiredOptionValue(name: string, value: string | undefined): string {
  if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function rejectArguments(args: string[]): void {
  if (args.length > 0) throw new Error(`unexpected argument: ${String(args[0])}`)
}

async function listProfileEvidence(home: string): Promise<Array<{
  name: string
  bundles: string[]
  snapshots: string[]
}>> {
  let entries
  try {
    entries = await readdir(resolve(home, 'profiles'), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const profiles = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    let name: string
    try {
      name = validateProfileName(entry.name)
    } catch {
      continue
    }
    let bundles: string[] = []
    try {
      const manifest = JSON.parse(await readFile(join(profileDir(home, name), 'package.json'), 'utf8')) as {
        dsh?: { profile?: { bundles?: unknown } }
      }
      if (Array.isArray(manifest.dsh?.profile?.bundles)) {
        bundles = manifest.dsh.profile.bundles.filter((item): item is string => typeof item === 'string').sort()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const snapshots = (await listSnapshots(home, name)).map(item => item.snapshotId)
    profiles.push({ name, bundles, snapshots })
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? 'unknown error' : String(error)
}

function helpText(): string {
  return [
    'Usage: dsh-trust <command>',
    '',
    'Commands:',
    '  inspect <source> [--format human|json|sarif] [--output path]',
    '  schema',
    '  rules',
    '  verify-import <source> [--output path]  Explicitly execute target entry',
    '  quarantine install <source> --target <profile> [--allow-execute]',
    '  quarantine promote <id> --target <profile> [--dry-run]',
    '  profile list',
    '  profile snapshot <profile>',
    '  profile restore <profile> <snapshot-id> [--dry-run]',
    '  profile disable <profile> <bundle> [--dry-run]',
    '',
  ].join('\n')
}

export function isDirectInvocation(argument: string | undefined, moduleUrl: string): boolean {
  if (argument === undefined) return false
  try {
    return pathToFileURL(realpathSync(argument)).href === moduleUrl
  } catch {
    return false
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) process.exitCode = await runCli(process.argv.slice(2))
