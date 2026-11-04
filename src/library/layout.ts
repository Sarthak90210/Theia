import path from 'node:path'

/**
 * Where things live under a library root. Two kinds of storage with different
 * promises, the way Apple's Photos library and Lightroom's catalog split them:
 *
 * - media: originals. Verified on import, never rewritten, backed up.
 * - cache: thumbnails, previews and later search indexes. Built from the
 *   originals and nothing else. Deleting the whole folder costs time to
 *   rebuild and loses no data, so nothing may exist only in here.
 *
 * ```
 * <root>/
 *   library.db
 *   media/   originals, plus .staging, .quarantine and .reports
 *   cache/   thumbs/<ab>/<sha256>-<size>.webp
 * ```
 */
export interface LibraryLayout {
  root: string
  db: string
  media: string
  cache: string
}

export function libraryLayout(root: string): LibraryLayout {
  return {
    root,
    db: path.join(root, 'library.db'),
    media: path.join(root, 'media'),
    cache: path.join(root, 'cache'),
  }
}
