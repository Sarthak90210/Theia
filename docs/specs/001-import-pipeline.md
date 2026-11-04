# Spec 001: iPhone import pipeline

Status: ready-for-agent
Depends on: nothing. This is the first code in the repo.

## Problem Statement

I plug my iPhone into my Windows laptop and the stock Photos app fails me in
four ways.

It often does not notice the phone is there at all, or shows it as an empty
device. When it does start importing, the transfer sometimes dies partway
through, and sometimes it just skips photos without telling me which ones. Some
of the photos and videos that do arrive are corrupt, and I have no idea why or
which ones until I open them, possibly months later. And the metadata does not
come across properly: I end up with stray files next to my photos instead of
dates and locations inside them.

The result is that I do not trust that my photos are actually on my laptop. I
cannot answer the question "did everything come across" without checking by
hand, and by the time I notice something is missing the phone has been wiped.

## Solution

An import tool that moves every photo and video off the phone with its metadata
intact, verifies each file before accepting it, and tells me precisely which
files did not make it and why.

It talks to the phone over AFC rather than MTP, which means transfers resume
from where they stopped instead of restarting, and the bytes that arrive are the
original bytes the phone recorded rather than a re-encode produced on the fly.

Every file is checked four ways before it is accepted into the library: the byte
count matches what the phone reported, a hash is recorded, the container
structure is walked to confirm it is complete, and the media is decoded to
confirm it is not garbage. Files that fail go into quarantine with a written
explanation rather than into the library pretending to be fine.

At the end of a run I get a report: how many files came across, how many were
already there, and a line per quarantined file naming the failure and the
reason.

## User Stories

### Connecting

1. As a photo owner, I want the app to notice my phone within a second of me
   plugging it in, so that I do not have to hunt for a refresh button.
2. As a photo owner, I want to see my phone's name, model, and iOS version once
   it connects, so that I know the app is talking to the right device.
3. As a photo owner, I want a clear "unlock your phone and tap Trust" prompt when
   the device is not paired, so that I know what action to take instead of seeing
   a generic failure.
4. As a photo owner, I want the app to keep polling while I unlock the phone and
   proceed automatically once I tap Trust, so that I do not have to unplug and
   replug.
5. As a photo owner, I want to be told when Apple's device driver is missing,
   along with what to install, so that I can fix the cause rather than guess.
6. As a photo owner, I want the app to tell me it has fallen back to a degraded
   transfer method, so that I understand why it is slower and less reliable.
7. As a photo owner, I want the app to notice when my phone is disconnected
   mid-import and say so plainly, so that I do not assume the import finished.

### Before the transfer

8. As a photo owner, I want original files no matter how my phone's transfer
   setting is configured, so that I never have to learn that the setting exists.
9. As a photo owner, I want to hear about the transcode setting only if the app
   has fallen back to MTP, where it genuinely does damage, so that I am not
   asked to change something that does not matter.
10. As a photo owner, I want to be told how much space the import needs and how
    much I have, before it starts, so that it does not fail halfway through.
11. As a photo owner, I want to choose where my library lives, so that I can put
    it on my large drive rather than my system drive.
12. As a photo owner, I want my laptop to stay awake and the USB port to stay
    powered for the duration of the import, so that a sleep timer does not
    truncate my files.
13. As a photo owner, I want to see how many photos and videos are on the phone
    and how many are new before committing to a run, so that I know what I am in
    for.

### During the transfer

14. As a photo owner, I want files I have already imported to be skipped
    automatically, so that a second run takes seconds rather than hours.
15. As a photo owner, I want to see current file, files remaining, bytes
    remaining, transfer rate, and an estimated finish time, so that I can decide
    whether to wait.
16. As a photo owner, I want related files to arrive together, so that a Live
    Photo is never left with only its still or only its motion half.
17. As a photo owner, I want to pause an import and resume it later, so that I
    can take my phone with me.
18. As a photo owner, I want to cancel an import without leaving partial files in
    my library, so that the library is never in a half state.
19. As a photo owner, I want an interrupted transfer to resume from the byte it
    stopped at, so that a failure at 90% does not cost me the whole file.
20. As a photo owner, I want a failing file retried a few times before it is given
    up on, so that a transient USB glitch does not become a lost photo.
