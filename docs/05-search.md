# Search

Built: search by meaning, by the words written in photos, by date, place,
album and person, merged into one ranked list; and faces grouped into people. Concept tags are not built
yet. Section headings say which parts are built.

No LLM anywhere in this. Everything here is a small fixed-function model running
on device.

## Why one index is not enough

"aadhar" and "beach at sunset" are different questions.

The first is a text question. The words are printed on the card in the photo,
and finding it means having read that text. Only OCR does that. No image
embedding model will reliably retrieve an Aadhaar card from the word "aadhar",
because the model was trained on captions describing scenes, not on document
contents.

The second is a visual question with no text involved at all, and OCR returns
nothing.

Google Photos and Apple Photos both run OCR and a visual embedding model and
merge the results. That is the design, and skipping either half gives you a
search that feels broken in a way users cannot articulate.

## Where it is stored

Everything search knows sits in the vault's own `library.db`, next to the rest
of what is known about each item, in one row per item per kind of index:

| Table | What | Made by | Size |
|---|---|---|---|
| `embedding` | 256 floats per item | EmbeddingGemma 2 | 1KB |
| `ocr_text` | the words read in the item, one line per line of text, `''` when none | PaddleOCR | usually 0, a few KB for a screenshot |
| `asset`, `place`, `album_asset` | capture time and offset, kind, favourite, place names, albums | already there | |

There is no file per folder. A vault is one database, so search, backup and
deletion all work on the vault as a whole, and a moved or copied vault keeps
its index. Each row carries the name of the model that made it, so a new model
version re-reads only its own table.

Each model is a **stage**: a job kind in the vault's job queue (`embed`,
`ocr`) that runs after thumbnails, newest photos first, survives restarts, and
steps aside while thumbnails are being made. The two stages run side by side,
each in its own worker thread. Adding a kind of search later (faces, concept
tags) means one more table and one more stage, and one more ranked list in the
fusion below; nothing about the existing ones changes.

Hidden and Recently Deleted items are never read by any stage, and every row
about an item is erased when it is hidden or deleted.

## Three indexes

### 1. Text, from OCR (built)

Models: PaddleOCR as ONNX, on the ONNX Runtime the app already carries for
EmbeddingGemma, CPU, two threads, in `ocr-worker.mjs`:

- **PP-OCRv4 mobile detection** (4.7MB) finds text lines. Each connected blob
  of the probability map is boxed by its smallest rotated rectangle, so a card
  photographed at an angle reads fine.
- **PP-OCRv5 English** (7.8MB) and **PP-OCRv3 Devanagari** (9MB) read each line,
  straightened out of the full image into a 48px strip. English goes first;
  the Devanagari reader is asked only when English is unsure, and the more
  confident reading wins. Indian documents carry both scripts on one card.

About 21MB in all, pinned and hash-checked in `src/search/ocr-model.ts` and
shipped in `resources/models/ppocr`. Input is the 1600px thumbnail. About 0.2
seconds for a photo with no text, up to 3 seconds for a page full of it.
Everything is read; with OCR this cheap, no gate in front of it is needed.

Windows' built-in OCR was the alternative. It depends on which language packs
a machine has, and is reachable from Electron only through a native addon or a
PowerShell bridge; bundling the models means every install reads the same.

Matching (`src/search/text.ts`) is forgiving, because people misspell and OCR
misreads: a query word matches a word in the photo exactly, as its beginning
(4+ letters), inside it (Devanagari often comes back without its spaces), or
one letter off (5+ letters; two off at 8+). "aadhar" finds "AADHAAR". A long
number typed without spaces matches one printed with them. Items need at least
half the query's words; more words, rarer words and closer matches rank first.
**Highlighting.** Each line is stored with its box (four corners, so tilted
text works) and where each character sits along it, taken from the reader's
output steps (`ocr_text.lines`). A search result carries the shapes of the
matched words, cut out of their lines, and the grid tile and the viewer draw
them over the photo as yellow outlines, in the photo's own pixels, so they
crop with the tile and zoom with the viewer. Devanagari read without spaces
marks just the word, not the whole run.

Brute force over the vault's text rather than FTS5: the text is small, and
fuzzy matching against a word list is simpler than trigram tables.

### 2. Visual, from image-text embeddings (built)

Model: EmbeddingGemma 2, in place of the SigLIP base first planned here. The
research behind the swap is in [11-embeddinggemma-search-research.md](11-embeddinggemma-search-research.md).
Text and images share one 768-dimension space; a typed query is compared
directly with photo vectors, in 100+ languages ("मंदिर" finds temples).

How it runs, in `src/search/`:

