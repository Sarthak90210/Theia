import fs from 'node:fs'
import path from 'node:path'

/**
 * Windows PowerShell by its full path. Started by name, it depends on PATH
 * containing System32\WindowsPowerShell\v1.0, and when it doesn't (a trimmed
 * PATH, as the packaged smoke test runs with), iPhone and Android transfers,
 * Share and the rest fail with ENOENT. It ships with every Windows install at
 * this path; the bare name stays as a fallback off Windows and in odd setups.
 */
export const POWERSHELL = (() => {
  const full = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    return process.platform === 'win32' && fs.existsSync(full) ? full : 'powershell.exe'
  } catch {
    return 'powershell.exe'
  }
})()
