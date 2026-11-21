import fs from 'node:fs'
import path from 'node:path'
import { ModelWorker } from './model-worker.ts'
import { FACE_FILES } from './face-model.ts'

export interface FoundFace {
  /** x, y, width, height in the pixels of the image read. */
  box: [number, number, number, number]
  /** Eyes, nose tip, mouth corners. */
  landmarks: [number, number][]
  score: number
  /** Higher is sharper; a blurred face describes poorly. */
  sharpness: number
  /** 128 numbers, unit length. Faces of one person point the same way. */
  vec: Float32Array
}

export interface FaceResult {
  width: number
  height: number
  faces: FoundFace[]
}

export interface ClusterInput {
  free: Float32Array
  freeAsset: Int32Array
  held: Float32Array
  heldAsset: Int32Array
  heldPerson: Int32Array
  /** [index into free, person id]: "this face is not that person". */
  rejects: [number, number][]
  threshold?: number
  minPhotos?: number
  /** Per free face: 1 when it looks roughly at the camera. Side-on faces never start a group. */
  frontal?: Uint8Array
  /** How much more alike a side-on face must be to join someone. */
  sideOnMargin?: number
  /** How near a person's average face a face must be to join them. */
  minCentre?: number
  /** How alike faces must be to start a group together (stricter than joining). */
  groupThreshold?: number
  /** Neighbours a face needs to anchor a new group. */
  minNeighbours?: number
}

export interface ClusterResult {
  /** Per free face: the person it joins, or -1. */
  person: Int32Array
  /** Per free face: a new group to become a person, or -1. */
  group: Int32Array
}

/** Finds faces in a photo, and groups faces into people. */
export interface ReadFaces {
  read(file: string): Promise<FaceResult>
  cluster(input: ClusterInput): Promise<ClusterResult>
}

/** YuNet and SFace in a worker thread (face-worker.mjs). */
export class FaceReader implements ReadFaces {
  private readonly worker: ModelWorker<FaceResult & ClusterResult>

  constructor(modelDir: string, opts: { idleMs?: number; threads?: number } = {}) {
    this.worker = new ModelWorker(
      new URL('./face-worker.mjs', import.meta.url),
      () => ({ modelDir, threads: opts.threads ?? 2 }),
      'face finder',
      opts.idleMs,
    )
  }

  static available(modelDir: string): boolean {
    return Object.keys(FACE_FILES).every((f) => fs.existsSync(path.join(modelDir, f)))
  }

  async read(file: string): Promise<FaceResult> {
    const { width, height, faces } = await this.worker.ask({ kind: 'read', file })
    return { width, height, faces }
  }

  async cluster(input: ClusterInput): Promise<ClusterResult> {
    const { person, group } = await this.worker.ask({ kind: 'cluster', ...input })
    return { person, group }
  }

  close(): Promise<void> {
    return this.worker.close()
  }
}