21. As a photo owner, I want the app to survive being killed mid-import and pick
    up where it left off when I reopen it, so that a crash costs me minutes, not
    an evening.

### Verification

22. As a photo owner, I want every file checked against the size the phone
    reported, so that a truncated transfer is caught immediately rather than
    months later.
23. As a photo owner, I want a hash recorded for every file, so that I can detect
    corruption on disk later and identify duplicates.
24. As a photo owner, I want the internal structure of each file checked, so that
    a video missing its index is caught before I think it is safely backed up.
25. As a photo owner, I want each image actually decoded before it is accepted, so
    that a file which is structurally valid but full of garbage does not pass.
26. As a photo owner, I want to turn off the slowest verification step for a very
    large first import, and to be told exactly what I give up by doing so, so
    that I can make that trade knowingly.
27. As a photo owner, I want a file that fails verification to never appear in my
    library as though it were fine, so that I can trust what I see.

### Quarantine and reporting

28. As a photo owner, I want failed files kept rather than deleted, so that I can
    decide what to do with a partially recovered photo.
29. As a photo owner, I want each quarantined file to carry a plain explanation of
    what failed and what was expected, so that I can tell a bad cable from a bad
    setting.
30. As a photo owner, I want to retry all quarantined files in one action, so that
    I can fix a cable and recover everything without hunting.
31. As a photo owner, I want to accept a quarantined file anyway, so that a
    partially readable photo is not lost just because it is imperfect.
32. As a photo owner, I want a report at the end of every run listing what came
    across, what was skipped, and what failed, so that I can answer the question
    of whether everything made it in one glance.
33. As a photo owner, I want past run reports kept, so that I can check what
    happened during an import I ran last month.

### Metadata

34. As a photo owner, I want capture date and time written inside each file, so
    that any other program I use reads the right date.
35. As a photo owner, I want the original timezone preserved alongside the time,
    so that a photo taken abroad does not show my home time.
36. As a photo owner, I want GPS coordinates preserved, so that I can find photos
    by where I took them.
37. As a photo owner, I want camera, lens, and exposure details preserved, so that
    nothing from the original is thrown away.
38. As a photo owner, I want no sidecar files created next to my photos, so that
    my library is media files and nothing else.
39. As a photo owner, I want the file's own created and modified timestamps set to
    when the photo was taken, so that sorting by date in Explorer is correct.
40. As a photo owner, I want to know when a date had to be guessed rather than
    read from the file, so that I can spot the photos whose dates I should not
    trust.

### Grouping

41. As a photo owner, I want a Live Photo treated as one item with two files, so
    that I do not see what looks like a duplicate video next to every photo.
42. As a photo owner, I want Live Photos paired by their real identifier rather
    than by filename, so that edited and burst photos still pair correctly.
43. As a photo owner, I want to be told when a Live Photo could not be paired
    because its identifier was stripped, so that I understand why it looks wrong.
44. As a photo owner, I want an edited photo kept together with its original and
    its edit recipe, so that I have not lost the ability to go back.
45. As a photo owner, I want the edited version shown by default, so that I see
    the photo as I meant it to look.
46. As a photo owner, I want a burst kept as one group with the pick Apple
    selected marked, so that thirty near-identical frames do not flood my
    library.

### Organisation

47. As a photo owner, I want files laid out in dated folders on disk, so that my
    library is navigable without this app.
48. As a photo owner, I want filenames that sort chronologically and still contain
    the original name, so that I can cross-reference against my phone.
49. As a photo owner, I want two files with identical content stored once, so that
    I am not paying disk for the same photo twice.
50. As a photo owner, I want two different files that want the same name both
    kept, so that a name clash never destroys a photo.

## Implementation Decisions

### Device access

The primary transport is AFC over usbmuxd, implemented in TypeScript against
Apple's named pipe, with no native compilation. The chain is usbmuxd for device
enumeration and channel multiplexing, lockdownd for pairing and service startup,
then AFC for filesystem operations. Pairing material is read from Apple's
Lockdown directory.

MTP via WIA is a fallback for machines without Apple's driver stack. It is
explicitly degraded: no byte ranges, so no resume, and a higher failure rate.
The UI says so and steers the user toward installing Apple's driver.
Verification applies identically on both paths and will reject more files on
MTP, which is the correct outcome.

### The device seam

