import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_CHANNELS, STATE_CHANNEL, type AppState, type PhotosApi } from '../shared/api.ts'

/**
 * The only bridge between the window and Node. The window gets `window.photos`
 * with exactly the methods in PhotosApi, and no access to ipcRenderer itself.
 */

const api: Record<string, unknown> = {}
for (const channel of INVOKE_CHANNELS) {
  api[channel] = (...args: unknown[]) => ipcRenderer.invoke(`photos:${channel}`, ...args)
}
api.onState = (listener: (s: AppState) => void) => {
  const wrapped = (_e: unknown, s: AppState) => listener(s)
  ipcRenderer.on(STATE_CHANNEL, wrapped)
  return () => ipcRenderer.off(STATE_CHANNEL, wrapped)
}

contextBridge.exposeInMainWorld('photos', api as unknown as PhotosApi)