- **Shipped inside the app.** The 8-bit text model and vision encoder (about
  510MB) are pinned to one Hugging Face revision, checked by SHA-256 in
  `scripts/prepare-models.mjs`, and packed into `resources/models`. Nothing is
  downloaded at run time; Transformers.js has remote models switched off.
- **Transformers.js on ONNX Runtime, CPU**, in a worker thread
  (`embed-worker.mjs`) that starts on first use and stops after two quiet
  minutes. DirectML fails on one of the model's reshape nodes, so no GPU yet.
- **70 vision tokens per photo**, not the default 280: four times faster
  (about 2 photos a second on an i7-13620H), same top result on every test
  query, mean cosine 0.95 to the 280-token vectors.
- **256 dimensions** (Matryoshka truncation, renormalised): 1KB per photo.
- **Input is the 800px grid thumbnail**, already decoded from HEIC. Videos use
  their poster frame for now.

Indexing is a job kind (`embed`) after thumbnails, newest photos first,
resumable across restarts, and steps aside whenever thumbnails are being made.
The `embedding` table keys each vector by a model string (model, revision,
precision, vision tokens, dimensions); changing any of them re-embeds rather
than migrating. Hidden and Recently Deleted items are never embedded, and their
vectors are erased when they get there, because a vector describes the photo.

Ranking: brute-force cosine over the vault (40,000 photos is about 40MB read
and tens of milliseconds). Scores bunch together, an unrelated photo scoring
about 0.62–0.68 and the best match 0.70–0.78, so a result is kept when it
stands at least halfway from the median score to the best and 0.04 above the
median. Results are fused (RRF) with place and album name matches, which carry
slightly more weight at equal rank.

Not done yet: the zero-shot concept tags below, and a better answer for a
query that matches nothing (it still shows the few photos closest to it).

Also run a zero-shot pass at index time against a fixed vocabulary of about
1,000 concepts: "document", "receipt", "screenshot", "identity card", "beach",
"dog", "whiteboard", and so on. Store anything above threshold as a tag. This
gives the user browsable categories without a separate classifier, and it is
roughly what Apple's scene classification produces.

### 3. Structured (dates built)

`src/search/query.ts` reads dates and kinds out of the query before anything
else sees it, and they become a hard filter; the rest is searched as usual.
"goa beach last december" looks for "goa beach" among photos from December
2025. Dates are the photo's local time (capture time plus its offset).

Understood, in English and Hindi: today, yesterday; this or last week,
weekend, month, year; past N days, weeks, months, years; N units ago; month
names with or without a day and year ("25 dec 2024", "december", which means
any December, "last december", "पिछले दिसंबर"); years; since and before.
"videos" and "favourites" filter by kind. "may" counts as a month only next to
a number or after "in". A query that is only a filter ("photos from 2024")
lists those photos newest first. The window shows what was understood under
the title ("December 2025 · 14 results").

Place and album names match as words (all of the query's words, in the place
label, city, region, country or album name). Not done: camera and lens.

## Fusion

Each index returns a ranked candidate list. Merge with reciprocal rank fusion:

```
score(doc) = Σ over indexes  weight_i / (60 + rank_i(doc))
```

RRF works well without per-index score calibration, which matters because
cosine similarity and word matches are not on comparable scales.

As built (`searchVault` in `src/search/index.ts`):

- Meaning: weight 1, after the relevance cut-off.
- Words in the photo: 1.1 when every query word was found, 0.8 when only some
  were. A card with "aadhaar" on it beats a photo that only looks like a card.
- Place or album name: 1.2.
- Dates and kinds in the query: a hard filter on all three, not a weight.

Kept simple and rule-based. A learned router is a lot of machinery for a gain
you will not measure on a personal library.

## Indexing budget

Measured on an i7-13620H laptop with an RTX 4060, all three stages running
side by side, on 482 real photos:

| Stage | Runs on | Photos per second |
|---|---|---|
| Thumbnail and decode | processor | 40 to 80 |
| EmbeddingGemma 2, 16-bit, 70 tokens | graphics card | about 5.5 (8 alone) |
| PaddleOCR, every photo | processor, 3 threads | about 3.5 |
| Faces, YuNet and SFace | processor | about 4 |

The whole pass takes about 2.5 minutes per 500 photos: about 20 minutes for
4,000, against 1.5 to 2 hours on the processor alone. It runs in the
background, survives a restart, and reads recent photos first, so search is
useful straight away.

Every stage records its completion per image, so adding a model later means
re-running one stage over the library, not rebuilding from scratch.

### The graphics card

`src/search/embed-worker.mjs` runs EmbeddingGemma through ONNX Runtime's
WebGPU, which on Windows sits on Direct3D 12. That is any recent Intel
(built in or Arc), AMD Radeon or NVIDIA graphics, with no vendor code; on a
laptop with two, it takes the high-performance one (the RTX 4060 here, not the
Intel UHD). Measured: 0.12 seconds a photo on the GPU, 1.3 on the processor,
1.8 with the 8-bit model used before.

