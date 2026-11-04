/**
 * Schema migrations, applied in order against `user_version`.
 *
 * The reserved search and face tables are created up front so that adding
 * those features later is not a migration. The vector tables are the one
 * exception: `vec0` needs the sqlite-vec extension loaded, so they arrive with
 * that dependency rather than now.
 */

export const MIGRATIONS: string[] = [
  /* ---------------------------------------------------------------- v1 */ `
  -- One thing the user captured. May be backed by several files.
  CREATE TABLE asset (
    id                INTEGER PRIMARY KEY,
    kind              TEXT NOT NULL,
    content_id        TEXT,
    burst_id          TEXT,
    is_burst_pick     INTEGER NOT NULL DEFAULT 0,
    has_adjustments   INTEGER NOT NULL DEFAULT 0,

    captured_utc      INTEGER,
    captured_offset   INTEGER,
    offset_inferred   INTEGER NOT NULL DEFAULT 0,
    time_source       TEXT,

    lat               REAL,
    lon               REAL,
    altitude          REAL,
    place_id          INTEGER REFERENCES place(id),

    width             INTEGER,
    height            INTEGER,
    duration_ms       INTEGER,

    favourite         INTEGER NOT NULL DEFAULT 0,
    hidden            INTEGER NOT NULL DEFAULT 0,
    deleted_at        INTEGER,

    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX idx_asset_time    ON asset(captured_utc DESC) WHERE deleted_at IS NULL;
  CREATE INDEX idx_asset_content ON asset(content_id) WHERE content_id IS NOT NULL;
  CREATE INDEX idx_asset_burst   ON asset(burst_id)   WHERE burst_id IS NOT NULL;
  CREATE INDEX idx_asset_geo     ON asset(lat, lon)   WHERE lat IS NOT NULL;

  -- One file on disk.
  CREATE TABLE file (
    id            INTEGER PRIMARY KEY,
    asset_id      INTEGER REFERENCES asset(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    is_primary    INTEGER NOT NULL DEFAULT 0,

    path          TEXT NOT NULL UNIQUE,
    bytes         INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    mime          TEXT NOT NULL,

    verified_at   INTEGER,
    verify_level  INTEGER NOT NULL DEFAULT 0,

    created_at    INTEGER NOT NULL
  );

  CREATE INDEX idx_file_asset ON file(asset_id);
  -- Not unique: identical bytes can legitimately appear twice, and whether to
  -- deduplicate is the user's decision rather than the schema's.
  CREATE INDEX idx_file_sha   ON file(sha256);

  CREATE TABLE place (
    id        INTEGER PRIMARY KEY,
    country   TEXT,
    region    TEXT,
    city      TEXT,
    label     TEXT NOT NULL,
    lat       REAL NOT NULL,
    lon       REAL NOT NULL
  );

  CREATE TABLE exif (
    file_id   INTEGER PRIMARY KEY REFERENCES file(id) ON DELETE CASCADE,
    raw       BLOB NOT NULL,
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
    plist     BLOB NOT NULL,
    editor    TEXT
  );

  -- ------------------------------------------------------------ devices

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
    library_root  TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    status        TEXT NOT NULL
  );

  -- The state machine. One row per file, carrying enough to resume from a
  -- crash, a cancel, or an unplugged cable through the same code path.
  CREATE TABLE import_item (
    id              INTEGER PRIMARY KEY,
    run_id          INTEGER NOT NULL REFERENCES import_run(id),
    device_udid     TEXT NOT NULL,
    device_path     TEXT NOT NULL,
    device_size     INTEGER NOT NULL,
    device_mtime    INTEGER NOT NULL,

    stage           TEXT NOT NULL,
    bytes_received  INTEGER NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,

    staging_path    TEXT,
    sha256          TEXT,
    file_id         INTEGER REFERENCES file(id),
    fail_level      INTEGER,
    fail_detail     TEXT,

    updated_at      INTEGER NOT NULL,

    UNIQUE(device_udid, device_path, device_mtime, device_size)
  );

  CREATE INDEX idx_item_stage ON import_item(run_id, stage);
  CREATE INDEX idx_item_open  ON import_item(stage) WHERE stage NOT IN ('committed','skipped','quarantined');

  -- -------------------------------------------------- reserved for search

  CREATE TABLE index_state (
    asset_id    INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    stage       TEXT NOT NULL,
    model_ver   TEXT NOT NULL,
    done_at     INTEGER NOT NULL,
    PRIMARY KEY (asset_id, stage)
  );

  CREATE TABLE ocr (
    asset_id  INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
    text      TEXT NOT NULL,
    lines     BLOB NOT NULL
  );

  CREATE TABLE tag (
    asset_id  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    label     TEXT NOT NULL,
    score     REAL NOT NULL,
    PRIMARY KEY (asset_id, label)
  );
  CREATE INDEX idx_tag_label ON tag(label, score DESC);

  CREATE TABLE face (
    id          INTEGER PRIMARY KEY,
    asset_id    INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    box         BLOB NOT NULL,
    cluster_id  INTEGER REFERENCES person(id),
    confirmed   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE person (
    id            INTEGER PRIMARY KEY,
    name          TEXT,
    cover_face_id INTEGER
  );
  `,

  /* ---------------------------------------------------------------- v2 */ `
  -- "inferred" alone does not say inferred how. A GPS-derived offset is exact;
  -- a host-zone assumption is a guess that is wrong for anything shot abroad.
  ALTER TABLE asset ADD COLUMN offset_source TEXT;
  `,

  /* ---------------------------------------------------------------- v3 */ `
  -- A file the user chose to keep despite failing verification. A JPEG missing
  -- its end marker still shows most of the image, and that can beat nothing;
  -- what it must not do is sit in the library pretending to be intact.
  ALTER TABLE file ADD COLUMN accepted_unverified INTEGER NOT NULL DEFAULT 0;
  `,

  /* ---------------------------------------------------------------- v4 */ `
  -- transient, permanent or fatal. Says whether retrying the file is worth it.
  ALTER TABLE import_item ADD COLUMN fail_class TEXT;

  -- Every failed attempt, kept so a run can report which kinds of failure
  -- retries actually recover. Retry policy gets tuned from this, not by guess.
  CREATE TABLE import_attempt (
    id        INTEGER PRIMARY KEY,
    item_id   INTEGER NOT NULL REFERENCES import_item(id),
    run_id    INTEGER NOT NULL REFERENCES import_run(id),
    attempt   INTEGER NOT NULL,
    class     TEXT NOT NULL,
    detail    TEXT NOT NULL,
    at        INTEGER NOT NULL
  );
  CREATE INDEX idx_attempt_run ON import_attempt(run_id, class);
  `,

  /* ---------------------------------------------------------------- v5 */ `
  -- What a run report needs that the item rows cannot reconstruct. Skips are
  -- counted at plan time and never written as a stage, and the reason a run
  -- stopped exists only in the exception that stopped it.
  ALTER TABLE import_run ADD COLUMN files_skipped INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE import_run ADD COLUMN stop_reason TEXT;
  ALTER TABLE import_run ADD COLUMN report_path TEXT;
  `,

  /* ---------------------------------------------------------------- v6 */ `
  -- Time the run was actually working, summed over every session. A run that
  -- stops in September and resumes in November did not take two months.
  ALTER TABLE import_run ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE import_run ADD COLUMN sessions  INTEGER NOT NULL DEFAULT 0;

  -- "gone" is terminal too: deleted from the phone before it was imported.
  DROP INDEX idx_item_open;
  CREATE INDEX idx_item_open ON import_item(stage)
    WHERE stage NOT IN ('committed','skipped','quarantined','gone');
  `,

  /* ---------------------------------------------------------------- v7 */ `
  -- Background work after import: thumbnails now, decode checks and search
  -- indexing later. One row per kind of work per asset, so the queue survives a
  -- crash the same way import does. Immich runs one queue per job type with its
  -- own concurrency; the kind column is that split.
  --
  -- state: queued, running, done, failed. A running job at startup was
  -- interrupted and goes back to queued.
  CREATE TABLE job (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL,
    asset_id    INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    state       TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    not_before  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(kind, asset_id)
  );
  CREATE INDEX idx_job_ready ON job(kind, state, not_before);
  `,

  /* ---------------------------------------------------------------- v8 */ `
  -- Level 3: the file decodes, not just parses. verify_level becomes 3 and
  -- verified_at moves forward when it passes. When it fails, the reason goes
  -- here and the level stays where import left it. A format with no decoder
  -- leaves both alone, because "could not check" is not "damaged".
  ALTER TABLE file ADD COLUMN decode_error TEXT;
  `,

  /* ---------------------------------------------------------------- v9 */ `
  -- The optional second copy made during import, at the same relative path
  -- under a second root. Verified by reading it back against the import hash.
  -- A failed second copy never undoes the import: the original is fine, and
  -- the error says what to redo.
  ALTER TABLE file ADD COLUMN mirror_verified_at INTEGER;
  ALTER TABLE file ADD COLUMN mirror_error TEXT;
  `,

  /* --------------------------------------------------------------- v10 */ `
  -- Albums, in the order the source had them. A vault keeps the phone's
  -- albums so it browses the way the phone did.
  CREATE TABLE album (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    -- The phone's identifier for the album, so saving the same album again
    -- adds to it instead of making a second one.
    source_uuid TEXT UNIQUE,
    position    INTEGER NOT NULL DEFAULT 0,
    -- Folder under the vault root that holds this album's files.
    folder      TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE album_asset (
    album_id  INTEGER NOT NULL REFERENCES album(id) ON DELETE CASCADE,
    asset_id  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (album_id, asset_id)
  );
  CREATE INDEX idx_album_asset ON album_asset(asset_id);

  -- The phone's identifier for the asset (ZASSET.ZUUID). Lets a vault know it
  -- already holds a phone photo before comparing bytes.
  ALTER TABLE asset ADD COLUMN source_uuid TEXT;
  CREATE INDEX idx_asset_source ON asset(source_uuid) WHERE source_uuid IS NOT NULL;

  -- screenshot, selfie, panorama, portrait, slomo, timelapse, screen-recording.
  -- From the phone's own classification when saved from a phone, so the
  -- sidebar collections match what the phone shows.
  ALTER TABLE asset ADD COLUMN subtype TEXT;
  `,
  /* --------------------------------------------------------------- v11 */ `
  CREATE TABLE edit_copy (
    asset_id INTEGER PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES asset(id) ON DELETE SET NULL,
    recipe TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  /* --------------------------------------------------------------- v12 */ `
  -- Hidden and Recently Deleted items are encrypted (src/vault/private.ts).
  -- The file's own path stays, so it can go back exactly where it was;
  -- encrypted_path names its encrypted copy in the vault's private folder.
  ALTER TABLE file ADD COLUMN encrypted_path TEXT;
  `,
]
