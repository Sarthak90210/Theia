import plist from 'plist'
import bplist from 'bplist-parser'

/** Apple hands back XML plists over the wire and binary plists on disk. Sniff. */
export function parsePlist(buf: Buffer): any {
  if (buf.length >= 8 && buf.subarray(0, 8).toString('ascii') === 'bplist00') {
    const [first] = bplist.parseBuffer(buf)
    return first
  }
  return plist.parse(buf.toString('utf8'))
}

export function buildPlist(obj: Record<string, unknown>): Buffer {
  return Buffer.from(plist.build(obj as plist.PlistValue), 'utf8')
}

/** Redact pairing material so a captured transcript is safe to commit. */
const SECRET_KEYS = new Set([
  'HostPrivateKey',
  'RootPrivateKey',
  'HostCertificate',
  'RootCertificate',
  'DeviceCertificate',
  'EscrowBag',
  'PairRecordData',
  'SessionID',
  'WiFiMACAddress',
])

export function scrub(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) ? '<redacted>' : scrub(v)
    }
    return out
  }
  return value
}
