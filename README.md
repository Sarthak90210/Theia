# Theia

A photo library and import tool for Windows, built because the stock Photos app
handles an iPhone badly. Android phones work too.

Stack: Electron + TypeScript. iPhones are read with AFC over usbmuxd; Android
phones through Windows Portable Devices (MTP).

## Download for Windows

Download the installer or portable executable from
[GitHub Releases](https://github.com/Sarthak90210/Theia/releases/latest).
**Theia-Setup** installs the app and adds Start menu and desktop shortcuts.
**Theia-Portable** runs without installation. Both target Windows x64 and
include FFmpeg, FFprobe, ExifTool and the image decoders; Node.js is not needed.

For an iPhone connection, install Apple Devices or iTunes so the Apple Mobile
Device Service and USB drivers are available. Unlock the phone and accept
its Trust prompt. Opening local vaults does not require Apple software.

An Android phone needs nothing installed. Unlock it, tap the USB notification
and choose **File transfer**. A phone set to charge only, or locked, shares no
files; Theia says so and picks the phone up once it does.

Release builds are unsigned. Windows may show an unknown-publisher prompt.
Updating or uninstalling keeps the app profile and your photo vaults.

To build the Windows release from source, run `npm ci` followed by
`npm run release:win` on Windows x64. The build verifies a pinned FFmpeg
archive before packaging. Outputs are in `release/`. See
[third-party notices](THIRD-PARTY-NOTICES.md) for the bundled tools.

## Documents

| Doc | What it covers |
|---|---|
| [01-diagnosis.md](docs/01-diagnosis.md) | Why the four problems happen. Read this first. |
| [02-architecture.md](docs/02-architecture.md) | Process layout, native dependencies, build |
| [03-import-pipeline.md](docs/03-import-pipeline.md) | v1 spec. Transfer, verification, resume |
| [04-metadata.md](docs/04-metadata.md) | EXIF, sidecars, Live Photos, edits |
| [05-search.md](docs/05-search.md) | OCR + CLIP + structured search. v2, specced now |
| [06-data-model.md](docs/06-data-model.md) | SQLite schema |
| [07-industry-practice.md](docs/07-industry-practice.md) | What Apple, Dropbox, Immich and Lightroom do that shaped the roadmap |
| [specs/001-import-pipeline.md](docs/specs/001-import-pipeline.md) | v1 spec, ready for implementation |
| [specs/002-roadmap.md](docs/specs/002-roadmap.md) | The phases, what is done, what is next |

## The short version

Windows Photos imports over MTP. MTP has no seek, no resume, and no integrity
check, and the iPhone's MTP responder will transcode HEIC to JPEG on the fly
if the phone is set to "Automatic". That single fact explains the dropped
files, the truncated ones, and the mangled metadata.

AFC is the protocol iTunes uses. It gives you `open`, `read`, `seek`, `close`
on the phone's media partition. Real byte ranges, so a failed transfer resumes
instead of restarting. Original bytes, so no transcode and no metadata loss.

Search is two mechanisms, not one. Typing "aadhar" is a text problem and needs
OCR. Typing "beach at sunset" is a visual problem and needs an image-text
embedding model. Google Photos runs both and fuses the results. So will we.

## Status

Phases 1 to 3 are done. The gallery app (`npm run app`) browses a plugged-in
iPhone in place and saves selections into vault folders. See
[docs/specs/002-roadmap.md](docs/specs/002-roadmap.md) for the phase table.

Measured on an iPhone 16 Pro Max, iOS 27: all 5,021 files imported and
verified at 23.8 MB/s, a repeat import skips everything in 8.5 seconds,
thumbnails exist for all 4,292 assets, and 4,604 of 4,612 files decode in full
with none damaged (the other 8 are DNGs, which cannot be checked).

```
app/            the Electron app: main process, preload bridge, React window.
src/protocol/   usbmux, lockdownd, AFC. Pure TypeScript, no native build.
src/device/     the DeviceSource seam: AFC for iPhones, an MTP helper for
                Android, the four-layer iPhone diagnosis and its watcher.
src/import/     the persisted import state machine, reports, quarantine, grouping.
src/jobs/       the background job queue shared by thumbnails and verification.
src/thumbs/     HEIC decode workers (libheif-js) and thumbnail rendering.
src/verify/     L2 container walkers and the L3 decode check.
src/library/    SQLite schema, migrations, and the media/cache layout.
src/metadata/   tag interpretation (pure) and the exiftool reader (I/O).
prototype/      probes kept because they answer questions on demand.
```

| Command | What it does |
|---|---|
| `npm run app` | Build and open the app |
| `npm test` | Automated tests, no device needed |
| `npm run import` | Import from the attached phone, CLI. `--dry-run`, `--second-copy=PATH` |
| `npm run thumbs` | Make missing thumbnails. Safe to stop and rerun |
| `npm run verify` | Decode-check every file. `--recheck` for flagged ones |
| `npm run diagnose` | Which of the four connection layers is broken |
| `npx tsx scripts/probe-android.ts` | Open each plugged-in Android phone, scan it and read a file. Read only |
| `npx tsx scripts/compare-deep.ts VAULT .release-tools/models` | Faces and text found by the ordinary and the closer look, on a vault's group photos. Read only |
| `npm run smoke -- 12` | Real import of N files into a test library |
| `npm run bench` | Enumeration, throughput, concurrency against the phone |

Development commands need `ffmpeg` and `ffprobe` on PATH. Release executables
include their own tools.

The gallery includes Live Photo hover playback, burst-frame browsing, cover
selection and keeping individual frames. Search, packaging and updates remain.

Open **Settings** in the sidebar, or press Ctrl+,, to switch maps off. Place
names and coordinates stay visible. Older imports gain missing place names
when the matching phone is connected. Unmatched items keep their coordinates.
Press F1 or ? for keyboard shortcuts.

## Editing and utility folders

Select a vault item and click **Edit**, or open it and use **Edit** in the viewer.
Photos support crop, rotate, horizontal flip, exposure, contrast and saturation.
Videos support those adjustments plus trimming and mute. **Save as copy** creates
a new JPEG or H.264/AAC MP4 at full resolution after the selected crop, leaving
the original unchanged. Video edits preview a frame at the trim start; the
original can play inside the editor to check the trim interval. A Live Photo
edit creates a still photo copy. Advanced Apple Photos tools and HDR video
export are not included in this first editor.

Vault items can be hidden or unhidden. Hidden items are excluded from normal
collections and albums. Set a vault passcode before hiding or deleting items.
Hidden and Recently Deleted media are encrypted at rest with AES-256-GCM;
the passcode or recovery key unlocks them. Save the recovery key when setting
up protection: losing both secrets means losing access to the encrypted files.
Dates, filenames, camera information and other database metadata remain readable.
Delete moves selected items to **Recently Deleted**;
**Recover** restores them, including their previous hidden state. They remain
until explicitly removed. **Delete permanently** moves the files to the Windows
Recycle Bin. Nothing is automatically erased after 30 days.

While Hidden is unlocked, it can hold **folders** (Documents, Private, …),
all opened by the vault's one passcode. Select items in Hidden and choose
**Move to folder**; make, rename or delete folders from the sidebar. Hidden
itself still shows everything hidden, deleting a folder leaves its items in
Hidden, and unhiding an item takes it out of its folder. Folder names and
contents are not shown, or sent to the window, while Hidden is locked.

Saving shows transfer speed and an estimated time left, including the copy's
read-back check. In the iPhone save menu, **Delete from iPhone after verified
save** is off by default and requires confirmation for each save. It verifies
all originals and companion files, independently rereads both sides, fully
decodes saved media, and verifies the exact Windows device objects while
locking destination copies against changes. Anything unsupported, ambiguous,
changed, incomplete or unchecked stays on the iPhone, and the summary says how
many were kept and why. Set the iPhone's **Settings › Photos › Transfer to Mac
or PC** to **Keep Originals**: otherwise Windows sees converted copies, which
are not the files Theia saved, so none can be deleted. Windows deletion may be
permanent and may sync through iCloud Photos. It is never retried automatically.
Extra deletion-verification work is shown as a separate phase. Live iPhone
deletion has not yet been qualified; generated-device and driver tests cover
the safety gates.

A vault on a drive that is unplugged closes cleanly: its background work stops,
a save into it ends saying what was saved (no originals are deleted), and it
stays in the sidebar as **not connected** until the drive is back, when it
opens again by itself. A vault missing when Theia starts is kept the same way.

Maps in photo info are off until switched on in Settings: showing one asks
OpenStreetMap for the tiles around where the photo was taken.

Use the menu beside a vault in the sidebar to see or copy its location,
open its folder, remove it from Theia while keeping files, or delete the vault.
Folder deletion requires typing its name and validates vault ownership and
path boundaries. Protected system/user folders and overlapping vaults are refused.

The iPhone has separate **Hidden** and **Recently Deleted** collections under
**Utilities**. Available items can be viewed and saved into a vault, where they
land in the vault's own Hidden or Recently Deleted and are encrypted (the vault
needs a Hidden passcode first; Theia asks for one). The iPhone
supports deletion only through the explicitly enabled verified-save workflow;
changing its hidden state and recovering its items are done on the iPhone.
**Refresh phone** reloads the phone's current library.
An item whose original is not exposed over USB may only have a thumbnail.

