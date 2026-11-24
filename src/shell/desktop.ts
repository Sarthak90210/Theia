import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { POWERSHELL } from './powershell.ts'

/**
 * The Windows side of a photo's right-click menu, through desktop-helper.ps1:
 * Share (the Windows share sheet), Open with (the apps File Explorer offers
 * for the file), desktop background, lock screen, and copying files the way
 * File Explorer does. Each call is one short PowerShell run; Share's stays
 * until the app chosen has read the files.
 */

export interface ShellCommand {
  /** Explorer's name for it ("open", "print", "Windows.ModernShare"), or "" when it has none. */
  verb: string
  label: string
}

export interface AppChoice {
  /** What to pass back to openWith. */
  id: string
  label: string
}

const HELPER = 'desktop-helper.ps1'

export function desktopHelperPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'shell', HELPER), path.join(here, HELPER), path.resolve(here, '../../src/shell', HELPER)]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

function helper(): string {
  if (process.platform !== 'win32') throw new Error('This needs Windows.')
  const p = desktopHelperPath()
  if (!p) throw new Error("Theia's Windows helper is missing. Rebuild or reinstall Theia.")
  return p
}

const ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File']

/** The helper's JSON line, or its error as an Error. */
export function parseReply<T>(stdout: string): T {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (!line) throw new Error('Windows gave no answer.')
  const reply = JSON.parse(line) as T & { error?: string }
  if (reply.error) throw new Error(reply.error)
  return reply
}

function run<T = { ok: true }>(op: string, args: string[], timeout = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, [...ARGS, helper(), op, ...args], { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      try {
        resolve(parseReply<T>(stdout))
      } catch (e) {
        reject(error && !stdout.trim() ? new Error(`Windows couldn't do that: ${error.message}`) : e)
      }
    })
  })
}

export async function shellCommands(file: string): Promise<ShellCommand[]> {
  return (await run<{ verbs: ShellCommand[] }>('verbs', [file])).verbs ?? []
}

/**
 * The apps worth offering under Open with, from Explorer's commands for the
 * file: its default app, then each "Edit with Paint", "Open with VLC" and the
 * like. Not Explorer's own housekeeping (Copy, Rename, 7-Zip, Send to).
 */
export function openWithChoices(commands: ShellCommand[]): AppChoice[] {
  const out: AppChoice[] = []
  const seen = new Set<string>()
  for (const c of commands) {
    if (c.label.includes(' > ')) continue
    const isDefault = c.verb === 'open'
    const isApp = /^(edit|open|play|view|preview) (with|in) /i.test(c.label) && !/notepad|copilot/i.test(c.label)
    if (!isDefault && !isApp) continue
    const label = isDefault ? 'Default app' : c.label.replace(/^(edit|open|play|view|preview) (with|in) /i, '').trim()
    if (!label || seen.has(label.toLowerCase())) continue
    seen.add(label.toLowerCase())
    out.push({ id: c.verb || c.label, label })
  }
  return out
}

export async function runShellCommand(file: string, verb: string): Promise<void> {
  await run('invoke', [file, verb])
}

/** Windows' own "How do you want to open this file?" dialog. */
export function chooseApp(file: string): void {
  const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', file], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

export async function setWallpaper(file: string): Promise<void> {
  await run('wallpaper', [file])
}

export async function setLockScreen(file: string): Promise<void> {
  await run('lockscreen', [file])
}

/** The files on the clipboard as File Explorer copies them; `image`, a picture to paste into a chat or a document too. */
export async function copyFiles(files: string[], image?: string): Promise<void> {
  await run('copy', image ? [...files, 'image', image] : files)
}

/**
 * The Windows share sheet for these files, over the point (x, y) on screen.
 * Resolves once the sheet is up. The helper stays running in the background
 * until the app chosen has the files, or `parentPid` (Theia) ends.
 */
export function shareFiles(files: string[], at: { x: number; y: number }, parentPid = process.pid): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, [...ARGS, helper(), 'share', ...files, 'at', String(Math.round(at.x)), String(Math.round(at.y)), String(parentPid)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error('Windows took too long to open the share sheet.')), 30_000)
    const finish = (e?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolve()
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      if (!out.includes('\n')) return
      try {
        parseReply(out)
        finish()
      } catch (e) {
        finish(e as Error)
      }
    })
    child.on('error', (e) => finish(e))
    child.on('exit', () => finish(new Error("Windows couldn't open the share sheet.")))
  })
}
