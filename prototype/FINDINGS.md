# Transport probe findings

Measured against a real device, not inferred. Everything here either confirms or
corrects a claim made in the specs.

Device under test: iPhone17,2 (16 Pro Max), iOS 27.0, 4,612 files, 71.03 GB in
`/DCIM` across 7 album folders. Host: Windows 11, Node 24.14.1.

## Confirmed

**usbmuxd is TCP, not a named pipe.** `127.0.0.1:27015`, owned by
`AppleMobileDeviceService`. There is no `iTunes_MobileDevice` pipe on this
machine, despite widespread documentation claiming otherwise. The architecture
doc said pipe and has been corrected.

**Node's TLS defaults work.** This was the single biggest risk in the whole
plan, and it evaporated. No `@SECLEVEL=0`, no TLS 1.0 floor, no legacy
renegotiation flag. `tls.connect` with the pair record's cert and key and
`rejectUnauthorized: false` completed the handshake on the first attempt, and a
`GetValue` for `DeviceName` came back over the encrypted channel.

Keep the four-strategy cascade anyway. This pair record was minted by a current
Apple Devices install. An older record can still carry an RSA-1024 key, which
OpenSSL 3 refuses at its default security level, and that is exactly the case
the fallbacks exist for.

The libimobiledevice binary fallback is now insurance, not a likely path. The
transport stays pure TypeScript.

**Pairing records come from usbmuxd without elevation.** `ReadPairRecord`
returned the record directly, so there is no need to read
`C:\ProgramData\Apple\Lockdown`, and therefore no need to run elevated.

**AFC needs no SSL of its own.** `StartService` for `com.apple.afc` returned
`EnableServiceSSL: false`. Only the lockdown session is encrypted.

**Ranged reads work, so resume works.** Read 4096 bytes, closed the file,
reopened it, seeked to 4096, read the next 4096. The concatenation is byte
identical to a straight contiguous read of 8192. `FILE_TELL` confirmed the
offset. This was the load-bearing assumption under the entire import design.

**AFC is immune to the transcode setting.** The device under test was set to
`Transfer to Mac or PC: Automatic` throughout, which is the setting that
re-encodes HEIC to JPEG and destroys Apple MakerNotes over MTP. AFC returned
`ftypheic` originals anyway. The transcoder lives in the MTP responder, above
the filesystem AFC reads.

This is the most consequential finding here. The transport alone fixes the
corruption and the metadata loss, and the user never has to learn that the
setting exists. Two user stories in the import spec required them to change it;
both have been rewritten, and the preflight block is now MTP-only.

## Corrections to the specs

**lockdownd and AFC are strictly one request in flight per channel.** Two
overlapping requests on one socket interleave their frames and desynchronise the
stream. Found by issuing parallel `StartService` calls, which failed with a
concurrent-read error rather than anything the protocol reported.

Both clients now serialize through a promise queue. Concurrency comes from
opening more channels, never from pipelining one. Each concurrent reader needs
its own `StartService` call and its own usbmux connection.

**Enumeration is entirely stat-bound.** `readDir` across all 7 albums returned
4,614 paths in 0.03 seconds. Stat-ing all 4,612 files took 9.79 seconds, at 2.12
ms each.

Listing is therefore free and sizes are expensive. Two consequences. The
enumeration cache in the import spec is worth keeping, because a 40,000 file
library would spend roughly 85 seconds here. And the UI can show the file count
instantly while sizes fill in behind it, rather than making the user wait for a
number before anything appears.

**Throughput saturates near 27 MB/s, and concurrency does not help.**

| Channels | Bytes read | Time | Rate |
|---|---|---|---|
| 1 | 128 MB | 4.87s | 26.3 MB/s |
| 2 | 256 MB | 9.62s | 26.6 MB/s |
| 4 | 512 MB | 18.85s | 27.2 MB/s |

Four channels bought three percent over one. That is noise. A single reader
already saturates the link.

This simplifies the import spec rather than complicating it. The spec asserts
two files in flight on no evidence. Use one. Sequential fetch means no
interleaved staging, no parallel progress accounting, and a resume path with one
file to reason about instead of two.

**Chunk size does not matter either.**

| Chunk | Rate |
|---|---|
| 1 MB | 25.4 MB/s |
| 4 MB | 26.7 MB/s |
| 16 MB | 26.0 MB/s |