## Right-click and the timeline

Right-click a photo, in the grid or the viewer, for the menu Photos on Windows
has: **Copy**, **Share**, **Delete** and **Print** along the top, then **Save
as** (Ctrl+S), **Open with**, **Copy as path** (Ctrl+Shift+C), **Resize
image**, **Set as** (desktop background or lock screen), the viewer's
**filmstrip** (F) and a **slideshow** (F5). Right-clicking a selected photo
acts on the whole selection where that makes sense.

These go through Windows itself (`src/shell/desktop-helper.ps1`): Copy puts
the file on the clipboard as File Explorer does, and the picture too; Share
opens the Windows share sheet; Open with lists the apps Windows offers for the
file, and opens a vault photo as a copy so the vault's original can't be
changed by them. Protected items, and the phone's own Hidden and Recently
Deleted, are refused rather than written out.

Beside the grid, a timeline shows each year where it starts and a dot for
every month. Click or drag on it to jump; hovering names the month. It shows
wherever photos are in date order, not in search results or albums.

## Looking closer

Indexing reads each photo once, from its thumbnails. **Settings → Indexing →
Then look again, more closely** adds a second pass with the same models, once
the first has finished. Each photo is decoded again from its original at up to
3200 px, read, and the copy deleted straight after:

- Faces: finer tiles for small faces in group photos, the photo turned a
  quarter each way for people lying down, and each face described twice (as is
  and mirrored) for steadier matching. Faces already found keep their names
  and answers.
