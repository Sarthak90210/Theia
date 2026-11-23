// Finds faces and groups them, off the main thread (face-core.mjs,
// cluster-core.mjs). Loaded by path, like the other model workers.
//
// workerData: { modelDir, threads }
// in:  { id, kind: 'read', file } | { id, kind: 'cluster', ...clusterFaces input }
// out: { id, width, height, faces } | { id, person, group } | { id, error }

import { parentPort, workerData } from 'node:worker_threads'
import { loadFaces, readFaces } from './face-core.mjs'
import { clusterFaces } from './cluster-core.mjs'

const { modelDir, threads } = workerData
let ready = null

let queue = Promise.resolve()
parentPort.on('message', (msg) => {
  queue = queue.then(async () => {
    try {
      if (msg.kind === 'cluster') {
        const { person, group } = clusterFaces(msg)
        parentPort.postMessage({ id: msg.id, person, group }, [person.buffer, group.buffer])
        return
      }
      ready ??= loadFaces(modelDir, { threads })
      const read = await readFaces(await ready, msg.file, { deep: !!msg.deep })
      parentPort.postMessage({ id: msg.id, ...read })
    } catch (e) {
      parentPort.postMessage({ id: msg.id, error: e?.message ?? String(e) })
    }
  })
})
