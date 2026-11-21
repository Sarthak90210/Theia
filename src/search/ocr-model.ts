/**
 * The text-reading (OCR) models, pinned and shipped inside Theia like the
 * search model (scripts/prepare-models.mjs, resources/models/ppocr).
 *
 * PaddleOCR, Apache 2.0, as ONNX: the PP-OCRv4 mobile text detector, the
 * PP-OCRv5 English line reader and the PP-OCRv3 Devanagari line reader
 * (Hindi, Marathi, Nepali). About 21MB in all, and about 0.2 seconds a photo
 * on a laptop CPU, more for a page full of text.
 */

export const OCR_NAME = 'ppocr'

const RAPIDOCR = { repo: 'SWHL/RapidOCR', revision: '1cfba2e90fc938db55889873735088de210cc173' }
const MONKT = { repo: 'monkt/paddleocr-onnx', revision: '7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65' }

/** Line readers, tried in this order. The most confident reading of a line wins. */
export const OCR_SCRIPTS = ['en', 'devanagari'] as const

/** File in the model folder, where it comes from, and its SHA-256. */
export const OCR_FILES: Record<string, { repo: string; revision: string; path: string; sha256: string }> = {
  'det.onnx': { ...RAPIDOCR, path: 'PP-OCRv4/ch_PP-OCRv4_det_infer.onnx', sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9' },
  'en.onnx': { ...MONKT, path: 'languages/english/rec.onnx', sha256: '4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7' },
  'en.txt': { ...MONKT, path: 'languages/english/dict.txt', sha256: 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6' },
  'devanagari.onnx': { ...MONKT, path: 'languages/hindi/rec.onnx', sha256: '43df175fa3c877fbf7bcc4e5bd1e203e24ec450cd3ea96c9e802c86e39a4d4cf' },
  'devanagari.txt': { ...MONKT, path: 'languages/hindi/dict.txt', sha256: 'b5f1be6d8bbff1a19fb96c5d4ca96a423380234bb7d2ce0e07b5838adb4d18ea' },
}

/**
 * What a stored reading depends on. A different key reads the library again;
 * text read under an older key is still searched until then.
 * v2: where each line and character is, for highlighting.
 */
export const OCR_KEY = `ppocr:det4-mobile:en5:deva3:v2`
