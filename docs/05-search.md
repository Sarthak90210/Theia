# Search

Not in v1, specced now because it constrains the schema and you do not want to
migrate a 40,000 row library later.

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

## Three indexes

### 1. Text, from OCR

Model: PP-OCRv4, detection and recognition, ONNX, run under `onnxruntime-node`
with the DirectML execution provider. English plus Devanagari recognition, which
matters for Indian documents where the same card carries both scripts.

The Windows built-in `Windows.Media.Ocr` is an alternative. It is free, fast,
ships with the OS, and uses whatever language packs are installed. It is also
only reachable from Electron through a native addon, and it is weaker on
rotated or low-contrast text. Worth benchmarking against PaddleOCR on your own
documents before committing.

Store per-image: the full extracted text, and per-line text with bounding boxes
so results can highlight where the match was.

Index with SQLite FTS5. Use two tokenizers on the same content:

- `unicode61 remove_diacritics 2` for normal word matching.
- `trigram` for fuzzy matching.

The trigram index is not optional. The card says "Aadhaar", people type
"aadhar", OCR on a worn card might produce "Aadhaat". Exact token matching
fails all three ways. Trigram matching survives it.

**Do not OCR everything.** OCR is the slowest stage by a wide margin. Gate it
behind a text-presence signal: a zero-shot pass with the image embedding model
against "a photo containing printed text" and similar prompts, or a cheap
edge-density heuristic. On a normal camera roll this skips most images and cuts
OCR time by roughly 80%.

### 2. Visual, from image-text embeddings

Model: SigLIP base, patch16, 224px. Two ONNX graphs, an image encoder and a text
encoder, sharing an embedding space. Roughly 200MB at fp16 for both.

OpenCLIP ViT-B/32 is the alternative and is a little weaker at retrieval for
about the same cost. SigLIP's sigmoid loss gives better behaviour on short
queries, which is what people actually type.

Embed every image at import. Embed the query text at search time, which takes a
few milliseconds. Rank by cosine similarity.

Also run a zero-shot pass at index time against a fixed vocabulary of about
1,000 concepts: "document", "receipt", "screenshot", "identity card", "beach",
"dog", "whiteboard", and so on. Store anything above threshold as a tag. This
gives the user browsable categories without a separate classifier, and it is
roughly what Apple's scene classification produces.

Storage: `sqlite-vec`, `vec0` virtual table, fp16. Brute force cosine over
40,000 vectors of 768 dimensions is about 60MB scanned per query and lands
under 50ms, which is fine. Past roughly 200,000 images, move to `usearch` or
`hnswlib` with an HNSW index. Design the query layer so that swap is one module.

### 3. Structured

Plain SQL over the columns you already have. Date and range, place from reverse
geocoding the GPS against an offline dataset, camera and lens, media type,
favourite, album, and later face cluster.

Parse these out of the query string before the other two indexes see it.
"photos from goa last december" should resolve the place and the date range
itself rather than hoping the embedding model understands either.

## Fusion

Each index returns a ranked candidate list. Merge with reciprocal rank fusion:

```
score(doc) = Σ over indexes  weight_i / (60 + rank_i(doc))
```

RRF works well without per-index score calibration, which matters because
cosine similarity and BM25 are not on comparable scales.

Weights shift by query shape:

- Query tokens have high IDF in the OCR vocabulary, or look like a proper noun
  or document word. Weight text.
- Query reads like a scene description. Weight visual.
- Query contains a resolved date, place, or camera. Structured filters become a
  hard filter rather than a ranking signal.

Keep the router simple and rule-based. A learned router is a lot of machinery
for a gain you will not measure on a personal library.

## Indexing budget

Rough throughput on a laptop iGPU under DirectML:

| Stage | Images per second | 40,000 images |
|---|---|---|
| Thumbnail and decode | 40 to 80 | 10 to 17 min |
| SigLIP embedding | 25 to 50 | 13 to 27 min |
| OCR, gated to ~20% of images | 8 to 15 | 9 to 17 min |

Call it an hour for a large first index, less on a discrete GPU. That is
acceptable if and only if it runs in the background, survives a restart, and
processes recent photos first so search becomes useful immediately rather than
after it finishes.

Every stage records its completion per image, so adding a model later means
re-running one stage over the library, not rebuilding from scratch.

## Faces

Deferred to v3. SCRFD for detection, ArcFace for embedding, HDBSCAN for
clustering, and a UI for naming clusters. The schema reserves space for it.

## What good looks like

Type "aadhar" and the card is the first result. Type "beach" and you get
beaches, not photos with the word beach in them. Type "receipts from march" and
the date filter and the document tag combine. Search returns in under 200ms on a
40,000 image library.
