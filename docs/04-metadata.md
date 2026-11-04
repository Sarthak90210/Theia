# Metadata and grouping

Two rules. Metadata lives inside the file, never in a sidecar we create. Files
are grouped into assets by content, never by filename.

## Asset versus file

An asset is one thing the user took. A file is one thing on disk. The mapping is
often not one to one, and most of the confusion around iPhone imports comes
from tools that assume it is.

| Asset kind | Files |
|---|---|
| Still | `IMG_1234.HEIC` |
| Adjusted capture | `IMG_1234.HEIC` original plus `IMG_1234.AAE` recipe, usually with no render |
| Live Photo | `IMG_1234.HEIC` still, `IMG_1234.MOV` motion |
| Edited Live Photo | all four of the above |
| Burst | many `IMG_1234.HEIC` sharing a burst UUID, one flagged as the pick |
| Video | `IMG_1234.MOV` |
| Slow motion | `IMG_1234.MOV` with a high capture frame rate and a playback range |

## Grouping

### Live Photos

Match on the content identifier, not the filename.

- Still: Apple MakerNote tag `0x0011`. Read with `-G1` it is
  `Apple:ContentIdentifier`; with `-G0` it is `MakerNotes:ContentIdentifier`.
- Video: the QuickTime metadata atom
  `com.apple.quicktime.content.identifier`. With `-G1` it is
  `Keys:ContentIdentifier`; with `-G0` it is `QuickTime:ContentIdentifier`.

Pick one group family and hold it. Mixing them produces lookups that silently
return nothing, which was a real bug in the probe that first tested this.

Equal UUID means one asset. Verified on a real pair: a HEIC and a MOV pulled
over AFC both reported `4B23D938-CC54-4D95-B0F6-55FE602F2CDA`. The filename
stems usually match too, and relying on that breaks the moment you hit an
adjusted file or a burst, so do not.

If the MakerNote is missing, the phone was transcoding during transfer and the
pairing is unrecoverable. Record the asset as a separate still and video, flag
it, and mention it in the import report.

### Edits and adjustments

The rule an earlier draft stated, that an edit produces `IMG_1234.HEIC`,
`IMG_E1234.HEIC`, and `IMG_1234.AAE`, does not hold. Measured on a real device:
384 AAE files and zero `IMG_E` renders anywhere in `/DCIM`.

The AAE is a plist. A representative one reads:

```
adjustmentEditorBundleID   com.apple.camera
adjustmentFormatIdentifier com.apple.photo
adjustmentFormatVersion    1.4
adjustmentRenderTypes      24576
adjustmentData             <159 bytes, opaque>
```

The editor is the camera, not the Photos app, so these are adjustments applied
at capture rather than edits the user made afterwards. They attach to `.HEIC`,
`.JPG`, and `.MOV` alike, so the grouping rule must not assume a still.

Three consequences.

Treat the render as optional. An `IMG_E` file may exist and usually will not.
Group by stem, attach whatever is present, and never require the render.

Keep the AAE bytes in the database. We cannot interpret `adjustmentData` and
should not pretend to, but discarding it throws away the only record of what the
phone is showing.

Flag assets that carry an AAE. The copy on disk is the unadjusted capture, so it
can differ from what the user sees on the phone. Say so rather than letting them
discover it.

There is a genuine trade-off buried here. iOS appears to serve rendered versions
through the MTP path, which is part of why imports there show `IMG_E` names. AFC
gives originals with perfect metadata and no renders; MTP gives renders that are
transcoded and sometimes corrupt. Originals are the right choice, and this is
what it costs. Worth confirming directly before v1 ships.

### Bursts

Apple MakerNote `BurstUUID`. Group them, mark the frame Apple selected as the
pick, and collapse the rest in the grid by default.

## EXIF handling

### Fields we treat as canonical

