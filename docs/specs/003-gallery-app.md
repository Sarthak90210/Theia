# Gallery app spec

Replaces the import screen in `app/` as the main interface. That screen was a
working check of the import engine against the real phone. This is the
product.

Layout and workflow follow Mac Photos: sidebar, gallery grid, full-size viewer,
info panel. The design (colours, icons, type) is our own. No Apple artwork.

## What the user does

1. Plugs in an iPhone. It appears in the sidebar under **Devices** by itself,
   by name. Several phones show as several entries.
2. Selects the phone. Its whole gallery opens in the same order as on the
   phone, with its albums listed under it in the sidebar, in the phone's order.
3. Selects a whole album, a collection, a range, or single photos.
4. Saves the selection into a **vault** folder they choose, new or existing.
5. Opens one or more vaults later from the sidebar and browses them exactly
   like a phone.
6. Clicks a photo or video to see it large. Opens the info panel to see
   everything about it, and can save just that one item.

## Decisions (asked 2026-11-04)

| Question | Answer |
|---|---|
| Vault layout on disk | **Album folders.** `Vault/<Album>/IMG_1234.HEIC`. A photo in two albums is stored once, and the second album links to it. Photos in no album go to `Vault/Library/`. |
| Edited photos and Live Photos | **Save everything.** Original, edited render, edit recipe (`.AAE`) and Live Photo video. The vault shows the edited version by default. |
| Info panel | **Right side.** The sidebar stays on the left, and both can be open. |
| iCloud-only items ("Optimize iPhone Storage") | **Shown with a cloud badge**, using the phone's preview. Saving skips them and reports how many. |
| Grid | **Square tiles**, cropped to fill, with a zoom slider for tiles per row. |
| Time grouping | **Years / Months / Days / All Photos** tabs. Default All Photos. |
| Saving into a vault that already holds some items | **Skip same bytes, then report:** "Saved 40, 12 were already there." |
| Appearance | **Permanent dark mode**, with neutral glass navigation and controls. |

## Sidebar

```
Devices
  Sarthak's iPhone          ← appears on plug-in, disappears on unplug
Vaults
  Family 2026
  Goa trip
  Open vault…
──────────────
<selected source>
  Library
  Favourites
  Videos · Live Photos · Screenshots · Selfies · Panoramas · Bursts
  Recently Saved             (vaults only)
  My Albums
    <albums in the source's own order>
```

A device that is plugged in but not usable (locked, not trusted, driver
missing) still appears, with the four-layer diagnosis shown in place of the
gallery. The import screen's diagnosis moves here.

## Engine work this needs

- **Read the phone's Photos database** (`PhotoData/Photos.sqlite` over AFC):
  assets in order, albums and their order, favourites, media subtypes, edits,
  Live Photo pairs, and whether the original is on the phone or only in iCloud.
  Unproven on iOS 27. First thing to test with the phone plugged in and
  unlocked.
- **Phone thumbnails** without copying originals: the phone's own previews if
  readable, otherwise decode on demand into a per-device cache.
- **Several devices at once.** The watcher tracks one today, and has to track a
  set.
- **Vaults.** The existing library folder plus a manifest (`vault.json`) and
  album folders. Opening several at once means one database handle per vault.
  Saving reuses the import engine (resume, verification, quarantine, report),
  targeting the vault and the selected items only.
- **Grid at speed.** Virtual list of tile rows sized from counts, placeholders
  first, thumbnails loaded around the viewport. See
  [../08-gallery-research.md](../08-gallery-research.md).

## Built, 2026-11-04

Everything in "What the user does" works against the iPhone 16 Pro Max
(iOS 27, 3,788 items) and `D:\PhotosLibrary` (4,292 items).

- Window: `app/renderer/`. `App.tsx` holds selection and navigation.
  `Grid.tsx` is the virtual grid, laid out by `layout.ts`, a pure function with
  tests in `test/gallery-layout.test.ts`. Then `Viewer.tsx`, `InfoPanel.tsx`,
  `Save.tsx` (the "Save to…" menu and the status bar) and `Diagnosis.tsx`.
- Selection: click, Ctrl+click, Shift+click, Ctrl+A, arrows, and "Select" on a
  day. With nothing selected, "Save all to…" saves the whole collection, which
  is how a whole album gets saved.
- Years and Months are overviews. A click goes one level down at that photo.
  A tab change goes to the newest photos. Zoom and resize keep the place.
- Phone sessions keep at most 8 files open and reconnect once if the phone
  drops the connection. See "Browsing the phone without copying it" in
  [../../prototype/FINDINGS.md](../../prototype/FINDINGS.md).
- The info panel shows which open vaults already hold a phone item. It matches
  saved vaults by the phone's UUID, and the import library by the file's path
  on the phone.

- The info panel follows the iPhone's info screen: "Friday • 30 Oct 2026 •
  3:29 PM" and the file name, then camera and format chip, then lens
  ("Ultra Wide Camera — 13 mm ƒ2.2") and "12 MP • 4032 × 3024 • 3.3 MB",
  then the ISO, focal length, ev, aperture and shutter strip, then a map with
  the photo as its pin and the phone's place name ("Bengaluru Urban - Dibburu").
  Times are 12-hour everywhere. For phone items all of it comes from the
  phone's database, so videos and iCloud-only items get it too. Vaults read
  the same values from the stored EXIF, and saving from a phone keeps its
  place name.
