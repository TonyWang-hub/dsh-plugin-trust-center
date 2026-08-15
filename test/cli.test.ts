import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDirectInvocation, runCli, type CliIo } from '../src/cli.js'

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: text => stdout.push(text),
      stderr: text => stderr.push(text),
    },
  }
}

describe('runCli', () => {
  it('recognizes direct invocation through a filesystem symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-cli-'))
    try {
      const target = join(root, 'cli.js')
      const link = join(root, 'dsh-trust')
      await writeFile(target, '')
      await symlink(target, link)

      expect(isDirectInvocation(link, pathToFileURL(await realpath(target)).href)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints a schema-valid JSON passport and returns the verdict exit code', async () => {
    const output = capture()

    const code = await runCli([
      'inspect',
      'test/fixtures/safe-bundle',
      '--format',
      'json',
    ], output.io)

    expect(code).toBe(0)
    expect(output.stderr).toEqual([])
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      schemaVersion: '1.0.0',
      verdict: { status: 'pass' },
    })
  })

  it('writes SARIF and returns 2 for a review verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-output-'))
    try {
      const path = join(root, 'report.sarif')
      const output = capture()
      const code = await runCli([
        'inspect',
        'test/fixtures/risky-bundle',
        '--format',
        'sarif',
        '--output',
        path,
      ], output.io)

      expect(code).toBe(2)
      expect(output.stdout).toEqual([])
      expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('2.1.0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes JSON and returns 3 for a fail verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-trust-output-'))
    try {
      const path = join(root, 'passport.json')
      const output = capture()
      const code = await runCli([
        'inspect',
        'test/fixtures/invalid-bundle',
        '--format',
        'json',
        '--output',
        path,
      ], output.io)

      expect(code).toBe(3)
      expect(JSON.parse(await readFile(path, 'utf8')).verdict.status).toBe('fail')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints the normative schema without inspecting a package', async () => {
    const output = capture()

    const code = await runCli(['schema'], output.io)

    expect(code).toBe(0)
    expect(JSON.parse(output.stdout.join('')).$id).toContain('passport.schema.json')
  })

  it('lists stable rules for external tooling', async () => {
    const output = capture()

    const code = await runCli(['rules'], output.io)

    expect(code).toBe(0)
    expect(JSON.parse(output.stdout.join(''))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'DSH-SCRIPT-001' }),
    ]))
  })

  it('returns an operational error without a stack or environment disclosure', async () => {
    const output = capture()

    const code = await runCli(['inspect', 'test/fixtures/does-not-exist'], output.io)

    expect(code).toBe(1)
    expect(output.stdout).toEqual([])
    expect(output.stderr.join('')).toContain('inspection failed')
    expect(output.stderr.join('')).not.toContain('node:internal')
  })
})
