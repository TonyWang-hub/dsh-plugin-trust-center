import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installFakeDsh } from './profile-helpers.js'
import {
  dshAddCommand,
  dshDumpConfigCommand,
  dshPathFromEnv,
  dshRemoveCommand,
  runCommand,
} from '../src/profile/runner.js'

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-trust-runner-'))
}

describe('command construction', () => {
  it('builds the exact official remove arguments', () => {
    expect(dshRemoveCommand('trust-test', 'trust-demo'))
      .toEqual(['plugin', '--profile', 'trust-test', 'remove', 'trust-demo'])
  })

  it('builds the exact official add arguments', () => {
    expect(dshAddCommand('trust-test', 'trust-demo@1.2.3'))
      .toEqual(['plugin', '--profile', 'trust-test', 'add', 'trust-demo@1.2.3'])
  })

  it('builds the exact dump-config arguments', () => {
    expect(dshDumpConfigCommand('trust-test'))
      .toEqual(['--profile', 'trust-test', '--dump-config'])
  })

  it('never embeds the dsh binary name in command arguments', () => {
    const commands = [
      dshRemoveCommand('t', 'p'),
      dshAddCommand('t', 'p@1.0.0'),
      dshDumpConfigCommand('t'),
    ]
    for (const args of commands) {
      expect(args[0]).not.toBe('dsh')
    }
  })

  it('rejects relative DSH_PATH and DSH_BIN values instead of using PATH lookup', () => {
    expect(() => dshPathFromEnv({ DSH_PATH: 'dsh' })).toThrow('absolute')
    expect(() => dshPathFromEnv({ DSH_BIN: './dsh' })).toThrow('absolute')
  })

  it('resolves the dsh binary path from DSH_PATH, then DSH_BIN, then default', () => {
    expect(dshPathFromEnv({ DSH_PATH: '/a/dsh' })).toBe('/a/dsh')
    expect(dshPathFromEnv({ DSH_BIN: '/b/dsh' })).toBe('/b/dsh')
    expect(dshPathFromEnv({ DSH_PATH: '/a/dsh', DSH_BIN: '/b/dsh' })).toBe('/a/dsh')
    expect(dshPathFromEnv({})).toBe(join(process.env.HOME ?? '', '.dsh', 'bin', 'dsh'))
  })
})

describe('runCommand', () => {
  it('executes the fake dsh at its absolute path and captures clean stdout', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      await mkdir(join(home, 'profiles', 'trust-test'), { recursive: true })
      const result = await runCommand(
        fixture.dshPath,
        dshDumpConfigCommand('trust-test'),
        { env: fixture.env(home), cwd: home },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('{"profile":"trust-test","bundles":[]}\n')
      expect(result.stderr).toBe('')
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('returns a nonzero exit code with stderr instead of throwing', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      const result = await runCommand(
        fixture.dshPath,
        dshDumpConfigCommand('trust-test'),
        { env: fixture.env(home, { FAKE_DSH_FAIL_DUMP: '1' }), cwd: home },
      )

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('dump-config failed')
      expect(result.stdout).toContain('bundles')
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('ignores a PATH-injected decoy dsh when the absolute path is given', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    const decoyDir = await mkdtemp(join(tmpdir(), 'dsh-trust-decoy-'))
    const marker = join(decoyDir, 'decoy-ran')
    try {
      await writeFile(join(decoyDir, 'dsh'), `#!/bin/sh\ntouch '${marker}'\necho HACKED\n`)
      await chmod(join(decoyDir, 'dsh'), 0o755)

      const env = {
        ...fixture.env(home),
        PATH: `${decoyDir}:${dirname(process.execPath)}`,
      }
      const result = await runCommand(
        fixture.dshPath,
        dshDumpConfigCommand('trust-test'),
        { env, cwd: home },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain('HACKED')
      expect(result.stdout).toContain('trust-test')
      await expect(readFile(marker)).rejects.toThrow()
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
      await rm(decoyDir, { recursive: true, force: true })
    }
  })

  it('kills the process and rejects when the timeout elapses', async () => {
    const fixture = await installFakeDsh()
    const home = await root()
    try {
      await expect(runCommand(
        fixture.dshPath,
        dshDumpConfigCommand('trust-test'),
        { env: fixture.env(home, { FAKE_DSH_SLEEP_MS: '6000' }), cwd: home, timeoutMs: 300 },
      )).rejects.toThrow(/timed out/)

      // The child was SIGKILLed: its completion marker must never appear, even
      // after letting any late output settle.
      await new Promise(resolve => setTimeout(resolve, 300))
      await expect(readFile(join(home, 'fake-dsh-finished'))).rejects.toThrow()
    } finally {
      await fixture.cleanup()
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('kills the entire process group on timeout', async () => {
    const home = await root()
    const childScript = join(home, 'grandchild.mjs')
    const parentScript = join(home, 'parent.mjs')
    const marker = join(home, 'grandchild-finished')
    try {
      await writeFile(childScript, `
        import { writeFile } from 'node:fs/promises'
        await new Promise(resolve => setTimeout(resolve, 800))
        await writeFile(${JSON.stringify(marker)}, 'survived')
      `)
      await writeFile(parentScript, `
        import { spawn } from 'node:child_process'
        spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' }).unref()
        await new Promise(resolve => setTimeout(resolve, 6000))
      `)

      await expect(runCommand(process.execPath, [parentScript], {
        cwd: home,
        timeoutMs: 300,
      })).rejects.toThrow(/timed out/)
      await new Promise(resolve => setTimeout(resolve, 900))
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('forwards termination signals to the detached process group', async () => {
    const home = await root()
    const childScript = join(home, 'signal-grandchild.mjs')
    const parentScript = join(home, 'signal-parent.mjs')
    const started = join(home, 'signal-grandchild-started')
    const finished = join(home, 'signal-grandchild-finished')
    try {
      await writeFile(childScript, `
        import { writeFile } from 'node:fs/promises'
        await writeFile(${JSON.stringify(started)}, 'started')
        await new Promise(resolve => setTimeout(resolve, 800))
        await writeFile(${JSON.stringify(finished)}, 'survived')
      `)
      await writeFile(parentScript, `
        import { spawn } from 'node:child_process'
        spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' }).unref()
        await new Promise(resolve => setTimeout(resolve, 6000))
      `)
      const running = runCommand(process.execPath, [parentScript], { cwd: home, timeoutMs: 3_000 })
      void running.catch(() => undefined)
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await readFile(started)
          break
        } catch {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      expect(await readFile(started, 'utf8')).toBe('started')

      process.emit('SIGTERM')
      await expect(running).rejects.toThrow('terminated by SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 900))
      await expect(readFile(finished)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects when the dsh executable does not exist', async () => {
    await expect(runCommand('/nonexistent/dsh-missing', dshDumpConfigCommand('t')))
      .rejects.toThrow()
  })
})