- People: faces that might be someone you named, but not surely enough to add
  without asking, appear under **More photos of them?** in People, to answer
  yes or no. A no is remembered.
- Search: vectors for each quarter and the middle of a photo, so something
  small in a corner is found; and text read in tiles at nearly full size, for
  small print.

Videos are left as they are. It is several times slower than the first pass
and follows the same pace setting. Switching it off stops it and keeps what it
found. On 8 group photos of a real library it found 189 faces where the first
pass found 157, and 138 lines of text where it read 53.

## Adding photos from a folder

Photos and videos already on the computer can go into a vault too. In a vault,
use **Add photos…** in the toolbar (from a folder, or chosen files), the
buttons in an empty vault, the vault's ⋯ menu, or drag files and folders from
File Explorer onto the window. They are copied with the same checks as a
save from a phone, and the originals stay where they are.

- A photo and a short video with the same name are one Live Photo; an `.aae`
  or `.xmp` file goes with its photo; a JPEG beside a DNG or HEIC of the same
  name is kept with it.
- Each folder directly inside the chosen one becomes an album. A dropped
  folder becomes an album named after it.
- The capture time comes from the photo's own EXIF date, or the file's date
  when it has none.
- Folders whose names start with a dot, the Recycle Bin and any vault are
  skipped, so a vault's own files can't be added back into it.
- Adding the same folder again skips what's already there without copying it.
- **Delete originals after they're safely in the vault** (in **Add photos…**,
  off by default, confirmed each time) moves each original to the Recycle Bin
  once the import is done, but only after checking that its exact bytes are
  in the vault and read back correctly, and that it hasn't changed. Anything
  that fails a check, or is on a drive without a Recycle Bin, stays where it
  is, with the reason shown. A stopped import deletes nothing.

## Android phones

An Android phone shows up under **Devices** like an iPhone. Android shares no
photo database over USB, so Theia shows what the phone's own gallery calls
folders on the device: everything under DCIM, Pictures, Movies and Download,
plus WhatsApp's media, with one album per folder. Folders Android hides (names
starting with a dot, or holding a `.nomedia` file) are left out, and so are
stickers and voice notes. Capture time comes from the file name when it has
one (`IMG_20240501_101500.jpg`, `PXL_…`, `Screenshot_…`), otherwise from the
date the phone reports. For a photo, the info panel reads camera details and
location from the file itself.

Android phones are read only. Theia never writes to or deletes from one, so
**Delete after verified save** is iPhone only. Saving checks each file's size
and date on the phone before and after copying, and the copy is reread like
any save. MTP can't resume a transfer partway: an unplugged cable stops the
save, items already saved stay in the vault, and saving again starts the
interrupted file over. Videos are copied to the computer before they play.

Reading goes through `mtp-helper.ps1`, a small helper built on the same pinned
MediaDevices library as iPhone deletion. It reads the Windows stream directly,
because the library's own wrapper reports a failed read as the end of the file.

The application is called **Theia**. Its existing profile directory remains
`%APPDATA%/photos-win-prototype` to preserve settings, caches and open vaults.

The interface uses permanent dark mode, a neutral palette and restrained glass
navigation surfaces. The sidebar can be collapsed with Ctrl+B, and Ctrl+I toggles
the inspector. See [the design notes](docs/08-ui-design.md) for the Apple HIG
sources and the layout/accessibility decisions behind the interface.

## Scope

v1 ships when you can plug in a phone, click import, and get every photo and
video onto disk with correct metadata, or a specific written reason why a given
file did not make it. No silent failures.

Explicit non-goals for v1: editing, cloud sync, iCloud account access, sharing.
