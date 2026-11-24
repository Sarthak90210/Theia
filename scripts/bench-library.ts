import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { vaultItems } from '../src/gallery/vault-gallery.ts'
import { hasThumbs } from '../src/thumbs/render.ts'
// How long the window's library queries and the thumbnail cache check take on
// a real vault. Read-only.
//   npx tsx scripts/bench-library.ts <vault>/.vault/library.db [cache folder]
const db = new Database(process.argv[2], { readonly: true }) as any
const cacheRoot = process.argv[3] ?? path.join(path.dirname(process.argv[2]!), 'cache')
const t = (label: string, f: () => unknown) => { const s = performance.now(); const r = f(); console.log(label, (performance.now() - s).toFixed(0) + ' ms', Array.isArray(r) ? r.length : r ?? ''); return r }
t('vaultItems(library)', () => vaultItems(db, 'library'))
t('vaultItems(library) again', () => vaultItems(db, 'library'))
const items = vaultItems(db, 'library')
t('JSON size of items (KB)', () => Math.round(JSON.stringify(items).length / 1024))
const done = db.prepare(`SELECT j.asset_id, f.sha256 FROM job j JOIN file f ON f.asset_id = j.asset_id AND f.is_primary = 1 JOIN asset a ON a.id = j.asset_id WHERE j.kind = 'thumbnail' AND j.state = 'done' AND f.encrypted_path IS NULL AND a.hidden = 0 AND a.deleted_at IS NULL`).all() as { sha256: string }[]
t(`hasThumbs scan over ${done.length} items in ${cacheRoot}`, () => done.filter(r => hasThumbs(cacheRoot, r.sha256)).length)
t('job counts', () => db.prepare(`SELECT kind, state, COUNT(*) n FROM job GROUP BY kind, state`).all().map((r: any) => `${r.kind}/${r.state}=${r.n}`).join(' '))

import { vaultCollections } from '../src/gallery/vault-gallery.ts'
t('vaultCollections', () => (vaultCollections as any)(db).albums?.length ?? 'ok')
t('vaultCollections again', () => (vaultCollections as any)(db).albums?.length ?? 'ok')