All code above the transport talks to a single narrow interface covering
directory listing, file stat, open, ranged read, and close, plus device identity
and free space. AFC, MTP, and the test fake all implement it. Nothing above this
interface knows which transport it is running on.

This interface is the one deliberate seam in the system. Keeping it narrow is
what makes the fake credible.

### Import as a persisted state machine

An import run is a row, and every file in it is a row carrying a stage, a
received byte count, and an attempt count. Stages advance in order: planned,
fetching, verifying, committed, or one of quarantined and skipped. Each
transition commits to the database before the next begins.

Resume is therefore not a special code path. Starting a run means selecting rows
that are not in a terminal stage, and a fetch that finds a non-zero received byte
count seeks to that offset. A crash, a cancel, and an unplugged cable all recover
through the same mechanism.

The uniqueness constraint on device identifier plus path plus size plus
modification time is what makes repeat imports fast.

### Transfer

One file at a time. Measured against a real device, one channel sustains
26.3 MB/s and four sustain 27.2, so concurrency buys three percent and costs an
interleaved staging area and a harder resume path. Reads are chunked at four
megabytes, a size chosen for resume granularity rather than speed, since 1 MB
and 16 MB perform identically. The hash is computed during the read rather than
in a second pass.

Bytes land in a staging directory on the same volume as the library, so the
commit is a rename rather than a copy.

### Verification ladder

Four levels, cheapest first, all of them by default.

Level zero compares bytes written against the size the device reported. Level one
records a content hash. Level two walks the container structure without decoding
pixels, confirming markers and box layout and that declared offsets fall inside
the file. Level three decodes the image fully, or demuxes and decodes the first
and last group of pictures for video.

Level two is the one that catches the specific failure the user is hitting with
video, where the index sits at the end of the file and truncation removes it
entirely.

Only level three is configurable, and disabling it surfaces what it protects
against.

### Commit

Flush to disk, then rename into the final path. Rename within an NTFS volume is
atomic, so there is never a partially written file at a real path.

Destination path is derived from capture time: year, then year and month, then a
filename combining a sortable timestamp with the original stem. Capture time
comes from EXIF with its offset applied, falling back to the container creation
date, then to the device modification time. The source used is recorded, because
date complaints are otherwise undiagnosable.

Name collisions are resolved by comparing hashes first. Identical content is one
file. Different content gets a numeric suffix.

### Metadata

Values are normalized into columns for querying and the full raw extraction is
retained compressed. Normalization is where bugs live, and keeping the raw form
means fixing one later does not mean re-reading the whole library from disk.

Capture time is stored as an instant plus the original offset, in separate
fields, never collapsed to local time. A missing offset is inferred from position
and date against an offline timezone dataset and flagged as inferred.

User-supplied metadata is written into the media file, not into a sidecar we
create.

Apple MakerNote parsing is delegated to exiftool running in a resident process.
Nothing else reads the content identifier reliably, and that identifier is the
only correct basis for Live Photo pairing.

### Grouping

Assets are formed from files after commit. A still and a video sharing a content
identifier are one Live Photo asset. An edited render, its original, and its
adjustment recipe are one asset with the render marked primary. Files sharing a
burst identifier are one burst with Apple's pick marked.

Filename stems are never used for grouping. They break on edits and bursts, which
is precisely where correctness matters.

### Storage

SQLite in WAL mode with exactly one writer, held by the main process. Workers
receive job descriptors and return results rather than touching the database.
Schema as specified in the data model document, including the tables reserved for
search and faces so that later work does not require a migration.

### Process layout

Electron main owns the device connection, the import engine, and the database.
A pool of utility processes handles hashing, structural validation, decode
probes, and thumbnailing. The renderer displays state and issues commands over
typed channels and does no heavy work.

### Preflight

A run cannot start until the preflight passes: device trusted, destination
writable, and enough free space.

The transcode setting is deliberately not part of this on the AFC path. Measured
against a device set to Automatic, AFC still returned genuine HEIC originals,
because it reads the media partition and the transcoder sits only in the MTP
path. The check applies to the MTP fallback alone, and there it is a warning
rather than a block, since MTP is already degraded and the user has no better
option on that path.

## Testing Decisions

### What a good test looks like here

A test drives the import engine through the device interface and asserts on what
a user could observe: which files exist on disk, what their bytes are, what the
database says, what the report says, and what ended up in quarantine. It does not
assert on how many times a chunk was read, which internal method was called, or
the shape of an intermediate value.

