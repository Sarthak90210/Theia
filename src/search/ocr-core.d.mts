import type { OcrLine } from './ocr.ts'

/** See ocr-core.mjs. Only what TypeScript code uses; the worker loads the rest. */
export function tiles(w: number, h: number, size: number, overlap: number): [number, number, number, number][]
export function mergeLines<T extends Pick<OcrLine, 'text' | 'conf' | 'box'>>(lines: T[]): T[]