- Map tiles come from OpenStreetMap through the main process, cached for 30
  days under the app's data folder. That means viewing a photo with a location
  sends its rough area (the tile coordinates) to OpenStreetMap's servers.
  Nothing else leaves the machine. Offline, cached tiles still show, and the
  place name and coordinates show regardless.

**Bursts.** One grid tile shows the frame count. Opening it displays a filmstrip
with the cover marked; Shift+Left/Right steps through frames. In a vault,
**Make cover** changes the representative image and **Keep as photo** separates
the selected original into a photo with the burst's time, place and albums.
The remaining burst keeps a cover and becomes a photo when only one frame
remains. Phone bursts are read-only, with **Save this frame to...** instead.
Saving a whole burst retains all available originals and the chosen cover.
A standalone frame and its full burst can both be saved in either order.

**Older import place names.** When the matching phone becomes ready, or an
import library opens while it is connected, missing labels are filled from
the phone's Photos database. Matching uses the photo UUID or the import's
device id, complete original path, committed file and capture time. Existing
labels and coordinates are preserved. The names persist for offline browsing.
Items without a safe match or a phone-provided name remain unnamed.

**Map privacy.** Sidebar **Settings**, or Ctrl+,, opens a persistent
**Show maps in photo info** switch. Turning it off removes maps, blocks tile
requests in the main process and cancels requests in progress. Place names
and coordinates remain visible. Opening a location in the browser is a
separate explicit action. Tests use generated cached tiles, without contacting
OpenStreetMap.

**Keyboard help.** Sidebar **Keyboard shortcuts**, F1 or ? lists the app,
grid, viewer, editor and video controls. Ctrl+O opens a vault, Ctrl+R refreshes
the current source, Ctrl+B toggles the sidebar and Ctrl+I toggles info.
Opening another vault and refreshing are disabled during editing.

## Selection and editing, 2026-11-04

**Clicking.** A click opens a photo or video. Selecting is a mode, as on the
iPhone: **Select** in the toolbar turns it on, clicks then tick and untick,
Shift+click ticks a range, and **Cancel** or Esc turns it off. Ctrl+click,
Shift+click and Ctrl+A also turn it on, for people used to File Explorer.
Arrow keys move a focus ring and Enter opens.

**Editor** (`app/renderer/Editor.tsx`, `EditCanvas.tsx`), modelled on Photos
on Windows, Google Photos and the iPhone:

- Crop is a frame on the picture with corner and edge handles, a thirds grid
  while dragging, and aspect presets (Freeform, Original, Square, 16:9, 4:3,
  3:2, 5:4) with a portrait/landscape switch. Rotate left or right and flip
  carry the frame with the picture.
- Straighten is a ruler under the picture, -45° to 45°, with a fine grid while
  dragging. The picture zooms just enough that no corner shows.
- Adjust: Exposure, Brightness, Contrast, Saturation, Warmth, Tint. Every
  change shows at once. Double-click a slider to reset it.
- Undo and redo (Ctrl+Z, Ctrl+Y), one step per drag. Hold Compare, or M, for
  the original. Leaving with unsaved edits asks first.
- Video: a filmstrip with trim handles, play the trimmed clip with Space, and
  mute. Crop, straighten and adjustments apply to video too.

The live preview and both exports share one set of numbers
(`src/media/edit-math.ts`): a tone curve per channel, then a saturation
matrix. In the window it's an SVG filter; for photos, a pixel loop; for video,
a 3D lookup table that ffmpeg applies (`lut3d`). Exposure works in linear light
with a soft shoulder, so +1 EV brightens a light sky without blowing it out.
A plain multiply clipped it to white.

The recipe applies in this order: flip, quarter turns, straighten, crop
(fractions of the picture as displayed), then colour.

**Live Photos** play in place in the grid when the pointer rests on one for
a quarter of a second: muted, fading in over the still and back out at the end
or when the pointer leaves. Not with Windows' "reduce motion" setting on.

**Title bar.** Theia draws its own (`TitleBar.tsx`), because Windows draws the
native title-bar icon at 16 px whatever the image. The logo shows at 26 px, the
bar drags the window, and Windows still draws the caption buttons over it
(`titleBarOverlay`), in Theia's colours. The sidebar no longer repeats the name.

**Checked end to end** by `scripts/qa-full.cjs`. It drives the built app with
real mouse and keyboard input against a generated test vault in its own
profile (`npx tsx scripts/prepare-ui-polish-qa.ts`, then `electron
scripts/qa-full.cjs`). The gallery-gap pass covers 28 flows and 19 layout checks
at 1280x820, 1000x700 and 860x560, and saves 34 screenshots. It checks burst
cover changes, keeping frames until the burst becomes a photo, map privacy and
its persisted setting, and shortcut help. Place backfill and phone burst saving
have automated fixture tests; these new paths have not been checked on a live
phone.

## Not decided yet

- What the sidebar collections are for a vault that was filled from several
  phones.
- Search, packaging and updates remain separate roadmap work.

Vault deletion is supported through Recently Deleted, with recovery and an
explicit permanent-delete action that sends files to the Windows Recycle Bin.
