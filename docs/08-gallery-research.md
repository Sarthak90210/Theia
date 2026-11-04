# Fast photo browsing: what the big apps do

Research for the gallery redesign: phones in a sidebar, the phone's own albums
and order, vaults, a full-size viewer and an info panel.

## Where the phone's order and albums come from

The files in `/DCIM` carry no albums and no gallery order. Both live in the
phone's Photos database, `PhotoData/Photos.sqlite`, in the same media area AFC
already reads. Since iOS 14 the asset table is `ZASSET` (it used to be
`ZGENERICASSET`). Albums are `ZGENERICALBUM`, with a custom sort key per album.
Each asset row gives its file as `ZDIRECTORY` + `ZFILENAME`, so a gallery row
maps straight to an AFC path the import engine can fetch.

Column names shift between iOS versions (the published schemas are for iOS 12
and macOS Photos 5), so the reader has to be checked against iOS 27 on the real
phone before anything is built on it. **Not yet tried on this phone.** It was
unplugged when this was written.

Also open: with "Optimize iPhone Storage" on, many originals are in iCloud and
not on the phone. The database still lists them. Those cannot be fetched over
USB.

## How fast grids stay fast

From Google's write-up of the Google Photos web grid, and an engineer's
reconstruction of it:

- **Lay out once, scroll cheaply.** Compute the justified layout (rows that
  keep each photo's aspect ratio) when the data changes, never on scroll. The
  scroll handler only works out which rows are on screen.
- **A scrollbar that tells the truth.** Reserve the full height of the library
  up front, from counts per section, so dragging the scrollbar to "2019" lands
  in 2019 even before 2019 has loaded.
- **Load by section.** Fetch the metadata for a month when it nears the
  viewport, not the whole library at start.
- **Placeholders first.** A tiny blurred image or average colour per photo,
  shown instantly, then the real thumbnail. Load a few screens ahead, in the
  direction of the scroll.
- **About 10 ms of work per frame** to hold 60 fps. Keep the DOM small: only
  the rows on screen, plus a small overscan.

Immich's web timeline went the same way. It moved from fetching every asset and
drawing every placeholder to sizing the timeline from counts and fetching only
what is in view.

## What this means here

- The grid is a virtual list of justified rows, built from counts per month.
- Thumbnails come from the cache folder that already exists (400 px grid,
  1600 px detail, 32 px blurred placeholder). Phone thumbnails need their own
  source: the phone keeps small previews in `PhotoData/Thumbnails`, or the app
  decodes on demand. To be measured.
- Decoding never happens on the window's thread. It already runs in the HEIC
  worker pool.
- A vault is the existing library folder (`library.db`, `media/`, `cache/`)
  plus a manifest, so the app can open several and save into any of them.

## Sources

- Google Design, [Building the Google Photos Web UI](https://medium.com/google-design/45b714dfbed1)
- Dan Schlosser, [Building the Image Grid from Google Photos](https://medium.com/@danrschlosser/building-the-image-grid-from-google-photos-6a09e193c74a)
- Immich maintainer on the timeline, [r/selfhosted, 2022](https://lr.us.psf.lt/r/selfhosted/comments/x7fnzg/here_is_another_immichs_progress_update_and/io9vfx0/?context=3), and the [timeline performance commit](https://ark.sudovanilla.org/Infrastructure/immich/commit/e96ffd43e75b88663af026140d04f9c9fdbbd381)
- osxphotos, [iOS 12.5.7 Photos.sqlite schema](https://github.com/RhetTbull/osxphotos/wiki/iOS-12.5.7-(16H81)-Photos.sqlite-schema) and [Photos 5 database](https://github.com/RhetTbull/osxphotos/wiki/Photos-version-5-database)
- [libimobiledevice gist reading Photos.sqlite](https://gist.github.com/aurorabbit/592bbc76df317f86c1a6ef64cc21244d)
- Packt, [iOS Forensics for Investigators, photos chapter](https://subscription.packtpub.com/book/security/9781803234083/11/ch11lvl1sec53/analyzing-photos-and-videos), on `ZASSET` replacing `ZGENERICASSET`
