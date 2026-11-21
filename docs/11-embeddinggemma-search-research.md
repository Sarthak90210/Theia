# Intelligent search with EmbeddingGemma 2

Research notes, 21 Nov 2026. Updates the visual-index choice in
[05-search.md](05-search.md); the rest of that plan (OCR, structured filters,
fusion, background indexing) still stands.

## What EmbeddingGemma 2 is

Google DeepMind's open embedding model, released 6 Oct 2026, with a technical
report on 17 Nov 2026.

| | EmbeddingGemma 1 (Sep 2025) | EmbeddingGemma 2 (Oct 2026) |
|---|---|---|
| Base | Gemma 3 | Gemma 4 |
| Size | 308M | 740M total; text and code path about 270M |
| Inputs | Text only | Text, code, images, video, audio |
| Output | 768 dims, truncatable to 512, 256 or 128 | Same |
| Context | 2K tokens | 8K tokens, shared across modalities |
| Languages | 100+ | 100+ |
| License | Gemma terms | Apache 2.0 |

What matters for Theia:

- **Version 2 can search photos directly.** Images, video frames and text land
  in one 768-dimension space. Embed every photo once, then embed the typed query
  and rank by cosine similarity. Version 1 was text-only and could only have
  searched captions or OCR text, not the pictures themselves.
- **Encoders load separately.** The text encoder alone is enough at query time,
  so the vision encoder only has to be loaded while indexing.
- **Shorter vectors are cheap to keep.** Google says 256 dimensions keep about
  95% of full-size quality for image, video and speech retrieval, and 128 keeps
  about 75%. At 256 dimensions in fp16, 40,000 photos take about 20 MB.
- **It accepts queries in many languages.** Hindi or Hinglish queries are
  plausible for this app, and SigLIP base is trained mostly on English
  captions.
- **Video works natively.** Sampled frames (about 1 fps) go in as one input,
  so a video gets one embedding instead of being searchable only by its first
  frame.
- **Memory:** Google reports about 567 MB of active RAM for the full
  multimodal model on a Pixel with quantization, and about 191 MB for the
  text-only path.

### Quality

- Google's model card gives MIEB-lite 65.67 and MMEB v2 image Hit@1 57.28, but
  no side-by-side rows against CLIP or SigLIP.
- One unofficial benchmark repo has EmbeddingGemma 2 ahead of SigLIP 2
  Base/16-224 on XM3600 English retrieval (about 62/84/90 against 52/77/84,
  probably R@1/5/10). Treat this as a lead, not a result.
- One third-party write-up says English text scores fell slightly compared with
  version 1. That doesn't matter much here: photo search is text-to-image
  retrieval.

## How the industry does photo search

Every serious product layers several indexes. None relies on embeddings
alone.

**Google Photos.** It runs ML labels for objects, places and faces, OCR, and
metadata search. Ask Photos adds a Gemini agent on top: the agent reads the
conversational query and picks a retrieval tool. A vector retrieval system
extends the existing metadata search. A Gemini answer model then reads the
returned photos with their dates and places and writes the reply. Google hasn't
published which embedding model or index it uses.

