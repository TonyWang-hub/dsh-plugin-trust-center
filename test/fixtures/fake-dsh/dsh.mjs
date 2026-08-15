#!/usr/bin/env node
// Trust Center test fixture: simulates the small official `dsh` CLI surface
// used by Stage 3 profile transactions. It never touches a real DSH
// installation — all state lives under $DSH_HOME, which tests point at a
// disposable temporary directory.
//
// Supported surface:
//   dsh --profile <name> --dump-config
//   dsh plugin --profile <name> remove <package>
//   dsh plugin --profile <name> add <spec>
//
// Failure injection via environment:
//   FAKE_DSH_FAIL_DUMP=1            dump-config exits 1
//   FAKE_DSH_FAIL_REMOVE=<pkg>      remove of <pkg> mutates, then exits 1
//   FAKE_DSH_FAIL_ADD=<pkg>         add of <pkg> mutates, then exits 1
//   FAKE_DSH_SLEEP_MS=<ms>          write started/finished markers around sleep

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const home = process.env.DSH_HOME ?? ''
const sleepMs = Number(process.env.FAKE_DSH_SLEEP_MS ?? '0')

if (sleepMs > 0) {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'fake-dsh-started'), 'started')
  await new Promise(resolve => setTimeout(resolve, sleepMs))
  await writeFile(join(home, 'fake-dsh-finished'), 'finished')
}

function profileDir(profile) {
  return join(home, 'profiles', profile)
}

async function readProfileJson(profile) {
  try {
    return JSON.parse(await readFile(join(profileDir(profile), 'package.json'), 'utf8'))
  } catch {
    return { name: profile, version: '0.0.0', dependencies: {}, dsh: { profile: { bundles: [] } } }
  }
}

async function writeProfileJson(profile, data) {
  await mkdir(profileDir(profile), { recursive: true })
  await writeFile(join(profileDir(profile), 'package.json'), `${JSON.stringify(data, null, 2)}\n`)
}

function pkgFromSpec(spec) {
  if (spec.startsWith('@')) {
    const match = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/)
    return { name: match?.[1] ?? spec, version: match?.[2] ?? '0.0.0' }
  }
  const match = spec.match(/^([^@]+)(?:@(.+))?$/)
  return { name: match?.[1] ?? spec, version: match?.[2] ?? '0.0.0' }
}

async function main() {
  const profileIndex = args.indexOf('--profile')
  const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined
  if (profile === undefined) {
    process.stderr.write(`fake dsh: missing --profile in: ${args.join(' ')}\n`)
    process.exit(2)
  }

  // Strip option tokens so positionals line up regardless of order.
  const cleaned = args.filter((arg, index) => !(
    arg === '--profile'
    || (index > 0 && args[index - 1] === '--profile')
  ))

  if (cleaned.includes('--dump-config')) {
    const data = await readProfileJson(profile)
    process.stdout.write(`${JSON.stringify({ profile, bundles: data.dsh?.profile?.bundles ?? [] })}\n`)
    if (process.env.FAKE_DSH_FAIL_DUMP === '1') {
      process.stderr.write('fake dsh: dump-config failed\n')
      process.exit(1)
    }
    process.exit(0)
  }

  const pluginIndex = cleaned.indexOf('plugin')
  const action = pluginIndex >= 0 ? cleaned[pluginIndex + 1] : undefined
  const target = pluginIndex >= 0 ? cleaned[pluginIndex + 2] : undefined
  if (action !== 'remove' && action !== 'add') {
    process.stderr.write(`fake dsh: unsupported command: ${args.join(' ')}\n`)
    process.exit(2)
  }

  const data = await readProfileJson(profile)
  if (action === 'remove') {
    data.dsh = data.dsh ?? {}
    data.dsh.profile = data.dsh.profile ?? {}
    data.dsh.profile.bundles = (data.dsh.profile.bundles ?? []).filter(bundle => bundle !== target)
    if (data.dependencies !== undefined) delete data.dependencies[target]
    if (process.env.FAKE_DSH_FAIL_REMOVE === target) {
      await writeProfileJson(profile, data)
      process.stderr.write(`fake dsh: remove failed for ${target}\n`)
      process.exit(1)
    }
    await writeProfileJson(profile, data)
    process.stdout.write(`fake dsh: removed ${target} from ${profile}\n`)
    process.exit(0)
  }

  const { name, version } = pkgFromSpec(target ?? '')
  data.dsh = data.dsh ?? {}
  data.dsh.profile = data.dsh.profile ?? {}
  data.dsh.profile.bundles = data.dsh.profile.bundles ?? []
  if (!data.dsh.profile.bundles.includes(name)) data.dsh.profile.bundles.push(name)
  data.dependencies = data.dependencies ?? {}
  data.dependencies[name] = version
  if (process.env.FAKE_DSH_FAIL_ADD === name) {
    await writeProfileJson(profile, data)
    process.stderr.write(`fake dsh: add failed for ${name}\n`)
    process.exit(1)
  }
  await writeProfileJson(profile, data)
  process.stdout.write(`fake dsh: added ${name}@${version} to ${profile}\n`)
  process.exit(0)
}

main().catch(error => {
  process.stderr.write(`fake dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
