import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../src/profile/runner.js'
import type { CommandResult, CommandRunner } from '../src/profile/runner.js'

/** Source of the fake `dsh` fixture, copied into a temp bin dir per test. */
export const FAKE_DSH_SOURCE = join('test', 'fixtures', 'fake-dsh', 'dsh.mjs')

export interface FakeDshFixture {
  /** Absolute path to the installed fake `dsh` executable. */
  dshPath: string
  /** Builds a spawn environment pointing DSH_HOME at `home`. */
  env(home: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  /** CommandRunner bound to the fixture; records every argument array. */
  runner: CommandRunner
  /** Every argument array the runner executed, in order. */
  calls: string[][]
  cleanup(): Promise<void>
}

/**
 * Installs the fake `dsh` fixture into a fresh executable temp directory.
 * Real command execution goes through the same `runCommand` used by the
 * profile modules, so the whole spawn/timeout/capture path is exercised.
 */
export async function installFakeDsh(): Promise<FakeDshFixture> {
  const binDir = await mkdtemp(join(tmpdir(), 'dsh-trust-fake-bin-'))
  const dshPath = join(binDir, 'dsh')
  await copyFile(FAKE_DSH_SOURCE, dshPath)
  await chmod(dshPath, 0o755)
  const calls: string[][] = []
  const runner: CommandRunner = async (command, args, options) => {
    calls.push(args)
    return runCommand(command, args, options)
  }
  return {
    dshPath,
    env: (home, extra = {}) => ({ ...process.env, DSH_HOME: home, ...extra }),
    runner,
    calls,
    cleanup: async () => {
      await rm(binDir, { recursive: true, force: true })
    },
  }
}

/** Builds the profile package.json fixture declaring installed bundles. */
export function profilePackageJson(bundles: string[], dependencies: Record<string, string> = {}): string {
  return `${JSON.stringify({
    name: 'profile-root',
    version: '1.0.0',
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2)}\n`
}

export type { CommandResult, CommandRunner }
