import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface AtomicWriteOptions {
  /** File mode applied when the temp file is created. Defaults to 0600. */
  mode?: number
}

/**
 * Writes `data` to `target` via a same-directory temp file: exclusive create,
 * full write, fsync, close, then atomic rename. On any failure the temp file
 * is removed and the target is left untouched. This is the only writer Trust
 * Center uses for its own JSON and ledger files.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600
  const dir = dirname(target)
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, 'wx', mode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, target)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}
