import fs from 'node:fs'
import path from 'node:path'

const MAX_AGE_MS = 30 * 24 * 3600 * 1000

/** All map access, including cached tiles, passes the current privacy setting. */
export class MapTiles {
  private readonly requests = new Set<AbortController>()

  constructor(private readonly deps: {
    cacheRoot: string
    enabled: () => boolean
    fetch: (url: string, init: RequestInit) => Promise<Response>
    userAgent: string
  }) {}

  cancel() { for (const request of this.requests) request.abort() }

  async get(pathname: string): Promise<Response> {
    const disabled = () => new Response('Maps are disabled in Settings.', { status: 403, headers: { 'Cache-Control': 'no-store' } })
    if (!this.deps.enabled()) return disabled()
    const parts = pathname.split('/').filter(Boolean)
    if (parts.length !== 3 || parts.some(n => !/^\d+$/.test(n))) return new Response('bad tile', { status: 400 })
    const [z, x, y] = parts.map(Number) as [number, number, number]
    if (z > 19 || x >= 2 ** z || y >= 2 ** z) return new Response('bad tile', { status: 400 })
    const file = path.join(this.deps.cacheRoot, String(z), String(x), `${y}.png`)
    const cached = fs.existsSync(file) ? fs.statSync(file) : null
    const serve = () => this.deps.enabled()
      ? new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
      : disabled()
    if (cached && Date.now() - cached.mtimeMs < MAX_AGE_MS) return serve()
    const request = new AbortController()
    this.requests.add(request)
    try {
      const res = await this.deps.fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
        headers: { 'User-Agent': this.deps.userAgent }, signal: request.signal,
      })
      if (!res.ok) throw new Error(`tile server said ${res.status}`)
      const body = Buffer.from(await res.arrayBuffer())
      if (!this.deps.enabled() || request.signal.aborted) return disabled()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, file)
      return serve()
    } catch (e) {
      if (!this.deps.enabled() || request.signal.aborted) return disabled()
      if (cached) return serve()
      return new Response((e as Error).message, { status: 502 })
    } finally { this.requests.delete(request) }
  }
}
