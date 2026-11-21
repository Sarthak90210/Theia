import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelWorker } from './model-worker.ts'
import { DIMENSIONS, MODEL_FILES, QUERY_PREFIX, VISION_TOKENS } from './model.ts'

/** Where a model runs: 'auto' tries the GPU and checks it against the CPU first. */
export type Device = 'auto' | 'gpu' | 'cpu'

export interface DeviceChoice {
  device: 'gpu' | 'cpu'
  /** Why not the GPU, when it is the CPU. */
  reason: string | null
}

/** Turns photos and typed queries into vectors in the same space. */
export interface Embed {
  image(file: string): Promise<Float32Array>
  query(text: string): Promise<Float32Array>
}

/** EmbeddingGemma 2 in a worker thread (embed-worker.mjs). */
export class Embedder implements Embed {
  private readonly worker: ModelWorker<{ vec: Float32Array }>

  constructor(modelDir: string, opts: { idleMs?: number; threads?: number; device?: Device; onDevice?: (d: DeviceChoice) => void } = {}) {
    // About a quarter of the logical cores: indexing runs for a while, and the
    // rest of the app (thumbnails, the window) should stay quick meanwhile.
    const threads = opts.threads ?? Math.max(2, Math.min(6, Math.floor(os.cpus().length / 4)))
    this.worker = new ModelWorker(
      new URL('./embed-worker.mjs', import.meta.url),
      () => ({ modelDir, visionTokens: VISION_TOKENS, dimensions: DIMENSIONS, threads, device: opts.device ?? 'auto' }),
      'search model',
      opts.idleMs,
      (e) => opts.onDevice?.({ device: e.device as 'gpu' | 'cpu', reason: (e.reason as string | null) ?? null }),
    )
  }

  /** Whether every model file is in place. Search by meaning is off without them. */
  static available(modelDir: string): boolean {
    return Object.keys(MODEL_FILES).every((f) => fs.existsSync(path.join(modelDir, ...f.split('/'))))
  }

  async image(file: string): Promise<Float32Array> {
    return (await this.worker.ask({ kind: 'image', file })).vec
  }

  async query(text: string): Promise<Float32Array> {
    return (await this.worker.ask({ kind: 'text', text: QUERY_PREFIX + text.trim() })).vec
  }

  close(): Promise<void> {
    return this.worker.close()
  }
}
