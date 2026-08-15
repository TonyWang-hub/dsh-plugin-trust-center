import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, posix, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020Import from 'ajv/dist/2020.js'

const Ajv2020 = Ajv2020Import as unknown as new (options?: { allErrors?: boolean; schemas?: unknown[] }) => {
  compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown }
}

export interface SiteCheckResult {
  files: number
  digest: string
}

export interface SiteCheckIo {
  stdout(line: string): void
  stderr(line: string): void
}

export async function runSiteCheckCli(
  args: string[],
  io: SiteCheckIo = {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  try {
    io.stdout(JSON.stringify(await checkSite(args[0] ?? 'public')))
    return 0
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export async function checkSite(rootInput: string): Promise<SiteCheckResult> {
  const root = resolve(rootInput)
  const files = await listFiles(root)
  const contents = new Map<string, Buffer>()
  for (const path of files) {
    const bytes = await readFile(join(root, path))
    contents.set(path, bytes)
    checkForbiddenOutput(path, bytes.toString('utf8'))
  }

  await checkReports(contents)
  await checkLinks(root, contents)

  const digest = createHash('sha256')
  for (const path of files) {
    digest.update(path)
    digest.update('\0')
    digest.update(contents.get(path) ?? Buffer.alloc(0))
    digest.update('\0')
  }
  return { files: files.length, digest: digest.digest('hex') }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`forbidden output symlink: ${relative(root, absolute)}`)
      if (info.isDirectory()) await visit(absolute)
      else if (info.isFile()) output.push(relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  await visit(root)
  return output.sort()
}

function checkForbiddenOutput(path: string, text: string): void {
  const patterns = [
    /(?:^|[\s"'])\/(?:Users|home|tmp|private\/var|var)\/[A-Za-z0-9._/-]+/,
    /[A-Za-z]:\\(?:Users\\)?[A-Za-z0-9._\\-]+/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
  ]
  if (patterns.some(pattern => pattern.test(text))) throw new Error(`forbidden output content: ${path}`)
}

async function checkReports(contents: Map<string, Buffer>): Promise<void> {
  const passportSchema = JSON.parse(await readFile(new URL('../../schemas/passport.schema.json', import.meta.url), 'utf8')) as unknown
  const reportSchema = JSON.parse(await readFile(new URL('../../schemas/registry-report.schema.json', import.meta.url), 'utf8')) as unknown
  const ajv = new Ajv2020({ allErrors: true, schemas: [passportSchema] })
  const validatePassport = ajv.compile(passportSchema)
  const validateReport = ajv.compile(reportSchema)
  for (const [path, bytes] of contents) {
    if (!path.startsWith('reports/') || !path.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown
    } catch {
      throw new Error(`invalid report JSON: ${path}`)
    }
    const registryReport = parsed !== null && typeof parsed === 'object'
      && 'slug' in parsed && 'status' in parsed
    if (registryReport) {
      if (!validateReport(parsed)) throw new Error(`invalid registry report: ${path}: ${JSON.stringify(validateReport.errors)}`)
      continue
    }
    const passport = parsed !== null && typeof parsed === 'object' && 'passport' in parsed
      ? (parsed as { passport: unknown }).passport
      : parsed
    if (!validatePassport(passport)) {
      throw new Error(`invalid report Passport: ${path}: ${JSON.stringify(validatePassport.errors)}`)
    }
  }
}

async function checkLinks(root: string, contents: Map<string, Buffer>): Promise<void> {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  for (const [path, bytes] of contents) {
    if (!path.endsWith('.html')) continue
    const html = bytes.toString('utf8')
    for (const match of html.matchAll(/(?:href|src)=(?:"([^"]+)"|'([^']+)')/g)) {
      const target = match[1] ?? match[2] ?? ''
      if (target === '' || target.startsWith('#') || /^(?:https?:|mailto:|data:)/.test(target)) continue
      const withoutFragment = target.split(/[?#]/, 1)[0] ?? ''
      if (withoutFragment === '') continue
      const relativeTarget = withoutFragment.startsWith('/')
        ? withoutFragment.slice(1)
        : posix.join(posix.dirname(path), withoutFragment)
      const normalized = relativeTarget.endsWith('/') ? `${relativeTarget}index.html` : relativeTarget
      const absolute = resolve(root, normalized)
      if (absolute !== root && !absolute.startsWith(rootPrefix)) throw new Error(`broken link escapes site root: ${path} -> ${target}`)
      const candidate = normalized === '' ? 'index.html' : normalized
      if (!contents.has(candidate)) throw new Error(`broken link: ${path} -> ${target}`)
    }
  }
}

function isDirectInvocation(argvPath: string | undefined): boolean {
  if (argvPath === undefined) return false
  try {
    return pathToFileURL(realpathSync(argvPath)).href === import.meta.url
  } catch {
    return false
  }
}

if (isDirectInvocation(process.argv[1])) {
  void runSiteCheckCli(process.argv.slice(2)).then(code => { process.exitCode = code })
}
