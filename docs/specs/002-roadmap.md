# Roadmap

Rebuilt after the research in [../07-industry-practice.md](../07-industry-practice.md).
The order the user asked for still holds: transfer, then UI, then search. What
changed is that each of those now has a step in front of it that the big apps
treat as non-negotiable and this plan had skipped.

Each phase ends at something usable rather than at a percentage.

## Where it stands, 2026-11-04

| Phase | State |
|---|---|
| 1. Harden the engine | Done |
| 2. Prove it at real size | Done. 5,021 files on disk, second run 8.5 s. USB 3 cable test still open. |
| 3. Library layer | Done. Thumbnails for all 4,292 assets, 4,604 of 4,612 files decode-verified, 0 damaged. |
| 4. Shippable shell | Electron shell, device detection with the four-layer diagnosis, power blocking. The import screen that proved the engine was replaced by the gallery. Not done: bundled ffmpeg, crash reports, code signing, auto-update, installer. |
| 5. Library UI | First version works on the real phone and the real library. See [003-gallery-app.md](003-gallery-app.md). |
| 6. Search | Not started |

Run it with `npm run app`. Details of what each phase found are in
[../../prototype/FINDINGS.md](../../prototype/FINDINGS.md).

## Already done

Moved here from the old phase 1 because the code has them and the tests cover
them.

- **Preflight.** Free space, writable destination, planned counts, resumed
  bytes. Returned as data. [test/preflight.test.ts](../../test/preflight.test.ts)
- **Progress.** Run-wide bytes, trailing-window rate, ETA.
- **Quarantine actions.** Retry all or some, accept as unverified.
  [test/quarantine.test.ts](../../test/quarantine.test.ts)
- **Phase 1.1 to 1.4.** Guarded transitions in
  [src/import/stages.ts](../../src/import/stages.ts), retry classes and backoff
  in [src/import/retry.ts](../../src/import/retry.ts) with every failed attempt
  kept in `import_attempt`, read-back verification, and quarantine names keyed
  on the device path. Schema v4. [test/stages.test.ts](../../test/stages.test.ts)
- **Phase 1.5.** Every run, finished or stopped, writes
  `.reports/run-NNNN-<start>.json` and `.txt` under the library root, built
  from the database by [src/import/report.ts](../../src/import/report.ts).
  A resumed run rewrites its own report in place. Schema v5.
  [test/report.test.ts](../../test/report.test.ts)
- **Collision fix.** A destination counts as free only if neither the disk nor
  `file` claims it. Identical bytes link to the existing file instead of
  crashing on `file.path UNIQUE`, and a file left by a crash between rename
  and record is adopted instead of getting a `_1` twin.

## Phase 1: harden the engine

Done when the engine catches its own mistakes and says so, before it is trusted
with 71 GB. No phone needed for any of this.

A full-library run takes about 45 minutes. It should happen once the engine
reports problems loudly, so the run teaches something instead of producing a
pile of files nobody can vouch for.

### 1.1 Guarded stage transitions

One function owns every write to `import_item.stage`, and it refuses a move that
is not in the allowed list. An illegal transition throws, naming the item, the
old stage and the new one. This is the check that found Dropbox's duplicate
upload bug, which unit tests had missed.

Allowed:

```
planned     → fetching
fetching    → verifying | planned (detach) | quarantined
verifying   → fetching (short read, retry) | committed | quarantined
quarantined → planned (requeue) | committed (accept)
```

Anything else is a bug, including `committed → committed`.

### 1.2 Retries by error class

Split read failures into transient (timeouts, short reads, AFC I/O errors) and
permanent (file gone, permission denied). Transient gets backoff between
attempts. Permanent goes to quarantine on the first failure, with the reason. Each
retry's class gets recorded, so the full run can report retry success per class.

### 1.3 Read-back verification

After the rename into the library, read the committed file back and compare its
hash with the one taken while streaming. A mismatch means the disk did not keep
what it was given, and the item goes to quarantine. Size checks do not catch
this, and ingest tools sell the read-back as the feature.

