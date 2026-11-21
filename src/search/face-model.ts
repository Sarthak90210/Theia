/**
 * The face models, pinned and shipped inside Theia like the others
 * (scripts/prepare-models.mjs, resources/models/faces).
 *
 * From the OpenCV Zoo: YuNet finds faces and their landmarks (MIT, 0.2MB),
 * SFace describes each face as 128 numbers (Apache 2.0, 37MB). Chosen over
 * the better-known InsightFace models, whose licence forbids shipping them in
 * an app. About 5 photos a second on a laptop CPU.
 */

export const FACE_NAME = 'faces'

const YUNET = { repo: 'opencv/face_detection_yunet', revision: '3cc26e7f1014a5ee5d74a42acee58bafc9d0a310' }
const SFACE = { repo: 'opencv/face_recognition_sface', revision: '3d7082438a6e4551e840c9b2bb60b71e8da4b524' }

export const FACE_FILES: Record<string, { repo: string; revision: string; path: string; sha256: string }> = {
  'yunet.onnx': { ...YUNET, path: 'face_detection_yunet_2023mar.onnx', sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  'yunet-LICENSE': { ...YUNET, path: 'LICENSE', sha256: 'c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958' },
  'sface.onnx': { ...SFACE, path: 'face_recognition_sface_2021dec.onnx', sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79' },
  'sface-LICENSE': { ...SFACE, path: 'LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
}

/** What stored faces depend on. A different key looks for faces again. */
export const FACE_KEY = 'yunet2023mar:sface2021dec:v1'
