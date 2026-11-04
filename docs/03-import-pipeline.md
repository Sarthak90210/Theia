# Import pipeline

The v1 deliverable. Everything else waits.

Governing rule: a file is either on disk, verified, and recorded, or it is in
quarantine with a written reason. There is no third state and nothing fails
silently.

## Stages

```
detect → check → enumerate → plan → fetch → verify → commit → group → record
```

Each stage writes its outcome to the database before the next one starts. A
crash at any point resumes from the last committed stage rather than restarting
the import.

### detect

`DeviceDaemon` holds a `Listen` subscription on usbmuxd and emits attach and
detach events. On attach, read `DeviceName`, `ProductType`, `ProductVersion`,
and `UniqueDeviceID` from lockdownd.

If `StartSession` fails with `InvalidHostID`, the device is not paired. Show
"unlock your phone and tap Trust" and poll, rather than throwing an error the
user cannot act on. This is the case Windows Photos handles worst.

### check

A preflight that runs once per device per session and writes its findings to
the import report.

- Free space on the destination volume against the sum of file sizes from AFC.
- On the MTP fallback only, whether the phone is set to transcode. Heuristic:
  sample 20 recent `/DCIM` entries. A modern device writing `.JPG` files that
  carry an Apple `Software` tag but no Apple MakerNote is transcoding. Warn and
  point at `Settings > Photos > Transfer to Mac or PC`.

  AFC is immune to this. Measured against a device set to Automatic, AFC
  returned HEIC originals, because the transcoder lives in the MTP responder and
  AFC reads the media partition underneath it. Do not run this check on the AFC
  path and do not mention the setting to the user.
- Request that Windows suppress USB selective suspend for the duration, and
  hold a power request so the machine does not sleep mid-import.

### enumerate

Walk `/DCIM` with `READ_DIR` and `GET_FILE_INFO`. Collect path, size, mtime,
and `st_ifmt` for every entry.

Cache the listing keyed by device UDID. Re-enumeration on a large camera roll
takes a while even over AFC, and a resumed import should not pay for it twice.

### plan

Build the work list. Skip anything already imported, matched by
`(device_udid, device_path, size, mtime)` first, then by content hash once
known.

Order by capture time ascending. Recent-first feels better but makes resume
harder to reason about, and an import that dies partway leaves a contiguous
range rather than holes.

Group candidates at this point so related files transfer adjacently. Live Photo
pairs, burst sets, and `IMG_xxxx` / `IMG_Exxxx` / `.AAE` triples move together.

### fetch

Per file: `FILE_OPEN` read-only, then `FILE_READ` in 4MB chunks into a
`.partial` file in a staging directory on the destination volume. Same volume
matters, because the commit step is an atomic rename and a cross-volume rename
is a copy.

Hash while reading. SHA-256 streaming costs nothing next to USB throughput and
saves a second pass over the file.

On a read error or a device detach, record `bytes_received` and stop. On resume,
`FILE_SEEK` to that offset and continue. Three attempts, then quarantine.

Concurrency: one file at a time. Measured on a real device, one channel
sustains 26.3 MB/s and four sustain 27.2, so parallelism buys nothing and costs
an interleaved staging area and a harder resume path.

### verify

Four levels, all of them, in order. Cheap checks first so a bad file fails fast.

**L0, length.** Bytes written equals `st_size` from `GET_FILE_INFO`. Catches
truncation and transcode length mismatch immediately.

**L1, hash.** Record the SHA-256 computed during fetch. Used for deduplication
and for detecting bit rot later. There is nothing on the device to compare it
against, so this is a record, not a check.

**L2, structure.** Walk the container without decoding pixels.

- JPEG: `FFD8` at offset 0, `FFD9` as the final marker, every segment length
  consistent with the file length.
- HEIC and HEIF: ISO base media box walk. `ftyp` brand in `heic`, `heix`,
  `hevc`, `mif1`. A `meta` box with an `iloc` that points inside the file. `mdat`
  length consistent.
- MOV and MP4: box walk. A `moov` box must be present and parseable, and sample
  offsets from `stco` or `co64` must fall inside the file. This is the check
  that catches the truncated-video case, where the phone wrote `moov` last and
  the transfer died before it.

**L3, decode probe.** Full decode for stills. For video, demux and decode the
first and last group of pictures. Slower, and it is the only thing that catches
a file whose structure is fine but whose payload is garbage.

Make L3 configurable, defaulting to on. A user importing 40,000 photos may want
to turn it off, and should be told what they are giving up.

### commit

Compute the destination path, `fsync` the `.partial` file, rename it into place.
Rename on the same NTFS volume is atomic, so a crash leaves either the old state
or the new one, never a half-written file at a real path.

Layout:

```
<root>/YYYY/YYYY-MM/YYYYMMDD_HHMMSS_<original-stem>.<ext>
```

Capture time comes from EXIF `DateTimeOriginal` with `OffsetTimeOriginal`
applied, falling back to the QuickTime creation date, then to the AFC mtime.
Record which source was used, because "the dates are wrong" is otherwise
impossible to debug.

Collisions get a `_1`, `_2` suffix, but only after the hashes are compared. Two
files with the same hash are one file and the second is skipped.

Set the file's created and modified timestamps to the capture time.

### group

Resolve assets from files. Covered in [04-metadata.md](04-metadata.md).

### record

One transaction per asset. Insert the asset, its files, its EXIF, and mark the
device paths imported.

## Quarantine

Anything that fails verification goes to `<root>/.quarantine/` with a JSON
report next to it: which level failed, what was expected, what was found, how
many attempts, and the device path.

Surface this in the UI as a list the user can act on. Retry, delete, or keep
anyway. "Keep anyway" is a real option, because a JPEG missing its end marker
still shows most of the image and the user may prefer that to nothing.

The quarantine list is the honest answer to "did everything come across", and
it is the feature the stock app is most conspicuously missing.

## Import report

Written at the end of every run and kept.

```
Imported     1,204 files, 1,187 assets, 14.2 GB      6m 41s
Skipped        318 files  already in library
Quarantined      3 files
  IMG_4471.MOV   L2  moov box absent, file ends inside mdat
  IMG_4890.HEIC  L0  expected 3,201,884 bytes, received 2,097,152
  IMG_5012.JPG   L3  decode failed at scanline 1,204 of 3,024
```

## Performance target

Measured, not estimated: AFC sustains about 27 MB/s over the cable Apple ships,
which is a USB 2.0 ceiling. Ten gigabytes takes a little over six minutes and a
70 GB library takes about 45.

Verification runs in workers alongside the next file's transfer, so L0 through
L2 cost nothing in wall clock. L3 decode is the bottleneck on HEIC and is why
the worker pool exists.

Enumeration is stat-bound. Listing all of `/DCIM` costs milliseconds; stat-ing
4,612 files costs 6 to 10 seconds. Show the file count immediately and let the
sizes fill in behind it.

A USB 3 cable may raise the 27 MB/s ceiling considerably, since the phone
supports it. Not yet measured.
