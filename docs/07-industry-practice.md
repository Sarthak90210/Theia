# How the big photo apps are built

Research done before restructuring the roadmap. The question was what Apple,
Google, Adobe, Dropbox and the serious open source projects do that this
project does not do yet.

A caveat up front. Apple and Google publish almost nothing about their photo
internals. What exists is Apple's 2019 privacy brief, reverse engineering of the
Photos library by the osxphotos project, and a lot of interview-prep "system
design" articles that guess. The two best primary sources turned out to be
Dropbox's write-up of its Camera Uploads rewrite and Immich's architecture docs.
Those carry most of the weight below.

## What they do

### 1. Originals never change. Everything else can be thrown away.

Apple's Photos library keeps unmodified originals in one folder and all resized
and edited versions under `resources/derivatives` and `resources/renders`.
Lightroom does the same with its catalog. Previews live in a separate
`Previews.lrdata` bundle that you can delete, and Lightroom rebuilds it.

The useful rule is two kinds of storage with different guarantees. Originals
get verified, backed up and never rewritten. Thumbnails, previews and indexes
are a cache, rebuildable from the originals, so losing them costs time and
never data.

**Here:** the importer already treats originals this way. The thumbnail cache
and search indexes have to be designed as rebuildable from day one, with no
data that exists only in them.

### 2. The state machine checks its own transitions at runtime.

Dropbox tracks every photo through `NEW`, `PENDING`, `DONE` and `ERROR`, and
checks each update against a list of allowed transitions. An illegal one stops
uploading and reports an exception. That check found a flood of `DONE` to
`DONE` transitions, which turned out to be duplicate uploads caused by the OS
restarting a worker before the old one was cancelled. Unit tests had not caught
it, and Dropbox says plainly that unit tests cannot catch that kind of race.

**Here:** `import_item.stage` is written from five different `UPDATE`
statements across two files, and nothing checks the move is legal. This is the
cheapest high-value change on the list.

### 3. Retries depend on what failed.

The old Dropbox client retried failed uploads forever. The rewrite separates
transient errors, which get several retries with backoff, from permanent ones,
which get none. Total retries went down and user-visible errors went down with
them. They tuned it by tracking retry success rate per error type.

**Here:** every non-detach error gets the same three immediate retries. A
missing file on the device gets retried three times for nothing. A flaky read
gets retried with no pause, which is the worst moment to try again.

### 4. Don't trust a new component until it agrees with the old one.

Dropbox ran its new Kotlin hashing beside the old C++ hashing in production and
compared outputs. They disagreed 0.005% of the time. The bug was in the old
code, which had been in production for years.

Professional ingest tools apply the same idea to copying. ShotPut Pro's own
documentation says only a full checksum comparison proves the copy matches the
source, and that a size check is not enough.

**Here:** the importer hashes the bytes as they stream past and then trusts the
disk to have stored them. A read-back of the committed file against the stream
hash is the copy-verification step those tools sell.

### 5. Ingest makes a second copy.

Lightroom's import dialog has "Make a Second Copy To". Photo Mechanic writes to a
primary and a secondary destination in one pass. The point is that the moment of
import is the moment you hold the only copy off the device, and a second disk is
cheap.

**Here:** not built and not in the old roadmap. Optional, off by default, and
small once the read-back exists, because the second copy gets verified the same
way.

### 6. Background work goes through queues, one per kind of job.

Immich gives each job type its own queue (metadata, thumbnails, smart search,
faces, transcoding) with its own concurrency setting. ML and transcoding default
to low concurrency because they are the heaviest. Jobs chain, so a finished
thumbnail triggers smart search and face detection. The ML runs in a separate
process that can be disabled or moved.

**Here:** the architecture doc already plans a `utilityProcess` pool. What is
missing is a persisted job table so thumbnails, L3 decode and indexing all
resume after a crash the same way import does.

### 7. Indexing waits for the machine to be idle.

Apple's search index is built on each device and is not synced. Users report it
runs while the phone is locked. Ente checks device temperature, battery level
and whether the user is active before running ML. Every one of them treats
indexing as something that happens in the gaps, never while you are using the
app.

**Here:** on a laptop that means pausing on battery and when the user is
actively scrolling the grid. Search indexing must not be what makes the app feel
slow.