**Apple Photos.** Everything is on-device. Scene classification, Live Text
OCR and face recognition go into an index built separately on each device,
which can take a long time on a big library. Natural-language search ("Maya
skateboarding in a tie-dye shirt") arrived with Apple Intelligence in iOS 18.1
and covers videos too. Apple hasn't published the model.

**Immich (self-hosted).** Smart search uses CLIP-family models in a separate
ML service. Their docs rank SigLIP 2 variants highest for recall. Embeddings
live in Postgres (VectorChord, formerly pgvecto.rs) and are ranked by cosine
distance. OCR, faces and smart search are separate background jobs, each with
its own queue.

**Ente (end-to-end encrypted).** "Magic Search" runs Apple's MobileCLIP on the
device. Ente shrank the text encoder about 70% by quantizing it without
noticeable quality loss. The index is stored encrypted and searched locally.

**What they share:**

1. **Several indexes:** visual embeddings, OCR text, faces/people, and
   structured metadata (date, place, camera, kind).
2. **Query parsing first.** Dates, places and people become hard filters
   before any vector ranking runs. "Goa last December" should never depend on
   the embedding model understanding dates.
3. **Merging rankings without calibration.** Reciprocal rank fusion
   (`Σ 1/(60 + rank)`) is the common choice, because cosine and BM25 scores
   aren't comparable.
4. **Background indexing** that is resumable, does recent photos first, and
   records which model version produced each result, so swapping models later
   means re-running one stage.
5. **An LLM only on top, and optional** (Google's Ask Photos). Retrieval itself
   uses small fixed models.

Brute-force cosine is fine for personal libraries. Apple's MicroNN paper and the
sqlite-vec examples show that pre-filtering on metadata then scanning vectors
gets full recall when filters are selective. Approximate indexes such as HNSW
only pay off past a few hundred thousand items.

## What this changes in Theia's plan

**Replace SigLIP with EmbeddingGemma 2** as the visual index in 05-search.md,
pending the benchmark below. Gains: multilingual queries, native video, one
model family for images and text, and Apache 2.0. Cost: a heavier model.

**Keep OCR.** An embedding can match "a photo of an ID card", but it can't
reliably find a specific number or a misspelled word printed on that card. That
still needs OCR plus FTS5 with trigram matching. EmbeddingGemma 2 can also
replace the "does this photo contain text?" check that decides which photos get
OCR, as a zero-shot comparison against prompts like "a document" or "a
screenshot".

**Keep the rest of 05-search.md:** structured parsing, RRF fusion, and
`sqlite-vec` storage, now at 256 dimensions instead of 768.

**Schema fit.** `index_state (asset_id, stage, model_ver)` already exists.
Add an embedding table keyed by asset, with the model version in it, so
changing the model or the vector size means re-embedding, never migrating.

## Open questions to settle with a spike

Each of these could change the plan, so test before building the feature.

1. **Does it run in Electron?** The official path is Python
   (sentence-transformers 6.1+, transformers with `embedding_gemma2`). For
   Node, `onnx-community/embeddinggemma-2-ONNX` has separate text and vision
   encoder graphs:
   - The int8 vision encoder is about 195 MB, and its graph and `_data` file
     must sit side by side.
   - The q4 graphs use `com.microsoft.GatherBlockQuantized`, which the WASM
     runtime lacks. Check whether `onnxruntime-node` with DirectML supports it.
   - No official multimodal Transformers.js example has been published.
2. **Image preprocessing:** input resolution and token budget. The default is
   about 280 vision tokens per image; read `preprocessor_config.json`.
3. **Prompts:** queries and documents probably take different task prefixes.
   One secondary source names `SearchQuery` and `Document`; confirm in
   `config_sentence_transformers.json`.
4. **Speed on this laptop.** Image cost is the vision tower plus the Gemma
   decoder over the image tokens, which is heavier than SigLIP base's single
   tower. Measure photos per second on the iGPU with DirectML against the
   05-search.md budget of about 25–50 photos per second.
5. **Quality on this library.** Take 50 real queries over your own photos,
   including "aadhar", "beach", "receipts from march" and some Hindi, and
   compare EmbeddingGemma 2 with SigLIP 2 at 256 and 768 dimensions.

## Sources

- Google, [EmbeddingGemma 2 announcement](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) and [technical report overview](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2-technical-report/)
- Google, [EmbeddingGemma docs](https://ai.google.dev/gemma/docs/embeddinggemma) and [EmbeddingGemma 2 model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)
- Google Developers Blog, [EmbeddingGemma 2: the developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/)
- Hugging Face, [google/embeddinggemma-2](https://huggingface.co/google/embeddinggemma-2), [Transformers docs](https://huggingface.co/docs/transformers/en/model_doc/embedding_gemma2), [onnx-community ONNX build](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), [int8 ONNX mirror](https://huggingface.co/WC-ECL/embeddinggemma-2-onnx-int8), [WASM fork notes](https://huggingface.co/sjenit/embeddinggemma-2-ONNX-wasm)
- MarkTechPost, [EmbeddingGemma 2 release coverage](https://www.marktechpost.com/2026/10/06/google-deepmind-releases-embeddinggemma-2-a-740m-open-multimodal-embedding-model-built-on-gemma-4/)
- [vision-language-benchmarks](https://github.com/kotadymo/vision-language-benchmarks) (unofficial EmbeddingGemma 2 vs SigLIP 2)
- 9to5Google, [How Ask Photos works](https://9to5google.com/2024/05/25/google-photos-ask-photos-works/); Google, [Ask Photos](https://blog.google/products-and-platforms/products/photos/ask-photos-google-io-2024/)
- Apple, [Apple Intelligence availability](https://www.apple.com/newsroom/2024/10/apple-intelligence-is-available-today-on-iphone-ipad-and-mac/); 9to5Mac, [iOS 18.1 Photos search](https://9to5mac.com/2024/09/25/photos-search-in-ios-181-actually-works-thanks-to-apple-intelligence/)
- Immich, [Searching](https://docs.immich.app/features/searching/)
- Ente, [Machine learning](https://ente.com/ml/), [Magic search](https://ente.com/help/photos/features/search-and-discovery/magic-search)
- Apple, [MicroNN on-device vector database](https://arxiv.org/pdf/2504.05573); Simon Willison, [Hybrid search with SQLite](https://simonwillison.net/2024/Oct/4/hybrid-full-text-search-and-vector-search-with-sqlite/)