The failure mode to avoid is a suite that passes while real imports lose files.
That happens when tests mock the filesystem or the database, so we do neither.

### Primary seam

One fake device implementation, backed by a fixture directory, is the injection
point for every pipeline test. It implements the same narrow interface as AFC and
MTP.

It supports scripted faults, because the faults are the feature:

- report a size larger or smaller than the bytes it will actually serve
- stop serving after a given byte offset and report the file closed
- disappear entirely partway through a read, simulating an unplugged cable
- return short reads that do not fill the requested buffer
- fail a given file's open call while others succeed
- serve bytes slowly enough to test progress and cancellation

Tests assert that a truncated file is quarantined and never committed, that a
resumed fetch reads only the missing range, that a cancelled run leaves nothing
in the library, that a killed process resumes correctly, and that the report
names the right files.

### Real filesystem, real database

Every pipeline test runs against a real temporary directory and a real SQLite
file, both torn down afterwards. Atomic rename semantics, flush behaviour, and
WAL recovery are behaviour under test, and a mock would assert nothing about
them. The database is a file rather than in-memory for the same reason.

Crash recovery is tested by running an import in a child process, killing it at a
known stage, and resuming in a fresh process against the same database and
directory.

### Transport seam

The usbmux client takes an injected duplex stream. Real sessions are captured
from a physical device once and committed as transcript fixtures, then replayed.
This covers frame boundaries, property list encoding, the lockdownd handshake
sequence, and AFC packet framing, which are the parts most likely to be subtly
wrong and the only parts the primary seam cannot reach.

Transcripts are scrubbed of pairing keys before committing.

### Pure functions, no seam

Container validators, capture time resolution, destination path computation, and
grouping rules are called directly. Validators are tested against a fixture
corpus of deliberately damaged files: a JPEG with its end marker removed, a video
with its index atom truncated away, a HEIC whose item locations point past the
end of the file, and a file of the right length filled with noise.

### Fixture corpus

This needs building before the tests can be written, and it needs a real phone.
Required: a plain HEIC still, a Live Photo pair, an edited still with its recipe,
a burst set, a recorded video, a slow motion video, a screenshot, and a photo
with no GPS. Each one is needed small, so trim the videos.

### Prior art

None. This is the first code in the repository, so these decisions set the
conventions. Vitest, tests beside the module they cover, fixtures in one shared
directory, no snapshot testing of anything a human has to read.

## Out of Scope

Search and indexing, including OCR, embeddings, and concept tagging. Specced
separately and deliberately deferred until import is trustworthy.

Face detection, clustering, and naming.

Any editing of photos, including applying or reinterpreting the adjustment
recipes we store.

Browsing the library. v1 ships an import screen, a progress view, a quarantine
review, and a run report. A photo grid is not part of this spec.

iCloud in any form: no account sign-in, no download of photos that live only in
the cloud, no sync. Only what is physically on the device.

Writing to the phone or deleting from it. The import never modifies the device.

Android devices, cameras, and SD cards.

Migration of existing folders on disk, including Google Takeout exports with
their sidecars. The metadata document describes how that should work when it is
built.

Sharing, export, and cloud backup.

## Further Notes

The transcode setting turned out not to matter on the AFC path. Measured with
the phone on Automatic, which is the setting that corrupts files over MTP, AFC
returned HEIC originals anyway. The fixture corpus can be captured over AFC
without touching any phone settings first.

The riskiest part of this spec is the lockdownd TLS handshake. Apple's
certificates are old enough that Node's defaults reject them, and the failure
mode is opaque. Build a throwaway prototype that connects, handshakes, and lists
the camera roll before committing to the rest of the architecture. If Node's TLS
cannot be persuaded, the fallback is bundling libimobiledevice's command line
tools, and that changes the transport layer but nothing above the device seam.

HEIC decoding is the second risk. Do not assume the image library's prebuilt
binaries include HEIF support, because depending on the version they do not.
Detect the capability at startup and fall back to a WebAssembly decoder. Verify
this early, since nearly every file coming off the phone is HEIC and level three
verification depends on it.

The quarantine list and the run report are the features that distinguish this
from the stock app more than the transport does. The transport makes failures
rare. The report makes them visible. Do not treat them as polish to add later.