### 8. Thumbnails come in a few fixed sizes, written atomically.

Immich makes small, large and blurred-placeholder thumbnails per asset. The
system-design writeups agree on pre-generating the common sizes and writing each
one to a temp name and renaming it on success, so a crash never leaves a
half-written thumbnail being served.

**Here:** the importer already uses stage-then-rename for originals. Thumbnails
should use the same pattern.

### 9. Ship to a small group for a long time first.

Dropbox put the rewrite in an opt-in beta pool through Play Store early access,
shipped a build weekly, and ran that for several months before full release.
They built a rollback path to the old client and never needed it. They watched
upload success rate, backlog growth, and support tickets.

For an Electron app on Windows the matching tools are `electron-updater` with
the NSIS target, which supports staged rollout by percentage through
`latest.yml`. Pulling a bad staged release means shipping a higher version
number, not reverting. Windows code signing is close to required for updates and
for SmartScreen.

**Here:** the beta pool is one person with one 71 GB phone. The equivalent of
"months of beta" is running it on the real library repeatedly before building
the UI on top.

### 10. Measure on the real size, early.

Dropbox reports first-time uploads of large libraries finishing up to 4x faster
after the rewrite, which they could only claim because they measured large
libraries specifically. Lightroom's most common complaint is slow large
catalogs.

**Here:** nothing has run over 40 files. This was already the top item. The
research makes it more urgent, not less.

## What this changes

1. Hardening the engine (guarded transitions, classified retries, read-back
   verification) moves ahead of the full-library run. A run of 4,612 files is
   expensive to repeat, so it should happen once the engine reports its own
   mistakes loudly.
2. A persisted job queue becomes its own step, shared by thumbnails, decode
   verification and indexing.
3. Release engineering (signing, updates, crash reports) gets a place in the
   plan instead of being assumed.
4. A second-copy option is added.

See [specs/002-roadmap.md](specs/002-roadmap.md) for the rebuilt phases.

## Sources

- Apple, [Photos privacy brief, 2019](https://apple.com/ph/ios/photos/pdf/Photos_Tech_Brief_Sept_2019.pdf)
- osxphotos, [Understanding the Photos database](https://github.com/RhetTbull/osxphotos/wiki/Understanding-the-Photos-database)
- [apple-photos-forensics](https://github.com/muxcmux/apple-photos-forensics), on library folder layout
- Dropbox, [Making camera uploads for Android faster and more reliable](https://dropbox.tech/mobile/making-camera-uploads-for-android-faster-and-more-reliable)
- Immich, [Architecture](https://docs.immich.app/developer/architecture/) and [Jobs](https://docs.pr-30460.preview.immich.app/reference/jobs)
- Ente, [Image search on the edge](https://ente.io/blog/image-search-with-clip-ggml) and [Machine learning](https://ente.com/ml/)
- AppleInsider forum, [Enhanced Visual Search](https://forums.appleinsider.com/discussion/239301)
- TidBITS, [iOS 18 Photos search](https://talk.tidbits.com/t/ios-18-photos-search-will-probably-be-great-someday/29114)
- Mac Power Users, [What is photoanalysisd](https://talk.macpowerusers.com/t/what-is-photoanalysisd-and-why-running/26446)
- Adobe, [Import options](https://helpx.adobe.com/ie/lightroom/help/photo-video-import-options.html)
- Camera Bits, [Ingesting photos](https://docs.camerabits.com/support/solutions/articles/48000207409)
- Imagine Products, [ShotPut Pro verification options](https://imagineproducts.freshdesk.com/support/solutions/articles/35000203787-what-are-the-differences-between-the-verification-options-available-on-shotput-pro-)
- [Rossmann Group on Lightroom catalogs](https://rossmanngroup.com/problems/lightroom-creative-cache-recovery) and [Julieanne Kost on Smart Previews](https://jkost.com/blog/2024/07/using-smart-previews-to-edit-off-line-files-in-lightroom-classic.html)
- electron-builder, [Auto update](https://www.electron.build/docs/features/auto-update)
- [System Design Handbook on Google Photos](https://www.systemdesignhandbook.com/guides/google-photos-system-design/) and [techinterview.org on thumbnail generation](https://www.techinterview.org/post/3233472111/lld-thumbnail-generation/), both secondary and speculative