All within noise. Keep 4 MB, now chosen for resume granularity and memory
footprint rather than for speed.

**The spec's time target was right, its rate range was not.** The import spec
claims 30 to 60 MB/s, which the measured ceiling of 27 contradicts. It also
targets six minutes for 10 GB, which implies about 28 MB/s, and that is very
close to what the hardware actually delivers. Correct the range, keep the
target. At 27 MB/s this library's 71 GB takes roughly 45 minutes.

This is still probably a USB 2.0 ceiling: 27 MB/s is 216 Mbps, consistent with
USB 2.0 bulk transfer after protocol overhead. The phone supports USB 3, so a
USB 3 cable may raise it substantially. Untested.

Correcting an earlier note in this file: a first reading of 20 MB/s led me to
call the spec's target too optimistic. Repeated measurement says otherwise, and
the 19.5 MB/s printed by the very first probe run was measuring the device's
cache over 0.04 seconds. Both readings were wrong.

**Enumeration timing varies run to run.** 2.12 ms per stat on the first run,
1.25 ms on the second, for 9.79s and 5.76s across 4,612 files. Budget roughly a
second per 500 files and cache the result.

## Library composition, measured

| Type | Files | Bytes |
|---|---|---|
| HEIC | 2,483 | 6.75 GB |
| MOV | 1,058 | 58.07 GB |
| JPG | 392 | 688 MB |
| AAE | 384 | 0.4 MB |
| PNG | 206 | 386 MB |
| MP4 | 47 | 4.99 GB |
| JPEG | 33 | 90 MB |
| DNG | 8 | 88 MB |
| GIF | 1 | tiny |

**Video is 89% of the bytes and 24% of the files.** 63 GB of the 71 GB total.
Import wall clock is therefore almost entirely video transfer, and the L3 decode
probe budget is dominated by demuxing MOV files rather than decoding HEIC. The
largest single file is 4.90 GB, which rules out any design that buffers a whole
file in memory.

289 stems carry both a HEIC and a MOV, so roughly 12% of stills are Live Photos.
Two stems pair a JPG with a MOV, which the grouping code must not choke on.

## ContentIdentifier survives AFC and does pair

Pulled a real Live Photo pair over AFC and read both halves with exiftool. The
still reported `Apple:ContentIdentifier` and the motion reported
`Keys:ContentIdentifier`, both `4B23D938-CC54-4D95-B0F6-55FE602F2CDA`. The
MakerNote arrived intact with 25 tags on it.

**The spec named these tags in the wrong group family.** Read with `-G1`,
exiftool reports Apple MakerNote tags under `Apple:` and the QuickTime Keys atom
under `Keys:`. The `MakerNotes:` and `QuickTime:` spellings in the spec are the
`-G0` names. Both are correct for their own family and mixing them returns
nothing silently, which is exactly what happened on the first run of this probe
and briefly looked like a missing MakerNote.

Every field the spec calls canonical was present on the sample: capture time,
GPS, make, model, lens, orientation. `OffsetTimeOriginal` read `+09:00` on a
photo whose GPS puts it in Tokyo, which is a concrete case of why capture time
and offset have to be stored separately rather than collapsed to local time.

## Edits do not work the way the spec assumed

384 AAE sidecars, zero `IMG_E` renders in the whole camera roll. The spec's rule
that an edit yields an original, a render, and a recipe is wrong on this device.

The AAE parses as a plist with `adjustmentEditorBundleID: com.apple.camera`, so
these are adjustments applied at capture rather than edits made later in Photos.
They attach to HEIC, JPG, and MOV alike. `adjustmentData` is 159 opaque bytes we
cannot render.

So the copy on disk is the unadjusted capture and may differ from what the phone
displays. The import has to flag that rather than let the user find out later.
The metadata document now carries the corrected rule.

Open and worth one test: iOS seems to serve rendered versions over MTP, which
would mean originals and renders are mutually exclusive depending on transport.
If so, AFC's choice is still right, and this is the price.

## Device presence has three independent layers

Worth designing around, because it is the direct answer to the original
complaint that Windows Photos "sometimes fails to recognise" the phone. That one
message covers three unrelated failures with three different fixes, and the app
can tell them apart cheaply.

**Layer 1, USB enumeration.** Does Windows see an Apple device at all? Query PnP
for vendor id `05AC` and check for a present device. If nothing is present, the
cause is the cable, the port, or the phone not being plugged in. Charge-only
USB-C cables enumerate nothing. Unlocking and trusting cannot help here, so
prompting for either is actively misleading.