### 1.4 Unique quarantine names

Found while reviewing the engine against the research. Quarantine files are
named by basename only. iPhone file numbers wrap at `IMG_9999` and repeat in the
next `1xxAPPLE` folder, so two failures with the same name overwrite each
other's bytes and report. Key them on the full device path instead.

### 1.5 Run reports on disk

At the end of every run, write a readable report next to the library: counts,
bytes, duration, rate, every quarantined file with its reason, and retry counts
by class. `import_run` rows already exist. This is what makes the full run in
phase 2 inspectable after the fact, so it moved up from the old 1.7.

## Phase 2: prove it at real size

Done when the whole library has been imported, twice, and the second run took
seconds.

This is the beta pool. Dropbox ran theirs for months. Here it is one person's
phone, and the equivalent is to run it for real, repeatedly, and fix what breaks.

- Full run: 4,612 files, 71 GB, including the 4.90 GB video. Record throughput,
  peak memory, staging directory size, and retries by class.
- Second run over the same phone. Everything should skip.
- Unplug the cable in the middle of the 4.90 GB file, plug it back in, and
  resume. Confirm the hash still matches.
- One USB 3 cable measurement, the open question in
  [FINDINGS.md](../../prototype/FINDINGS.md).

Fix what this surfaces before going on. Everything after this builds on the
engine.

## Phase 3: the library layer

Done when every imported asset has thumbnails and a decode check, and deleting
the cache folder loses nothing but time. Still no UI.

### 3.1 Originals and cache kept apart

Two roots with different promises. Originals are verified, never rewritten,
and included in backups. The cache (thumbnails, previews, indexes) is
rebuildable from originals and can be deleted at any time. Apple and Lightroom
both lay out their libraries this way.

### 3.2 Persisted job queue

A `job` table with a kind, a target asset, a state and attempts, plus per-kind
concurrency limits. Thumbnails, L3 decode and later all search indexing go
through it. Jobs chain: a finished thumbnail queues the next stage. Same
resume-after-crash property as import, for the same reason.

### 3.3 HEIC decode, settled once

The open risk from day one. Test whether the prebuilt `sharp` decodes HEIC on
this machine. If not, use `libheif-js`. Thumbnails and L3 verification share
this decoder, so decide it once.

**Settled 2026-11-04.** sharp 0.35.5 ships libheif 1.23.5 without the HEVC
decoder. It reads HEIC metadata and fails on pixels with "Support for this
compression format has not been built in: HEVC". `libheif-js` 1.23.5 (WASM,
libde265 included) decodes a 12 MP iPhone HEIC in about 500 ms with rotation
applied, then sharp resizes the raw RGBA. It runs in a `worker_threads` pool
because it is synchronous. Video frames come from ffmpeg on PATH for now.
Phase 4 has to bundle one.

Also found: sharp's libvips file cache keeps handles open, which on Windows
blocks moving or deleting the file. `sharp.cache(false)` is set wherever sharp
reads originals.

### 3.4 Thumbnails

Three sizes per asset: small for the grid, large for the detail view, and a tiny
blurred placeholder for scrolling. Write to a temp name and rename on success,
same as originals. Content-addressed by hash, on disk, never in SQLite.

### 3.5 Level 3 verification

Full image decode, and first and last group of pictures for video. Runs as a
job, not inline in import, so a slow decode never holds up a transfer.

### 3.6 Optional second copy

A second destination written during import and verified the same way, off by
default. Lightroom and Photo Mechanic both offer it, because the moment of import
is when you hold the only copy off the phone.

## Phase 4: a shippable shell

Done when the app installs, updates itself, and tells you which layer is broken
when the phone is not seen.

- **Electron shell.** Main process owns device, engine and database. Workers in
  a `utilityProcess` pool. Renderer only displays, over typed IPC.
