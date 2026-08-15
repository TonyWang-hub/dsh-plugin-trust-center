#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyDynamicImport } from './dynamic.js'
import { inspectSource } from './passport.js'
import { renderHuman, renderJson, renderSarif } from './render.js'
import { RULE_CATALOG } from './rule-catalog.js'
import { canonicalJson } from './passport.js'

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

const processIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

export async function runCli(argv: string[], io: CliIo = processIo): Promise<number> {
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