- **Checked, not trusted.** The first time, the model embeds a test picture
  drawn in code on the GPU and on the processor; the GPU is kept only when the
  two agree (cosine 0.98 or better; measured 0.996 on real photos). The choice
  is saved in `accel.json` in the profile and checked again after two weeks or
  a model change.
- **Falls back by itself.** No usable GPU, an old driver, a virtual machine,
  or a GPU that fails mid-run: the model moves to the processor, the request
  is tried again, and the status bar stops saying "graphics card".
- **16-bit weights** (`*_fp16.onnx`), for both: DirectML fails on a reshape
  node in the vision encoder in every precision, and WebGPU runs the 8-bit
  build no faster. The 16-bit model is also faster on a processor than the
  8-bit one. The 4-bit build is smaller but drifts further (cosine 0.98, top
  results changed), so it is not used.
- **Only one model on the GPU.** ONNX Runtime's WebGPU crashes the process when
  two threads use it at once. The search model gains 15 times from it, text
  reading 1.5 times and faces nothing, so text and faces stay on the processor
  and all three run side by side safely.

## Faces and people (built)

Models from the OpenCV Zoo, shipped in `resources/models/faces`: **YuNet**
(MIT, 0.2MB) finds faces and five landmarks; **SFace** (Apache 2.0, 37MB)
describes each face as 128 numbers. Chosen over InsightFace (SCRFD, ArcFace),
whose licence forbids shipping in an app. About 0.16 seconds a photo.

- **Finding** (`src/search/face-core.mjs`). YuNet takes a fixed 640x640 input
  and sees faces of 10 to 300 pixels, so each 1600px thumbnail is looked at
  whole at 640, whole at 320 (close-ups, selfies) and in four overlapping
  tiles of a 1152 copy (small faces in groups). Faces under 40px are dropped.
- **Describing.** Each face is turned upright by its landmarks onto the
  standard 112x112 template before SFace reads it. A sharpness score is kept;
  blurred faces are stored but never grouped.
- **Grouping** (`src/search/cluster-core.mjs`, in the worker; rules in
  `src/people/people.ts`). Tuned on a real library of about 5,400 faces:
  - A new face joins the person whose best three faces it matches on average
    at 0.55 or more, and only if it is also within 0.45 of their average face:
    a big group has three close matches for almost anyone, and a 671-photo
    group had collected strangers and a statue that way.
  - The rest are grouped density-first, starting a group only at 0.6. At 0.55
    look-alike young men chained into one group of 789 photos; at 0.6 the
    largest group was one person throughout.
  - Side-on faces (nose more than 0.6 eye-widths off centre) never start a
    group, and join someone only at 0.65.
  - Groups whose average faces are 0.75 alike are merged without asking (one
    person split by glasses, hair or light scored 0.79 to 0.95; different
    people at most 0.71). Between 0.55 and 0.75 the People page asks "Same
    person?"; "Different" is remembered.
  - Faces further than 0.4 from their group's average face are taken back out.
  - A group seen in fewer than three photos waits.
- **Not people.** Each new group's clearest faces, with room around them, go
  through EmbeddingGemma against descriptions of real faces and of statues,
  carvings, cartoons and paintings (`src/people/objects.ts`). Statues, a
  carving and a cartoon scored +0.04 to +0.07 nearer "made"; every real person
  -0.01 or less; a group above +0.02 is hidden as an object, which can be
  undone ("It's a real person"). Printed photographs of people (posters,
  signboards) look like real faces to every model here and are not caught;
  "Not someone I know" hides them, and their faces keep going to the hidden
  group instead of coming back as new ones.
- **Naming** (`src/people/people.ts`). The People page asks "Who's this?" for
  each group. A name someone already has merges the group into them. "Not
  this person" takes photos out and keeps them out. "Not someone I know" hides
  a group without deleting it, so their faces keep going to them and they are
  not asked about again. Grouping runs after each vault's indexing, and every
  250 photos meanwhile, so people appear while the library is still read.
- **Searching.** Named people in a query are a filter, like dates: "aai
  beach" is beaches with Aai in them; "aai and ravi" needs both.
- **Privacy.** Everything stays in the vault's `library.db` (`person`, `face`,
  `face_scan`, `face_not`). Faces in hidden or deleted items are never kept
  and are erased, with their cut-out pictures, when an item is hidden. A
  setting turns face grouping off, which erases faces, groups and names.

## What good looks like

Type "aadhar" and the card is the first result. Type "beach" and you get
beaches, not photos with the word beach in them. Type "receipts from march" and
the date filter and the document tag combine. Search returns in under 200ms on a
40,000 image library.
