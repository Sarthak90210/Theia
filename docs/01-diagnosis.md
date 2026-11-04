# Diagnosis

Four reported problems. Three of them share a root cause.

## 1. Windows Photos does not reliably see the phone

Windows Photos imports through WIA, which sits on top of WPD, which speaks MTP
to the phone. Every layer adds a failure mode.

The iPhone's MTP responder is not a real filesystem server. It is a shim that
enumerates `/DCIM` and hands back objects, and it only answers at all once the
device is unlocked and the host is trusted. Enumeration of a 40,000 item camera
roll means tens of thousands of `GetObjectPropList` round trips before the UI
shows anything.

Specific reasons it "fails to recognize":

- The phone is locked. MTP enumeration returns an empty store rather than an
  error, so Windows shows a device with nothing in it.
- The pairing record is stale. After a Windows update, a cable reseat, or a
  sleep/wake cycle, WPD can hold a dead device handle and never re-enumerate.
- USB selective suspend powers down the port. Windows lets this happen during a
  long enumeration.
- `AppleMobileDeviceService` is not running or is a version mismatched with the
  iOS release.

## 2. Transfers fail partway or skip files

This is MTP's design, not a bug in your setup.

MTP `GetObject` is one shot. There is no byte range, no seek, no resume. A
transfer that dies at 90% starts again at zero, and Windows Photos does not
even do that. It marks the file failed and moves on, often without telling you
which file.

Worse, if `Settings > Photos > Transfer to Mac or PC` is set to **Automatic**,
the phone transcodes HEIC to JPEG and HEVC to H.264 while the transfer is
running. The object size MTP advertised was computed before transcoding. The
actual byte count differs. The host copies until the declared length is reached
and stops, which produces a file that is short, padded, or both.

That is the mechanism behind problem 4 as well. See below.

## 3. Metadata lands in a separate file

Several different things get reported this way. They are not the same problem
and they need different handling.

**`.AAE` files.** These are Apple property lists holding an edit recipe, not
metadata. When you edit a photo on the phone, `/DCIM` ends up with three files:
`IMG_1234.HEIC` (the original), `IMG_E1234.HEIC` (the rendered edit), and
`IMG_1234.AAE` (the adjustments). Nothing is lost. The importer has to
understand that all three are one asset.

**`.MOV` next to a still.** That is a Live Photo. The pairing is not encoded in
the filenames. It lives in a UUID stored in the Apple MakerNote of the still
(tag `0x0011`, `ContentIdentifier`) and in the QuickTime metadata atom
`com.apple.quicktime.content.identifier` of the video. Match on that UUID, never
on the filename stem, because burst and edited files break the stem convention.

**`.json` sidecars.** These come from Google Takeout or an iCloud web download,
not from a USB transfer. If you have a backlog exported that way, the importer
should read the JSON and write the values back into the image, then drop the
sidecar.

**Actual EXIF loss.** Real, and again caused by Automatic transcoding. The
on-the-fly HEIC to JPEG conversion drops the Apple MakerNote entirely, which
takes the Live Photo `ContentIdentifier` with it, and on some iOS versions
mangles the GPS block. Once the MakerNote is gone you cannot reconstruct the
Live Photo pairing.

## 4. Photos and videos get corrupted

Ranked by how likely each is to be what you are hitting.

**Transcode length mismatch.** Described above. Symptom for a JPEG: the top
half renders, the bottom is grey or garbage, because the decoder ran out of
scan data. This is the most common cause and it is entirely explained by the
Automatic setting.

**Truncation with no `moov` atom.** The iPhone writes captured video with the
`moov` atom at the end of the file, because it is streaming samples to disk and
only knows the index when recording stops. A truncated `.MOV` therefore loses
its index completely and will not play at all, rather than playing partially.
This is why video corruption looks more total than photo corruption.

**USB selective suspend and device sleep.** The port powers down mid-read. MTP
surfaces this as a session reset, and the partial file is left on disk as if it
were complete.

**Cable and hub quality.** Long cables, unpowered hubs, and USB 2.0 front-panel
headers produce CRC errors that force MTP session restarts. Cheap to rule out,
worth ruling out.

**Nothing verifies anything.** No byte count check, no hash, no structural
validation, no atomic write. A partial file is indistinguishable from a good
one until you open it, possibly months later. This is the part that makes the
other causes invisible.

## What follows from this

Use AFC instead of MTP. AFC gives `afc_file_open`, `afc_file_read`,
`afc_file_seek`, and `afc_get_file_info`. Byte ranges mean resume. Reading the
file directly means the original bytes, no transcode, no metadata loss, and a
size you can check against.

Confirmed by measurement rather than assumed: with the phone set to Automatic,
the setting that mangles files over MTP, AFC still returned HEIC originals. The
transcoder lives in the MTP responder, above the filesystem AFC reads.

Verify every file before committing it. Byte count, hash, container structure,
then a decode probe. Write to `.partial` and rename only on success. Quarantine
anything that fails and say exactly why.

Treat "which files did not make it" as a first-class output. The single most
frustrating property of the current setup is that it loses files quietly.
