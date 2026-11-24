import os from 'node:os'
import { HeicPool } from './heic-pool.ts'
import { renderThumbnails } from './render.ts'
import { PermanentJobError } from '../jobs/queue.ts'
import type { RenderRequest } from './render-host.ts'

/**
 * The thumbnail process (see render-host.ts). Takes one request per message,
 * renders all three sizes into the cache, and answers with the image's size.
 * Runs under Electron's utilityProcess in the app (messages on
 * process.parentPort) and under child_process.fork in tests (process.send).
 */

type Incoming = RenderRequest & { id: number }

const parentPort = (process as unknown as { parentPort?: { on(e: 'message', l: (ev: { data: Incoming }) => void): void; postMessage(m: unknown): void } }).parentPort
const reply = (m: unknown) => (parentPort ? parentPort.postMessage(m) : process.send?.(m))

const heic = new HeicPool(Math.max(1, Math.min(Math.floor(os.cpus().length / 4), 4)))

async function handle(msg: Incoming) {
  try {
    const result = await renderThumbnails(msg.file, msg.mime, msg.sha256, msg.cacheRoot, { heic })
    reply({ id: msg.id, ok: true, result })
  } catch (e) {
    reply({ id: msg.id, ok: false, error: (e as Error).message, permanent: e instanceof PermanentJobError })
  }
}

if (parentPort) parentPort.on('message', (ev) => void handle(ev.data))
else process.on('message', (m) => void handle(m as Incoming))
