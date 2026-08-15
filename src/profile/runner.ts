import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface RunOptions {
  /** Working directory for the spawned process. */
  cwd?: string
  /** Full environment; defaults to the current process environment. */
  env?: NodeJS.ProcessEnv
  /** Kill the process and reject after this many milliseconds. */
  timeoutMs?: number
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Injected process runner: executes an absolute binary path with explicit
 * arguments and returns a clean stdout/stderr capture. Binary resolution by
 * PATH is deliberately never used for `dsh` — callers pass the absolute path.
 */
export type CommandRunner = (command: string, args: string[], options?: RunOptions) => Promise<CommandResult>

/**
 * Spawns `command` with `args`, captures stdout/stderr separately, and
 * enforces an optional timeout that kills the child. Resolves with the exit
 * code even for nonzero exits; rejects only on spawn failure or timeout.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    let settled = false
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`command timed out after ${options.timeoutMs}ms: ${describeCommand(command, args)}`))
    }, options.timeoutMs)

    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ exitCode: code ?? (signal === null ? 0 : 1), stdout, stderr })
    })
  })
}

/** `dsh plugin --profile <profile> remove <package>` */
export function dshRemoveCommand(profile: string, pkg: string): string[] {
  return ['plugin', '--profile', profile, 'remove', pkg]
}

/** `dsh plugin --profile <profile> add <spec>` */
export function dshAddCommand(profile: string, spec: string): string[] {
  return ['plugin', '--profile', profile, 'add', spec]
}

/** `dsh --profile <profile> --dump-config` */
export function dshDumpConfigCommand(profile: string): string[] {
  return ['--profile', profile, '--dump-config']
}

/**
 * Resolves the official `dsh` binary: explicit `DSH_PATH`, then `DSH_BIN`,
 * then the conventional `~/.dsh/bin/dsh`. Never a PATH lookup.
 */
export function dshPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_PATH ?? env.DSH_BIN
  if (explicit !== undefined && explicit.trim() !== '') {
    if (!isAbsolute(explicit)) throw new Error('DSH_PATH/DSH_BIN must be an absolute path')
    return explicit
  }
  return join(homedir(), '.dsh', 'bin', 'dsh')
}

function describeCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ')
}