Note that stale PnP records persist for every phone ever connected, so presence
must be checked explicitly rather than inferred from a record existing. This
machine carries ghost entries for two different iPhones.

**Layer 2, usbmuxd visibility.** Does `ListDevices` return the device? If layer 1
is present but this is empty, `AppleMobileDeviceService` has lost the device.
Replugging the cable usually recovers it; restarting the service is the next
step and needs elevation.

This one is not theoretical. It occurred twice during development, on a machine
whose service was running the whole time and whose phone Windows could see. It
is very likely one of the causes behind the original complaint that Windows
Photos "sometimes fails to recognize" the phone, and it is invisible without
checking layer 1 first, because the symptom is identical to an unplugged cable.

The product should detect this state by name, say that the service has lost
track of the device rather than that no device is connected, and offer replug
first and an elevated service restart second. Doing the restart itself requires
running elevated, which the app should not do for an import.

**Layer 3, pairing and trust.** Does `StartSession` succeed, or fail with
`InvalidHostID`? This is the only layer where "unlock your phone and tap Trust"
is the right prompt.

Diagnosing the layer costs one PnP query and two round trips, and it turns a
dead end into an instruction the user can act on. Observed during this probe: a
disconnected phone is indistinguishable from an untrusted one unless you check
layer 1 first.

## Full library run, 2026-11-04

The phase 2 checkpoint. The phone had grown to 5,021 files. 2,795 of them were
already in `D:\PhotosLibrary` from September, so this run moved the rest.

**It worked.** 2,226 files, 26.50 GB, transferred and verified in 19 minutes 1
second, which is 23.8 MB/s with the read-back included. No transient failures, no
verification failures, no detaches. The staging folder was empty afterwards.
Every one of the 5,021 files on the phone is now committed.

**The second run took 8.5 seconds.** Enumeration was 7 of those. All 5,021
skipped.

**Grouping at full size:** 4,292 assets (3,083 stills, 913 videos, 290 Live
Photos, 6 bursts), 409 sidecars absorbed, 3 files unpaired. Capture times came
from EXIF for 3,282 files, QuickTime for 901, and the filesystem for 109. Offsets
were recorded for 3,895 and assumed from the host zone for 397.

### What it found

**Stale items from an unfinished run get quarantined as failures.** The
September run never finished, so its `import_run` row stayed `running` and this
run resumed it. 167 of its items were for files since deleted from the phone.
The engine tried to open each one, got `object not found`, and quarantined it as
a permanent failure. Nothing was lost, but the report lists 167 "files that did
not make it" that were never meant to. The fix is to compare pending items with
the current enumeration and record the missing ones as gone from the device,
without trying to fetch them.

**A resumed run's report has a meaningless duration and rate.** Run 1 started on
13 September and finished on 4 November, so the report says 1253h 36m and
0.0 MB/s. Duration has to count the time the run was active, not the time
between its first start and its last finish.

### Both fixed the same day

Items the phone no longer has now move to a new terminal stage, `gone`, before
anything is fetched. The engine confirms each one with a `stat` on the device,
because a filtered listing like the smoke import's hides files that still exist.
Runs now record `active_ms` and `sessions` (schema v6), and the report shows
active time.

Run 2 against the real library retired all 167: `Gone 167`, `Quarantined 0`,
and an empty `.quarantine` folder. Run 1's report file is left as written, since
it records what that run saw at the time. This also exposed a CLI shortcut. It
exited at "nothing to do" without calling the engine, which skipped the cleanup,
so that exit is gone.

## Library layer at full size, 2026-11-04

**Thumbnails.** All 4,292 assets in 975 seconds with 8 HEIC workers, none
failed, 984 MB of cache. Identical photos share one set, so 12,867 files, not
12,876. The first version ran at 4.1/s against 7.8/s for decoding alone. The
libuv thread pool was not the cause (4 or 16 threads, same rate). Resizing the
full 12 MP image three times was. Shrinking once to 1600 px and deriving the
smaller sizes from that brought it to 5.5/s.

**Decode verification.** 4,604 of 4,612 files decode in full. 0 damaged. The 8
DNGs cannot be checked, because sharp only reads the embedded preview. The
first pass flagged 65 videos, every one of them a false alarm: ffmpeg's null
muxer complains about timestamps ("non monotonically increasing dts") at a
seek point or the last frame, and that is about writing the throwaway output,
not reading the file. Those lines are now filtered and the 65 pass.

