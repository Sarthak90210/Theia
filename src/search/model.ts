/**
 * The search model, pinned. Theia ships these exact files inside the app
 * (scripts/prepare-models.mjs puts them in .release-tools/models, the
 * installer carries them to resources/models), so search works offline from
 * the first launch and nobody has to fetch or set up anything.
 *
 * EmbeddingGemma 2, the ONNX build for Transformers.js. Text and image share
 * one vector space: a typed query is compared directly with photo vectors.
 */

export const MODEL_NAME = 'embeddinggemma-2'
export const MODEL_REPO = 'onnx-community/embeddinggemma-2-ONNX'
export const MODEL_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'

/**
 * Image budget in vision tokens (70, 140, 280, 560 or 1120). 70 is about four
 * times faster than the default 280 on a laptop CPU. Measured on a real
 * library, it kept the same top result for every test query and a mean cosine
 * of 0.95 to the 280-token vectors.
 */
export const VISION_TOKENS = 70

/** Matryoshka truncation: about 98% of full-size image retrieval quality at a third of the storage. */
export const DIMENSIONS = 256

/**
 * Everything that changes what a stored vector means. A different key
 * re-embeds the library. The device is not part of it: vectors made on a GPU
 * and on a CPU agree to a cosine of 0.996 (measured on a real library), so a
 * vault indexed on one machine searches fine on another.
 */
export const MODEL_KEY = `${MODEL_NAME}@${MODEL_REVISION.slice(0, 7)}:fp16:t${VISION_TOKENS}:d${DIMENSIONS}`

/** The model was trained with task prefixes on text. Images take none. */
export const QUERY_PREFIX = 'task: search result | query: '

/**
 * Files the app needs, with their SHA-256. 16-bit weights for the text model
 * and the vision encoder: what GPUs run (the 8-bit build fails on DirectML and
 * WebGPU runs it no faster), and on a CPU still faster than the 8-bit build
 * (1.3 against 1.8 seconds a photo on an i7-13620H).
 */
export const MODEL_FILES: Record<string, string> = {
  'config.json': '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d',
  'config_sentence_transformers.json': '031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5',
  'preprocessor_config.json': '9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa',
  'processor_config.json': '168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c',
  'tokenizer.json': '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4',
  'tokenizer_config.json': '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874',
  'chat_template.jinja': '4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e',
  'onnx/model_fp16.onnx': 'a49e227d7e0e5f4ee606d79879d084264366367bc6318f344ab179e35d4fd6a4',
  'onnx/model_fp16.onnx_data': 'b9dbe09415d77c8686ba6e216a244086f4ada1608238c13f2bfaa587ba627207',
  'onnx/vision_encoder_fp16.onnx': '3e2b6d5648a3ae61b572cc3ec0a23b13ebfda3b63e3c9c343c593636392a879c',
  'onnx/vision_encoder_fp16.onnx_data': '9f374070808b8b96252f7d04c9c4eae34df60283473fde5a3fbf4d9205495e19',
}
