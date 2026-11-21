import fs from 'node:fs'
import path from 'node:path'
import { ModelWorker } from './model-worker.ts'
import { OCR_FILES, OCR_SCRIPTS } from './ocr-model.ts'
import type { Device, DeviceChoice } from './embedder.ts'

export interface OcrLine {
  text: string
  conf: number
  /** Corners in image pixels: top left, top right, bottom right, bottom left of the text. */
  box: [number, number][]
  /** Where each character of `text` sits along the box, 0 (start) to 1 (end). */
  at: number[]
}

export interface OcrResult {
  /** Size of the image read, which the boxes are in. */
  width: number
  height: number
  lines: OcrLine[]
}

/** Reads the text in a photo, line by line, top to bottom. */
export interface ReadText {
  read(file: string): Promise<OcrResult>
}

/** PaddleOCR in a worker thread (ocr-worker.mjs). */
export class OcrReader implements ReadText {
  private readonly worker: ModelWorker<OcrResult>

  constructor(modelDir: string, opts: { idleMs?: number; threads?: number; device?: Device; onDevice?: (d: DeviceChoice) => void } = {}) {
    this.worker = new ModelWorker(
      new URL('./ocr-worker.mjs', import.meta.url),
      // Two threads: the models are small, and search by meaning runs alongside.
      () => ({ modelDir, threads: opts.threads ?? 2, scripts: [...OCR_SCRIPTS], device: opts.device ?? 'auto' }),
      'text reader',
      opts.idleMs,
      (e) => opts.onDevice?.({ device: e.device as 'gpu' | 'cpu', reason: (e.reason as string | null) ?? null }),
    )
  }

  static available(modelDir: string): boolean {
    return Object.keys(OCR_FILES).every((f) => fs.existsSync(path.join(modelDir, f)))
  }

  async read(file: string): Promise<OcrResult> {
    const { width, height, lines } = await this.worker.ask({ file })
    return { width, height, lines }
  }

  close(): Promise<void> {
    return this.worker.close()
  }
}