| Field | Source | Notes |
|---|---|---|
| `DateTimeOriginal` | EXIF | Local wall clock, no zone |
| `OffsetTimeOriginal` | EXIF | The real timezone. Store it. Without it you cannot tell 3pm in Delhi from 3pm in London. |
| `GPSLatitude`, `GPSLongitude`, `GPSAltitude` | EXIF | Signed decimal after applying the ref fields |
| `Make`, `Model`, `LensModel` | EXIF | |
| `Orientation` | EXIF | Apply on display, never by rewriting pixels |
| `ContentIdentifier` | MakerNote | Live Photo pairing |
| `BurstUUID` | MakerNote | Burst grouping |
| `CreationDate` | QuickTime | For video, includes the offset |

Store both the raw EXIF blob and the normalized values. The normalized columns
are what queries use. The raw blob is what you go back to when a normalization
turns out to be wrong, and one of them will.

### Timezone

Store capture time as UTC plus the original offset, in two columns. Do not
convert to local time on import. The user is in Delhi. The photo was taken in
Bangkok. Both facts matter and collapsing them loses one.

When `OffsetTimeOriginal` is absent, infer one rather than storing null. A null
offset forces the caller to keep a local wall clock labelled UTC, which is not
an instant, and a library holding a mix of the two cannot be sorted.

Inference has two sources and the asset records which was used.

**GPS, and it is exact.** `Composite:GPSDateTime` is UTC while
`DateTimeOriginal` is local, so their difference is the offset the camera
declined to write down. Round to the nearest quarter hour to absorb the seconds
between the GPS fix and the shutter. This needs no timezone boundary dataset,
which an earlier draft of this document called for, and it recovers the right
zone for a travel photo.

**The importing machine's zone, which is a guess.** Screenshots are the common
case: they carry `DateTimeOriginal`, no offset tag, and no GPS at all. Assuming
the user's own zone is right for anything they shot at home and wrong by the
difference for anything else, which is no worse than the alternatives and at
least yields a real instant.

`offset_source` distinguishes `recorded`, `gps` and `host`, because "inferred"
alone does not say inferred how, and those three differ in how much they can be
trusted.

The invariant that holds in every case: capture instant plus offset reproduces
the wall-clock reading the camera recorded, so the user always sees the time
they remember.

### Dates that are not dates

QuickTime writes `0000:00:00 00:00:00` when it has no creation date, which is
normal for video that did not come from the camera. Reject it, along with any
impossible component, rather than parsing it.

This matters more than it looks. `Date.UTC` maps years 0 to 99 onto 1900 to
1999, so year zero becomes 1900 and the rest of the zero date rolls backwards
into 1899-11-30. An MP4 in the reference library filed itself under
`1899/1899-11/` exactly this way. Reject a day that does not exist in its month
too, or 31 February quietly becomes 3 March.

A file whose only date is a zero date should fall through to the filesystem and
record `time_source: filesystem`, which is the honest answer.

### Never write sidecars

If the user edits a caption, rating, or keyword, write it into the file.
XMP-dc:description, XMP-xmp:Rating, XMP-dc:subject. exiftool writes these into
HEIC, JPEG, and MOV without re-encoding the media.

The one case where a sidecar is acceptable is a format that genuinely cannot
carry XMP. Note it in the report when that happens.

## Ingesting sidecars from elsewhere

For a backlog exported from Google Takeout or iCloud web, files arrive with
`.json` companions and stripped EXIF.

Read the JSON, map `photoTakenTime.timestamp` to `DateTimeOriginal`,
`geoData` to the GPS block, and `description` to XMP. Write them into the media
file, verify the write, then delete the sidecar. This is a one-way migration and
it should be an explicit user action with a preview, not something the importer
does on its own.

## The transcode setting does not apply here

An earlier draft of this document required the user to set
`Transfer to Mac or PC` to Keep Originals before importing. Measurement says
otherwise. With the phone on Automatic, AFC still returned HEIC originals with
their `ftyp` brand intact, because AFC reads the media partition and the
transcoder sits only in the MTP path.

The setting is therefore irrelevant on the primary path and the user never needs
to hear about it. It still matters on the MTP fallback, where re-encoding
destroys the Apple MakerNote and takes Live Photo pairing with it, and there it
is a warning rather than a block.
