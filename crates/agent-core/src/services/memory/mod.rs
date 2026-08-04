use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Timelike, Utc};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MEMORY_DIR_NAME: &str = ".liveagent";
const MEMORY_ROOT_DIR: &str = "memory";
const DB_FILENAME: &str = "memory-index.sqlite3";
const MAX_BODY_BYTES: usize = 8 * 1024;
const MAX_DAILY_BODY_BYTES: usize = 32 * 1024;
const DAILY_NEAR_LIMIT_BYTES: usize = 28 * 1024;
const MAX_SCOPE_ENTRIES: usize = 500;
const MAX_DESCRIPTION_CHARS: usize = 120;
const MAX_SEARCH_LIMIT: usize = 32;
const DEFAULT_SEARCH_LIMIT: usize = 8;
const DEFAULT_ROLLOVER_HOUR: u32 = 4;
const DEFAULT_DAILY_RETENTION_DAYS: i64 = 90;
const RECENT_DAYS_LIMIT: usize = 3;
const MEMORY_SCORE_WEIGHT_PROJECT: f64 = 1.4;
const MEMORY_SCORE_WEIGHT_USER: f64 = 1.3;
const MEMORY_SCORE_WEIGHT_FEEDBACK: f64 = 1.25;
const MEMORY_SCORE_WEIGHT_REFERENCE: f64 = 1.0;
const MEMORY_SCORE_WEIGHT_DAILY: f64 = 0.35;
const MEMORY_CONFIDENCE_UNKNOWN: &str = "unknown";
const ORGANIZE_RUN_STALE_AFTER_MS: i64 = 6 * 60 * 60 * 1000;
const ORGANIZE_RUN_STALE_SUMMARY: &str = "上一次记忆整理长时间未完成，已自动标记为失败。";

const MEMORY_SCHEMA_DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_meta (
    scope         TEXT    NOT NULL CHECK (scope IN ('global', 'project')),
    workdir_hash  TEXT    NOT NULL DEFAULT '',
    slug          TEXT    NOT NULL,
    type          TEXT    NOT NULL
                  CHECK (type IN ('user', 'feedback', 'project', 'reference', 'daily')),
    description   TEXT    NOT NULL DEFAULT '',
    headline      TEXT    NOT NULL DEFAULT '',
    date_local    TEXT,
    age_anchor    INTEGER,
    append_count  INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    body_hash     TEXT    NOT NULL,
    file_mtime    INTEGER NOT NULL,
    file_size     INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    source_json   TEXT,
    links_json    TEXT,
    PRIMARY KEY (scope, workdir_hash, slug),
    CHECK (
        (type != 'daily') OR
        (date_local IS NOT NULL AND age_anchor IS NOT NULL AND scope = 'global')
    )
);

CREATE INDEX IF NOT EXISTS idx_memory_meta_workdir
    ON memory_meta(scope, workdir_hash, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_meta_type
    ON memory_meta(scope, workdir_hash, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_meta_daily
    ON memory_meta(type, archived, date_local DESC)
    WHERE type = 'daily';

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    slug          UNINDEXED,
    scope         UNINDEXED,
    workdir_hash  UNINDEXED,
    type,
    description,
    headline,
    body,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tri USING fts5(
    slug          UNINDEXED,
    scope         UNINDEXED,
    workdir_hash  UNINDEXED,
    description,
    headline,
    body,
    tokenize = "trigram"
);

CREATE TABLE IF NOT EXISTS memory_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    op              TEXT    NOT NULL CHECK (op IN ('write','update','delete','restore','batch','accept','wipe','reconcile')),
    scope           TEXT    NOT NULL,
    workdir_hash    TEXT    NOT NULL DEFAULT '',
    slug            TEXT    NOT NULL,
    actor           TEXT    NOT NULL CHECK (actor IN ('user','tool','extractor','reconcile')),
    conversation_id TEXT,
    trigger         TEXT,
    model           TEXT,
    detail_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_recent
    ON memory_audit_log(ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_slug
    ON memory_audit_log(scope, workdir_hash, slug, ts DESC);

CREATE TABLE IF NOT EXISTS memory_organize_runs (
    run_id                TEXT PRIMARY KEY,
    trigger               TEXT    NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    status                TEXT    NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    created_at            INTEGER NOT NULL,
    started_at            INTEGER,
    finished_at           INTEGER,
    due_at                INTEGER,
    claimed_at            INTEGER,
    model_json            TEXT,
    scope                 TEXT    NOT NULL DEFAULT 'all',
    mode                  TEXT    NOT NULL DEFAULT 'standard',
    input_count           INTEGER NOT NULL DEFAULT 0,
    cluster_count         INTEGER NOT NULL DEFAULT 0,
    safe_applied          INTEGER NOT NULL DEFAULT 0,
    review_skipped        INTEGER NOT NULL DEFAULT 0,
    created_count         INTEGER NOT NULL DEFAULT 0,
    updated_count         INTEGER NOT NULL DEFAULT 0,
    deleted_count         INTEGER NOT NULL DEFAULT 0,
    merged_count          INTEGER NOT NULL DEFAULT 0,
    parse_failures        INTEGER NOT NULL DEFAULT 0,
    error                 TEXT,
    final_summary         TEXT,
    trimmed_protocol_json TEXT    NOT NULL DEFAULT '{}',
    phase                 TEXT,
    final_count           INTEGER NOT NULL DEFAULT 0,
    compression_ratio     REAL,
    compression_target    INTEGER,
    dry_run               INTEGER NOT NULL DEFAULT 0,
    token_usage_total     INTEGER NOT NULL DEFAULT 0,
    quota_headroom_at_start INTEGER,
    override_reviewed     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_organize_runs_recent
    ON memory_organize_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_organize_runs_status
    ON memory_organize_runs(status, created_at ASC);

CREATE TABLE IF NOT EXISTS memory_schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO memory_schema_version (version, applied_at)
VALUES (4, strftime('%s','now') * 1000);
"#;

include!("types.rs");
include!("store.rs");
include!("mutations/mod.rs");
include!("organize.rs");
include!("daily.rs");
include!("maintenance.rs");
include!("paths.rs");
include!("content.rs");
include!("schema.rs");
include!("search.rs");
include!("tests.rs");
