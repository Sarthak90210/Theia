import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'

/**
 * SHA-256 of a file, streamed: constant memory whatever the size, and the
 * reads happen off the main thread, so a multi-gigabyte video being checked
 * doesn't freeze the window. Use this over a synchronous loop or readFileSync
 * on any path that runs while the app is open.
 *
 * Returns only once the file is closed again. A read stream signals its end
 * before it lets go of the file, and Windows refuses to delete or rename a
 * file that is still open: hashing and then removing a copy failed with EPERM.
 */
export async function sha256Of(file: string, opts: { signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
  const closed = once(stream, 'close')
  try {
    for await (const chunk of stream) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted')
      hash.update(chunk as Buffer)
      opts.onBytes?.((chunk as Buffer).length)
    }
  } finally {
    stream.destroy()
    await closed
  }
  return hash.digest('hex')
}
