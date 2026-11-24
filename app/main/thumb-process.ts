import path from 'node:path'
import { utilityProcess } from 'electron'
import type { ChildLike } from '../../src/thumbs/render-host.ts'

/**
 * Start the thumbnail process (dist-app/thumb-host.cjs, built from
 * src/thumbs/render-child.ts) as an Electron utility process: its own OS
 * process, so a decoder that crashes takes only it down (render-host.ts).
 */
export function spawnThumbnailProcess(): ChildLike {
  const child = utilityProcess.fork(path.join(__dirname, 'thumb-host.cjs'), [], { serviceName: 'Theia thumbnails' })
  return {
    post: (m) => child.postMessage(m),
    onMessage: (l) => child.on('message', l),
    onExit: (l) => child.on('exit', (code) => l(code)),
    kill: () => { child.kill() },
  }
}