- **Device lifecycle.** Subscribe to usbmux `Listen` for attach and detach. Fold
  in the four-layer diagnosis from [prototype/diagnose.ts](../../prototype/diagnose.ts).
  This is the direct fix for "Windows does not see my phone".
- **Import screen.** Device state, preflight numbers, live progress, run report,
  quarantine review.
- **Power.** `powerSaveBlocker` during import.
- **Crash reports.** Electron `crashReporter` writing local dumps. Nothing leaves
  the machine without asking.
- **Release.** `electron-builder`, NSIS, code signed, `electron-updater` with a
  beta channel. Staged rollout exists if there are ever other users.

**Built so far (2026-11-04):** the shell (`app/`), bundled by esbuild
(`npm run app`). `better-sqlite3` 13 and sharp are both N-API, so one
`node_modules` serves the tests under Node and the app under Electron 44 with
no rebuild. Typed IPC in `app/shared/api.ts`. Device detection in
`src/device/watcher.ts` and `src/device/diagnose.ts`. The import screen, the
quarantine review and power blocking all work against the real phone.

Added from what the real phone did: auto-resume. The phone dropping off the
driver when it locks stopped two test imports, so an import interrupted that
way now resumes by itself once the phone is ready again.

**Still to do in this phase:**
- Bundle ffmpeg. Video thumbnails and video decode checks use the one on PATH.
- Move the engine off the main thread. The read-back hash of a 4.9 GB video
  blocks the main process for seconds, which stalls IPC (the window stays
  painted but stops updating).
- Crash reports, `electron-builder` packaging, signing, auto-update.
- The dev harness in `app/main/main.ts` (`PHOTOS_DEV_DIR`) drove the
  end-to-end checks. Keep it out of release builds.

## Phase 5: the library UI

Done when you would rather use this than the stock Photos app.

**Built so far (2026-11-04):** the gallery in [003-gallery-app.md](003-gallery-app.md).
Phones appear in the sidebar by themselves and open in place, with their albums
in the phone's order. Vaults open the same way. There's a virtual grid with Years, Months,
Days and All Photos, a full-size viewer, and an info panel. The selection
saves into a vault, which skips items already there and reports them. Checked against the
iPhone 16 Pro Max and `D:\PhotosLibrary`.

Also built: Live Photo hover playback, bursts collapsed into one tile with a
frame filmstrip in the viewer, vault cover selection and individual-frame
retention, maps with a persistent privacy switch, and discoverable keyboard
help. Older imports backfill missing place names from matching phone records.
See the gallery spec for behavior and verification limits.

- Virtualized grid by capture time, placeholders first, then small thumbnails.
- Live Photos play on hover. Bursts collapse. Adjusted assets say so, because the
  file on disk is the unadjusted capture.
- Asset detail with full image, metadata, map when there is GPS, and the files
  behind the asset.

## Phase 6: search

Done when typing "aadhar" returns the card first and "beach" returns beaches.
Specced in [../05-search.md](../05-search.md).

- **Indexing as background jobs** on the phase 3 queue, recent photos first.
  Pauses on battery and while the user is scrolling, the way Apple and Ente
  index only when the device is idle.
- **Visual search.** SigLIP under ONNX Runtime with DirectML, stored in
  `sqlite-vec`.
- **Text search.** PaddleOCR, English and Devanagari, gated on a text-presence
  check. FTS5 with `unicode61` and `trigram`.
- **Structured search.** Dates, places from offline reverse geocoding, camera,
  media type.
- **Fusion.** Reciprocal rank fusion with rule-based weights.

The index is a cache like thumbnails. `index_state` records the model version, so
a model swap refills one stage.

## Deferred, with reasons

- **Faces.** The schema has room. Worth nothing until search works.
- **MTP fallback.** Large, and every measurement says MTP is the thing to avoid.
- **Burst pick from EXIF alone.** Phone browsing uses the Photos database's
  visible pick, and vaults support choosing a cover. Inferring Apple's pick
  from imported EXIF tags alone remains deferred.
- **Sync across machines.** Apple does not even sync its own index. Out of scope.
