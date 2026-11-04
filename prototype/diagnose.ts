import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { UsbmuxConnection } from '../src/protocol/usbmux.ts'
import { LockdownClient, LOCKDOWN_PORT, TLS_STRATEGIES, type PairRecord } from '../src/protocol/lockdown.ts'
import { parsePlist } from '../src/protocol/plist-io.ts'

/**
 * Tells you which of the three device layers is broken, and what to do about it.
 * "Cannot find device" is three unrelated failures wearing one message, and
 * prompting for Trust when the cable is dead is worse than saying nothing.
 */

const run = promisify(execFile)

const ok = (s: string) => console.log(`  \x1b[32mok\x1b[0m    ${s}`)
const bad = (s: string) => console.log(`  \x1b[31mfail\x1b[0m  ${s}`)
const fix = (s: string) => console.log(`  \x1b[33m→\x1b[0m     ${s}`)
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

async function usbPresent(): Promise<{ present: boolean; ghosts: number }> {
  const script = `
    $all = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_05AC' -and $_.Class -eq 'USBDevice' })
    $now = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_05AC' })
    [pscustomobject]@{ present = $now.Count; ghosts = $all.Count } | ConvertTo-Json -Compress
  `
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', script])
  const parsed = JSON.parse(stdout.trim())
  return { present: parsed.present > 0, ghosts: parsed.ghosts }
}

async function serviceRunning(): Promise<boolean> {
  try {
    const { stdout } = await run('powershell', [
      '-NoProfile',
      '-Command',
      "(Get-Service 'Apple Mobile Device Service' -ErrorAction SilentlyContinue).Status",
    ])
    return stdout.trim() === 'Running'
  } catch {
    return false
  }
}

async function main() {
  console.log('\n\x1b[1mdevice connection diagnostic\x1b[0m')

  // --------------------------------------------------- layer 0, the service
  step('0. Apple Mobile Device Service')
  if (!(await serviceRunning())) {
    bad('not running')
    fix('Install Apple Devices from the Microsoft Store, or start the service.')
    return
  }
  ok('running')

  // ------------------------------------------------ layer 1, USB enumeration
  step('1. USB enumeration')
  const usb = await usbPresent()
  if (!usb.present) {
    bad(`no Apple USB device present (${usb.ghosts} stale records from past connections)`)
    fix('Check the cable first. Charge-only USB-C cables enumerate nothing.')
    fix('Then try a different port, preferring one directly on the machine.')
    fix('Unlocking and tapping Trust cannot help at this layer.')
    return
  }
  ok('Windows sees an Apple USB device')

  // --------------------------------------------- layer 2, usbmuxd visibility
  step('2. usbmuxd visibility')
  const mux = await UsbmuxConnection.open()
  const devices = await mux.listDevices()
  mux.close()
  const device = devices.find((d) => d.Properties.ConnectionType === 'USB')
  if (!device) {
    bad('usbmuxd does not see the device, though Windows does')
    fix('Restart Apple Mobile Device Service, then run this again.')
    return
  }
  ok(`device ${device.Properties.DeviceID}, udid ${device.Properties.SerialNumber}`)

  // ------------------------------------------------ layer 3, pairing / trust
  step('3. pairing and trust')
  const mux2 = await UsbmuxConnection.open()
  const data = await mux2.readPairRecord(device.Properties.SerialNumber)
  mux2.close()
  if (!data) {
    bad('no pairing record')
    fix('Unlock the phone and tap Trust on the prompt, then run this again.')
    return
  }
  const pair = parsePlist(data) as PairRecord
  ok('pairing record present')

  const muxL = await UsbmuxConnection.open()
  const lockdown = new LockdownClient(await muxL.connectToPort(device.Properties.DeviceID, LOCKDOWN_PORT))
  try {
    await lockdown.queryType()
    const session = await lockdown.startSession(pair)
    if (session.ssl) await lockdown.enableSSL(pair, TLS_STRATEGIES[0]!)
    const name = await lockdown.getValue('DeviceName')
    const version = await lockdown.getValue('ProductVersion')
    ok(`session established with ${name}, iOS ${version}`)
    await lockdown.stopSession()
    console.log('\n\x1b[32mAll four layers healthy. Ready to import.\x1b[0m')
  } catch (e) {
    const msg = (e as Error).message
    bad(msg)
    if (msg.includes('InvalidHostID')) {
      fix('The pairing record is stale. Unlock the phone and tap Trust again.')
    } else if (msg.includes('PasswordProtected')) {
      fix('The phone is locked. Unlock it and run this again.')
    } else {
      fix('Unexpected lockdownd failure. Capture this message before retrying.')
    }
  } finally {
    lockdown.destroy()
  }
}

main().catch((e) => {
  console.error(`\n\x1b[31munhandled\x1b[0m ${(e as Error).stack}`)
  process.exitCode = 1
})
