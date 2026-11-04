// Exercise the shipped runtime with an isolated profile and no developer tools on PATH.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const executable = path.resolve(process.argv[2] ?? 'release/win-unpacked/Theia.exe')
if (!fs.existsSync(executable)) throw new Error(`Build the app first: ${executable}`)
const root = path.resolve('transcripts', `release-smoke-${Date.now()}`)
fs.mkdirSync(root, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const windows = env.SystemRoot ?? 'C:\\Windows'
env.PATH = `${path.join(windows, 'System32')};${windows}`
const stdout = fs.openSync(path.join(root, 'stdout.log'), 'w')
const stderr = fs.openSync(path.join(root, 'stderr.log'), 'w')
const child = spawn(executable, [`--theia-smoke-dir=${root}`], { env, windowsHide: true, stdio: ['ignore', stdout, stderr] })
const timer = setTimeout(() => { child.kill(); console.error('Packaged smoke timed out.'); process.exitCode = 1 }, 120_000)
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'packaged-smoke.json'), 'utf8'))
  console.log(JSON.stringify({ executable, receipt: path.join(root, 'packaged-smoke.json'), ok: receipt.ok,
    checks: receipt.checks.length, error: receipt.error }, null, 2))
  fs.writeFileSync('transcripts/latest-release-smoke.txt', root)
  process.exitCode = code === 0 && receipt.ok ? 0 : 1
} finally { clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr) }
