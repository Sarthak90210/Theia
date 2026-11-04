# Data model

SQLite, WAL mode, one writer in the main process. `better-sqlite3`.

Schema version in `user_version`, migrations applied on open in a transaction.

## Core

```sql
-- One thing the user captured.
CREATE TABLE asset (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,      -- still | live | video | burst
  content_id        TEXT,               -- Apple ContentIdentifier, Live Photo pairing
  burst_id          TEXT,
  is_burst_pick     INTEGER NOT NULL DEFAULT 0,

  captured_utc      INTEGER,            -- unix seconds
  captured_offset   INTEGER,            -- seconds east of UTC
  offset_inferred   INTEGER NOT NULL DEFAULT 0,
  time_source       TEXT,               -- exif | quicktime | filesystem

  lat               REAL,
  lon               REAL,
  altitude          REAL,
  place_id          INTEGER REFERENCES place(id),

  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,

  favourite         INTEGER NOT NULL DEFAULT 0,
  hidden            INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,            -- soft delete, purged after 30 days

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_asset_time    ON asset(captured_utc DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_asset_content ON asset(content_id) WHERE content_id IS NOT NULL;
CREATE INDEX idx_asset_burst   ON asset(burst_id)   WHERE burst_id IS NOT NULL;
CREATE INDEX idx_asset_geo     ON asset(lat, lon)   WHERE lat IS NOT NULL;

-- One file on disk. An asset has one or more.
CREATE TABLE file (
  id            INTEGER PRIMARY KEY,
  asset_id      INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,          -- master | edited | motion | aae
  is_primary    INTEGER NOT NULL DEFAULT 0,

  path          TEXT NOT NULL UNIQUE,   -- relative to library root
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  mime          TEXT NOT NULL,

  verified_at   INTEGER,
  verify_level  INTEGER NOT NULL DEFAULT 0,   -- highest level passed, 0..3

  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_file_asset  ON file(asset_id);
CREATE INDEX idx_file_sha    ON file(sha256);
```

`sha256` is indexed but not unique. Identical bytes can legitimately appear
twice, for example a photo you were sent and also took. Deduplication is a
decision the user makes, not one the schema enforces.

## Import tracking

The state machine that makes resume work.

```sql
CREATE TABLE device (
  udid          TEXT PRIMARY KEY,
  name          TEXT,
  product_type  TEXT,
  os_version    TEXT,
  last_seen     INTEGER
);

CREATE TABLE import_run (
  id            INTEGER PRIMARY KEY,
  device_udid   TEXT REFERENCES device(udid),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL           -- running | done | aborted
);

CREATE TABLE import_item (
  id              INTEGER PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES import_run(id),
  device_udid     TEXT NOT NULL,
  device_path     TEXT NOT NULL,
  device_size     INTEGER NOT NULL,
  device_mtime    INTEGER NOT NULL,

  stage           TEXT NOT NULL,        -- planned | fetching | verifying | committed | quarantined | skipped
  bytes_received  INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,

  file_id         INTEGER REFERENCES file(id),
  fail_level      INTEGER,              -- 0..3, which verify level failed
  fail_detail     TEXT,                 -- human readable, shown in the report

  UNIQUE(device_udid, device_path, device_mtime, device_size)
);

CREATE INDEX idx_item_stage ON import_item(run_id, stage);
```

`bytes_received` is what makes a resumed fetch a `FILE_SEEK` rather than a
restart. The unique constraint is what makes a second import of the same phone
skip the 39,000 photos it already has.

## Metadata

```sql
CREATE TABLE exif (
  file_id   INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
  raw       BLOB NOT NULL,              -- full exiftool JSON, zstd compressed
  make      TEXT,
  model     TEXT,
  lens      TEXT,
  iso       INTEGER,
  f_number  REAL,
  exposure  REAL,
  focal_mm  REAL
);

CREATE TABLE aae (
  asset_id  INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  plist     BLOB NOT NULL
);

CREATE TABLE place (
  id        INTEGER PRIMARY KEY,
  country   TEXT,
  region    TEXT,
  city      TEXT,
  label     TEXT NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL
);
```

Keeping the raw exiftool output is worth the disk. Normalization is where the
bugs are, and without the raw blob every fix means re-reading 40,000 files.

## Search

```sql
-- Which index stages have run for which asset.
CREATE TABLE index_state (
  asset_id    INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,            -- thumb | embed | ocr_gate | ocr | faces
  model_ver   TEXT NOT NULL,
  done_at     INTEGER NOT NULL,
  PRIMARY KEY (asset_id, stage)
);

-- OCR output, one row per asset.
CREATE TABLE ocr (
  asset_id  INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  lines     BLOB NOT NULL               -- JSON: [{text, box, conf}]
);

CREATE VIRTUAL TABLE ocr_fts USING fts5(
  text,
  content='ocr', content_rowid='asset_id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE ocr_tri USING fts5(
  text,
  content='ocr', content_rowid='asset_id',
  tokenize='trigram'
);

-- Zero-shot concept tags.
CREATE TABLE tag (
  asset_id  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,
  score     REAL NOT NULL,
  PRIMARY KEY (asset_id, label)
);
CREATE INDEX idx_tag_label ON tag(label, score DESC);

-- Image embeddings. sqlite-vec.
CREATE VIRTUAL TABLE embedding USING vec0(
  asset_id  INTEGER PRIMARY KEY,
  vec       FLOAT[768]
);
```

`index_state` carries the model version. Swapping SigLIP for something better
later means deleting rows where `model_ver` is old and letting the background
indexer refill them. No migration, no rebuild.

`ocr_fts` and `ocr_tri` are external content tables over `ocr`, so the text is
stored once. Keep them in sync with triggers on `ocr`.

## Faces, reserved

```sql
CREATE TABLE face (
  id          INTEGER PRIMARY KEY,
  asset_id    INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  box         BLOB NOT NULL,
  cluster_id  INTEGER REFERENCES person(id),
  confirmed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE person (
  id    INTEGER PRIMARY KEY,
  name  TEXT,
  cover_face_id INTEGER
);

CREATE VIRTUAL TABLE face_embedding USING vec0(
  face_id INTEGER PRIMARY KEY,
  vec     FLOAT[512]
);
```

Unused in v1 and v2. Present so the schema version does not have to change when
faces land.

## Sizing

For 40,000 assets: roughly 60MB of embeddings at fp16, 40MB of OCR text and
indexes, 25MB of raw EXIF compressed, and a few MB for everything else. Under
150MB of database against maybe 200GB of media. Thumbnails live on disk in a
content-addressed cache, not in SQLite.
