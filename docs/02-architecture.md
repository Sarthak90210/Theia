# Architecture

## Process layout

```
Electron main (Node)
├─ DeviceDaemon      usbmuxd connection, device presence, pairing state
├─ ImportEngine      job queue, state machine, resume
├─ Library (SQLite)  better-sqlite3, single writer, WAL
└─ IPC bridge        typed channels to the renderer

utilityProcess pool (n = cores - 1)
├─ verify worker     hashing, container validation, decode probe
├─ thumbnail worker  sharp / libheif
└─ (v2) inference worker  onnxruntime-node, OCR and embeddings

Renderer (React + TypeScript)
└─ virtualized grid, import UI, quarantine review
```

The main process owns the only SQLite write handle. Workers get read-only
connections or, more often, no database access at all. They take a job
descriptor and return a result. Keeping writes in one place removes a whole
category of locking bugs and makes crash recovery a single transaction replay.

Do not put heavy work in the renderer. Decode and hashing belong in workers,
and `utilityProcess` is preferable to `child_process` because it gets Node
integration and proper lifecycle tied to the app.

## Talking to the phone

The primary path is usbmuxd, implemented in TypeScript. No native compilation.

### usbmuxd

Apple's `AppleMobileDeviceService` listens on TCP `127.0.0.1:27015`. Verified
against a running service: there is no `iTunes_MobileDevice` named pipe, despite
a lot of documentation saying otherwise. A plain `net.connect` reaches it.

The wire format is a 16 byte little-endian header (total length, protocol
version, message type, tag) followed by an XML property list. `plist` on npm
handles encode and decode. The messages needed are `ListDevices`, `Listen` for
attach and detach events, and `Connect` to open a channel to a TCP port on the
device.

### lockdownd

Connect to device port 62078. Send `QueryType` to confirm you are talking to
lockdownd, then `StartSession` with the `HostID` and `SystemBUID` from the
pairing record.

Pairing records live at `C:\ProgramData\Apple\Lockdown\<UDID>.plist` and are
binary plists, so you need `bplist-parser` as well. They contain
`HostCertificate`, `HostPrivateKey`, and `RootCertificate`.

`StartSession` responds with `EnableSessionSSL: true`. Upgrade the existing
socket with `tls.connect({ socket, cert, key, ca, rejectUnauthorized: false })`.

One gotcha worth budgeting time for: Apple's certificates are old and Node's
defaults will reject them. Expect to set `minVersion: 'TLSv1'` and to widen the
cipher list. If Node's TLS proves too strict on a given iOS version, the
fallback is described below.

Then `StartService` with `com.apple.afc`, which returns a port number and
whether that service also wants SSL. Open a second usbmux channel to that port.

### AFC

A simple binary protocol. Header is the magic `CFA6LPAA`, then entire length,
this length, packet number, and an operation code. Take the operation values
from `afc.h` in libimobiledevice rather than transcribing them from a blog
post, because a wrong opcode fails in confusing ways.

The operations v1 needs: `READ_DIR`, `GET_FILE_INFO`, `FILE_OPEN`, `FILE_READ`,
`FILE_SEEK`, `FILE_CLOSE`, and `GET_DEVINFO` for free space.

The `com.apple.afc` service is jailed to `/var/mobile/Media`, so the camera roll
is at `/DCIM` from AFC's point of view.

`FILE_SEEK` plus `FILE_READ` is the whole reason for this design. It is what
makes a resumable transfer possible.

### Fallbacks

Two, in order.

**Bundled libimobiledevice binaries.** Ship `idevice_id`, `ideviceinfo`, and
`afcclient` from libimobiledevice-win32 and drive them with `child_process`.
This costs you streaming control and progress granularity, and it still depends
on Apple's driver being installed, but it sidesteps any TLS incompatibility.

**WIA/MTP.** Only when Apple's driver stack is absent. Treat it as degraded and
say so in the UI: no resume, no byte range, higher failure rate. Verification
still applies, and it will reject more files. If the user is on this path, the
setup check should push them toward installing Apple Devices from the Store.

## Native dependencies

| Package | Purpose | Risk |
|---|---|---|
| `better-sqlite3` | Library database | Prebuilds are reliable. Rebuild for Electron ABI. |
| `sharp` | Thumbnails, resize | HEIC support is not guaranteed by the prebuilt libvips. See below. |
| `exiftool-vendored` | EXIF, Apple MakerNote | Perl binary, ~30MB. Nothing else reads `ContentIdentifier` reliably. |
| `plist`, `bplist-parser` | usbmuxd and lockdownd payloads | Pure JS. |
| `onnxruntime-node` | v2 inference | DirectML execution provider for GPU. |

**On HEIC decoding.** Measured, not assumed: the prebuilt sharp 0.35.5 has
libheif but no HEVC decoder, so it cannot decode iPhone HEIC pixels. HEIC goes
through `libheif-js` (WebAssembly, about 500 ms per 12 MP photo) in a
`worker_threads` pool, see `src/thumbs/heic-pool.ts`, and sharp takes the raw
RGBA from there. Every other image format goes straight to sharp. Call
`sharp.cache(false)`, or libvips holds files open and Windows refuses to move
or delete them.

**On exiftool.** It stays resident in `-stay_open` mode, which is the only way
the throughput is acceptable. `exiftool-vendored` manages that for you. It is a
large dependency for one job, and it is still the right call, because the Apple
MakerNote parsing is the difference between Live Photos working and not.

## Packaging

`electron-builder`, NSIS target, x64 and arm64. Native modules rebuilt against
the Electron ABI via `electron-rebuild` in the build step.

Bundle size will land somewhere north of 250MB once exiftool and the ONNX
models are in. That is the price of the stack choice and it is fine.
