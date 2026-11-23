import { FACE_KEY } from './face-model.ts'
import { MODEL_KEY } from './model.ts'
import { OCR_KEY } from './ocr-model.ts'

/**
 * What a closer look at a photo depends on, per stage: the model that looked
 * and how. A new model, or a change to how closely it looks, looks again.
 */
export const DEEP_VERSION = 'deep1'

export const DEEP_KEYS = {
  faces: `${FACE_KEY}:${DEEP_VERSION}`,
  ocr: `${OCR_KEY}:${DEEP_VERSION}`,
  embed: `${MODEL_KEY}:${DEEP_VERSION}`,
} as const

export type DeepStage = keyof typeof DEEP_KEYS