**sharp holds files open.** libvips caches open files by default, and on
Windows an open handle blocks moving or deleting the file. Found when the
thumbnail tests could not delete their temp folders. `sharp.cache(false)`.

## The phone locks, and the import stops

Seen twice in the app. The import ended with "stream ended mid-frame",
followed 130 ms later by a usbmux `Detached` event, while the phone stayed
plugged in. Afterwards the diagnosis showed layer 2 failing: Windows sees the
phone, usbmuxd does not. That is the phone auto-locking, as noted below under
Reproducing. The CLI full run did not hit it because the phone was in use.

This is the main risk for a long import in real use, so the app now tells you
to keep the phone unlocked while importing, lists unlocking first in the fix for
layer 2, and resumes an interrupted import by itself once a device check made
after the interruption says the phone is ready again.

## Browsing the phone without copying it, 2026-11-04

The gallery reads the phone in place: its Photos database for order, albums
and flags, its own JPEG previews for the grid, and originals only when one is
opened full size.

**Photos.sqlite reads on iOS 27.** Copied over AFC with its `-wal` file, it
gives 3,788 items, the smart collections (Favourites, Videos, Live Photos,
Screenshots, Selfies, Panoramas, Bursts) and 17 user albums in the phone's own
order. The schema matched what `src/gallery/phone-library.ts` expected.

**The phone keeps a preview for every item.** Each one is at
`/PhotoData/Thumbnails/V2/<directory>/<filename>/5005.JPG`, about 90 to 105 KB.
The name is the same in every folder, so after the first hit the session opens
it directly. That's one round trip per tile instead of a listing plus a stat
per file.

**One AFC connection allows 240 open files.** The 241st open fails with
"no resources". The grid asks for hundreds of tiles at once. The AFC channel
runs requests one at a time, but it queued every open ahead of every read, so
about 400 files were open together. The phone then ended the connection
("ended by the other party") while USB and trust stayed up, and every later
tile failed with the phone still shown as ready. The session now keeps at most
8 files open, and it reconnects once if the connection drops anyway. It
measures about 40 tiles a second from the phone: a 498-tile Years view fills in
about 10 seconds.

Not the cause, though each was suspected and tested: idle time (a connection
idle for 40 s still reads), the diagnosis opening its own lockdown session, a
second AFC connection, and Electron's BoringSSL (the same probe under Electron
behaves the same).

**The phone's info screen comes from its database.** `ZEXTENDEDATTRIBUTES`
has make, model, lens model, ISO, aperture, shutter, focal length (actual and
35 mm), exposure bias, digital zoom, codec and frame rate. For IMG_6182 it
gives exactly what the phone shows, including the shutter of 0.00074683 s,
which is 1/1339 s. `ZADDITIONALASSETATTRIBUTES.ZREVERSELOCATIONDATA` is an
NSKeyedArchiver blob with the postal address the phone looked up. The label
under the phone's map is `subAdministrativeArea - subLocality`. 3,860 of 4,442
items have one. Captions are in `ZASSETDESCRIPTION.ZLONGDESCRIPTION`.

**HEVC video plays in the window.** A 1080x1920 iPhone `.MOV` plays in
Electron 44 on this machine. The "open in the video player" fallback stays for
machines without hardware HEVC decoding.

**Saving into a vault.** The phone's "Best Photos" album (7 items, one of them
a Live Photo) saved in a few seconds as 27 MB. The `.MOV` came along. A photo
that is also in three other albums is one file with four hard links. Saving
the album again reported 0 saved and 7 already there.

## Open questions

**Does a USB 3 cable lift the 27 MB/s ceiling?** Worth one measurement, since
it would cut a full-library import from 45 minutes to something much shorter.

## Reproducing

```
npx tsx prototype/main.ts    # conformance probe, writes a redacted transcript
npx tsx prototype/bench.ts   # enumeration cost, throughput, concurrency
```

Both need the phone plugged in, unlocked, and trusted. To run the app from a
shell inside another Electron app (an editor, say), unset
`ELECTRON_RUN_AS_NODE` first, or Electron starts as plain Node and fails on
`protocol`. Note that the device
disappears from usbmuxd when it locks or the cable is disturbed, which is itself
a useful reminder of what the import engine has to survive.
