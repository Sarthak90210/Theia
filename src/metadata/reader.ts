import { gunzipSync, gzipSync } from 'node:zlib'
import { deriveMetadata, type FileMetadata, type RawTags, type ResolveOptions } from './tags.ts'

/**
 * The I/O half of metadata. Kept behind an interface so grouping and the
 * import engine can be tested with literal tags and no exiftool process.
 */
export interface MetadataReader {
  read(filePath: string, fallbackMs?: number): Promise<{ meta: FileMetadata; raw: RawTags }>
  close(): Promise<void>
}

/** Raw tags are stored compressed; they are highly repetitive JSON. */
export function packTags(raw: RawTags): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(raw), 'utf8'))
}

export function unpackTags(blob: Buffer | Uint8Array): RawTags {
  return JSON.parse(gunzipSync(Buffer.from(blob)).toString('utf8')) as RawTags
}

/**
 * exiftool is a large dependency for one job and still the right call: nothing
 * else reads the Apple MakerNote reliably, and that is what pairs Live Photos.
 * It runs resident via -stay_open, which is the only way the throughput is
 * tolerable across thousands of files.
 */
export class ExifToolReader implements MetadataReader {
  private tool: { readRaw(f: string, a: string[]): Promise<unknown>; end(): Promise<void> } | null = null

  private async tool_(): Promise<NonNullable<typeof this.tool>> {
    if (!this.tool) {
      const { exiftool } = await import('exiftool-vendored')
      this.tool = exiftool as unknown as NonNullable<typeof this.tool>
    }
    return this.tool
  }

  async read(filePath: string, fallbackMs?: number) {
    const tool = await this.tool_()
    // -G1 for family-1 group names, -n for numeric values rather than the
    // human-readable forms (GPS especially, which otherwise reads as
    // `35 deg 39' 23.54"`).
    const raw = (await tool.readRaw(filePath, ['-G1', '-n'])) as RawTags
    return { meta: deriveMetadata(raw, fallbackMs), raw }
  }

  async close() {
    if (this.tool) {
      await this.tool.end()
      this.tool = null
    }
  }
}

/**
 * For tests: serves tags supplied up front. Keys match either the full path or
 * the basename, because the engine reads from a generated staging path that a
 * test cannot know in advance.
 */
export class StubMetadataReader implements MetadataReader {
  constructor(
    private readonly byPath: Record<string, RawTags>,
    private readonly opts?: ResolveOptions,
  ) {}

  async read(filePath: string, fallbackMs?: number) {
    // Staging names flatten the device path, so a read arrives as something
    // like "DCIM_100APPLE_IMG_0001.HEIC.partial".
    const base = (filePath.split(/[\\/]/).pop() ?? filePath).replace(/\.partial$/, '')
    const raw =
      this.byPath[filePath] ??
      Object.entries(this.byPath).find(([k]) => base === k || base.endsWith(`_${k}`))?.[1] ??
      {}
    return { meta: deriveMetadata(raw, fallbackMs, this.opts), raw }
  }

  async close() {}
}
