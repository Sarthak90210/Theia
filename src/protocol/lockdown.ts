import tls from 'node:tls'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { ByteReader, writeAll } from './bytes.ts'
import { buildPlist, parsePlist, scrub } from './plist-io.ts'
import type { Recorder } from './usbmux.ts'

export const LOCKDOWN_PORT = 62078

export interface PairRecord {
  HostID: string
  SystemBUID: string
  HostCertificate: Buffer
  HostPrivateKey: Buffer
  RootCertificate: Buffer
  DeviceCertificate?: Buffer
}

/**
 * The whole reason this prototype exists. Apple's lockdownd presents an old
 * self-signed certificate and, on older pair records, an RSA key below what
 * OpenSSL 3 accepts at its default security level. Node will refuse before it
 * ever sends a byte. These are tried in order and the one that works is
 * reported, so the real implementation can hardcode it.
 */
export interface TlsStrategy {
  name: string
  options: tls.ConnectionOptions
}

export const TLS_STRATEGIES: TlsStrategy[] = [
  {
    name: 'node defaults',
    options: { rejectUnauthorized: false },
  },
  {
    name: 'TLSv1.2 floor, security level 0',
    options: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      ciphers: 'DEFAULT:@SECLEVEL=0',
    },
  },
  {
    name: 'TLSv1 floor, security level 0',
    options: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1',
      ciphers: 'ALL:@SECLEVEL=0',
    },
  },
  {
    name: 'TLSv1 floor, security level 0, legacy renegotiation',
    options: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1',
      ciphers: 'ALL:@SECLEVEL=0',
      // SSL_OP_LEGACY_SERVER_CONNECT | SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
      secureOptions: 0x00000004 | 0x00040000,
    },
  },
]

export class LockdownClient {
  private reader: ByteReader
  private stream: Duplex
  sessionId: string | null = null
  tlsStrategy: string | null = null

  constructor(stream: Duplex, private record?: Recorder) {
    this.stream = stream
    this.reader = new ByteReader(stream)
  }

  private async send(obj: Record<string, unknown>): Promise<void> {
    const body = buildPlist({ Label: 'photos-win', ProtocolVersion: '2', ...obj })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    this.record?.('tx', 'lockdown', scrub({ Label: 'photos-win', ...obj }))
    await writeAll(this.stream, Buffer.concat([header, body]))
  }

  private async receive(): Promise<any> {
    const header = await this.reader.read(4)
    const body = await this.reader.read(header.readUInt32BE(0))
    const msg = parsePlist(body)
    this.record?.('rx', 'lockdown', scrub(msg))
    if (msg.Error) throw new Error(`lockdownd error: ${msg.Error}`)
    return msg
  }

  /**
   * lockdownd is strictly one request, one response per channel. Two callers
   * overlapping on the same socket interleave frames and desynchronise the
   * stream. Found the hard way benchmarking parallel StartService calls.
   */
  private queue: Promise<unknown> = Promise.resolve()

  async request(obj: Record<string, unknown>): Promise<any> {
    const run = this.queue.then(
      () => this.exchange(obj),
      () => this.exchange(obj),
    )
    this.queue = run.catch(() => undefined)
    return run
  }

  private async exchange(obj: Record<string, unknown>): Promise<any> {
    await this.send(obj)
    return this.receive()
  }

  async queryType(): Promise<string> {
    const res = await this.request({ Request: 'QueryType' })
    return res.Type
  }

  async getValue(key: string, domain?: string): Promise<unknown> {
    const req: Record<string, unknown> = { Request: 'GetValue', Key: key }
    if (domain) req.Domain = domain
    const res = await this.request(req)
    return res.Value
  }

  async startSession(pair: PairRecord): Promise<{ ssl: boolean; sessionId: string }> {
    const res = await this.request({
      Request: 'StartSession',
      HostID: pair.HostID,
      SystemBUID: pair.SystemBUID,
    })
    this.sessionId = res.SessionID
    return { ssl: res.EnableSessionSSL === true, sessionId: res.SessionID }
  }

  /** Upgrade the live socket in place. Returns the strategy name that worked. */
  async enableSSL(pair: PairRecord, strategy: TlsStrategy): Promise<void> {
    const { stream, leftover } = this.reader.detach()
    if (leftover.length) {
      throw new Error(`${leftover.length} unread bytes before TLS upgrade, framing is wrong`)
    }

    const secure = await new Promise<tls.TLSSocket>((res, rej) => {
      const sock = tls.connect({
        socket: stream as net.Socket,
        cert: pair.HostCertificate,
        key: pair.HostPrivateKey,
        ca: [pair.RootCertificate],
        ...strategy.options,
      })
      const onError = (e: Error) => {
        sock.off('secureConnect', onOk)
        rej(e)
      }
      const onOk = () => {
        sock.off('error', onError)
        res(sock)
      }
      sock.once('error', onError)
      sock.once('secureConnect', onOk)
    })

    this.stream = secure
    this.reader = new ByteReader(secure)
    this.tlsStrategy = strategy.name
  }

  async startService(name: string): Promise<{ port: number; ssl: boolean }> {
    const res = await this.request({ Request: 'StartService', Service: name })
    if (res.Error) throw new Error(`StartService ${name}: ${res.Error}`)
    return { port: res.Port, ssl: res.EnableServiceSSL === true }
  }

  async stopSession(): Promise<void> {
    if (!this.sessionId) return
    await this.request({ Request: 'StopSession', SessionID: this.sessionId })
    this.sessionId = null
  }

  destroy() {
    ;(this.stream as net.Socket).destroy?.()
  }
}
