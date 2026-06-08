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
    trimmed_protocol_json TEXT    NOT NULL DEFAULT '{}'
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
VALUES (3, strftime('%s','now') * 1000);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMeta {
    pub slug: String,
    pub scope: String,
    pub workdir_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir_path: Option<String>,
    pub memory_type: String,
    pub description: String,
    pub headline: String,
    pub date_local: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub append_count: i64,
    pub archived: bool,
    pub unreviewed: bool,
    pub confidence: String,
    pub file_size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListResponse {
    pub entries: Vec<MemoryMeta>,
    pub truncated: bool,
    pub quota: MemoryQuota,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryQuota {
    pub used: usize,
    pub limit: usize,
    pub scope_quotas: Vec<MemoryScopeQuota>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScopeQuota {
    pub scope: String,
    pub workdir_hash: String,
    pub used: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadResponse {
    pub slug: String,
    pub scope: String,
    pub memory_type: String,
    pub description: String,
    pub headline: String,
    pub body: String,
    pub total_lines: usize,
    pub window: MemoryReadWindow,
    pub meta: MemoryReadMeta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadWindow {
    pub offset: usize,
    pub length: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadMeta {
    pub unreviewed: bool,
    pub confidence: String,
    pub source: Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResponse {
    pub matches: Vec<MemorySearchMatch>,
    pub history_matches: Vec<MemoryHistorySearchMatch>,
    pub used_fallback: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchMatch {
    pub slug: String,
    pub scope: String,
    #[serde(skip)]
    pub workdir_hash: String,
    pub memory_type: String,
    pub description: String,
    pub headline: String,
    pub snippet: String,
    pub score: f64,
    pub raw_score: Option<f64>,
    pub age_days: Option<f64>,
    pub unreviewed: bool,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHistorySearchMatch {
    pub source: String,
    pub conversation_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub segment_index: i64,
    pub segment_id: String,
    pub message_index: Option<i64>,
    pub message_id: Option<String>,
    pub role: Option<String>,
    pub snippet: String,
    pub score: f64,
    pub raw_score: Option<f64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMutationResponse {
    pub slug: String,
    pub scope: String,
    pub created: bool,
    pub updated: bool,
    pub deleted: bool,
    pub index_updated: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteProjectResponse {
    pub workdir_hash: String,
    pub deleted_count: usize,
    pub quarantine_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOverviewResponse {
    pub user: Vec<MemoryOverviewEntry>,
    pub project: Vec<MemoryOverviewEntry>,
    pub global: Vec<MemoryOverviewEntry>,
    pub recent_days: Vec<MemoryOverviewEntry>,
    pub root: String,
    pub workdir_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOverviewEntry {
    pub slug: String,
    pub scope: String,
    pub memory_type: String,
    pub description: String,
    pub headline: String,
    pub date_local: Option<String>,
    pub updated_at: i64,
    pub unreviewed: bool,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPathsInfo {
    pub root: String,
    pub is_fresh: bool,
    pub is_in_cloud: bool,
    pub cloud_provider: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecentRejectionsArgs {
    /// Look back this many days from now. Defaults to 7.
    pub since_days: Option<u32>,
    /// Maximum number of entries to return. Defaults to 30.
    pub limit: Option<u32>,
    /// Optional current workdir used to scope project-memory rejections.
    pub workdir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRejectionEntry {
    pub slug: String,
    pub scope: String,
    pub workdir_hash: String,
    pub rejected_at: i64,
    pub actor: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecentRejectionsResponse {
    pub entries: Vec<MemoryRejectionEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBatchResponse {
    pub created: Vec<String>,
    pub updated: Vec<String>,
    pub deleted: Vec<String>,
    pub warnings: Vec<String>,
    pub warning_details: Vec<MemoryBatchWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBatchWarning {
    pub code: String,
    pub message: String,
    pub slug: Option<String>,
    pub op: Option<String>,
    pub group_id: Option<String>,
    pub decision_index: Option<usize>,
    pub details: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRun {
    pub run_id: String,
    pub trigger: String,
    pub status: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub due_at: Option<i64>,
    pub claimed_at: Option<i64>,
    pub model: Value,
    pub scope: String,
    pub mode: String,
    pub input_count: i64,
    pub cluster_count: i64,
    pub safe_applied: i64,
    pub review_skipped: i64,
    pub created_count: i64,
    pub updated_count: i64,
    pub deleted_count: i64,
    pub merged_count: i64,
    pub parse_failures: i64,
    pub error: Option<String>,
    pub final_summary: Option<String>,
    pub trimmed_protocol: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunCreateArgs {
    pub trigger: String,
    pub due_at: Option<i64>,
    pub model: Option<Value>,
    pub scope: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunCreateResponse {
    pub run: Option<MemoryOrganizeRun>,
    pub accepted: bool,
    pub already_running: bool,
    pub active_run: Option<MemoryOrganizeRun>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunUpdateArgs {
    pub run_id: String,
    pub status: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub input_count: Option<i64>,
    pub cluster_count: Option<i64>,
    pub safe_applied: Option<i64>,
    pub review_skipped: Option<i64>,
    pub created_count: Option<i64>,
    pub updated_count: Option<i64>,
    pub deleted_count: Option<i64>,
    pub merged_count: Option<i64>,
    pub parse_failures: Option<i64>,
    pub error: Option<String>,
    pub final_summary: Option<String>,
    pub trimmed_protocol: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunListArgs {
    pub status: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunListResponse {
    pub runs: Vec<MemoryOrganizeRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunClearHistoryResponse {
    pub deleted_count: i64,
    pub retained_active_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeRunReadArgs {
    pub run_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeDueClaimArgs {
    pub enabled: Option<bool>,
    pub due_at: Option<i64>,
    pub now: Option<i64>,
    pub model: Option<Value>,
    pub scope: Option<String>,
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOrganizeDueClaimResponse {
    pub run: Option<MemoryOrganizeRun>,
    pub skipped_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListArgs {
    pub scope: Option<String>,
    pub workdir: Option<String>,
    pub include_all_projects: Option<bool>,
    pub memory_type: Option<String>,
    pub include_daily: Option<bool>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadArgs {
    pub slug: String,
    pub scope: Option<String>,
    pub workdir: Option<String>,
    pub workdir_hash: Option<String>,
    pub offset: Option<usize>,
    pub length: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchArgs {
    pub query: String,
    pub scope: Option<String>,
    pub workdir: Option<String>,
    pub memory_type: Option<String>,
    pub limit: Option<usize>,
    pub include_history: Option<bool>,
    pub history_since: Option<i64>,
    pub history_until: Option<i64>,
    pub history_date_local: Option<String>,
    pub history_time_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteArgs {
    pub slug: String,
    pub scope: String,
    pub workdir: Option<String>,
    pub memory_type: String,
    pub description: String,
    pub body: String,
    pub actor: Option<String>,
    pub conversation_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUpdateArgs {
    pub slug: String,
    pub scope: Option<String>,
    pub workdir: Option<String>,
    pub workdir_hash: Option<String>,
    pub memory_type: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub mode: Option<String>,
    pub actor: Option<String>,
    pub conversation_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteArgs {
    pub slug: String,
    pub scope: String,
    pub workdir: Option<String>,
    pub workdir_hash: Option<String>,
    pub actor: Option<String>,
    pub reason: Option<String>,
    pub conversation_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteProjectArgs {
    pub workdir: String,
    pub actor: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAcceptArgs {
    pub slug: String,
    pub scope: String,
    pub workdir: Option<String>,
    pub workdir_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBatchArgs {
    pub workdir: Option<String>,
    pub conversation_id: Option<String>,
    pub trigger: Option<String>,
    pub model: Option<String>,
    pub local_date: Option<String>,
    pub daily_append: Option<MemoryDailyAppendArgs>,
    pub decisions: Option<Vec<MemoryDecisionArgs>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDailyAppendArgs {
    pub bullet: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDecisionArgs {
    pub op: String,
    pub slug: String,
    pub scope: Option<String>,
    pub workdir_hash: Option<String>,
    pub memory_type: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub reason: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedMemoryFile {
    meta: ParsedFrontmatter,
    body: String,
    path: PathBuf,
    archived: bool,
}

#[derive(Debug, Clone, Default)]
struct ParsedFrontmatter {
    name: String,
    memory_type: String,
    scope: String,
    description: String,
    headline: String,
    date: Option<String>,
    append_count: i64,
    created_at: Option<String>,
    updated_at: Option<String>,
    source_json: Value,
    links_json: Value,
    unreviewed: bool,
}

#[derive(Debug, Clone)]
struct ResolvedEntry {
    meta: MemoryMeta,
    path: PathBuf,
    parsed: ParsedMemoryFile,
}

#[derive(Debug, Clone)]
struct WriteOptions {
    actor: String,
    conversation_id: Option<String>,
    trigger: Option<String>,
    model: Option<String>,
    unreviewed: bool,
    risk_flag: Option<String>,
}

pub struct MemoryStore {
    root: PathBuf,
    db_path: PathBuf,
    conn: Mutex<Connection>,
    mutation_lock: Mutex<()>,
}

impl MemoryStore {
    pub fn open() -> Result<Self, String> {
        let root = memory_root_dir()?;
        ensure_root_dirs(&root)?;
        let db_path = root.join(DB_FILENAME);
        let conn = open_memory_connection(&db_path)?;
        let store = Self {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        store.reconcile()?;
        store.gc_old_wipe_backups()?;
        store.gc_old_organize_snapshots()?;
        Ok(store)
    }

    pub fn list(&self, args: MemoryListArgs) -> Result<MemoryListResponse, String> {
        let workdir_hash = optional_workdir_hash(args.workdir.as_deref())?;
        let include_all_projects = args.include_all_projects.unwrap_or(false);
        let type_filter = args
            .memory_type
            .as_deref()
            .map(normalize_type_filter)
            .transpose()?;
        let include_daily =
            args.include_daily.unwrap_or(false) || type_filter.as_deref() == Some("daily");
        let limit = args.limit.unwrap_or(200).min(1000);
        let offset = args.offset.unwrap_or(0);
        let scope_filter = normalize_scope_filter(args.scope.as_deref())?;
        let conn = self.lock_conn()?;

        let mut rows = load_all_meta(&conn)?;
        self.enrich_project_paths(&mut rows);
        rows.retain(|entry| include_daily || entry.memory_type != "daily");
        if let Some(scope) = scope_filter.as_deref() {
            rows.retain(|entry| entry.scope == scope);
        }
        if let Some(filter) = type_filter {
            rows.retain(|entry| entry.memory_type == filter);
        }
        if !include_all_projects {
            if let Some(hash) = workdir_hash.as_deref() {
                rows.retain(|entry| {
                    entry.scope == "global"
                        || (entry.scope == "project" && entry.workdir_hash == hash)
                });
            } else {
                rows.retain(|entry| entry.scope == "global");
            }
        }
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });

        let truncated = rows.len() > offset.saturating_add(limit);
        rows = rows.into_iter().skip(offset).take(limit).collect();
        let quota = build_list_quota(&conn, workdir_hash.as_deref(), scope_filter.as_deref())?;
        Ok(MemoryListResponse {
            entries: rows,
            truncated,
            quota,
        })
    }

    pub fn read(&self, args: MemoryReadArgs) -> Result<MemoryReadResponse, String> {
        let resolved = self.resolve_entry(
            &args.slug,
            args.scope.as_deref(),
            args.workdir.as_deref(),
            args.workdir_hash.as_deref(),
        )?;
        let body = resolved.parsed.body;
        let lines = body.lines().map(ToString::to_string).collect::<Vec<_>>();
        let total_lines = lines.len();
        let offset = args.offset.unwrap_or(0).min(total_lines);
        let default_len = total_lines.saturating_sub(offset);
        let length = args.length.unwrap_or(default_len).min(default_len);
        let truncated = offset > 0 || offset + length < total_lines;
        let window_body = if total_lines == 0 {
            String::new()
        } else {
            lines[offset..offset + length].join("\n")
        };
        let headline = if resolved.meta.memory_type == "daily" {
            daily_title_for_meta(&resolved.meta.slug, resolved.meta.date_local.as_deref())
        } else {
            resolved.meta.headline.clone()
        };

        Ok(MemoryReadResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            memory_type: resolved.meta.memory_type,
            description: resolved.meta.description,
            headline,
            body: window_body,
            total_lines,
            window: MemoryReadWindow {
                offset,
                length,
                truncated,
            },
            meta: MemoryReadMeta {
                unreviewed: resolved.meta.unreviewed,
                confidence: resolved.meta.confidence,
                source: resolved.parsed.meta.source_json,
                created_at: resolved.meta.created_at,
                updated_at: resolved.meta.updated_at,
                archived: resolved.meta.archived,
            },
        })
    }

    pub fn search(&self, args: MemorySearchArgs) -> Result<MemorySearchResponse, String> {
        let query = args.query.trim();
        if query.is_empty() {
            return Ok(MemorySearchResponse {
                matches: Vec::new(),
                history_matches: Vec::new(),
                used_fallback: false,
            });
        }
        let workdir_hash = optional_workdir_hash(args.workdir.as_deref())?;
        let scope_filter = normalize_scope_filter(args.scope.as_deref())?;
        let type_filter = args
            .memory_type
            .as_deref()
            .map(normalize_search_type_filter)
            .transpose()?;
        let limit = args
            .limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let conn = self.lock_conn()?;
        let meta_by_key = load_all_meta(&conn)?
            .into_iter()
            .map(|meta| {
                (
                    (
                        meta.scope.clone(),
                        meta.workdir_hash.clone(),
                        meta.slug.clone(),
                    ),
                    meta,
                )
            })
            .collect::<HashMap<_, _>>();

        let mut matches = Vec::new();
        let mut used_fallback = false;
        let terms = expand_memory_search_terms(query);

        for term in &terms {
            let term_matches = search_fts(&conn, term, &meta_by_key, type_filter.as_deref())
                .unwrap_or_else(|_| {
                    used_fallback = true;
                    Vec::new()
                });
            matches.extend(term_matches);
        }
        drop(conn);

        if matches.len() < limit {
            used_fallback = true;
            matches.extend(self.search_by_scanning(
                &meta_by_key,
                &terms,
                type_filter.as_deref(),
            )?);
        }

        matches
            .retain(|entry| scope_matches(entry, scope_filter.as_deref(), workdir_hash.as_deref()));
        matches = dedupe_and_apply_project_shadow(matches);
        matches.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    b.raw_score
                        .partial_cmp(&a.raw_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| b.slug.cmp(&a.slug))
        });
        matches.truncate(limit);

        Ok(MemorySearchResponse {
            matches,
            history_matches: Vec::new(),
            used_fallback,
        })
    }

    pub fn write(&self, args: MemoryWriteArgs) -> Result<MemoryMutationResponse, String> {
        let actor = args.actor.unwrap_or_else(|| "tool".to_string());
        let options = WriteOptions {
            unreviewed: actor == "extractor",
            actor,
            conversation_id: args.conversation_id,
            trigger: None,
            model: args.model,
            risk_flag: None,
        };
        self.write_entry(
            args.slug,
            args.scope,
            args.workdir,
            args.memory_type,
            args.description,
            args.body,
            options,
            false,
        )
    }

    pub fn update(&self, args: MemoryUpdateArgs) -> Result<MemoryMutationResponse, String> {
        self.update_inner(args, None)
    }

    fn update_inner(
        &self,
        args: MemoryUpdateArgs,
        trigger: Option<String>,
    ) -> Result<MemoryMutationResponse, String> {
        if is_daily_slug(&args.slug) {
            let mode = args.mode.as_deref().unwrap_or("replace");
            if mode != "append" {
                return Err(error_json(
                    "append_mode_required",
                    "daily memory must be updated with mode=\"append\"",
                    Some(json!({
                        "action": "update",
                        "slug": args.slug,
                        "mode": "append"
                    })),
                    None,
                ));
            }
            let body = args.body.unwrap_or_default();
            let actor = args.actor.unwrap_or_else(|| "tool".to_string());
            return self.append_daily(
                args.slug,
                body,
                WriteOptions {
                    unreviewed: actor == "extractor",
                    actor,
                    conversation_id: args.conversation_id,
                    trigger,
                    model: args.model,
                    risk_flag: None,
                },
            );
        }

        let default_mode = if args.actor.as_deref() == Some("extractor") {
            "merge"
        } else {
            "replace"
        };
        let mode = args.mode.as_deref().unwrap_or(default_mode);
        if mode == "append" {
            return Err(error_json(
                "invalid_mode",
                "ordinary memory entries do not support mode=\"append\"; use mode=\"replace\" or mode=\"merge\"",
                Some(json!({
                    "action": "update",
                    "slug": args.slug,
                    "mode": "merge"
                })),
                None,
            ));
        }
        if mode != "replace" && mode != "merge" {
            return Err(error_json(
                "invalid_mode",
                "ordinary memory entries only support mode=\"replace\" or mode=\"merge\"",
                Some(json!({
                    "action": "update",
                    "slug": args.slug,
                    "mode": "merge"
                })),
                None,
            ));
        }

        let _mutation_guard = self.lock_mutation()?;
        let resolved = self.resolve_entry(
            &args.slug,
            args.scope.as_deref(),
            args.workdir.as_deref(),
            args.workdir_hash.as_deref(),
        )?;
        let body_arg = args.body.clone();
        let evidence_only_update = body_arg.as_deref().is_some_and(is_evidence_only_body)
            && args.description.is_none()
            && args.memory_type.is_none();
        let memory_type = args
            .memory_type
            .unwrap_or(resolved.meta.memory_type.clone());
        let description = args
            .description
            .unwrap_or(resolved.meta.description.clone());
        let incoming_body = args.body.unwrap_or_else(|| resolved.parsed.body.clone());
        let body = if mode == "merge" {
            merge_memory_body(&resolved.parsed.body, &incoming_body)
        } else {
            incoming_body
        };
        let actor = args.actor.unwrap_or_else(|| "tool".to_string());
        let options = WriteOptions {
            unreviewed: if actor == "extractor" {
                if evidence_only_update {
                    resolved.meta.unreviewed
                } else {
                    true
                }
            } else if actor == "user" {
                false
            } else {
                resolved.meta.unreviewed
            },
            actor,
            conversation_id: args.conversation_id,
            trigger,
            model: args.model,
            risk_flag: None,
        };
        self.replace_existing_entry(resolved, memory_type, description, body, options, mode)
    }

    pub fn delete(&self, args: MemoryDeleteArgs) -> Result<MemoryMutationResponse, String> {
        self.delete_inner(args, None)
    }

    pub fn delete_project(
        &self,
        args: MemoryDeleteProjectArgs,
    ) -> Result<MemoryDeleteProjectResponse, String> {
        let MemoryDeleteProjectArgs {
            workdir,
            actor,
            reason,
        } = args;
        let workdir = workdir.trim().to_string();
        if workdir.is_empty() {
            return Err(error_json(
                "workdir_required",
                "project memory deletion requires a workdir",
                None,
                None,
            ));
        }
        let actor = actor
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let actor = match actor.as_deref() {
            Some(value @ ("user" | "tool" | "extractor" | "reconcile")) => value.to_string(),
            _ => "tool".to_string(),
        };
        let reason = reason
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let _mutation_guard = self.lock_mutation()?;
        let workdir_hash = self.resolve_project_delete_workdir_hash(&workdir)?;
        let deleted_count = self.count_project_memory_entries(&workdir_hash)?;
        let project_dir = self.projects_dir().join(&workdir_hash);
        let quarantine_path = if project_dir.exists() {
            let quarantine_dir = self.root.join(".quarantine");
            fs::create_dir_all(&quarantine_dir)
                .map_err(|e| format!("创建项目记忆隔离目录失败：{e}"))?;
            let ts = now_ms();
            let mut target =
                quarantine_dir.join(format!("deleted-project-{}-{}", workdir_hash, ts));
            let mut suffix = 1;
            while target.exists() {
                target = quarantine_dir.join(format!(
                    "deleted-project-{}-{}-{}",
                    workdir_hash, ts, suffix
                ));
                suffix += 1;
            }
            fs::rename(&project_dir, &target).map_err(|e| format!("隔离项目记忆目录失败：{e}"))?;
            Some(target)
        } else {
            None
        };

        if deleted_count > 0 || quarantine_path.is_some() {
            let mut conn = self.lock_conn()?;
            delete_project_index_rows(
                &mut conn,
                &workdir_hash,
                &workdir,
                deleted_count,
                quarantine_path.as_deref(),
                &actor,
                reason.as_deref(),
            )?;
            drop(conn);
            self.refresh_memory_indexes()?;
        }

        Ok(MemoryDeleteProjectResponse {
            workdir_hash,
            deleted_count,
            quarantine_path: quarantine_path.map(|path| path.to_string_lossy().to_string()),
        })
    }

    fn resolve_project_delete_workdir_hash(&self, workdir: &str) -> Result<String, String> {
        let primary_hash = workdir_hash(workdir)?;
        if self.project_memory_state_exists(&primary_hash)? {
            return Ok(primary_hash);
        }
        Ok(self
            .find_project_workdir_hash_by_marker(workdir)
            .unwrap_or(primary_hash))
    }

    fn project_memory_state_exists(&self, workdir_hash: &str) -> Result<bool, String> {
        if self.projects_dir().join(workdir_hash).exists() {
            return Ok(true);
        }
        Ok(self.count_project_memory_entries(workdir_hash)? > 0)
    }

    fn count_project_memory_entries(&self, workdir_hash: &str) -> Result<usize, String> {
        let conn = self.lock_conn()?;
        let count = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_meta WHERE scope = 'project' AND workdir_hash = ?1",
                params![workdir_hash],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("读取项目记忆数量失败：{e}"))?;
        Ok(count.max(0) as usize)
    }

    fn find_project_workdir_hash_by_marker(&self, workdir: &str) -> Option<String> {
        let projects_dir = self.projects_dir();
        let entries = fs::read_dir(projects_dir).ok()?;
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let hash = entry.file_name().to_string_lossy().to_string();
            if normalize_workdir_hash_input(Some(&hash))
                .ok()
                .flatten()
                .is_none()
            {
                continue;
            }
            let Some(marker_path) = self.project_workdir_path(&hash) else {
                continue;
            };
            if workdir_paths_match(&marker_path, workdir) {
                return Some(hash);
            }
        }
        None
    }

    fn delete_inner(
        &self,
        args: MemoryDeleteArgs,
        trigger: Option<String>,
    ) -> Result<MemoryMutationResponse, String> {
        let MemoryDeleteArgs {
            slug,
            scope,
            workdir,
            workdir_hash,
            actor,
            reason,
            conversation_id,
            model,
        } = args;
        let _mutation_guard = self.lock_mutation()?;
        let resolved = self.resolve_entry(
            &slug,
            Some(&scope),
            workdir.as_deref(),
            workdir_hash.as_deref(),
        )?;
        if resolved.meta.archived {
            return Err(error_json(
                "daily_archived",
                "archived daily memory is read-only",
                None,
                None,
            ));
        }
        if trigger.as_deref() == Some("memory-organize") {
            self.snapshot_entry_before_organize(&resolved.meta, &resolved.path)?;
        }
        let trash_dir = self.trash_dir_for(&resolved.meta)?;
        fs::create_dir_all(&trash_dir).map_err(|e| format!("创建记忆回收站失败：{e}"))?;
        let target = trash_dir.join(format!("{}.{}.md", resolved.meta.slug, now_ms()));
        fs::rename(&resolved.path, &target).map_err(|e| format!("移动记忆到回收站失败：{e}"))?;
        let mut conn = self.lock_conn()?;
        delete_index_rows(
            &mut conn,
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
        )?;
        let actor = actor.unwrap_or_else(|| "tool".to_string());
        let reason = reason
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut detail = json!({ "trashPath": target.to_string_lossy() });
        if let Some(reason) = reason {
            detail["reason"] = Value::String(reason);
        }
        insert_audit_log(
            &mut conn,
            "delete",
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
            &actor,
            conversation_id.as_deref(),
            trigger.as_deref(),
            model.as_deref(),
            detail,
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            created: false,
            updated: false,
            deleted: true,
            index_updated: true,
            warning: None,
        })
    }

    pub fn accept(&self, args: MemoryAcceptArgs) -> Result<MemoryMutationResponse, String> {
        let _mutation_guard = self.lock_mutation()?;
        let resolved = self.resolve_entry(
            &args.slug,
            Some(&args.scope),
            args.workdir.as_deref(),
            args.workdir_hash.as_deref(),
        )?;
        if resolved.meta.memory_type == "daily" {
            return Err(error_json(
                "invalid_type",
                "daily entries cannot be accepted",
                None,
                None,
            ));
        }
        let mut parsed = resolved.parsed;
        parsed.meta.unreviewed = false;
        parsed.meta.source_json = normalize_source_json(
            parsed.meta.source_json,
            false,
            "user",
            None,
            None,
            None,
            None,
        );
        let content = render_memory_markdown(&parsed.meta, &parsed.body);
        self.atomic_replace_entry_file(&resolved.path, &content)?;
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &resolved.path, resolved.meta.archived)?;
        insert_audit_log(
            &mut conn,
            "accept",
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
            "user",
            None,
            None,
            None,
            json!({ "unreviewed": false }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            created: false,
            updated: true,
            deleted: false,
            index_updated: true,
            warning: None,
        })
    }

    pub fn apply_batch(&self, args: MemoryBatchArgs) -> Result<MemoryBatchResponse, String> {
        let mut created = Vec::new();
        let mut updated = Vec::new();
        let mut deleted = Vec::new();
        let mut warnings = Vec::new();
        let mut warning_details = Vec::new();
        let local_date = args
            .local_date
            .clone()
            .unwrap_or_else(|| today_local(DEFAULT_ROLLOVER_HOUR).to_string());
        let options = WriteOptions {
            actor: "extractor".to_string(),
            conversation_id: args.conversation_id.clone(),
            trigger: args.trigger.clone(),
            model: args.model.clone(),
            unreviewed: true,
            risk_flag: None,
        };

        if let Some(daily) = args.daily_append.clone() {
            if !daily.bullet.trim().is_empty() {
                match self.append_daily(
                    format!("daily-{local_date}"),
                    daily.bullet,
                    options.clone(),
                ) {
                    Ok(resp) => {
                        if resp.created {
                            created.push(resp.slug);
                        } else {
                            updated.push(resp.slug);
                        }
                        if let Some(warning) = resp.warning {
                            warnings.push(warning);
                        }
                    }
                    Err(error) => push_batch_warning(
                        &mut warnings,
                        &mut warning_details,
                        error,
                        None,
                        None,
                        "daily_append_failed",
                    ),
                }
            }
        }

        let decisions = args.decisions.clone().unwrap_or_default();
        if args.trigger.as_deref() == Some("memory-organize") {
            let mut groups: HashMap<String, Vec<(usize, MemoryDecisionArgs)>> = HashMap::new();
            for (index, decision) in decisions.iter().cloned().enumerate() {
                if let Some(group_id) = decision
                    .group_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    groups
                        .entry(group_id.to_string())
                        .or_default()
                        .push((index, decision));
                }
            }
            let mut consumed = HashSet::new();
            for (index, decision) in decisions.into_iter().enumerate() {
                if consumed.contains(&index) {
                    continue;
                }
                if let Some(group_id) = decision
                    .group_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    if let Some(group) = groups
                        .get(group_id)
                        .filter(|items| items.len() > 1)
                        .cloned()
                    {
                        for (group_index, _) in &group {
                            consumed.insert(*group_index);
                        }
                        self.apply_batch_group(
                            &args,
                            &options,
                            group,
                            &mut created,
                            &mut updated,
                            &mut deleted,
                            &mut warnings,
                            &mut warning_details,
                        );
                        continue;
                    }
                }
                self.apply_batch_decision(
                    &args,
                    &options,
                    decision,
                    index,
                    &mut created,
                    &mut updated,
                    &mut deleted,
                    &mut warnings,
                    &mut warning_details,
                );
            }
        } else {
            for (index, decision) in decisions.into_iter().enumerate() {
                self.apply_batch_decision(
                    &args,
                    &options,
                    decision,
                    index,
                    &mut created,
                    &mut updated,
                    &mut deleted,
                    &mut warnings,
                    &mut warning_details,
                );
            }
        }

        Ok(MemoryBatchResponse {
            created,
            updated,
            deleted,
            warnings,
            warning_details,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_batch_group(
        &self,
        args: &MemoryBatchArgs,
        options: &WriteOptions,
        group: Vec<(usize, MemoryDecisionArgs)>,
        created: &mut Vec<String>,
        updated: &mut Vec<String>,
        deleted: &mut Vec<String>,
        warnings: &mut Vec<String>,
        warning_details: &mut Vec<MemoryBatchWarning>,
    ) {
        let mut deferred_deletes = Vec::new();
        let mut group_failed = false;
        for (index, decision) in group {
            if decision.op.trim() == "delete" {
                deferred_deletes.push((index, decision));
                continue;
            }
            let ok = self.apply_batch_decision(
                args,
                options,
                decision,
                index,
                created,
                updated,
                deleted,
                warnings,
                warning_details,
            );
            if !ok {
                group_failed = true;
            }
        }
        if group_failed {
            for (index, decision) in deferred_deletes {
                let message = format!(
                    "skipped delete '{}' because its merge group update failed",
                    decision.slug
                );
                push_batch_warning(
                    warnings,
                    warning_details,
                    message,
                    Some(&decision),
                    Some(index),
                    "group_upsert_failed",
                );
            }
            return;
        }
        for (index, decision) in deferred_deletes {
            self.apply_batch_decision(
                args,
                options,
                decision,
                index,
                created,
                updated,
                deleted,
                warnings,
                warning_details,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_batch_decision(
        &self,
        args: &MemoryBatchArgs,
        options: &WriteOptions,
        decision: MemoryDecisionArgs,
        decision_index: usize,
        created: &mut Vec<String>,
        updated: &mut Vec<String>,
        deleted: &mut Vec<String>,
        warnings: &mut Vec<String>,
        warning_details: &mut Vec<MemoryBatchWarning>,
    ) -> bool {
        let op = decision.op.trim();
        let decision_workdir_hash = decision.workdir_hash.clone();
        if op == "delete" {
            let scope = decision
                .scope
                .clone()
                .unwrap_or_else(|| "project".to_string());
            let delete_args = MemoryDeleteArgs {
                slug: decision.slug.clone(),
                scope,
                workdir: args.workdir.clone(),
                workdir_hash: decision_workdir_hash,
                actor: Some("extractor".to_string()),
                reason: decision.reason.clone(),
                conversation_id: args.conversation_id.clone(),
                model: args.model.clone(),
            };
            let result = if args.trigger.as_deref() == Some("memory-organize") {
                self.delete_inner(delete_args, args.trigger.clone())
            } else {
                self.delete(delete_args)
            };
            return match result {
                Ok(resp) => {
                    deleted.push(resp.slug);
                    true
                }
                Err(error) => {
                    push_batch_warning(
                        warnings,
                        warning_details,
                        error,
                        Some(&decision),
                        Some(decision_index),
                        "delete_failed",
                    );
                    false
                }
            };
        }
        if op != "upsert" {
            push_batch_warning(
                warnings,
                warning_details,
                format!("unsupported memory decision op: {op}"),
                Some(&decision),
                Some(decision_index),
                "unsupported_op",
            );
            return false;
        }
        let Some(memory_type) = decision.memory_type.clone() else {
            push_batch_warning(
                warnings,
                warning_details,
                format!("memory decision {} missing memoryType", decision.slug),
                Some(&decision),
                Some(decision_index),
                "missing_memory_type",
            );
            return false;
        };
        let Some(description) = decision.description.clone() else {
            push_batch_warning(
                warnings,
                warning_details,
                format!("memory decision {} missing description", decision.slug),
                Some(&decision),
                Some(decision_index),
                "missing_description",
            );
            return false;
        };
        let Some(body) = decision.body.clone() else {
            push_batch_warning(
                warnings,
                warning_details,
                format!("memory decision {} missing body", decision.slug),
                Some(&decision),
                Some(decision_index),
                "missing_body",
            );
            return false;
        };
        let scope = decision
            .scope
            .clone()
            .unwrap_or_else(|| "project".to_string());
        let write_options = options.clone();
        if args.trigger.as_deref() == Some("memory-organize") {
            return match self.update_inner(
                MemoryUpdateArgs {
                    slug: decision.slug.clone(),
                    scope: Some(scope),
                    workdir: args.workdir.clone(),
                    workdir_hash: decision_workdir_hash,
                    memory_type: Some(memory_type),
                    description: Some(description),
                    body: Some(body),
                    mode: Some("replace".to_string()),
                    actor: Some("extractor".to_string()),
                    conversation_id: args.conversation_id.clone(),
                    model: args.model.clone(),
                },
                args.trigger.clone(),
            ) {
                Ok(resp) => {
                    updated.push(resp.slug);
                    true
                }
                Err(update_error) => {
                    push_batch_warning(
                        warnings,
                        warning_details,
                        update_error,
                        Some(&decision),
                        Some(decision_index),
                        "update_failed",
                    );
                    false
                }
            };
        }
        match self.write_entry(
            decision.slug.clone(),
            scope.clone(),
            args.workdir.clone(),
            memory_type.clone(),
            description.clone(),
            body.clone(),
            write_options.clone(),
            false,
        ) {
            Ok(resp) => {
                if resp.created {
                    created.push(resp.slug);
                } else {
                    updated.push(resp.slug);
                }
                true
            }
            Err(error) if error.contains("\"slug_exists\"") => {
                match self.update(MemoryUpdateArgs {
                    slug: decision.slug.clone(),
                    scope: Some(scope),
                    workdir: args.workdir.clone(),
                    workdir_hash: None,
                    memory_type: Some(memory_type),
                    description: Some(description),
                    body: Some(body),
                    mode: Some("merge".to_string()),
                    actor: Some("extractor".to_string()),
                    conversation_id: args.conversation_id.clone(),
                    model: args.model.clone(),
                }) {
                    Ok(resp) => {
                        updated.push(resp.slug);
                        true
                    }
                    Err(update_error) => {
                        push_batch_warning(
                            warnings,
                            warning_details,
                            update_error,
                            Some(&decision),
                            Some(decision_index),
                            "update_failed",
                        );
                        false
                    }
                }
            }
            Err(error) => {
                push_batch_warning(
                    warnings,
                    warning_details,
                    error,
                    Some(&decision),
                    Some(decision_index),
                    "write_failed",
                );
                false
            }
        }
    }

    pub fn organize_run_create(
        &self,
        args: MemoryOrganizeRunCreateArgs,
    ) -> Result<MemoryOrganizeRunCreateResponse, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize run 事务失败：{e}"))?;
        let now = now_ms();
        reap_stale_organize_runs(&tx, now)?;
        if let Some(active) = find_blocking_organize_run(&tx)? {
            tx.commit()
                .map_err(|e| format!("提交 stale memory organize run 回收事务失败：{e}"))?;
            return Ok(MemoryOrganizeRunCreateResponse {
                run: None,
                accepted: false,
                already_running: true,
                active_run: Some(active),
            });
        }

        let run_id = format!("memory-organize-{}", Uuid::new_v4());
        let trigger = normalize_organize_trigger(&args.trigger)?;
        let scope = normalize_organize_scope(args.scope.as_deref());
        let mode = normalize_organize_mode(args.mode.as_deref());
        insert_organize_run(
            &tx,
            &run_id,
            &trigger,
            "pending",
            now,
            None,
            None,
            args.due_at,
            None,
            args.model.as_ref(),
            &scope,
            &mode,
        )?;
        tx.commit()
            .map_err(|e| format!("提交 memory organize run 事务失败：{e}"))?;
        drop(conn);
        let run = self
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: run_id.clone(),
            })?
            .ok_or_else(|| format!("memory organize run not found after create: {run_id}"))?;
        Ok(MemoryOrganizeRunCreateResponse {
            run: Some(run),
            accepted: true,
            already_running: false,
            active_run: None,
        })
    }

    pub fn organize_due_claim(
        &self,
        args: MemoryOrganizeDueClaimArgs,
    ) -> Result<MemoryOrganizeDueClaimResponse, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize claim 事务失败：{e}"))?;
        let now = args.now.unwrap_or_else(now_ms);
        reap_stale_organize_runs(&tx, now)?;
        if find_active_organize_run(&tx)?.is_some() {
            let due_at = args.due_at.unwrap_or(0);
            if args.enabled.unwrap_or(false) && due_at > 0 && due_at <= now {
                let run_id = if let Some(existing_run_id) =
                    find_existing_skipped_organize_run_id(&tx, due_at, "already_running")?
                {
                    existing_run_id
                } else {
                    insert_skipped_organize_run(
                        &tx,
                        now,
                        due_at,
                        args.model.as_ref(),
                        &normalize_organize_scope(args.scope.as_deref()),
                        &normalize_organize_mode(args.mode.as_deref()),
                        "already_running",
                        "本次自动记忆整理因已有整理任务运行中而跳过。",
                    )?
                };
                tx.commit()
                    .map_err(|e| format!("提交 memory organize skipped claim 失败：{e}"))?;
                drop(conn);
                return Ok(MemoryOrganizeDueClaimResponse {
                    run: self.organize_run_read(MemoryOrganizeRunReadArgs { run_id })?,
                    skipped_reason: Some("already_running".to_string()),
                });
            }
            tx.commit()
                .map_err(|e| format!("提交 stale memory organize claim 回收事务失败：{e}"))?;
            return Ok(MemoryOrganizeDueClaimResponse {
                run: None,
                skipped_reason: Some("already_running".to_string()),
            });
        }

        if let Some(run_id) = find_pending_organize_run_id(&tx)? {
            mark_organize_run_running(&tx, &run_id, now)?;
            tx.commit()
                .map_err(|e| format!("提交 memory organize pending claim 失败：{e}"))?;
            drop(conn);
            return Ok(MemoryOrganizeDueClaimResponse {
                run: self.organize_run_read(MemoryOrganizeRunReadArgs { run_id })?,
                skipped_reason: None,
            });
        }

        if args.enabled.unwrap_or(false) {
            let due_at = args.due_at.unwrap_or(0);
            if due_at > 0 && due_at <= now {
                let run_id = format!("memory-organize-{}", Uuid::new_v4());
                let scope = normalize_organize_scope(args.scope.as_deref());
                let mode = normalize_organize_mode(args.mode.as_deref());
                insert_organize_run(
                    &tx,
                    &run_id,
                    "scheduled",
                    "running",
                    now,
                    Some(now),
                    None,
                    Some(due_at),
                    Some(now),
                    args.model.as_ref(),
                    &scope,
                    &mode,
                )?;
                tx.commit()
                    .map_err(|e| format!("提交 memory organize scheduled claim 失败：{e}"))?;
                drop(conn);
                return Ok(MemoryOrganizeDueClaimResponse {
                    run: self.organize_run_read(MemoryOrganizeRunReadArgs { run_id })?,
                    skipped_reason: None,
                });
            }
        }

        tx.commit()
            .map_err(|e| format!("提交 stale memory organize claim 回收事务失败：{e}"))?;
        Ok(MemoryOrganizeDueClaimResponse {
            run: None,
            skipped_reason: None,
        })
    }

    pub fn organize_due_complete(
        &self,
        args: MemoryOrganizeRunUpdateArgs,
    ) -> Result<Option<MemoryOrganizeRun>, String> {
        self.organize_run_update(args)
    }

    pub fn organize_run_update(
        &self,
        args: MemoryOrganizeRunUpdateArgs,
    ) -> Result<Option<MemoryOrganizeRun>, String> {
        let run_id = args.run_id.trim();
        if run_id.is_empty() {
            return Err("memory organize run_id is required".to_string());
        }
        if let Some(status) = args.status.as_deref() {
            normalize_organize_status(status)?;
        }

        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize update 事务失败：{e}"))?;
        let current = load_organize_run_by_id(&tx, run_id)?;
        let Some(current) = current else {
            return Ok(None);
        };

        let next_status = args.status.unwrap_or(current.status);
        let next_started_at = args.started_at.or(current.started_at);
        let next_finished_at = args.finished_at.or(current.finished_at);
        let next_trimmed_protocol = args.trimmed_protocol.unwrap_or(current.trimmed_protocol);
        let trimmed_protocol_json = serde_json::to_string(&next_trimmed_protocol)
            .map_err(|e| format!("serialize organizer trimmed protocol failed: {e}"))?;

        tx.execute(
            r#"
            UPDATE memory_organize_runs
            SET status = ?2,
                started_at = ?3,
                finished_at = ?4,
                input_count = ?5,
                cluster_count = ?6,
                safe_applied = ?7,
                review_skipped = ?8,
                created_count = ?9,
                updated_count = ?10,
                deleted_count = ?11,
                merged_count = ?12,
                parse_failures = ?13,
                error = ?14,
                final_summary = ?15,
                trimmed_protocol_json = ?16
            WHERE run_id = ?1
            "#,
            params![
                run_id,
                next_status,
                next_started_at,
                next_finished_at,
                args.input_count.unwrap_or(current.input_count),
                args.cluster_count.unwrap_or(current.cluster_count),
                args.safe_applied.unwrap_or(current.safe_applied),
                args.review_skipped.unwrap_or(current.review_skipped),
                args.created_count.unwrap_or(current.created_count),
                args.updated_count.unwrap_or(current.updated_count),
                args.deleted_count.unwrap_or(current.deleted_count),
                args.merged_count.unwrap_or(current.merged_count),
                args.parse_failures.unwrap_or(current.parse_failures),
                args.error.or(current.error),
                args.final_summary.or(current.final_summary),
                trimmed_protocol_json,
            ],
        )
        .map_err(|e| format!("更新 memory organize run 失败：{e}"))?;
        tx.commit()
            .map_err(|e| format!("提交 memory organize update 事务失败：{e}"))?;
        drop(conn);
        self.organize_run_read(MemoryOrganizeRunReadArgs {
            run_id: run_id.to_string(),
        })
    }

    pub fn organize_run_list(
        &self,
        args: MemoryOrganizeRunListArgs,
    ) -> Result<MemoryOrganizeRunListResponse, String> {
        let status = args
            .status
            .as_deref()
            .map(normalize_organize_status)
            .transpose()?;
        let limit = args.limit.unwrap_or(50).clamp(1, 200);
        let conn = self.lock_conn()?;
        let runs = if let Some(status) = status {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
                           claimed_at, model_json, scope, mode, input_count, cluster_count,
                           safe_applied, review_skipped, created_count, updated_count,
                           deleted_count, merged_count, parse_failures, error, final_summary,
                           trimmed_protocol_json
                    FROM memory_organize_runs
                    WHERE status = ?1
                    ORDER BY created_at DESC
                    LIMIT ?2
                    "#,
                )
                .map_err(|e| format!("准备 memory organize run list 失败：{e}"))?;
            let rows = stmt
                .query_map(params![status, limit as i64], row_to_organize_run)
                .map_err(|e| format!("查询 memory organize run list 失败：{e}"))?;
            collect_organize_runs(rows)?
        } else {
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
                           claimed_at, model_json, scope, mode, input_count, cluster_count,
                           safe_applied, review_skipped, created_count, updated_count,
                           deleted_count, merged_count, parse_failures, error, final_summary,
                           trimmed_protocol_json
                    FROM memory_organize_runs
                    ORDER BY created_at DESC
                    LIMIT ?1
                    "#,
                )
                .map_err(|e| format!("准备 memory organize run list 失败：{e}"))?;
            let rows = stmt
                .query_map(params![limit as i64], row_to_organize_run)
                .map_err(|e| format!("查询 memory organize run list 失败：{e}"))?;
            collect_organize_runs(rows)?
        };
        Ok(MemoryOrganizeRunListResponse { runs })
    }

    pub fn organize_run_read(
        &self,
        args: MemoryOrganizeRunReadArgs,
    ) -> Result<Option<MemoryOrganizeRun>, String> {
        let run_id = args.run_id.trim();
        if run_id.is_empty() {
            return Err("memory organize run_id is required".to_string());
        }
        let conn = self.lock_conn()?;
        load_organize_run_by_id(&conn, run_id)
    }

    pub fn organize_run_clear_history(
        &self,
    ) -> Result<MemoryOrganizeRunClearHistoryResponse, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("创建 memory organize history clear 事务失败：{e}"))?;
        let retained_active_count = tx
            .query_row(
                "SELECT COUNT(*) FROM memory_organize_runs WHERE status IN ('pending', 'running')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("统计 memory organize active runs 失败：{e}"))?;
        let deleted_count =
            tx.execute(
                "DELETE FROM memory_organize_runs WHERE status NOT IN ('pending', 'running')",
                [],
            )
            .map_err(|e| format!("清空 memory organize history 失败：{e}"))? as i64;
        tx.commit()
            .map_err(|e| format!("提交 memory organize history clear 事务失败：{e}"))?;
        Ok(MemoryOrganizeRunClearHistoryResponse {
            deleted_count,
            retained_active_count,
        })
    }

    pub fn overview(&self, workdir: Option<String>) -> Result<MemoryOverviewResponse, String> {
        let workdir_hash = optional_workdir_hash(workdir.as_deref())?;
        let conn = self.lock_conn()?;
        let mut rows = load_all_meta(&conn)?;
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });

        let project_slugs = rows
            .iter()
            .filter(|entry| {
                entry.scope == "project"
                    && workdir_hash
                        .as_deref()
                        .is_some_and(|hash| entry.workdir_hash == hash)
                    && entry.memory_type != "daily"
            })
            .map(|entry| entry.slug.clone())
            .collect::<HashSet<_>>();

        let user = rows
            .iter()
            .filter(|entry| {
                entry.scope == "global"
                    && (entry.memory_type == "user"
                        || (entry.memory_type == "feedback" && !entry.unreviewed))
            })
            .take(80)
            .map(overview_entry)
            .collect();

        let project = rows
            .iter()
            .filter(|entry| {
                entry.scope == "project"
                    && workdir_hash
                        .as_deref()
                        .is_some_and(|hash| entry.workdir_hash == hash)
                    && entry.memory_type != "daily"
            })
            .take(80)
            .map(overview_entry)
            .collect();

        let global = rows
            .iter()
            .filter(|entry| {
                entry.scope == "global"
                    && entry.memory_type != "daily"
                    && !matches!(entry.memory_type.as_str(), "user" | "feedback")
                    && !project_slugs.contains(&entry.slug)
            })
            .take(80)
            .map(overview_entry)
            .collect();

        let mut recent_days = rows
            .iter()
            .filter(|entry| entry.memory_type == "daily" && !entry.archived)
            .map(overview_entry)
            .collect::<Vec<_>>();
        recent_days.sort_by(|a, b| b.date_local.cmp(&a.date_local));
        recent_days.truncate(RECENT_DAYS_LIMIT);

        Ok(MemoryOverviewResponse {
            user,
            project,
            global,
            recent_days,
            root: self.root.to_string_lossy().to_string(),
            workdir_hash,
        })
    }

    pub fn paths_info(&self) -> Result<MemoryPathsInfo, String> {
        let conn = self.lock_conn()?;
        let used = count_non_daily_entries(&conn, None)?;
        let daily_count = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_meta WHERE type = 'daily'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("读取记忆状态失败：{e}"))?;
        let (is_in_cloud, cloud_provider) = detect_sync_root(&self.root);
        Ok(MemoryPathsInfo {
            root: self.root.to_string_lossy().to_string(),
            is_fresh: used == 0 && daily_count == 0,
            is_in_cloud,
            cloud_provider,
        })
    }

    pub fn recent_rejections(
        &self,
        args: MemoryRecentRejectionsArgs,
    ) -> Result<MemoryRecentRejectionsResponse, String> {
        let since_days = args.since_days.unwrap_or(7).clamp(1, 365);
        let limit = args.limit.unwrap_or(30).clamp(1, 200);
        let workdir_hash = optional_workdir_hash(args.workdir.as_deref())?;
        let cutoff_ms = now_ms() - (since_days as i64) * 86_400_000;
        let conn = self.lock_conn()?;
        let map_row = |row: &rusqlite::Row<'_>| {
            let slug: String = row.get(0)?;
            let scope: String = row.get(1)?;
            let workdir_hash: String = row.get(2)?;
            let rejected_at: i64 = row.get(3)?;
            let actor: String = row.get(4)?;
            let detail_json: Option<String> = row.get(5)?;
            let reason = detail_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|value| {
                    value
                        .get("reason")
                        .and_then(|v| v.as_str().map(|s| s.to_string()))
                });
            Ok(MemoryRejectionEntry {
                slug,
                scope,
                workdir_hash,
                rejected_at,
                actor,
                reason,
            })
        };
        let mut stmt = if workdir_hash.is_some() {
            conn.prepare(
                "
                SELECT slug, scope, workdir_hash, ts, actor, detail_json
                FROM memory_audit_log
                WHERE op = 'delete'
                  AND actor = 'user'
                  AND ts >= ?1
                  AND (scope = 'global' OR (scope = 'project' AND workdir_hash = ?2))
                ORDER BY ts DESC
                LIMIT ?3
                ",
            )
        } else {
            conn.prepare(
                "
                SELECT slug, scope, workdir_hash, ts, actor, detail_json
                FROM memory_audit_log
                WHERE op = 'delete'
                  AND actor = 'user'
                  AND ts >= ?1
                  AND scope = 'global'
                ORDER BY ts DESC
                LIMIT ?2
                ",
            )
        }
        .map_err(|e| format!("准备记忆拒绝日志查询失败：{e}"))?;
        let rows = if let Some(hash) = workdir_hash.as_deref() {
            stmt.query_map(params![cutoff_ms, hash, limit as i64], map_row)
        } else {
            stmt.query_map(params![cutoff_ms, limit as i64], map_row)
        }
        .map_err(|e| format!("读取记忆拒绝日志失败：{e}"))?;

        // De-duplicate by slug, keeping the most recent rejection. Audit log
        // may record the same slug being deleted multiple times across a user
        // session; the silent-memory prompt only needs the latest one.
        let mut seen_entries = std::collections::HashSet::new();
        let mut entries = Vec::new();
        for row in rows {
            let entry = row.map_err(|e| format!("读取记忆拒绝行失败：{e}"))?;
            let key = (
                entry.scope.clone(),
                entry.workdir_hash.clone(),
                entry.slug.clone(),
            );
            if seen_entries.insert(key) {
                entries.push(entry);
            }
        }
        Ok(MemoryRecentRejectionsResponse { entries })
    }

    pub fn today_local_date(&self, rollover_hour: Option<u32>) -> String {
        today_local(rollover_hour.unwrap_or(DEFAULT_ROLLOVER_HOUR)).to_string()
    }

    pub fn today_daily(
        &self,
        rollover_hour: Option<u32>,
    ) -> Result<Option<MemoryReadResponse>, String> {
        let slug = format!("daily-{}", self.today_local_date(rollover_hour));
        match self.read(MemoryReadArgs {
            slug,
            scope: Some("global".to_string()),
            workdir: None,
            workdir_hash: None,
            offset: None,
            length: None,
        }) {
            Ok(resp) => Ok(Some(resp)),
            Err(error) if error.contains("\"slug_not_found\"") => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn wipe_all(&self) -> Result<MemoryPathsInfo, String> {
        let _mutation_guard = self.lock_mutation()?;
        let quarantine = self
            .root
            .join(".quarantine")
            .join(format!("wiped-{}", now_ms()));
        fs::create_dir_all(&quarantine).map_err(|e| format!("创建记忆备份目录失败：{e}"))?;
        for name in ["global", "projects", DB_FILENAME] {
            let src = self.root.join(name);
            if src.exists() {
                let dst = quarantine.join(name);
                fs::rename(&src, &dst).map_err(|e| format!("备份记忆 {name} 失败：{e}"))?;
            }
        }
        ensure_root_dirs(&self.root)?;
        {
            let mut conn = self.lock_conn()?;
            *conn = open_memory_connection(&self.db_path)?;
        }
        self.reconcile()?;
        self.paths_info()
    }

    fn write_entry(
        &self,
        slug_input: String,
        scope_input: String,
        workdir: Option<String>,
        memory_type_input: String,
        description_input: String,
        body: String,
        mut options: WriteOptions,
        upsert: bool,
    ) -> Result<MemoryMutationResponse, String> {
        let slug = normalize_slug(&slug_input)?;
        let scope = normalize_write_scope(&scope_input)?;
        let memory_type = normalize_memory_type(&memory_type_input)?;
        if memory_type == "daily" {
            return Err(error_json(
                "invalid_type",
                "memory.write cannot create type=daily",
                None,
                None,
            ));
        }
        validate_body_limit(&body, MAX_BODY_BYTES, &slug)?;
        apply_risk_policy(&slug, &body, &mut options)?;
        let description = normalize_description(&description_input)?;
        let workdir_hash = if scope == "project" {
            required_workdir_hash(workdir.as_deref())?
        } else {
            String::new()
        };
        let _mutation_guard = self.lock_mutation()?;
        let target = self.path_for(
            &scope,
            &workdir_hash,
            workdir.as_deref(),
            &memory_type,
            &slug,
        )?;
        let existed_before = target.exists();
        if existed_before && !upsert {
            return Err(error_json(
                "slug_exists",
                &format!("memory with slug '{slug}' already exists in {scope} scope"),
                Some(json!({
                    "action": "update",
                    "slug": slug,
                    "scope": scope
                })),
                None,
            ));
        }
        self.validate_scope_quota(&scope, &workdir_hash, existed_before)?;
        let now = now_ms();
        let source = normalize_source_json(
            Value::Null,
            options.unreviewed,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            options.risk_flag.as_deref(),
        );
        let meta = ParsedFrontmatter {
            name: slug.clone(),
            memory_type: memory_type.clone(),
            scope: scope.clone(),
            description,
            headline: String::new(),
            date: None,
            append_count: 0,
            created_at: Some(format_rfc3339(now)),
            updated_at: Some(format_rfc3339(now)),
            source_json: source,
            links_json: Value::Array(Vec::new()),
            unreviewed: options.unreviewed,
        };
        let content = render_memory_markdown(&meta, &body);
        self.atomic_replace_entry_file(&target, &content)?;
        let parsed = ParsedMemoryFile {
            meta,
            body,
            path: target.clone(),
            archived: false,
        };
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &target, false)?;
        insert_audit_log(
            &mut conn,
            if existed_before { "update" } else { "write" },
            &scope,
            &workdir_hash,
            &slug,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            json!({ "type": memory_type }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug,
            scope,
            created: !existed_before,
            updated: existed_before,
            deleted: false,
            index_updated: true,
            warning: None,
        })
    }

    fn replace_existing_entry(
        &self,
        resolved: ResolvedEntry,
        memory_type_input: String,
        description_input: String,
        body: String,
        mut options: WriteOptions,
        update_mode: &str,
    ) -> Result<MemoryMutationResponse, String> {
        let memory_type = normalize_memory_type(&memory_type_input)?;
        if memory_type == "daily" {
            return Err(error_json(
                "invalid_type",
                "ordinary update cannot set type=daily",
                None,
                None,
            ));
        }
        validate_body_limit(&body, MAX_BODY_BYTES, &resolved.meta.slug)?;
        apply_risk_policy(&resolved.meta.slug, &body, &mut options)?;
        let description = normalize_description(&description_input)?;
        let mut parsed = resolved.parsed;
        parsed.meta.memory_type = memory_type.clone();
        parsed.meta.description = description;
        parsed.meta.updated_at = Some(format_rfc3339(now_ms()));
        parsed.meta.unreviewed = options.unreviewed;
        parsed.meta.source_json = normalize_source_json(
            parsed.meta.source_json,
            options.unreviewed,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            options.risk_flag.as_deref(),
        );
        let target = self.path_for(
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            None,
            &memory_type,
            &resolved.meta.slug,
        )?;
        let content = render_memory_markdown(&parsed.meta, &body);
        if options.trigger.as_deref() == Some("memory-organize") {
            self.snapshot_entry_before_organize(&resolved.meta, &resolved.path)?;
        }
        self.atomic_replace_entry_file(&target, &content)?;
        if target != resolved.path && resolved.path.exists() {
            let _ = fs::remove_file(&resolved.path);
        }
        parsed.body = body;
        parsed.path = target.clone();
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &target, false)?;
        insert_audit_log(
            &mut conn,
            "update",
            &resolved.meta.scope,
            &resolved.meta.workdir_hash,
            &resolved.meta.slug,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            json!({ "type": memory_type, "mode": update_mode }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug: resolved.meta.slug,
            scope: resolved.meta.scope,
            created: false,
            updated: true,
            deleted: false,
            index_updated: true,
            warning: None,
        })
    }

    fn append_daily(
        &self,
        slug_input: String,
        bullet: String,
        options: WriteOptions,
    ) -> Result<MemoryMutationResponse, String> {
        let slug = normalize_daily_slug(&slug_input)?;
        validate_body_limit(&bullet, MAX_DAILY_BODY_BYTES, &slug)?;
        let _mutation_guard = self.lock_mutation()?;
        let date = slug.trim_start_matches("daily-").to_string();
        let path = self.global_daily_dir().join(format!("{date}.md"));
        let existing = if path.exists() {
            Some(parse_memory_file(&path, false)?)
        } else {
            None
        };
        let now = now_ms();
        let mut meta = existing
            .as_ref()
            .map(|entry| entry.meta.clone())
            .unwrap_or_else(|| ParsedFrontmatter {
                name: slug.clone(),
                memory_type: "daily".to_string(),
                scope: "global".to_string(),
                description: String::new(),
                headline: String::new(),
                date: Some(date.clone()),
                append_count: 0,
                created_at: Some(format_rfc3339(now)),
                updated_at: Some(format_rfc3339(now)),
                source_json: Value::Null,
                links_json: Value::Array(Vec::new()),
                unreviewed: false,
            });
        meta.name = slug.clone();
        meta.memory_type = "daily".to_string();
        meta.scope = "global".to_string();
        meta.date = Some(date.clone());
        meta.headline = daily_title_for_date(&date);
        meta.append_count += 1;
        meta.updated_at = Some(format_rfc3339(now));
        meta.source_json = append_daily_source(
            meta.source_json,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
        );

        let previous_body = existing
            .map(|entry| entry.body.trim_end().to_string())
            .unwrap_or_default();
        let normalized_bullet = bullet.trim();
        let body = if previous_body.is_empty() {
            normalized_bullet.to_string()
        } else if normalized_bullet.is_empty() {
            previous_body
        } else {
            format!("{previous_body}\n\n{normalized_bullet}")
        };
        if body.as_bytes().len() > MAX_DAILY_BODY_BYTES {
            return Err(error_json(
                "body_too_large",
                "daily memory body exceeds 32 KB",
                Some(json!({
                    "action": "update",
                    "slug": slug,
                    "mode": "append",
                    "body": "<consolidated daily summary>"
                })),
                None,
            ));
        }
        let warning = if body.as_bytes().len() >= DAILY_NEAR_LIMIT_BYTES {
            Some(format!(
                "{slug} is near the 32 KB daily limit; consolidate soon"
            ))
        } else {
            None
        };
        let content = render_memory_markdown(&meta, &body);
        let created = !path.exists();
        self.atomic_replace_entry_file(&path, &content)?;
        let parsed = ParsedMemoryFile {
            meta,
            body,
            path: path.clone(),
            archived: false,
        };
        let mut conn = self.lock_conn()?;
        index_parsed_file(&mut conn, &parsed, &path, false)?;
        insert_audit_log(
            &mut conn,
            if created { "write" } else { "update" },
            "global",
            "",
            &slug,
            &options.actor,
            options.conversation_id.as_deref(),
            options.trigger.as_deref(),
            options.model.as_deref(),
            json!({ "type": "daily", "append": true }),
        )?;
        drop(conn);
        self.refresh_memory_indexes()?;
        Ok(MemoryMutationResponse {
            slug,
            scope: "global".to_string(),
            created,
            updated: !created,
            deleted: false,
            index_updated: true,
            warning,
        })
    }

    fn validate_scope_quota(
        &self,
        scope: &str,
        workdir_hash: &str,
        replacing_existing_file: bool,
    ) -> Result<(), String> {
        if replacing_existing_file {
            return Ok(());
        }
        let conn = self.lock_conn()?;
        let used = count_non_daily_entries(&conn, Some((scope, workdir_hash)))?;
        if used >= MAX_SCOPE_ENTRIES {
            return Err(error_json(
                "quota_exceeded",
                "memory scope quota exceeded",
                Some(json!({
                    "action": "list",
                    "scope": scope,
                    "includeDaily": false
                })),
                None,
            ));
        }
        Ok(())
    }

    fn resolve_entry(
        &self,
        slug_input: &str,
        scope_input: Option<&str>,
        workdir: Option<&str>,
        workdir_hash_input: Option<&str>,
    ) -> Result<ResolvedEntry, String> {
        let slug = if is_daily_slug(slug_input) {
            normalize_daily_slug(slug_input)?
        } else {
            normalize_slug(slug_input)?
        };
        let scope = normalize_scope_filter(scope_input)?.unwrap_or_else(|| "auto".to_string());
        let workdir_hash =
            normalize_workdir_hash_input(workdir_hash_input)?.or(optional_workdir_hash(workdir)?);
        let conn = self.lock_conn()?;
        let candidates = load_all_meta(&conn)?
            .into_iter()
            .filter(|entry| entry.slug == slug)
            .filter(|entry| {
                if scope == "global" {
                    entry.scope == "global"
                } else if scope == "project" {
                    entry.scope == "project"
                        && workdir_hash
                            .as_deref()
                            .is_some_and(|hash| hash == entry.workdir_hash)
                } else {
                    entry.scope == "global"
                        || (entry.scope == "project"
                            && workdir_hash
                                .as_deref()
                                .is_some_and(|hash| hash == entry.workdir_hash))
                }
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            let fuzzy = fuzzy_candidates(&conn, &slug)?;
            return Err(error_json(
                "slug_not_found",
                &format!("memory slug '{slug}' was not found"),
                Some(missing_slug_suggested_next_call(&slug)),
                Some(fuzzy),
            ));
        }
        if candidates.len() > 1 && scope == "auto" {
            let candidates_json = candidates
                .iter()
                .map(|entry| json!({ "slug": entry.slug, "scope": entry.scope }))
                .collect::<Vec<_>>();
            return Err(error_json(
                "scope_ambiguous",
                &format!("memory slug '{slug}' exists in multiple scopes"),
                None,
                Some(candidates_json),
            ));
        }
        let meta = candidates.into_iter().next().expect("candidate exists");
        let path = self.path_for_meta(&meta)?;
        if !path.exists() {
            return Err(error_json(
                "slug_not_found",
                &format!("memory file for slug '{}' is missing", meta.slug),
                Some(missing_slug_suggested_next_call(&meta.slug)),
                None,
            ));
        }
        let parsed = parse_memory_file(&path, meta.archived)?;
        Ok(ResolvedEntry { meta, path, parsed })
    }

    fn search_by_scanning(
        &self,
        meta_by_key: &HashMap<(String, String, String), MemoryMeta>,
        terms: &[String],
        type_filter: Option<&str>,
    ) -> Result<Vec<MemorySearchMatch>, String> {
        let mut out = Vec::new();
        for meta in meta_by_key.values() {
            if let Some(filter) = type_filter {
                if meta.memory_type != filter {
                    continue;
                }
            }
            let path = self.path_for_meta(meta)?;
            if !path.exists() {
                continue;
            }
            let parsed = parse_memory_file(&path, meta.archived)?;
            let haystack = format!(
                "{}\n{}\n{}\n{}",
                meta.slug, meta.description, meta.headline, parsed.body
            )
            .to_lowercase();
            let mut best_score = 0.0;
            for term in terms {
                let term_lower = term.to_lowercase();
                if term_lower.is_empty() {
                    continue;
                }
                if haystack.contains(&term_lower) {
                    best_score = f64::max(best_score, term_lower.len() as f64 / 10.0 + 1.0);
                }
            }
            if best_score > 0.0 {
                let (score, raw_score, age_days) = apply_daily_decay(best_score, meta);
                out.push(MemorySearchMatch {
                    slug: meta.slug.clone(),
                    scope: meta.scope.clone(),
                    workdir_hash: meta.workdir_hash.clone(),
                    memory_type: meta.memory_type.clone(),
                    description: meta.description.clone(),
                    headline: meta.headline.clone(),
                    snippet: build_snippet(&parsed.body, terms),
                    score,
                    raw_score,
                    age_days,
                    unreviewed: meta.unreviewed,
                    confidence: meta.confidence.clone(),
                });
            }
        }
        Ok(out)
    }

    fn reconcile(&self) -> Result<(), String> {
        self.archive_old_dailies(DEFAULT_DAILY_RETENTION_DAYS)?;
        let mut conn = self.lock_conn()?;
        conn.execute_batch(
            "DELETE FROM memory_meta; DELETE FROM memory_fts; DELETE FROM memory_fts_tri;",
        )
        .map_err(|e| format!("清空记忆索引失败：{e}"))?;
        let files = self.collect_memory_files()?;
        for parsed in files {
            if let Err(error) = index_parsed_file(&mut conn, &parsed, &parsed.path, parsed.archived)
            {
                eprintln!(
                    "failed to index memory file {}: {error}",
                    parsed.path.display()
                );
            }
        }
        drop(conn);
        self.refresh_memory_indexes()
    }

    fn archive_old_dailies(&self, retention_days: i64) -> Result<(), String> {
        let daily_dir = self.global_daily_dir();
        if !daily_dir.exists() {
            return Ok(());
        }
        let today = Local::now().date_naive();
        let entries = fs::read_dir(&daily_dir).map_err(|e| format!("读取 daily 目录失败：{e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取 daily 文件失败：{e}"))?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let parsed = match parse_memory_file(&path, false) {
                Ok(parsed) => parsed,
                Err(error) => {
                    eprintln!("failed to parse daily memory {}: {error}", path.display());
                    continue;
                }
            };
            if parsed.meta.memory_type != "daily" {
                continue;
            }
            let Some(date_text) = parsed
                .meta
                .date
                .as_deref()
                .or_else(|| path.file_stem().and_then(|value| value.to_str()))
            else {
                continue;
            };
            let Ok(date) = NaiveDate::parse_from_str(date_text, "%Y-%m-%d") else {
                continue;
            };
            if today.signed_duration_since(date).num_days() <= retention_days {
                continue;
            }
            let archive_dir = daily_dir.join(".archive").join(format!("{}", date.year()));
            fs::create_dir_all(&archive_dir)
                .map_err(|e| format!("创建 daily 归档目录失败：{e}"))?;
            let target = archive_dir.join(
                path.file_name()
                    .ok_or_else(|| "daily file has no file name".to_string())?,
            );
            if target.exists() {
                eprintln!(
                    "daily archive target already exists, leaving hot file in place: {}",
                    target.display()
                );
                continue;
            }
            fs::rename(&path, &target).map_err(|e| {
                format!(
                    "归档 daily 记忆 {} -> {} 失败：{e}",
                    path.display(),
                    target.display()
                )
            })?;
        }
        Ok(())
    }

    fn collect_memory_files(&self) -> Result<Vec<ParsedMemoryFile>, String> {
        let mut out = Vec::new();
        collect_md_files(&self.global_dir(), false, &mut out)?;
        collect_md_files(&self.global_user_dir(), false, &mut out)?;
        collect_md_files(&self.global_daily_dir(), false, &mut out)?;
        let projects = self.projects_dir();
        if projects.exists() {
            for entry in
                fs::read_dir(&projects).map_err(|e| format!("读取项目记忆目录失败：{e}"))?
            {
                let entry = entry.map_err(|e| format!("读取项目记忆目录项失败：{e}"))?;
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    collect_md_files(&entry.path(), false, &mut out)?;
                }
            }
        }
        Ok(out)
    }

    fn enrich_project_paths(&self, rows: &mut [MemoryMeta]) {
        let mut cache: HashMap<String, Option<String>> = HashMap::new();
        for entry in rows {
            if entry.scope != "project" || entry.workdir_hash.is_empty() {
                continue;
            }
            let path = cache
                .entry(entry.workdir_hash.clone())
                .or_insert_with(|| self.project_workdir_path(&entry.workdir_hash))
                .clone();
            entry.workdir_path = path;
        }
    }

    fn project_workdir_path(&self, workdir_hash: &str) -> Option<String> {
        let marker = self.projects_dir().join(workdir_hash).join(".workdir.json");
        let bytes = fs::read(marker).ok()?;
        let value = serde_json::from_slice::<Value>(&bytes).ok()?;
        value
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(ToString::to_string)
    }

    fn refresh_memory_indexes(&self) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let rows = load_all_meta(&conn)?;
        drop(conn);
        render_scope_index(
            &self.global_dir(),
            rows.iter().filter(|entry| entry.scope == "global"),
        )?;
        let mut project_rows: BTreeMap<String, Vec<&MemoryMeta>> = BTreeMap::new();
        for entry in &rows {
            if entry.scope == "project" {
                project_rows
                    .entry(entry.workdir_hash.clone())
                    .or_default()
                    .push(entry);
            }
        }
        for (hash, entries) in project_rows {
            render_scope_index(&self.projects_dir().join(hash), entries.into_iter())?;
        }
        Ok(())
    }

    fn atomic_replace_entry_file(&self, target: &Path, content: &str) -> Result<(), String> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建记忆目录失败：{e}"))?;
        }
        atomic_write(target, content.as_bytes())
    }

    fn path_for(
        &self,
        scope: &str,
        workdir_hash: &str,
        workdir: Option<&str>,
        memory_type: &str,
        slug: &str,
    ) -> Result<PathBuf, String> {
        if memory_type == "daily" {
            let date = slug.trim_start_matches("daily-");
            return Ok(self.global_daily_dir().join(format!("{date}.md")));
        }
        if scope == "global" {
            if matches!(memory_type, "user" | "feedback") {
                return Ok(self.global_user_dir().join(format!("{slug}.md")));
            }
            return Ok(self.global_dir().join(format!("{slug}.md")));
        }
        if workdir_hash.is_empty() {
            return Err("project memory requires workdir hash".to_string());
        }
        let dir = self.projects_dir().join(workdir_hash);
        fs::create_dir_all(&dir).map_err(|e| format!("创建项目记忆目录失败：{e}"))?;
        if let Some(workdir) = workdir {
            let marker = dir.join(".workdir.json");
            if !marker.exists() {
                let payload = serde_json::to_vec_pretty(&json!({
                    "path": workdir,
                    "createdAt": format_rfc3339(now_ms())
                }))
                .map_err(|e| format!("序列化项目记忆标记失败：{e}"))?;
                atomic_write(&marker, &payload)?;
            }
        }
        Ok(dir.join(format!("{slug}.md")))
    }

    fn path_for_meta(&self, meta: &MemoryMeta) -> Result<PathBuf, String> {
        if meta.archived && meta.memory_type == "daily" {
            let date = meta
                .date_local
                .as_deref()
                .unwrap_or_else(|| meta.slug.trim_start_matches("daily-"));
            let year = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map(|date| date.year().to_string())
                .unwrap_or_else(|_| date.chars().take(4).collect::<String>());
            let archive_dir = self.global_daily_dir().join(".archive").join(year);
            let canonical = archive_dir.join(format!("{date}.md"));
            if canonical.exists() {
                return Ok(canonical);
            }
            let legacy = archive_dir.join(format!("{}.md", meta.slug));
            if legacy.exists() {
                return Ok(legacy);
            }
            return Ok(canonical);
        }
        self.path_for(
            &meta.scope,
            &meta.workdir_hash,
            None,
            &meta.memory_type,
            &meta.slug,
        )
    }

    fn trash_dir_for(&self, meta: &MemoryMeta) -> Result<PathBuf, String> {
        if meta.scope == "global" {
            Ok(self.global_dir().join(".trash"))
        } else {
            Ok(self.projects_dir().join(&meta.workdir_hash).join(".trash"))
        }
    }

    fn organize_snapshot_dir_for(&self, meta: &MemoryMeta) -> PathBuf {
        if meta.scope == "global" {
            self.global_dir().join(".organize-snapshots")
        } else {
            self.projects_dir()
                .join(&meta.workdir_hash)
                .join(".organize-snapshots")
        }
    }

    fn snapshot_entry_before_organize(&self, meta: &MemoryMeta, path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let dir = self.organize_snapshot_dir_for(meta);
        fs::create_dir_all(&dir).map_err(|e| format!("创建记忆整理快照目录失败：{e}"))?;
        let snapshot = dir.join(format!("{}.{}.md", now_ms(), meta.slug));
        fs::copy(path, snapshot).map_err(|e| format!("写入记忆整理快照失败：{e}"))?;
        Ok(())
    }

    fn global_dir(&self) -> PathBuf {
        self.root.join("global")
    }

    fn global_user_dir(&self) -> PathBuf {
        self.global_dir().join("user")
    }

    fn global_daily_dir(&self) -> PathBuf {
        self.global_dir().join("daily")
    }

    fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        match self.conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                eprintln!("memory sqlite mutex was poisoned; recovering existing connection");
                let guard = poisoned.into_inner();
                self.conn.clear_poison();
                Ok(guard)
            }
        }
    }

    fn lock_mutation(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        match self.mutation_lock.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                eprintln!("memory mutation mutex was poisoned; continuing with recovered lock");
                let guard = poisoned.into_inner();
                self.mutation_lock.clear_poison();
                Ok(guard)
            }
        }
    }

    fn gc_old_wipe_backups(&self) -> Result<(), String> {
        let dir = self.root.join(".quarantine");
        if !dir.exists() {
            return Ok(());
        }
        let cutoff = now_ms() - 7 * 24 * 60 * 60 * 1000;
        for entry in fs::read_dir(&dir).map_err(|e| format!("读取记忆隔离目录失败：{e}"))?
        {
            let entry = entry.map_err(|e| format!("读取记忆隔离目录项失败：{e}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("wiped-") {
                continue;
            }
            let ts = name
                .trim_start_matches("wiped-")
                .parse::<i64>()
                .unwrap_or(now_ms());
            if ts < cutoff {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }

    fn gc_old_organize_snapshots(&self) -> Result<(), String> {
        let cutoff = now_ms() - 30 * 24 * 60 * 60 * 1000;
        for dir in collect_organize_snapshot_dirs(&self.root) {
            if !dir.exists() {
                continue;
            }
            for entry in fs::read_dir(&dir).map_err(|e| format!("读取记忆整理快照目录失败：{e}"))?
            {
                let entry = entry.map_err(|e| format!("读取记忆整理快照目录项失败：{e}"))?;
                let name = entry.file_name().to_string_lossy().to_string();
                let ts = name
                    .split('.')
                    .next()
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(now_ms());
                if ts < cutoff {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }
}

fn collect_organize_snapshot_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.join("global").join(".organize-snapshots")];
    let projects_dir = root.join("projects");
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path.join(".organize-snapshots"));
            }
        }
    }
    dirs
}

fn memory_root_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join(MEMORY_DIR_NAME).join(MEMORY_ROOT_DIR))
}

fn ensure_root_dirs(root: &Path) -> Result<(), String> {
    for dir in [
        root.to_path_buf(),
        root.join("global"),
        root.join("global").join("user"),
        root.join("global").join("daily"),
        root.join("projects"),
        root.join(".quarantine"),
    ] {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("创建记忆目录 {} 失败：{e}", dir.display()))?;
    }
    Ok(())
}

fn open_memory_connection(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建记忆数据库目录失败：{e}"))?;
    }
    let conn = Connection::open(db_path).map_err(|e| format!("打开记忆数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置记忆数据库 busy_timeout 失败：{e}"))?;
    if let Err(error) = integrity_check(&conn) {
        quarantine_db_files(db_path)?;
        drop(conn);
        let conn = Connection::open(db_path).map_err(|e| format!("重建记忆数据库失败：{e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置记忆数据库 busy_timeout 失败：{e}"))?;
        init_schema(&conn)?;
        eprintln!("memory index was quarantined and rebuilt: {error}");
        return Ok(conn);
    }
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    if memory_schema_needs_rebuild(conn)? {
        conn.execute_batch(
            "DROP TABLE IF EXISTS memory_fts;
             DROP TABLE IF EXISTS memory_fts_tri;
             DROP TABLE IF EXISTS memory_meta;
             DROP TABLE IF EXISTS memory_audit_log;
             DROP TABLE IF EXISTS memory_schema_version;",
        )
        .map_err(|e| format!("重建旧版记忆索引表失败：{e}"))?;
    }
    conn.execute_batch(MEMORY_SCHEMA_DDL)
        .map_err(|e| format!("初始化记忆索引表失败：{e}"))
}

fn memory_schema_needs_rebuild(conn: &Connection) -> Result<bool, String> {
    if !sqlite_table_exists(conn, "memory_meta")? {
        return Ok(false);
    }
    if !sqlite_table_exists(conn, "memory_schema_version")? {
        return Ok(true);
    }

    let version = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM memory_schema_version",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取记忆 schema 版本失败：{e}"))?;
    if version < 3 {
        return Ok(true);
    }
    if version > 3 {
        return Err(format!("unsupported memory schema version: {version}"));
    }

    let meta_columns = table_columns(conn, "memory_meta")?;
    for column in [
        "scope",
        "workdir_hash",
        "slug",
        "type",
        "description",
        "headline",
        "date_local",
        "age_anchor",
        "append_count",
        "archived",
        "body_hash",
        "file_mtime",
        "file_size",
        "created_at",
        "updated_at",
        "source_json",
        "links_json",
    ] {
        if !meta_columns.contains(column) {
            return Ok(true);
        }
    }

    if sqlite_table_exists(conn, "memory_fts")? {
        let fts_columns = table_columns(conn, "memory_fts")?;
        if !fts_columns.contains("headline") {
            return Ok(true);
        }
    }
    if sqlite_table_exists(conn, "memory_fts_tri")? {
        let fts_tri_columns = table_columns(conn, "memory_fts_tri")?;
        if !fts_tri_columns.contains("description") || !fts_tri_columns.contains("headline") {
            return Ok(true);
        }
    }

    Ok(false)
}

fn sqlite_table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?1)",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| format!("检查记忆索引表是否存在失败：{e}"))
}

fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("读取记忆索引表列失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取记忆索引表列失败：{e}"))?;
    let mut out = HashSet::new();
    for row in rows {
        out.insert(row.map_err(|e| format!("读取记忆索引表列失败：{e}"))?);
    }
    Ok(out)
}

fn integrity_check(conn: &Connection) -> Result<(), String> {
    let result = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| format!("记忆数据库 integrity_check 失败：{e}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("记忆数据库 integrity_check 异常：{result}"))
    }
}

fn quarantine_db_files(db_path: &Path) -> Result<(), String> {
    let root = db_path
        .parent()
        .ok_or_else(|| "memory db path has no parent".to_string())?;
    let quarantine = root
        .join(".quarantine")
        .join(format!("corrupt-{}", now_ms()));
    fs::create_dir_all(&quarantine).map_err(|e| format!("创建记忆数据库隔离目录失败：{e}"))?;
    for suffix in ["", "-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{}", db_path.to_string_lossy(), suffix));
        if src.exists() {
            let file_name = src
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_else(|| format!("memory-index.sqlite3{suffix}").into());
            fs::rename(&src, quarantine.join(file_name))
                .map_err(|e| format!("隔离损坏记忆数据库失败：{e}"))?;
        }
    }
    Ok(())
}

fn collect_md_files(
    dir: &Path,
    archived: bool,
    out: &mut Vec<ParsedMemoryFile>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in
        fs::read_dir(dir).map_err(|e| format!("读取记忆目录 {} 失败：{e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("读取记忆目录项失败：{e}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取记忆文件类型失败：{e}"))?;
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if archived || name == ".archive" {
                collect_md_files(&path, archived || name == ".archive", out)?;
            }
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) == Some("MEMORY.md") {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        match parse_memory_file(&path, archived) {
            Ok(parsed) => out.push(parsed),
            Err(error) => eprintln!("failed to parse memory file {}: {error}", path.display()),
        }
    }
    Ok(())
}

fn parse_memory_file(path: &Path, archived: bool) -> Result<ParsedMemoryFile, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("读取记忆文件 {} 失败：{e}", path.display()))?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let mut meta = parse_frontmatter(&frontmatter);
    if meta.name.is_empty() {
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
        meta.name = if meta.memory_type == "daily" && !stem.starts_with("daily-") {
            format!("daily-{stem}")
        } else {
            stem
        };
    }
    if meta.memory_type.is_empty() {
        meta.memory_type = if meta.name.starts_with("daily-") {
            "daily".to_string()
        } else {
            "reference".to_string()
        };
    }
    if meta.scope.is_empty() {
        meta.scope = if path.components().any(|part| part.as_os_str() == "projects") {
            "project".to_string()
        } else {
            "global".to_string()
        };
    }
    if meta.memory_type == "daily" && meta.date.is_none() {
        meta.date = Some(meta.name.trim_start_matches("daily-").to_string());
    }
    Ok(ParsedMemoryFile {
        meta,
        body,
        path: path.to_path_buf(),
        archived,
    })
}

fn split_frontmatter(raw: &str) -> (String, String) {
    let normalized = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if !normalized.starts_with("---\n") && !normalized.starts_with("---\r\n") {
        return (String::new(), normalized.to_string());
    }
    let mut lines = normalized.lines();
    let _ = lines.next();
    let mut frontmatter = Vec::new();
    let mut body = Vec::new();
    let mut in_frontmatter = true;
    for line in lines {
        if in_frontmatter && line.trim() == "---" {
            in_frontmatter = false;
            continue;
        }
        if in_frontmatter {
            frontmatter.push(line.to_string());
        } else {
            body.push(line.to_string());
        }
    }
    (
        frontmatter.join("\n"),
        body.join("\n").trim_start_matches('\n').to_string(),
    )
}

fn normalize_memory_confidence(value: &str) -> String {
    match value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase()
        .as_str()
    {
        "high" => "high".to_string(),
        "medium" => "medium".to_string(),
        "low" => "low".to_string(),
        _ => MEMORY_CONFIDENCE_UNKNOWN.to_string(),
    }
}

fn evidence_confidence_from_body(body: &str) -> String {
    let (frontmatter, _) = split_frontmatter(body);
    if frontmatter.trim().is_empty() {
        return MEMORY_CONFIDENCE_UNKNOWN.to_string();
    }
    for line in frontmatter.lines().take(20) {
        let trimmed = line.trim();
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        if key.trim() == "confidence" {
            return normalize_memory_confidence(value);
        }
    }
    MEMORY_CONFIDENCE_UNKNOWN.to_string()
}

fn is_evidence_only_body(body: &str) -> bool {
    let (frontmatter, content) = split_frontmatter(body);
    !frontmatter.trim().is_empty() && content.trim().is_empty()
}

fn source_json_with_confidence(source: Value, confidence: &str) -> Value {
    let confidence = normalize_memory_confidence(confidence);
    match source {
        Value::Object(mut object) => {
            object.insert("confidence".to_string(), Value::String(confidence));
            Value::Object(object)
        }
        _ => json!({ "confidence": confidence }),
    }
}

fn render_evidence_body(frontmatter: &str, body: &str) -> String {
    if frontmatter.trim().is_empty() {
        return body.trim().to_string();
    }
    let trimmed_body = body.trim();
    if trimmed_body.is_empty() {
        format!("---\n{}\n---", frontmatter.trim())
    } else {
        format!("---\n{}\n---\n\n{trimmed_body}", frontmatter.trim())
    }
}

fn merge_memory_body(existing: &str, incoming: &str) -> String {
    let (existing_frontmatter, existing_content) = split_frontmatter(existing);
    let (incoming_frontmatter, incoming_content) = split_frontmatter(incoming);
    let merged_content = merge_memory_content(&existing_content, &incoming_content);
    let frontmatter = if incoming_frontmatter.trim().is_empty() {
        existing_frontmatter
    } else {
        incoming_frontmatter
    };
    render_evidence_body(&frontmatter, &merged_content)
}

fn merge_memory_content(existing: &str, incoming: &str) -> String {
    let existing_trimmed = existing.trim();
    let incoming_trimmed = incoming.trim();
    if existing_trimmed.is_empty() {
        return incoming_trimmed.to_string();
    }
    if incoming_trimmed.is_empty() {
        return existing_trimmed.to_string();
    }

    let existing_units = split_merge_units(existing_trimmed);
    let incoming_units = split_merge_units(incoming_trimmed);
    if existing_units.is_empty() {
        return incoming_trimmed.to_string();
    }
    if incoming_units.is_empty() {
        return existing_trimmed.to_string();
    }

    let mut merged = existing_units.clone();
    let mut appended = Vec::new();
    for incoming_unit in &incoming_units {
        if let Some(index) = best_merge_match_index(&merged, incoming_unit) {
            merged[index] = incoming_unit.clone();
            continue;
        }
        if !merged
            .iter()
            .chain(appended.iter())
            .any(|existing_unit| merge_units_equivalent(existing_unit, incoming_unit))
        {
            appended.push(incoming_unit.clone());
        }
    }

    merged.extend(appended);
    dedupe_merge_units(merged).join("\n\n")
}

fn split_merge_units(body: &str) -> Vec<String> {
    let normalized = body.replace("\r\n", "\n");
    let mut units = Vec::new();
    for paragraph in normalized.split("\n\n") {
        let trimmed = paragraph.trim();
        if trimmed.is_empty() {
            continue;
        }
        if should_preserve_merge_block(trimmed) {
            units.push(trimmed.to_string());
            continue;
        }
        for raw_line in trimmed.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            if should_preserve_merge_line(line) {
                units.push(line.to_string());
                continue;
            }
            let sentences = split_sentence_like_units(line);
            if sentences.is_empty() {
                units.push(line.to_string());
            } else {
                units.extend(sentences);
            }
        }
    }
    units
}

fn should_preserve_merge_block(text: &str) -> bool {
    text.starts_with("```")
}

fn should_preserve_merge_line(text: &str) -> bool {
    text.starts_with('#')
        || text.starts_with("- ")
        || text.starts_with("* ")
        || text.starts_with("> ")
        || text.starts_with("|")
        || text.starts_with("```")
}

fn split_sentence_like_units(text: &str) -> Vec<String> {
    let mut units = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '。' | '！' | '？' | '；' | '.' | '!' | '?' | ';') {
            let sentence = current.trim();
            if !sentence.is_empty() {
                units.push(sentence.to_string());
            }
            current.clear();
        }
    }
    let tail = current.trim();
    if !tail.is_empty() {
        units.push(tail.to_string());
    }
    units
}

fn normalize_merge_unit_key(input: &str) -> String {
    input
        .trim()
        .to_lowercase()
        .chars()
        .filter_map(|ch| {
            if ch.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                Some(ch)
            } else if ch.is_whitespace() {
                Some(' ')
            } else {
                None
            }
        })
        .collect::<String>()
}

fn extract_merge_tokens(input: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let normalized = normalize_merge_unit_key(input);
    let mut ascii = String::new();

    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() {
            ascii.push(ch);
            continue;
        }
        if !ascii.is_empty() {
            tokens.insert(ascii.clone());
            ascii.clear();
        }
        if ch == ' ' {
            continue;
        }
        tokens.insert(ch.to_string());
    }

    if !ascii.is_empty() {
        tokens.insert(ascii);
    }

    tokens
}

fn merge_units_equivalent(left: &str, right: &str) -> bool {
    let left_key = normalize_merge_unit_key(left);
    let right_key = normalize_merge_unit_key(right);
    left_key == right_key
        || (!left_key.is_empty()
            && !right_key.is_empty()
            && (left_key.contains(&right_key) || right_key.contains(&left_key)))
}

fn merge_unit_similarity(left: &str, right: &str) -> f64 {
    let left_tokens = extract_merge_tokens(left);
    let right_tokens = extract_merge_tokens(right);
    if left_tokens.is_empty() || right_tokens.is_empty() {
        return 0.0;
    }
    let overlap = left_tokens.intersection(&right_tokens).count();
    if overlap == 0 {
        return 0.0;
    }
    let union = left_tokens.union(&right_tokens).count();
    overlap as f64 / union as f64
}

fn best_merge_match_index(existing_units: &[String], incoming_unit: &str) -> Option<usize> {
    let incoming_tokens = extract_merge_tokens(incoming_unit);
    if incoming_tokens.is_empty() {
        return None;
    }

    let mut best: Option<(usize, f64, usize)> = None;
    for (index, existing_unit) in existing_units.iter().enumerate() {
        if merge_units_equivalent(existing_unit, incoming_unit) {
            return Some(index);
        }
        let existing_tokens = extract_merge_tokens(existing_unit);
        if existing_tokens.is_empty() {
            continue;
        }
        let overlap = existing_tokens.intersection(&incoming_tokens).count();
        if overlap < 4 {
            continue;
        }
        let similarity = merge_unit_similarity(existing_unit, incoming_unit);
        if similarity < 0.32 {
            continue;
        }
        match best {
            Some((_, best_similarity, best_overlap))
                if similarity < best_similarity
                    || (similarity == best_similarity && overlap <= best_overlap) => {}
            _ => best = Some((index, similarity, overlap)),
        }
    }

    best.map(|(index, _, _)| index)
}

fn dedupe_merge_units(units: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for unit in units {
        let key = normalize_merge_unit_key(&unit);
        if key.is_empty() {
            continue;
        }
        if seen.insert(key) {
            deduped.push(unit);
        }
    }
    deduped
}

fn parse_frontmatter(raw: &str) -> ParsedFrontmatter {
    let mut meta = ParsedFrontmatter::default();
    let mut in_source = false;
    let mut in_sources = false;
    let mut source = serde_json::Map::new();
    let mut sources = Vec::new();
    let mut current_daily_source: Option<serde_json::Map<String, Value>> = None;

    fn normalize_scalar(value: &str) -> String {
        value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string()
    }

    fn push_daily_source(
        current: &mut Option<serde_json::Map<String, Value>>,
        sources: &mut Vec<Value>,
    ) {
        if let Some(item) = current.take() {
            if !item.is_empty() {
                sources.push(Value::Object(item));
            }
        }
    }

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let is_indented = line.starts_with(' ') || line.starts_with('\t');
        if !is_indented {
            in_source = false;
            if in_sources && !trimmed.starts_with("sources:") {
                push_daily_source(&mut current_daily_source, &mut sources);
                in_sources = false;
            }
        }

        if in_sources && trimmed.starts_with("- ") {
            push_daily_source(&mut current_daily_source, &mut sources);
            let mut item = serde_json::Map::new();
            if let Some((key, value)) = trimmed.trim_start_matches("- ").split_once(':') {
                let value = normalize_scalar(value);
                if !value.is_empty() {
                    item.insert(key.trim().to_string(), Value::String(value));
                }
            }
            current_daily_source = Some(item);
            continue;
        }

        if in_sources && is_indented {
            if let Some((key, value)) = trimmed.split_once(':') {
                let value = normalize_scalar(value);
                if !value.is_empty() {
                    current_daily_source
                        .get_or_insert_with(serde_json::Map::new)
                        .insert(key.trim().to_string(), Value::String(value));
                }
            }
            continue;
        }

        if let Some((key, value)) = trimmed.split_once(':') {
            let value = normalize_scalar(value);
            match key.trim() {
                "name" => meta.name = value,
                "type" => meta.memory_type = value,
                "scope" => meta.scope = value,
                "description" => meta.description = value,
                "headline" => meta.headline = value,
                "date" => meta.date = Some(value),
                "appendCount" => meta.append_count = value.parse::<i64>().unwrap_or(0),
                "createdAt" => meta.created_at = Some(value),
                "updatedAt" => meta.updated_at = Some(value),
                "source" => {
                    in_source = true;
                    meta.source_json = Value::Object(serde_json::Map::new());
                }
                "sources" => {
                    in_sources = true;
                    meta.source_json = Value::Array(Vec::new());
                }
                "links" => meta.links_json = Value::Array(Vec::new()),
                _ if in_source => {
                    if key.trim() == "unreviewed" {
                        let flag = value == "true";
                        meta.unreviewed = flag;
                        source.insert("unreviewed".to_string(), Value::Bool(flag));
                    } else if !value.is_empty() {
                        source.insert(key.trim().to_string(), Value::String(value));
                    }
                }
                _ => {}
            }
        }
    }
    push_daily_source(&mut current_daily_source, &mut sources);
    if !source.is_empty() {
        meta.source_json = Value::Object(source);
    } else if !sources.is_empty() {
        meta.source_json = Value::Array(sources);
    }
    meta
}

fn render_memory_markdown(meta: &ParsedFrontmatter, body: &str) -> String {
    let mut lines = Vec::new();
    let headline = if meta.memory_type == "daily" {
        daily_title_for_meta(&meta.name, meta.date.as_deref())
    } else {
        meta.headline.clone()
    };
    lines.push("---".to_string());
    lines.push(format!("name: {}", meta.name));
    if !meta.description.is_empty() {
        lines.push(format!("description: {}", yaml_scalar(&meta.description)));
    }
    lines.push(format!("type: {}", meta.memory_type));
    lines.push(format!("scope: {}", meta.scope));
    if !headline.is_empty() || meta.memory_type == "daily" {
        lines.push(format!("headline: {}", yaml_scalar(&headline)));
    }
    if let Some(date) = &meta.date {
        lines.push(format!("date: {date}"));
    }
    lines.push(format!(
        "createdAt: {}",
        meta.created_at
            .clone()
            .unwrap_or_else(|| format_rfc3339(now_ms()))
    ));
    lines.push(format!(
        "updatedAt: {}",
        meta.updated_at
            .clone()
            .unwrap_or_else(|| format_rfc3339(now_ms()))
    ));
    if meta.memory_type == "daily" {
        lines.push(format!("appendCount: {}", meta.append_count.max(0)));
        lines.push("sources:".to_string());
        if let Some(items) = meta.source_json.as_array() {
            for item in items {
                let obj = item.as_object();
                lines.push(format!(
                    "  - conversationId: {}",
                    obj.and_then(|v| v.get("conversationId"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                ));
                if let Some(appended_at) = obj
                    .and_then(|v| v.get("appendedAt"))
                    .and_then(Value::as_str)
                {
                    lines.push(format!("    appendedAt: {appended_at}"));
                }
                if let Some(trigger) = obj.and_then(|v| v.get("trigger")).and_then(Value::as_str) {
                    lines.push(format!("    trigger: {trigger}"));
                }
                if let Some(model) = obj.and_then(|v| v.get("model")).and_then(Value::as_str) {
                    lines.push(format!("    model: {}", yaml_scalar(model)));
                }
            }
        }
    } else {
        lines.push("source:".to_string());
        let source = meta.source_json.as_object();
        lines.push(format!(
            "  trigger: {}",
            source
                .and_then(|value| value.get("trigger"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
        ));
        if let Some(conversation_id) = source
            .and_then(|value| value.get("conversationId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("  conversationId: {conversation_id}"));
        }
        if let Some(model) = source
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("  model: {}", yaml_scalar(model)));
        }
        if let Some(risk_flag) = source
            .and_then(|value| value.get("risk_flag"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("  risk_flag: {}", yaml_scalar(risk_flag)));
        }
        lines.push(format!("  unreviewed: {}", meta.unreviewed));
    }
    lines.push("links: []".to_string());
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(body.trim().to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn yaml_scalar(value: &str) -> String {
    if value.is_empty() {
        "\"\"".to_string()
    } else if value.contains(':')
        || value.contains('#')
        || value.starts_with(' ')
        || value.ends_with(' ')
    {
        format!("{:?}", value)
    } else {
        value.to_string()
    }
}

fn index_parsed_file(
    conn: &mut Connection,
    parsed: &ParsedMemoryFile,
    path: &Path,
    archived: bool,
) -> Result<(), String> {
    let slug = normalize_index_slug(&parsed.meta, path)?;
    let scope = normalize_index_scope(&parsed.meta)?;
    let memory_type = normalize_index_type(&parsed.meta)?;
    let workdir_hash = if scope == "project" {
        path.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string()
    } else {
        String::new()
    };
    let metadata = fs::metadata(path).map_err(|e| format!("读取记忆文件元数据失败：{e}"))?;
    let file_mtime = metadata
        .modified()
        .ok()
        .and_then(system_time_to_ms)
        .unwrap_or_else(now_ms);
    let file_size = metadata.len() as i64;
    let created_at = parsed
        .meta
        .created_at
        .as_deref()
        .and_then(parse_rfc3339_ms)
        .unwrap_or(file_mtime);
    let updated_at = parsed
        .meta
        .updated_at
        .as_deref()
        .and_then(parse_rfc3339_ms)
        .unwrap_or(file_mtime);
    let date_local = if memory_type == "daily" {
        parsed
            .meta
            .date
            .clone()
            .or_else(|| Some(slug.trim_start_matches("daily-").to_string()))
    } else {
        None
    };
    let indexed_headline = if memory_type == "daily" {
        daily_title_for_meta(&parsed.meta.name, date_local.as_deref())
    } else {
        parsed.meta.headline.clone()
    };
    let age_anchor = date_local
        .as_deref()
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .and_then(|dt| Local.from_local_datetime(&dt).single())
        .map(|dt| dt.timestamp());
    let confidence = if memory_type == "daily" {
        MEMORY_CONFIDENCE_UNKNOWN.to_string()
    } else {
        evidence_confidence_from_body(&parsed.body)
    };
    let source_for_index = if memory_type == "daily" {
        parsed.meta.source_json.clone()
    } else {
        source_json_with_confidence(parsed.meta.source_json.clone(), &confidence)
    };
    let source_json =
        serde_json::to_string(&source_for_index).map_err(|e| format!("序列化记忆来源失败：{e}"))?;
    let links_json = serde_json::to_string(&parsed.meta.links_json)
        .map_err(|e| format!("序列化记忆链接失败：{e}"))?;
    let body_hash = sha256_hex(parsed.body.as_bytes());
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启记忆索引事务失败：{e}"))?;
    upsert_index_rows(
        &tx,
        &scope,
        &workdir_hash,
        &slug,
        &memory_type,
        &parsed.meta.description,
        &indexed_headline,
        date_local.as_deref(),
        age_anchor,
        parsed.meta.append_count,
        archived,
        &body_hash,
        file_mtime,
        file_size,
        created_at,
        updated_at,
        &source_json,
        &links_json,
        &parsed.body,
    )?;
    tx.commit()
        .map_err(|e| format!("提交记忆索引事务失败：{e}"))
}

#[allow(clippy::too_many_arguments)]
fn upsert_index_rows(
    tx: &Transaction<'_>,
    scope: &str,
    workdir_hash: &str,
    slug: &str,
    memory_type: &str,
    description: &str,
    headline: &str,
    date_local: Option<&str>,
    age_anchor: Option<i64>,
    append_count: i64,
    archived: bool,
    body_hash: &str,
    file_mtime: i64,
    file_size: i64,
    created_at: i64,
    updated_at: i64,
    source_json: &str,
    links_json: &str,
    body: &str,
) -> Result<(), String> {
    tx.execute(
        "
        INSERT OR REPLACE INTO memory_meta
            (scope, workdir_hash, slug, type, description, headline, date_local, age_anchor,
             append_count, archived, body_hash, file_mtime, file_size, created_at, updated_at,
             source_json, links_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ",
        params![
            scope,
            workdir_hash,
            slug,
            memory_type,
            description,
            headline,
            date_local,
            age_anchor,
            append_count,
            if archived { 1 } else { 0 },
            body_hash,
            file_mtime,
            file_size,
            created_at,
            updated_at,
            source_json,
            links_json
        ],
    )
    .map_err(|e| format!("写入 memory_meta 失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除旧 memory_fts 行失败：{e}"))?;
    tx.execute(
        "INSERT INTO memory_fts (slug, scope, workdir_hash, type, description, headline, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            slug,
            scope,
            workdir_hash,
            memory_type,
            description,
            headline,
            body
        ],
    )
    .map_err(|e| format!("写入 memory_fts 失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts_tri WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除旧 memory_fts_tri 行失败：{e}"))?;
    tx.execute(
        "INSERT INTO memory_fts_tri (slug, scope, workdir_hash, description, headline, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![slug, scope, workdir_hash, description, headline, body],
    )
    .map_err(|e| format!("写入 memory_fts_tri 失败：{e}"))?;
    Ok(())
}

fn delete_index_rows(
    conn: &mut Connection,
    scope: &str,
    workdir_hash: &str,
    slug: &str,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启记忆删除事务失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_meta WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除 memory_meta 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除 memory_fts 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts_tri WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除 memory_fts_tri 行失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交记忆删除事务失败：{e}"))
}

fn delete_project_index_rows(
    conn: &mut Connection,
    workdir_hash: &str,
    workdir: &str,
    deleted_count: usize,
    quarantine_path: Option<&Path>,
    actor: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启项目记忆删除事务失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_meta WHERE scope = 'project' AND workdir_hash = ?1",
        params![workdir_hash],
    )
    .map_err(|e| format!("删除项目 memory_meta 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts WHERE scope = 'project' AND workdir_hash = ?1",
        params![workdir_hash],
    )
    .map_err(|e| format!("删除项目 memory_fts 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts_tri WHERE scope = 'project' AND workdir_hash = ?1",
        params![workdir_hash],
    )
    .map_err(|e| format!("删除项目 memory_fts_tri 行失败：{e}"))?;

    let mut detail = json!({
        "workdir": workdir,
        "deletedCount": deleted_count,
    });
    if let Some(path) = quarantine_path {
        detail["quarantinePath"] = Value::String(path.to_string_lossy().to_string());
    }
    if let Some(reason) = reason {
        detail["reason"] = Value::String(reason.to_string());
    }
    let detail_json = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());
    tx.execute(
        "
        INSERT INTO memory_audit_log
            (ts, op, scope, workdir_hash, slug, actor, detail_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
            now_ms(),
            "delete",
            "project",
            workdir_hash,
            "*",
            actor,
            detail_json
        ],
    )
    .map_err(|e| format!("写入项目记忆删除审计日志失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交项目记忆删除事务失败：{e}"))
}

#[allow(clippy::too_many_arguments)]
fn insert_audit_log(
    conn: &mut Connection,
    op: &str,
    scope: &str,
    workdir_hash: &str,
    slug: &str,
    actor: &str,
    conversation_id: Option<&str>,
    trigger: Option<&str>,
    model: Option<&str>,
    detail: Value,
) -> Result<(), String> {
    let detail_json = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "
        INSERT INTO memory_audit_log
            (ts, op, scope, workdir_hash, slug, actor, conversation_id, trigger, model, detail_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ",
        params![
            now_ms(),
            op,
            scope,
            workdir_hash,
            slug,
            actor,
            conversation_id,
            trigger,
            model,
            detail_json
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("写入记忆审计日志失败：{e}"))
}

fn load_all_meta(conn: &Connection) -> Result<Vec<MemoryMeta>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT scope, workdir_hash, slug, type, description, headline, date_local,
                   created_at, updated_at, append_count, archived, source_json, file_size
            FROM memory_meta
            ",
        )
        .map_err(|e| format!("准备记忆列表查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let source_json: Option<String> = row.get(11)?;
            let source_value = source_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or(Value::Null);
            Ok(normalize_memory_meta(MemoryMeta {
                scope: row.get(0)?,
                workdir_hash: row.get(1)?,
                workdir_path: None,
                slug: row.get(2)?,
                memory_type: row.get(3)?,
                description: row.get(4)?,
                headline: row.get(5)?,
                date_local: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                append_count: row.get(9)?,
                archived: row.get::<_, i64>(10)? != 0,
                unreviewed: source_value
                    .get("unreviewed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                confidence: source_value
                    .get("confidence")
                    .and_then(Value::as_str)
                    .map(normalize_memory_confidence)
                    .unwrap_or_else(|| MEMORY_CONFIDENCE_UNKNOWN.to_string()),
                file_size: row.get(12)?,
            }))
        })
        .map_err(|e| format!("查询记忆列表失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取记忆列表失败：{e}"))
}

fn count_non_daily_entries(
    conn: &Connection,
    scope: Option<(&str, &str)>,
) -> Result<usize, String> {
    let count = if let Some((scope, workdir_hash)) = scope {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_meta WHERE type != 'daily' AND scope = ?1 AND workdir_hash = ?2",
            params![scope, workdir_hash],
            |row| row.get::<_, i64>(0),
        )
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_meta WHERE type != 'daily'",
            [],
            |row| row.get::<_, i64>(0),
        )
    }
    .map_err(|e| format!("读取记忆配额失败：{e}"))?;
    Ok(count.max(0) as usize)
}

fn build_list_quota(
    conn: &Connection,
    workdir_hash: Option<&str>,
    scope_filter: Option<&str>,
) -> Result<MemoryQuota, String> {
    let mut scope_quotas = Vec::new();

    if scope_filter.is_none() || scope_filter == Some("global") {
        scope_quotas.push(MemoryScopeQuota {
            scope: "global".to_string(),
            workdir_hash: String::new(),
            used: count_non_daily_entries(conn, Some(("global", "")))?,
            limit: MAX_SCOPE_ENTRIES,
        });
    }

    if scope_filter.is_none() || scope_filter == Some("project") {
        if let Some(hash) = workdir_hash {
            scope_quotas.push(MemoryScopeQuota {
                scope: "project".to_string(),
                workdir_hash: hash.to_string(),
                used: count_non_daily_entries(conn, Some(("project", hash)))?,
                limit: MAX_SCOPE_ENTRIES,
            });
        } else if scope_filter == Some("project") {
            scope_quotas.push(MemoryScopeQuota {
                scope: "project".to_string(),
                workdir_hash: String::new(),
                used: 0,
                limit: MAX_SCOPE_ENTRIES,
            });
        }
    }

    let used = scope_quotas
        .iter()
        .map(|quota| quota.used)
        .max()
        .unwrap_or(0);

    Ok(MemoryQuota {
        used,
        limit: MAX_SCOPE_ENTRIES,
        scope_quotas,
    })
}

fn search_fts(
    conn: &Connection,
    term: &str,
    meta_by_key: &HashMap<(String, String, String), MemoryMeta>,
    type_filter: Option<&str>,
) -> Result<Vec<MemorySearchMatch>, String> {
    let query = fts_phrase(term);
    let mut out = Vec::new();
    search_fts_table(
        conn,
        "memory_fts",
        &query,
        meta_by_key,
        type_filter,
        &mut out,
        false,
    )?;
    if contains_cjk(term) || out.len() < DEFAULT_SEARCH_LIMIT {
        search_fts_table(
            conn,
            "memory_fts_tri",
            &query,
            meta_by_key,
            type_filter,
            &mut out,
            true,
        )?;
    }
    Ok(out)
}

fn search_fts_table(
    conn: &Connection,
    table: &str,
    query: &str,
    meta_by_key: &HashMap<(String, String, String), MemoryMeta>,
    type_filter: Option<&str>,
    out: &mut Vec<MemorySearchMatch>,
    tri: bool,
) -> Result<(), String> {
    let sql = if tri {
        format!(
            "SELECT slug, scope, workdir_hash, snippet({table}, 5, '[', ']', '...', 12), bm25({table}) FROM {table} WHERE {table} MATCH ?1 LIMIT 32"
        )
    } else {
        format!(
            "SELECT slug, scope, workdir_hash, snippet({table}, 6, '[', ']', '...', 12), bm25({table}) FROM {table} WHERE {table} MATCH ?1 LIMIT 32"
        )
    };
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("准备记忆 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![query], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })
        .map_err(|e| format!("执行记忆 FTS 查询失败：{e}"))?;
    for row in rows {
        let (slug, scope, workdir_hash, snippet, bm25) =
            row.map_err(|e| format!("读取记忆 FTS 结果失败：{e}"))?;
        let Some(meta) = meta_by_key.get(&(scope, workdir_hash, slug)) else {
            continue;
        };
        if let Some(filter) = type_filter {
            if meta.memory_type != filter {
                continue;
            }
        }
        let raw = if bm25 <= 0.0 {
            -bm25
        } else {
            1.0 / (1.0 + bm25)
        };
        let (score, raw_score, age_days) = apply_daily_decay(raw, meta);
        out.push(MemorySearchMatch {
            slug: meta.slug.clone(),
            scope: meta.scope.clone(),
            workdir_hash: meta.workdir_hash.clone(),
            memory_type: meta.memory_type.clone(),
            description: meta.description.clone(),
            headline: meta.headline.clone(),
            snippet,
            score,
            raw_score,
            age_days,
            unreviewed: meta.unreviewed,
            confidence: meta.confidence.clone(),
        });
    }
    Ok(())
}

fn dedupe_and_apply_project_shadow(matches: Vec<MemorySearchMatch>) -> Vec<MemorySearchMatch> {
    let mut by_key: HashMap<(String, String, String), MemorySearchMatch> = HashMap::new();
    for item in matches {
        let key = (
            item.scope.clone(),
            item.memory_type.clone(),
            item.slug.clone(),
        );
        by_key
            .entry(key)
            .and_modify(|existing| {
                if item.score > existing.score {
                    *existing = item.clone();
                }
            })
            .or_insert(item);
    }
    let mut items = by_key.into_values().collect::<Vec<_>>();
    let project_slugs = items
        .iter()
        .filter(|item| item.scope == "project" && item.memory_type != "daily")
        .map(|item| item.slug.clone())
        .collect::<HashSet<_>>();
    items.retain(|item| {
        item.memory_type == "daily" || item.scope != "global" || !project_slugs.contains(&item.slug)
    });
    items
}

fn scope_matches(
    entry: &MemorySearchMatch,
    scope_filter: Option<&str>,
    workdir_hash: Option<&str>,
) -> bool {
    match scope_filter {
        Some("global") => entry.scope == "global",
        Some("project") => {
            entry.scope == "project" && workdir_hash.is_some_and(|hash| entry.workdir_hash == hash)
        }
        _ => {
            entry.scope == "global"
                || (entry.scope == "project"
                    && workdir_hash.is_some_and(|hash| entry.workdir_hash == hash))
        }
    }
}

fn normalize_organize_trigger(input: &str) -> Result<String, String> {
    match input.trim() {
        "manual" | "scheduled" => Ok(input.trim().to_string()),
        other => Err(format!("invalid memory organize trigger: {other}")),
    }
}

fn normalize_organize_status(input: &str) -> Result<String, String> {
    match input.trim() {
        "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" => {
            Ok(input.trim().to_string())
        }
        other => Err(format!("invalid memory organize status: {other}")),
    }
}

fn normalize_organize_scope(input: Option<&str>) -> String {
    match input.unwrap_or("all").trim() {
        "global" => "global".to_string(),
        "projects" | "all-projects" => "projects".to_string(),
        "current-project" => "current-project".to_string(),
        _ => "all".to_string(),
    }
}

fn normalize_organize_mode(input: Option<&str>) -> String {
    match input.unwrap_or("standard").trim() {
        "conservative" => "conservative".to_string(),
        "aggressive" => "aggressive".to_string(),
        _ => "standard".to_string(),
    }
}

fn parse_json_value(raw: Option<String>, fallback: Value) -> Value {
    let Some(raw) = raw else {
        return fallback;
    };
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn row_to_organize_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryOrganizeRun> {
    let model_json: Option<String> = row.get(8)?;
    let trimmed_protocol_json: String = row.get(22)?;
    Ok(MemoryOrganizeRun {
        run_id: row.get(0)?,
        trigger: row.get(1)?,
        status: row.get(2)?,
        created_at: row.get(3)?,
        started_at: row.get(4)?,
        finished_at: row.get(5)?,
        due_at: row.get(6)?,
        claimed_at: row.get(7)?,
        model: parse_json_value(model_json, Value::Null),
        scope: row.get(9)?,
        mode: row.get(10)?,
        input_count: row.get(11)?,
        cluster_count: row.get(12)?,
        safe_applied: row.get(13)?,
        review_skipped: row.get(14)?,
        created_count: row.get(15)?,
        updated_count: row.get(16)?,
        deleted_count: row.get(17)?,
        merged_count: row.get(18)?,
        parse_failures: row.get(19)?,
        error: row.get(20)?,
        final_summary: row.get(21)?,
        trimmed_protocol: parse_json_value(Some(trimmed_protocol_json), json!({})),
    })
}

fn collect_organize_runs<I>(rows: I) -> Result<Vec<MemoryOrganizeRun>, String>
where
    I: IntoIterator<Item = rusqlite::Result<MemoryOrganizeRun>>,
{
    rows.into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取 memory organize run row 失败：{e}"))
}

fn load_organize_run_by_id(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<MemoryOrganizeRun>, String> {
    conn.query_row(
        r#"
        SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
               claimed_at, model_json, scope, mode, input_count, cluster_count,
               safe_applied, review_skipped, created_count, updated_count,
               deleted_count, merged_count, parse_failures, error, final_summary,
               trimmed_protocol_json
        FROM memory_organize_runs
        WHERE run_id = ?1
        "#,
        params![run_id],
        row_to_organize_run,
    )
    .optional()
    .map_err(|e| format!("读取 memory organize run 失败：{e}"))
}

fn find_active_organize_run(conn: &Connection) -> Result<Option<MemoryOrganizeRun>, String> {
    conn.query_row(
        r#"
        SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
               claimed_at, model_json, scope, mode, input_count, cluster_count,
               safe_applied, review_skipped, created_count, updated_count,
               deleted_count, merged_count, parse_failures, error, final_summary,
               trimmed_protocol_json
        FROM memory_organize_runs
        WHERE status = 'running'
        ORDER BY started_at ASC, created_at ASC
        LIMIT 1
        "#,
        [],
        row_to_organize_run,
    )
    .optional()
    .map_err(|e| format!("读取 active memory organize run 失败：{e}"))
}

fn find_blocking_organize_run(conn: &Connection) -> Result<Option<MemoryOrganizeRun>, String> {
    conn.query_row(
        r#"
        SELECT run_id, trigger, status, created_at, started_at, finished_at, due_at,
               claimed_at, model_json, scope, mode, input_count, cluster_count,
               safe_applied, review_skipped, created_count, updated_count,
               deleted_count, merged_count, parse_failures, error, final_summary,
               trimmed_protocol_json
        FROM memory_organize_runs
        WHERE status IN ('pending', 'running')
        ORDER BY created_at ASC
        LIMIT 1
        "#,
        [],
        row_to_organize_run,
    )
    .optional()
    .map_err(|e| format!("读取 blocking memory organize run 失败：{e}"))
}

fn find_pending_organize_run_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        r#"
        SELECT run_id
        FROM memory_organize_runs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        "#,
        [],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 pending memory organize run 失败：{e}"))
}

fn find_existing_skipped_organize_run_id(
    conn: &Connection,
    due_at: i64,
    reason: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        r#"
        SELECT run_id
        FROM memory_organize_runs
        WHERE trigger = 'scheduled'
          AND status = 'skipped'
          AND due_at = ?1
          AND error = ?2
        ORDER BY created_at DESC
        LIMIT 1
        "#,
        params![due_at, reason],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 skipped memory organize run 失败：{e}"))
}

#[allow(clippy::too_many_arguments)]
fn insert_organize_run(
    conn: &Connection,
    run_id: &str,
    trigger: &str,
    status: &str,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    due_at: Option<i64>,
    claimed_at: Option<i64>,
    model: Option<&Value>,
    scope: &str,
    mode: &str,
) -> Result<(), String> {
    let model_json = model
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("serialize memory organizer model failed: {e}"))?;
    conn.execute(
        r#"
        INSERT INTO memory_organize_runs
            (run_id, trigger, status, created_at, started_at, finished_at, due_at,
             claimed_at, model_json, scope, mode)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
        params![
            run_id,
            trigger,
            status,
            created_at,
            started_at,
            finished_at,
            due_at,
            claimed_at,
            model_json,
            scope,
            mode,
        ],
    )
    .map_err(|e| format!("插入 memory organize run 失败：{e}"))?;
    Ok(())
}

fn insert_skipped_organize_run(
    conn: &Connection,
    now: i64,
    due_at: i64,
    model: Option<&Value>,
    scope: &str,
    mode: &str,
    reason: &str,
    final_summary: &str,
) -> Result<String, String> {
    let run_id = format!("memory-organize-{}", Uuid::new_v4());
    let model_json = model
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("serialize memory organizer model failed: {e}"))?;
    let trimmed_protocol_json = serde_json::to_string(&json!({
        "reviewNotes": [final_summary],
        "skipReason": reason,
    }))
    .map_err(|e| format!("serialize memory organizer skipped protocol failed: {e}"))?;
    conn.execute(
        r#"
        INSERT INTO memory_organize_runs
            (run_id, trigger, status, created_at, started_at, finished_at, due_at,
             claimed_at, model_json, scope, mode, error, final_summary, trimmed_protocol_json)
        VALUES (?1, 'scheduled', 'skipped', ?2, ?2, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            run_id,
            now,
            due_at,
            model_json,
            scope,
            mode,
            reason,
            final_summary,
            trimmed_protocol_json,
        ],
    )
    .map_err(|e| format!("插入 skipped memory organize run 失败：{e}"))?;
    Ok(run_id)
}

fn reap_stale_organize_runs(conn: &Connection, now: i64) -> Result<usize, String> {
    let stale_before = now.saturating_sub(ORGANIZE_RUN_STALE_AFTER_MS);
    let trimmed_protocol_json = serde_json::to_string(&json!({
        "reviewNotes": [ORGANIZE_RUN_STALE_SUMMARY],
        "staleReason": "stale_timeout",
    }))
    .map_err(|e| format!("serialize stale memory organizer protocol failed: {e}"))?;
    conn.execute(
        r#"
        UPDATE memory_organize_runs
        SET status = 'failed',
            finished_at = ?1,
            error = 'stale_timeout',
            final_summary = ?2,
            trimmed_protocol_json = ?3
        WHERE status IN ('pending', 'running')
          AND COALESCE(claimed_at, started_at, created_at) <= ?4
        "#,
        params![
            now,
            ORGANIZE_RUN_STALE_SUMMARY,
            trimmed_protocol_json,
            stale_before,
        ],
    )
    .map_err(|e| format!("回收 stale memory organize run 失败：{e}"))
}

fn mark_organize_run_running(conn: &Connection, run_id: &str, now: i64) -> Result<(), String> {
    conn.execute(
        r#"
        UPDATE memory_organize_runs
        SET status = 'running',
            started_at = COALESCE(started_at, ?2),
            claimed_at = ?2
        WHERE run_id = ?1 AND status = 'pending'
        "#,
        params![run_id, now],
    )
    .map_err(|e| format!("claim memory organize run 失败：{e}"))?;
    Ok(())
}

fn apply_daily_decay(raw_score: f64, meta: &MemoryMeta) -> (f64, Option<f64>, Option<f64>) {
    let weighted_score = raw_score * memory_priority_weight(meta);
    if meta.memory_type != "daily" {
        return (weighted_score, None, None);
    }
    let Some(date) = meta.date_local.as_deref() else {
        return (weighted_score, Some(raw_score), None);
    };
    let age_days = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|entry_date| {
            let today = Local::now().date_naive();
            (today.signed_duration_since(entry_date).num_days().max(0)) as f64
        })
        .unwrap_or(0.0);
    let score = weighted_score * (-age_days / 30.0).exp();
    (score, Some(raw_score), Some(age_days))
}

fn memory_priority_weight(meta: &MemoryMeta) -> f64 {
    if meta.memory_type == "daily" {
        return MEMORY_SCORE_WEIGHT_DAILY;
    }
    if meta.scope == "project" {
        return MEMORY_SCORE_WEIGHT_PROJECT;
    }
    match meta.memory_type.as_str() {
        "user" => MEMORY_SCORE_WEIGHT_USER,
        "feedback" => MEMORY_SCORE_WEIGHT_FEEDBACK,
        "reference" => MEMORY_SCORE_WEIGHT_REFERENCE,
        _ => MEMORY_SCORE_WEIGHT_REFERENCE,
    }
}

fn fts_phrase(input: &str) -> String {
    let escaped = input.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn expand_memory_search_terms(query: &str) -> Vec<String> {
    let mut terms = vec![query.trim().to_string()];
    let lower = query.to_lowercase();
    if lower.contains("我是谁")
        || lower.contains("我的名字")
        || lower.contains("我叫什么")
        || lower.contains("who am i")
        || lower.contains("my name")
    {
        terms.extend([
            "我叫".to_string(),
            "我的名字是".to_string(),
            "我是".to_string(),
            "身份".to_string(),
            "name".to_string(),
            "identity".to_string(),
            "profile".to_string(),
            "user".to_string(),
        ]);
    }
    if lower.contains("偏好") || lower.contains("习惯") || lower.contains("preference") {
        terms.extend([
            "偏好".to_string(),
            "习惯".to_string(),
            "prefer".to_string(),
            "feedback".to_string(),
        ]);
    }
    terms.sort();
    terms.dedup();
    terms
}

fn contains_cjk(input: &str) -> bool {
    input
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
}

fn build_snippet(body: &str, terms: &[String]) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = compact.to_lowercase();
    for term in terms {
        let term_lower = term.to_lowercase();
        if let Some(pos) = lower.find(&term_lower) {
            let start = floor_char_boundary(&compact, pos.saturating_sub(80));
            let end = ceil_char_boundary(
                &compact,
                pos.saturating_add(term_lower.len()).saturating_add(160),
            );
            if start >= end {
                return truncate_chars(&compact, 240);
            }
            return compact[start..end].to_string();
        }
    }
    truncate_chars(&compact, 240)
}

fn missing_slug_suggested_next_call(slug: &str) -> Value {
    if let Some(local_date) = daily_slug_local_date(slug) {
        return json!({
            "action": "search",
            "query": local_date,
            "include_history": true,
            "history_date_local": local_date,
            "history_time_mode": "message",
            "limit": DEFAULT_SEARCH_LIMIT
        });
    }
    json!({ "action": "search", "query": slug.replace('-', " ") })
}

fn daily_slug_local_date(slug: &str) -> Option<&str> {
    let date = slug.strip_prefix("daily-")?;
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|_| date)
}

fn daily_title_for_date(date: &str) -> String {
    date.to_string()
}

fn daily_title_for_meta(slug: &str, date_local: Option<&str>) -> String {
    date_local
        .or_else(|| daily_slug_local_date(slug))
        .map(daily_title_for_date)
        .unwrap_or_else(|| slug.trim_start_matches("daily-").to_string())
}

fn normalize_memory_meta(mut meta: MemoryMeta) -> MemoryMeta {
    meta.confidence = normalize_memory_confidence(&meta.confidence);
    if meta.memory_type == "daily" {
        meta.headline = daily_title_for_meta(&meta.slug, meta.date_local.as_deref());
        meta.confidence = MEMORY_CONFIDENCE_UNKNOWN.to_string();
    }
    meta
}

fn floor_char_boundary(input: &str, index: usize) -> usize {
    let mut index = index.min(input.len());
    while index > 0 && !input.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(input: &str, index: usize) -> usize {
    let mut index = index.min(input.len());
    while index < input.len() && !input.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn normalize_index_slug(meta: &ParsedFrontmatter, path: &Path) -> Result<String, String> {
    if meta.memory_type == "daily" {
        let slug = if meta.name.starts_with("daily-") {
            meta.name.clone()
        } else {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            format!("daily-{stem}")
        };
        normalize_daily_slug(&slug)
    } else {
        normalize_slug(&meta.name)
    }
}

fn normalize_index_scope(meta: &ParsedFrontmatter) -> Result<String, String> {
    match meta.scope.as_str() {
        "global" | "project" => Ok(meta.scope.clone()),
        _ => Err(format!("invalid memory scope: {}", meta.scope)),
    }
}

fn normalize_index_type(meta: &ParsedFrontmatter) -> Result<String, String> {
    if meta.memory_type == "daily" {
        Ok("daily".to_string())
    } else {
        normalize_memory_type(&meta.memory_type)
    }
}

fn normalize_slug(input: &str) -> Result<String, String> {
    let slug = input.trim().to_lowercase().replace('_', "-");
    let re = Regex::new(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$").expect("valid slug regex");
    if re.is_match(&slug) {
        Ok(slug)
    } else {
        Err(error_json(
            "slug_invalid",
            "memory slug must be kebab-case and match [a-z0-9-]{3,64}",
            Some(json!({
                "action": "write",
                "slug": normalize_slug_suggestion(input)
            })),
            None,
        ))
    }
}

fn normalize_daily_slug(input: &str) -> Result<String, String> {
    let slug = input.trim().to_lowercase();
    let re = Regex::new(r"^daily-\d{4}-\d{2}-\d{2}$").expect("valid daily slug regex");
    if re.is_match(&slug) {
        Ok(slug)
    } else {
        Err(error_json(
            "slug_invalid",
            "daily memory slug must be daily-YYYY-MM-DD",
            Some(
                json!({ "action": "update", "slug": format!("daily-{}", today_local(DEFAULT_ROLLOVER_HOUR)), "mode": "append" }),
            ),
            None,
        ))
    }
}

fn normalize_slug_suggestion(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.len() < 3 {
        "memory-note".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn is_daily_slug(input: &str) -> bool {
    input.trim().to_lowercase().starts_with("daily-")
}

fn normalize_write_scope(input: &str) -> Result<String, String> {
    match input.trim() {
        "global" => Ok("global".to_string()),
        "project" => Ok("project".to_string()),
        other => Err(error_json(
            "invalid_scope",
            &format!("invalid memory scope: {other}"),
            None,
            None,
        )),
    }
}

fn normalize_scope_filter(input: Option<&str>) -> Result<Option<String>, String> {
    match input.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("auto") => Ok(None),
        Some("global") => Ok(Some("global".to_string())),
        Some("project") => Ok(Some("project".to_string())),
        Some(other) => Err(error_json(
            "invalid_scope",
            &format!("invalid memory scope: {other}"),
            None,
            None,
        )),
    }
}

fn normalize_memory_type(input: &str) -> Result<String, String> {
    match input.trim() {
        "user" | "feedback" | "project" | "reference" => Ok(input.trim().to_string()),
        other => Err(error_json(
            "invalid_type",
            &format!("invalid memory type: {other}"),
            None,
            None,
        )),
    }
}

fn normalize_type_filter(input: &str) -> Result<String, String> {
    match input.trim() {
        "daily" => Ok("daily".to_string()),
        other => normalize_memory_type(other),
    }
}

fn normalize_search_type_filter(input: &str) -> Result<String, String> {
    match input.trim() {
        "daily" => Ok("daily".to_string()),
        other => normalize_memory_type(other),
    }
}

fn normalize_description(input: &str) -> Result<String, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err(error_json(
            "description_required",
            "memory description is required",
            None,
            None,
        ));
    }
    Ok(truncate_chars(value, MAX_DESCRIPTION_CHARS))
}

fn validate_body_limit(body: &str, max: usize, slug: &str) -> Result<(), String> {
    if body.as_bytes().len() <= max {
        return Ok(());
    }
    Err(error_json(
        "body_too_large",
        &format!("memory body for '{slug}' exceeds {} bytes", max),
        Some(json!({
            "action": "update",
            "slug": slug,
            "body": "<consolidated shorter body>"
        })),
        None,
    ))
}

fn push_batch_warning(
    warnings: &mut Vec<String>,
    warning_details: &mut Vec<MemoryBatchWarning>,
    raw: String,
    decision: Option<&MemoryDecisionArgs>,
    decision_index: Option<usize>,
    fallback_code: &str,
) {
    warning_details.push(batch_warning_from_raw(
        &raw,
        decision,
        decision_index,
        fallback_code,
    ));
    warnings.push(raw);
}

fn batch_warning_from_raw(
    raw: &str,
    decision: Option<&MemoryDecisionArgs>,
    decision_index: Option<usize>,
    fallback_code: &str,
) -> MemoryBatchWarning {
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.get("error").or_else(|| value.get("code")))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_code)
        .to_string();
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw)
        .to_string();
    let suggested_slug = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("suggested_next_call")
                .or_else(|| value.get("suggestedNextCall"))
        })
        .and_then(Value::as_object)
        .and_then(|value| value.get("slug"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string);
    MemoryBatchWarning {
        code,
        message,
        slug: suggested_slug.or_else(|| decision.map(|item| item.slug.clone())),
        op: decision.map(|item| item.op.clone()),
        group_id: decision.and_then(|item| item.group_id.clone()),
        decision_index,
        details: parsed.unwrap_or_else(|| json!({ "raw": raw })),
    }
}

fn optional_workdir_hash(workdir: Option<&str>) -> Result<Option<String>, String> {
    workdir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(workdir_hash)
        .transpose()
}

fn normalize_workdir_hash_input(workdir_hash: Option<&str>) -> Result<Option<String>, String> {
    let Some(hash) = workdir_hash
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let valid = hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err(error_json(
            "invalid_workdir_hash",
            "workdirHash must be a 16-character hex project id",
            None,
            None,
        ));
    }
    Ok(Some(hash.to_ascii_lowercase()))
}

fn required_workdir_hash(workdir: Option<&str>) -> Result<String, String> {
    let workdir = workdir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_json(
                "workdir_required",
                "project memory requires a workdir",
                None,
                None,
            )
        })?;
    workdir_hash(workdir)
}

fn workdir_hash(workdir: &str) -> Result<String, String> {
    let path = fs::canonicalize(workdir).unwrap_or_else(|_| PathBuf::from(workdir));
    let normalized = path.to_string_lossy();
    let digest = Sha256::digest(normalized.as_bytes());
    Ok(to_hex(&digest)[..16].to_string())
}

fn workdir_paths_match(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    to_hex(&digest)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn today_local(rollover_hour: u32) -> NaiveDate {
    let now = Local::now();
    let hour = rollover_hour.min(23);
    let mut date = now.date_naive();
    if now.hour() < hour {
        date = date.pred_opt().unwrap_or(date);
    }
    date
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}

fn system_time_to_ms(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

fn format_rfc3339(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    Utc.timestamp_opt(seconds, millis * 1_000_000)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn parse_rfc3339_ms(input: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(input)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn normalize_source_json(
    existing: Value,
    unreviewed: bool,
    actor: &str,
    conversation_id: Option<&str>,
    trigger: Option<&str>,
    model: Option<&str>,
    risk_flag: Option<&str>,
) -> Value {
    let mut obj = existing.as_object().cloned().unwrap_or_default();
    obj.insert("trigger".to_string(), Value::String(actor.to_string()));
    obj.insert("unreviewed".to_string(), Value::Bool(unreviewed));
    if let Some(conversation_id) = conversation_id.filter(|value| !value.is_empty()) {
        obj.insert(
            "conversationId".to_string(),
            Value::String(conversation_id.to_string()),
        );
    }
    if let Some(trigger) = trigger.filter(|value| !value.is_empty()) {
        obj.insert("lifecycle".to_string(), Value::String(trigger.to_string()));
    }
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        obj.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(risk_flag) = risk_flag.filter(|value| !value.is_empty()) {
        obj.insert(
            "risk_flag".to_string(),
            Value::String(risk_flag.to_string()),
        );
    } else {
        obj.remove("risk_flag");
    }
    Value::Object(obj)
}

fn append_daily_source(
    existing: Value,
    conversation_id: Option<&str>,
    trigger: Option<&str>,
    model: Option<&str>,
) -> Value {
    let mut items = existing.as_array().cloned().unwrap_or_default();
    items.push(json!({
        "conversationId": conversation_id.unwrap_or(""),
        "appendedAt": format_rfc3339(now_ms()),
        "trigger": trigger.unwrap_or("end"),
        "model": model.unwrap_or("")
    }));
    Value::Array(items)
}

fn atomic_write(target: &Path, content: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("目标路径没有父目录：{}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("创建临时记忆文件失败：{e}"))?;
    tmp.write_all(content)
        .map_err(|e| format!("写入临时记忆文件失败：{e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("fsync 临时记忆文件失败：{e}"))?;
    tmp.persist(target)
        .map_err(|e| format!("替换记忆文件失败：{}", e.error))?;
    if let Ok(parent_file) = File::open(parent) {
        let _ = parent_file.sync_all();
    }
    Ok(())
}

fn render_scope_index<'a>(
    dir: &Path,
    entries: impl Iterator<Item = &'a MemoryMeta>,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建 MEMORY.md 目录失败：{e}"))?;
    let mut rows = entries
        .filter(|entry| entry.memory_type != "daily")
        .cloned()
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.slug.cmp(&b.slug))
    });
    let mut lines = vec![
        "# MEMORY",
        "",
        "This file is auto-generated by LiveAgent. Edit individual memory Markdown files instead.",
        "",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    for entry in rows {
        let marker = if entry.unreviewed {
            " (unreviewed)"
        } else {
            ""
        };
        lines.push(format!(
            "- [{}] type={}{} — {}",
            entry.slug, entry.memory_type, marker, entry.description
        ));
    }
    lines.push(String::new());
    atomic_write(&dir.join("MEMORY.md"), lines.join("\n").as_bytes())
}

fn overview_entry(entry: &MemoryMeta) -> MemoryOverviewEntry {
    MemoryOverviewEntry {
        slug: entry.slug.clone(),
        scope: entry.scope.clone(),
        memory_type: entry.memory_type.clone(),
        description: entry.description.clone(),
        headline: entry.headline.clone(),
        date_local: entry.date_local.clone(),
        updated_at: entry.updated_at,
        unreviewed: entry.unreviewed,
        confidence: entry.confidence.clone(),
    }
}

fn fuzzy_candidates(conn: &Connection, slug: &str) -> Result<Vec<Value>, String> {
    let pattern = format!("%{}%", slug.replace('-', "%"));
    let mut stmt = conn
        .prepare(
            "SELECT slug, scope FROM memory_meta WHERE slug LIKE ?1 ORDER BY updated_at DESC LIMIT 3",
        )
        .map_err(|e| format!("准备记忆候选查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![pattern], |row| {
            Ok(json!({
                "slug": row.get::<_, String>(0)?,
                "scope": row.get::<_, String>(1)?
            }))
        })
        .map_err(|e| format!("查询记忆候选失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取记忆候选失败：{e}"))
}

fn detect_sync_root(path: &Path) -> (bool, Option<String>) {
    let text = path.to_string_lossy().to_lowercase();
    for (needle, provider) in [
        ("mobile documents", "iCloud"),
        ("icloud", "iCloud"),
        ("dropbox", "Dropbox"),
        ("onedrive", "OneDrive"),
        ("google drive", "Google Drive"),
    ] {
        if text.contains(needle) {
            return (true, Some(provider.to_string()));
        }
    }
    (false, None)
}

fn error_json(
    code: &str,
    message: &str,
    suggested_next_call: Option<Value>,
    candidates: Option<Vec<Value>>,
) -> String {
    let mut value = json!({
        "error": code,
        "message": message
    });
    if let Some(suggested_next_call) = suggested_next_call {
        value["suggested_next_call"] = suggested_next_call;
    }
    if let Some(candidates) = candidates {
        value["candidates"] = Value::Array(candidates);
    }
    serde_json::to_string(&value).unwrap_or_else(|_| message.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RiskClass {
    None,
    Soft,
    Hard,
}

fn classify_risk(body: &str) -> RiskClass {
    let hard_patterns = [
        r"-----BEGIN .* PRIVATE KEY-----",
        r"AKIA[0-9A-Z]{16}",
        r"sk-ant-api03-[0-9A-Za-z-_]{40,}",
        r"ghp_[0-9A-Za-z]{36}",
        r"xoxb-[0-9A-Za-z-]+",
        r"github_pat_[0-9A-Za-z_]{82,}",
    ];
    for pattern in hard_patterns {
        if Regex::new(pattern)
            .expect("valid hard risk regex")
            .is_match(body)
        {
            return RiskClass::Hard;
        }
    }
    let soft_patterns = [
        r"(?i)bypass\s+auth|disable\s+validation|override\s+safety|ignore\s+previous\s+instructions",
        r"(?i)\bsudo\b|\bexec\s*\(|\beval\s*\(|--no-verify",
    ];
    for pattern in soft_patterns {
        if Regex::new(pattern)
            .expect("valid soft risk regex")
            .is_match(body)
        {
            return RiskClass::Soft;
        }
    }
    RiskClass::None
}

fn apply_risk_policy(slug: &str, body: &str, options: &mut WriteOptions) -> Result<(), String> {
    match classify_risk(body) {
        RiskClass::None => Ok(()),
        RiskClass::Soft => {
            options.unreviewed = true;
            options.risk_flag = Some("low".to_string());
            Ok(())
        }
        RiskClass::Hard => Err(error_json(
            "risk_hard_blocked",
            &format!("memory '{slug}' contains high-risk secret-like content and was not stored"),
            None,
            None,
        )),
    }
}

fn truncate_chars(input: &str, max: usize) -> String {
    input.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn test_store() -> MemoryStore {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("memory");
        ensure_root_dirs(&root).expect("root dirs");
        let db_path = root.join(DB_FILENAME);
        let conn = open_memory_connection(&db_path).expect("open db");
        let store = MemoryStore {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        std::mem::forget(temp);
        store
    }

    #[test]
    fn organize_runs_claim_update_and_list_history() {
        let store = test_store();
        let created = store
            .organize_run_create(MemoryOrganizeRunCreateArgs {
                trigger: "manual".to_string(),
                due_at: None,
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("all".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("create organize run");
        assert!(created.accepted);
        assert!(!created.already_running);
        let run_id = created.run.expect("created run").run_id;

        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(false),
                due_at: None,
                now: Some(1_000),
                model: None,
                scope: None,
                mode: None,
            })
            .expect("claim pending run");
        let claimed_run = claimed.run.expect("claimed run");
        assert_eq!(claimed_run.run_id, run_id);
        assert_eq!(claimed_run.status, "running");
        assert_eq!(claimed_run.started_at, Some(1_000));

        let duplicate = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(1_000),
                now: Some(1_000),
                model: None,
                scope: None,
                mode: None,
            })
            .expect("duplicate claim");
        let skipped = duplicate.run.expect("skipped scheduled run");
        assert_eq!(skipped.status, "skipped");
        assert_eq!(skipped.trigger, "scheduled");
        assert_eq!(duplicate.skipped_reason.as_deref(), Some("already_running"));

        let duplicate_again = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(1_000),
                now: Some(1_001),
                model: None,
                scope: None,
                mode: None,
            })
            .expect("duplicate skipped claim");
        let skipped_again = duplicate_again.run.expect("deduped skipped scheduled run");
        assert_eq!(skipped_again.run_id, skipped.run_id);
        assert_eq!(
            duplicate_again.skipped_reason.as_deref(),
            Some("already_running")
        );

        let updated = store
            .organize_run_update(MemoryOrganizeRunUpdateArgs {
                run_id: run_id.clone(),
                status: Some("succeeded".to_string()),
                started_at: None,
                finished_at: Some(2_000),
                input_count: Some(12),
                cluster_count: Some(2),
                safe_applied: Some(3),
                review_skipped: Some(1),
                created_count: Some(0),
                updated_count: Some(2),
                deleted_count: Some(1),
                merged_count: Some(1),
                parse_failures: Some(0),
                error: None,
                final_summary: Some("整理完成".to_string()),
                trimmed_protocol: Some(json!({ "clusterSummaries": ["完成"] })),
            })
            .expect("update run")
            .expect("updated run");
        assert_eq!(updated.status, "succeeded");
        assert_eq!(updated.final_summary.as_deref(), Some("整理完成"));
        assert_eq!(updated.safe_applied, 3);

        let list = store
            .organize_run_list(MemoryOrganizeRunListArgs {
                status: None,
                limit: Some(10),
            })
            .expect("list runs");
        assert_eq!(list.runs.len(), 2);
        assert!(list.runs.iter().any(|run| run.run_id == run_id));
        assert!(list.runs.iter().any(|run| run.status == "skipped"));
    }

    #[test]
    fn organize_run_clear_history_deletes_finished_and_retains_active() {
        let store = test_store();
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "pending-run",
                "manual",
                "pending",
                1_000,
                None,
                None,
                None,
                None,
                None,
                "all",
                "standard",
            )
            .expect("insert pending run");
            insert_organize_run(
                &conn,
                "running-run",
                "scheduled",
                "running",
                1_001,
                Some(1_001),
                None,
                Some(1_000),
                Some(1_001),
                None,
                "global",
                "standard",
            )
            .expect("insert running run");
            insert_organize_run(
                &conn,
                "succeeded-run",
                "manual",
                "succeeded",
                1_002,
                Some(1_002),
                Some(1_003),
                None,
                None,
                None,
                "all",
                "standard",
            )
            .expect("insert succeeded run");
            insert_organize_run(
                &conn,
                "failed-run",
                "manual",
                "failed",
                1_004,
                Some(1_004),
                Some(1_005),
                None,
                None,
                None,
                "all",
                "standard",
            )
            .expect("insert failed run");
        }

        let cleared = store
            .organize_run_clear_history()
            .expect("clear organize history");
        assert_eq!(cleared.deleted_count, 2);
        assert_eq!(cleared.retained_active_count, 2);

        let list = store
            .organize_run_list(MemoryOrganizeRunListArgs {
                status: None,
                limit: Some(10),
            })
            .expect("list retained runs");
        let retained: Vec<_> = list.runs.iter().map(|run| run.run_id.as_str()).collect();
        assert_eq!(retained.len(), 2);
        assert!(retained.contains(&"pending-run"));
        assert!(retained.contains(&"running-run"));
    }

    #[test]
    fn organize_run_create_reaps_stale_active_run() {
        let store = test_store();
        let stale_at = now_ms() - ORGANIZE_RUN_STALE_AFTER_MS - 1_000;
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "stale-running-run",
                "manual",
                "running",
                stale_at,
                Some(stale_at),
                None,
                None,
                Some(stale_at),
                None,
                "all",
                "standard",
            )
            .expect("insert stale running run");
        }

        let created = store
            .organize_run_create(MemoryOrganizeRunCreateArgs {
                trigger: "manual".to_string(),
                due_at: None,
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("all".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("create after stale run");
        assert!(created.accepted);
        assert!(!created.already_running);
        assert!(created.run.is_some());

        let stale = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "stale-running-run".to_string(),
            })
            .expect("read stale run")
            .expect("stale run exists");
        assert_eq!(stale.status, "failed");
        assert_eq!(stale.error.as_deref(), Some("stale_timeout"));
        assert_eq!(
            stale.final_summary.as_deref(),
            Some(ORGANIZE_RUN_STALE_SUMMARY)
        );
        assert!(stale.finished_at.is_some());
    }

    #[test]
    fn organize_run_create_keeps_fresh_active_run_blocking() {
        let store = test_store();
        let fresh_at = now_ms();
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "fresh-running-run",
                "manual",
                "running",
                fresh_at,
                Some(fresh_at),
                None,
                None,
                Some(fresh_at),
                None,
                "all",
                "standard",
            )
            .expect("insert fresh running run");
        }

        let created = store
            .organize_run_create(MemoryOrganizeRunCreateArgs {
                trigger: "manual".to_string(),
                due_at: None,
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("all".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("create blocked by fresh run");
        assert!(!created.accepted);
        assert!(created.already_running);
        assert_eq!(
            created.active_run.as_ref().map(|run| run.run_id.as_str()),
            Some("fresh-running-run")
        );

        let fresh = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "fresh-running-run".to_string(),
            })
            .expect("read fresh run")
            .expect("fresh run exists");
        assert_eq!(fresh.status, "running");
        assert_eq!(fresh.error, None);
    }

    #[test]
    fn organize_due_claim_creates_scheduled_run_when_due() {
        let store = test_store();
        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(1_000),
                now: Some(2_000),
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("global".to_string()),
                mode: Some("conservative".to_string()),
            })
            .expect("claim scheduled run");
        let run = claimed.run.expect("scheduled run");
        assert_eq!(run.trigger, "scheduled");
        assert_eq!(run.status, "running");
        assert_eq!(run.scope, "global");
        assert_eq!(run.mode, "conservative");
        assert_eq!(run.due_at, Some(1_000));
    }

    #[test]
    fn organize_due_claim_reaps_stale_running_run_before_scheduled_claim() {
        let store = test_store();
        let stale_at = 1_000;
        let now = stale_at + ORGANIZE_RUN_STALE_AFTER_MS + 1;
        let due_at = now - 1_000;
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "stale-scheduled-run",
                "scheduled",
                "running",
                stale_at,
                Some(stale_at),
                None,
                Some(stale_at),
                Some(stale_at),
                None,
                "global",
                "standard",
            )
            .expect("insert stale scheduled run");
        }

        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(due_at),
                now: Some(now),
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("global".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("claim scheduled run after stale reap");
        let run = claimed.run.expect("new scheduled run");
        assert_eq!(claimed.skipped_reason, None);
        assert_ne!(run.run_id, "stale-scheduled-run");
        assert_eq!(run.trigger, "scheduled");
        assert_eq!(run.status, "running");
        assert_eq!(run.due_at, Some(due_at));

        let stale = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "stale-scheduled-run".to_string(),
            })
            .expect("read stale scheduled run")
            .expect("stale scheduled run exists");
        assert_eq!(stale.status, "failed");
        assert_eq!(stale.error.as_deref(), Some("stale_timeout"));
    }

    #[test]
    fn organize_due_claim_reaps_stale_running_run_even_when_not_due() {
        let store = test_store();
        let stale_at = 1_000;
        let now = stale_at + ORGANIZE_RUN_STALE_AFTER_MS + 1;
        {
            let conn = store.lock_conn().expect("lock conn");
            insert_organize_run(
                &conn,
                "stale-not-due-run",
                "scheduled",
                "running",
                stale_at,
                Some(stale_at),
                None,
                Some(stale_at + ORGANIZE_RUN_STALE_AFTER_MS + 60_000),
                Some(stale_at),
                None,
                "global",
                "standard",
            )
            .expect("insert stale not-due run");
        }

        let claimed = store
            .organize_due_claim(MemoryOrganizeDueClaimArgs {
                enabled: Some(true),
                due_at: Some(now + 60_000),
                now: Some(now),
                model: Some(json!({ "customProviderId": "provider-1", "model": "gpt-5" })),
                scope: Some("global".to_string()),
                mode: Some("standard".to_string()),
            })
            .expect("claim before next due after stale reap");
        assert!(claimed.run.is_none());
        assert_eq!(claimed.skipped_reason, None);

        let stale = store
            .organize_run_read(MemoryOrganizeRunReadArgs {
                run_id: "stale-not-due-run".to_string(),
            })
            .expect("read stale not-due run")
            .expect("stale not-due run exists");
        assert_eq!(stale.status, "failed");
        assert_eq!(stale.error.as_deref(), Some("stale_timeout"));
    }

    #[test]
    fn init_schema_rebuilds_legacy_v1_cache_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("memory");
        ensure_root_dirs(&root).expect("root dirs");
        let memory_file = root.join("global").join("user").join("user-legacy.md");
        fs::write(
            &memory_file,
            [
                "---",
                "name: user-legacy",
                "type: user",
                "scope: global",
                "description: legacy user memory",
                "createdAt: 2026-05-01T00:00:00Z",
                "updatedAt: 2026-05-01T00:00:00Z",
                "---",
                "legacy body",
            ]
            .join("\n"),
        )
        .expect("write legacy memory file");

        let db_path = root.join(DB_FILENAME);
        let legacy = Connection::open(&db_path).expect("open legacy db");
        legacy
            .execute_batch(
                r#"
                CREATE TABLE memory_meta (
                    scope TEXT NOT NULL,
                    workdir_hash TEXT NOT NULL DEFAULT '',
                    slug TEXT NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
                    description TEXT NOT NULL DEFAULT '',
                    body_hash TEXT NOT NULL,
                    file_mtime INTEGER NOT NULL,
                    file_size INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    source_json TEXT,
                    links_json TEXT,
                    PRIMARY KEY (scope, workdir_hash, slug)
                );
                CREATE VIRTUAL TABLE memory_fts USING fts5(
                    slug UNINDEXED,
                    scope UNINDEXED,
                    workdir_hash UNINDEXED,
                    type,
                    description,
                    body
                );
                CREATE VIRTUAL TABLE memory_fts_tri USING fts5(
                    slug UNINDEXED,
                    scope UNINDEXED,
                    workdir_hash UNINDEXED,
                    body,
                    tokenize = "trigram"
                );
                CREATE TABLE memory_schema_version (
                    version INTEGER PRIMARY KEY,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO memory_schema_version (version, applied_at) VALUES (1, 0);
                "#,
            )
            .expect("create legacy schema");
        drop(legacy);

        let conn = open_memory_connection(&db_path).expect("open migrated db");
        let store = MemoryStore {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        store.reconcile().expect("reconcile legacy files");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-legacy".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read migrated memory");
        assert_eq!(read.body, "legacy body");

        let conn = store.lock_conn().expect("lock migrated db");
        let version = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM memory_schema_version",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("schema version");
        assert_eq!(version, 3);
        let meta_columns = table_columns(&conn, "memory_meta").expect("memory_meta columns");
        assert!(meta_columns.contains("archived"));
        let trigram_columns = table_columns(&conn, "memory_fts_tri").expect("trigram columns");
        assert!(trigram_columns.contains("description"));
        assert!(trigram_columns.contains("headline"));
    }

    #[test]
    fn write_read_and_search_global_user_memory() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-name".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户叫 Kevin".to_string(),
                body: "用户的名字是 Kevin，是计算机专业的大学生。".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write memory");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-name".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read memory");
        assert!(read.body.contains("Kevin"));

        let search = store
            .search(MemorySearchArgs {
                query: "我是谁".to_string(),
                scope: None,
                workdir: None,
                memory_type: None,
                limit: None,
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search memory");
        assert!(
            search.matches.iter().any(|item| item.slug == "user-name"),
            "identity query should find user-name: {:?}",
            search.matches
        );
    }

    #[test]
    fn list_quota_reports_applicable_scope_usage() {
        let store = test_store();
        let workdir = tempfile::tempdir().expect("workdir");
        let workdir_text = workdir.path().to_string_lossy().to_string();
        let workdir_hash = workdir_hash(&workdir_text).expect("workdir hash");

        store
            .write(MemoryWriteArgs {
                slug: "user-style".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "feedback".to_string(),
                description: "全局偏好".to_string(),
                body: "用户偏好中文回答。".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write global memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-purpose".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_text.clone()),
                memory_type: "project".to_string(),
                description: "项目目标".to_string(),
                body: "当前项目是 LiveAgent。".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project memory");
        store
            .update(MemoryUpdateArgs {
                slug: "daily-2026-05-18".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("- daily does not count toward ordinary quota".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("append daily");

        let list = store
            .list(MemoryListArgs {
                scope: None,
                workdir: Some(workdir_text),
                include_all_projects: None,
                memory_type: None,
                include_daily: Some(true),
                limit: None,
                offset: None,
            })
            .expect("list memories");

        assert_eq!(list.quota.used, 1);
        assert_eq!(list.quota.limit, MAX_SCOPE_ENTRIES);
        assert_eq!(list.quota.scope_quotas.len(), 2);
        assert!(list.quota.scope_quotas.iter().any(|quota| {
            quota.scope == "global" && quota.workdir_hash.is_empty() && quota.used == 1
        }));
        assert!(list.quota.scope_quotas.iter().any(|quota| {
            quota.scope == "project" && quota.workdir_hash == workdir_hash && quota.used == 1
        }));
    }

    #[test]
    fn list_all_projects_returns_project_paths_and_hash_read_works() {
        let store = test_store();
        let workdir_a = tempfile::tempdir().expect("workdir a");
        let workdir_b = tempfile::tempdir().expect("workdir b");
        let workdir_a_text = workdir_a.path().to_string_lossy().to_string();
        let workdir_b_text = workdir_b.path().to_string_lossy().to_string();
        let workdir_a_hash = workdir_hash(&workdir_a_text).expect("workdir a hash");
        let workdir_b_hash = workdir_hash(&workdir_b_text).expect("workdir b hash");

        store
            .write(MemoryWriteArgs {
                slug: "project-a-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 A 说明".to_string(),
                body: "project A body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project a memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-b-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 B 说明".to_string(),
                body: "project B body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project b memory");

        let list = store
            .list(MemoryListArgs {
                scope: None,
                workdir: None,
                include_all_projects: Some(true),
                memory_type: None,
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list all project memories");

        assert!(list.entries.iter().any(|entry| {
            entry.slug == "project-a-note"
                && entry.workdir_hash == workdir_a_hash
                && entry.workdir_path.as_deref() == Some(workdir_a_text.as_str())
        }));
        assert!(list.entries.iter().any(|entry| {
            entry.slug == "project-b-note"
                && entry.workdir_hash == workdir_b_hash
                && entry.workdir_path.as_deref() == Some(workdir_b_text.as_str())
        }));

        let read = store
            .read(MemoryReadArgs {
                slug: "project-b-note".to_string(),
                scope: Some("project".to_string()),
                workdir: None,
                workdir_hash: Some(workdir_b_hash),
                offset: None,
                length: None,
            })
            .expect("read project memory by workdir hash");
        assert_eq!(read.body, "project B body");
    }

    #[test]
    fn delete_project_removes_only_matching_project_memory() {
        let store = test_store();
        let workdir_a = tempfile::tempdir().expect("workdir a");
        let workdir_b = tempfile::tempdir().expect("workdir b");
        let workdir_a_text = workdir_a.path().to_string_lossy().to_string();
        let workdir_b_text = workdir_b.path().to_string_lossy().to_string();
        let workdir_a_hash = workdir_hash(&workdir_a_text).expect("workdir a hash");
        let workdir_b_hash = workdir_hash(&workdir_b_text).expect("workdir b hash");

        store
            .write(MemoryWriteArgs {
                slug: "global-note".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "全局说明".to_string(),
                body: "global body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write global memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-a-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 A 说明".to_string(),
                body: "project A body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project a memory");
        store
            .write(MemoryWriteArgs {
                slug: "project-b-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b_text.clone()),
                memory_type: "project".to_string(),
                description: "项目 B 说明".to_string(),
                body: "project B body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project b memory");

        let project_a_dir = store.projects_dir().join(&workdir_a_hash);
        assert!(project_a_dir.exists());

        let deleted = store
            .delete_project(MemoryDeleteProjectArgs {
                workdir: workdir_a_text,
                actor: Some("tool".to_string()),
                reason: Some("workspace removal".to_string()),
            })
            .expect("delete project memory");

        assert_eq!(deleted.workdir_hash, workdir_a_hash);
        assert_eq!(deleted.deleted_count, 1);
        let quarantine_path = deleted
            .quarantine_path
            .as_deref()
            .map(PathBuf::from)
            .expect("quarantine path");
        assert!(!project_a_dir.exists());
        assert!(quarantine_path.exists());
        assert!(quarantine_path.join("project-a-note.md").exists());

        let list = store
            .list(MemoryListArgs {
                scope: None,
                workdir: None,
                include_all_projects: Some(true),
                memory_type: None,
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list memories after project delete");
        assert!(!list
            .entries
            .iter()
            .any(|entry| entry.slug == "project-a-note"));
        assert!(list.entries.iter().any(|entry| {
            entry.slug == "project-b-note" && entry.workdir_hash == workdir_b_hash
        }));
        assert!(list.entries.iter().any(|entry| entry.slug == "global-note"));
        store
            .read(MemoryReadArgs {
                slug: "project-a-note".to_string(),
                scope: Some("project".to_string()),
                workdir: None,
                workdir_hash: Some(deleted.workdir_hash),
                offset: None,
                length: None,
            })
            .expect_err("deleted project memory should not be readable");
    }

    #[cfg(unix)]
    #[test]
    fn delete_project_uses_workdir_marker_when_path_no_longer_canonicalizes() {
        use std::os::unix::fs::symlink;

        let store = test_store();
        let real_workdir = tempfile::tempdir().expect("real workdir");
        let link_parent = tempfile::tempdir().expect("link parent");
        let link_path = link_parent.path().join("project-link");
        symlink(real_workdir.path(), &link_path).expect("create workdir symlink");
        let link_text = link_path.to_string_lossy().to_string();
        let canonical_hash = workdir_hash(&link_text).expect("canonical workdir hash");

        store
            .write(MemoryWriteArgs {
                slug: "symlink-project-note".to_string(),
                scope: "project".to_string(),
                workdir: Some(link_text.clone()),
                memory_type: "project".to_string(),
                description: "symlink project".to_string(),
                body: "project body".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write symlink project memory");
        assert!(store.projects_dir().join(&canonical_hash).exists());

        fs::remove_file(&link_path).expect("remove workdir symlink");
        let raw_hash = workdir_hash(&link_text).expect("raw workdir hash");
        assert_ne!(raw_hash, canonical_hash);

        let deleted = store
            .delete_project(MemoryDeleteProjectArgs {
                workdir: link_text,
                actor: Some("tool".to_string()),
                reason: Some("workspace removal".to_string()),
            })
            .expect("delete symlink project memory");

        assert_eq!(deleted.workdir_hash, canonical_hash);
        assert_eq!(deleted.deleted_count, 1);
        assert!(!store.projects_dir().join(&canonical_hash).exists());
    }

    #[test]
    fn read_missing_daily_suggests_time_filtered_history_search() {
        let store = test_store();
        let error = store
            .read(MemoryReadArgs {
                slug: "daily-2026-05-13".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect_err("missing daily should return a structured error");
        let value: Value = serde_json::from_str(&error).expect("structured memory error");
        let suggested = value
            .get("suggested_next_call")
            .expect("missing daily should suggest a next call");

        assert_eq!(value["error"], "slug_not_found");
        assert_eq!(suggested["action"], "search");
        assert_eq!(suggested["query"], "2026-05-13");
        assert_eq!(suggested["include_history"], true);
        assert_eq!(suggested["history_date_local"], "2026-05-13");
        assert_eq!(suggested["history_time_mode"], "message");
        assert!(suggested.get("filter_type").is_none());
        assert!(suggested.get("type").is_none());
    }

    #[test]
    fn build_snippet_handles_cjk_byte_offsets() {
        let body = format!("{}但{}", "记".repeat(1069), "后续".repeat(80));
        let snippet = build_snippet(&body, &["但".to_string()]);

        assert!(snippet.contains("但"));
        assert!(snippet.is_char_boundary(snippet.len()));
    }

    #[test]
    fn daily_append_updates_single_file() {
        let store = test_store();
        let slug = "daily-2026-05-13".to_string();
        store
            .update(MemoryUpdateArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("## 10:00 — conversation test — liveagent\n- 写入 daily".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: Some("conversation-a".to_string()),
                model: Some("model-a".to_string()),
            })
            .expect("append daily");
        store
            .update(MemoryUpdateArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("## 11:00 — conversation test — liveagent\n- 完成验证".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: Some("conversation-b".to_string()),
                model: Some("model-b".to_string()),
            })
            .expect("append daily again");

        let read = store
            .read(MemoryReadArgs {
                slug,
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read daily");
        assert_eq!(read.headline, "2026-05-13");
        assert_eq!(read.meta.archived, false);
        assert!(read.body.contains("10:00"));
        assert!(read.body.contains("11:00"));
        let sources = read
            .meta
            .source
            .as_array()
            .expect("daily source should be a source array");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0]["conversationId"], "conversation-a");
        assert_eq!(sources[0]["trigger"], "end");
        assert_eq!(sources[0]["model"], "model-a");
        assert_eq!(sources[1]["conversationId"], "conversation-b");
        assert_eq!(sources[1]["trigger"], "end");
        assert_eq!(sources[1]["model"], "model-b");
    }

    #[test]
    fn list_daily_filter_includes_daily_entries_without_include_daily_flag() {
        let store = test_store();
        store
            .update(MemoryUpdateArgs {
                slug: "daily-2026-05-13".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("- daily entry".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("append daily");

        let list = store
            .list(MemoryListArgs {
                scope: Some("global".to_string()),
                workdir: None,
                include_all_projects: None,
                memory_type: Some("daily".to_string()),
                include_daily: None,
                limit: None,
                offset: None,
            })
            .expect("list daily memories");

        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].slug, "daily-2026-05-13");
        assert_eq!(list.entries[0].memory_type, "daily");
    }

    #[test]
    fn reconcile_archives_old_daily_files() {
        let store = test_store();
        let slug = "daily-2000-01-01".to_string();
        store
            .update(MemoryUpdateArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("- old daily entry".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: Some("conversation-old".to_string()),
                model: Some("model-old".to_string()),
            })
            .expect("append old daily");

        store.reconcile().expect("reconcile archives old daily");

        assert!(!store.global_daily_dir().join("2000-01-01.md").exists());
        assert!(store
            .global_daily_dir()
            .join(".archive")
            .join("2000")
            .join("2000-01-01.md")
            .exists());
        let read = store
            .read(MemoryReadArgs {
                slug,
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read archived daily");
        assert!(read.meta.archived);
    }

    #[test]
    fn merge_update_preserves_unrelated_trip_details() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "北京找朋友玩的出行计划".to_string(),
                body: [
                    "---",
                    r#"confidence: high"#,
                    r#"source_quote: "请你记住我的计划""#,
                    r#"reasoning: "用户明确要求记住北京出行计划""#,
                    "aliases: []",
                    "conflicts_with: []",
                    r#"supersedes: """#,
                    r#"override_reject: """#,
                    "---",
                    "",
                    "7月去北京找朋友玩的出行计划。",
                    "可能会去找大学同学，也有可能去找我的导师，但是一定会去故宫玩一玩。",
                    "第一天故宫，第二天长城，第三天回去。",
                ]
                .join("\n"),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write original trip plan");

        store
            .update(MemoryUpdateArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: Some("user".to_string()),
                description: Some("北京找朋友玩的出行计划（7月改至8月）".to_string()),
                body: Some(
                    [
                        "---",
                        r#"confidence: medium"#,
                        r#"source_quote: "本来打算7月份去北京玩，但是现在要改到8月了，因为工作很忙""#,
                        r#"reasoning: "用户明确修正了出发月份""#,
                        "aliases: []",
                        "conflicts_with: []",
                        r#"supersedes: """#,
                        r#"override_reject: """#,
                        "---",
                        "",
                        "8月去北京找朋友玩的出行计划，原计划7月但因工作忙推迟到8月。",
                    ]
                    .join("\n"),
                ),
                mode: Some("merge".to_string()),
                actor: Some("extractor".to_string()),
                conversation_id: Some("conversation-merge".to_string()),
                model: Some("model-merge".to_string()),
            })
            .expect("merge update trip plan");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read merged trip plan");

        assert!(read.body.contains("8月去北京找朋友玩的出行计划"));
        assert!(read.body.contains("第一天故宫，第二天长城，第三天回去"));
        assert!(read.body.contains("一定会去故宫玩一玩"));
        assert!(!read.body.contains("7月去北京找朋友玩的出行计划。"));
    }

    #[test]
    fn extractor_update_defaults_to_merge_when_mode_is_omitted() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "北京找朋友玩的出行计划".to_string(),
                body: [
                    "7月去北京找朋友玩的出行计划。",
                    "第一天故宫，第二天长城，第三天回去。",
                ]
                .join("\n"),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write original trip plan");

        store
            .update(MemoryUpdateArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: Some("user".to_string()),
                description: Some("北京找朋友玩的出行计划（7月改至8月）".to_string()),
                body: Some(
                    "8月去北京找朋友玩的出行计划，原计划7月但因工作忙推迟到8月。".to_string(),
                ),
                mode: None,
                actor: Some("extractor".to_string()),
                conversation_id: Some("conversation-default-merge".to_string()),
                model: Some("model-default-merge".to_string()),
            })
            .expect("extractor update defaults to merge");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read merged trip plan");

        assert!(read.body.contains("8月去北京找朋友玩的出行计划"));
        assert!(read.body.contains("第一天故宫，第二天长城，第三天回去"));
    }

    #[test]
    fn confidence_only_update_refreshes_evidence_without_rewriting_body() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-major".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户专业信息".to_string(),
                body: [
                    "---",
                    r#"confidence: low"#,
                    r#"source_quote: "可能是计算机专业""#,
                    r#"reasoning: "早期推断""#,
                    "---",
                    "",
                    "用户可能是计算机专业学生。",
                ]
                .join("\n"),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write low-confidence user memory");

        store
            .update(MemoryUpdateArgs {
                slug: "user-major".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some(
                    [
                        "---",
                        r#"confidence: medium"#,
                        r#"source_quote: "我是计算机专业学生""#,
                        r#"reasoning: "用户在后续轮次自然复述了专业信息""#,
                        "---",
                    ]
                    .join("\n"),
                ),
                mode: Some("merge".to_string()),
                actor: Some("extractor".to_string()),
                conversation_id: Some("conversation-confidence".to_string()),
                model: Some("model-confidence".to_string()),
            })
            .expect("confidence-only update");

        let read = store
            .read(MemoryReadArgs {
                slug: "user-major".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read confidence-updated memory");
        assert!(read.meta.unreviewed);
        assert_eq!(read.meta.confidence, "medium");
        assert!(read.body.contains("confidence: medium"));
        assert!(read.body.contains("用户可能是计算机专业学生。"));
        assert!(!read.body.contains("confidence: low"));
    }

    #[test]
    fn apply_batch_slug_exists_uses_merge_for_partial_corrections() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "北京找朋友玩的出行计划".to_string(),
                body: [
                    "7月去北京找朋友玩的出行计划。",
                    "第一天故宫，第二天长城，第三天回去。",
                ]
                .join("\n"),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write original trip plan");

        let response = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: Some("conversation-batch".to_string()),
                trigger: Some("end".to_string()),
                model: Some("deepseek-v4-flash".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "user-beijing-trip-plan".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("北京找朋友玩的出行计划（7月改至8月）".to_string()),
                    body: Some(
                        "8月去北京找朋友玩的出行计划，原计划7月但因工作忙推迟到8月。".to_string(),
                    ),
                    reason: None,
                    group_id: None,
                }]),
            })
            .expect("apply batch update");

        assert_eq!(response.created, Vec::<String>::new());
        assert_eq!(response.updated, vec!["user-beijing-trip-plan".to_string()]);

        let read = store
            .read(MemoryReadArgs {
                slug: "user-beijing-trip-plan".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read merged batch plan");

        assert!(read.body.contains("8月去北京找朋友玩的出行计划"));
        assert!(read.body.contains("第一天故宫，第二天长城，第三天回去"));
    }

    #[test]
    fn reviewed_user_memory_outranks_conflicting_daily_journal() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "kevin-accent".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户口音偏好".to_string(),
                body: "用户 Kevin 之前让我用北京腔说话，后来改成要求用陕西口音交流，不习惯北京腔。"
                    .to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write user memory");
        store
            .update(MemoryUpdateArgs {
                slug: "daily-2026-05-14".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                memory_type: None,
                description: None,
                body: Some("## 07:19\n- User: 我希望你在跟我交流的时候带点北京腔儿～".to_string()),
                mode: Some("append".to_string()),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("append conflicting daily");

        let search = store
            .search(MemorySearchArgs {
                query: "北京腔".to_string(),
                scope: None,
                workdir: None,
                memory_type: None,
                limit: Some(8),
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search accent memory");

        let user_index = search
            .matches
            .iter()
            .position(|item| item.slug == "kevin-accent")
            .expect("user memory should match");
        let daily_index = search
            .matches
            .iter()
            .position(|item| item.slug == "daily-2026-05-14")
            .expect("daily should match");
        assert!(
            user_index < daily_index,
            "reviewed user preference should outrank daily journal: {:?}",
            search.matches
        );
        assert!(search.matches[user_index].score > search.matches[daily_index].score);
    }

    #[test]
    fn search_recovers_after_poisoned_sqlite_mutex() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-concurrency".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "并发搜索恢复测试".to_string(),
                body: "memory sqlite mutex poison recovery marker".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write memory");

        let poison_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = store.conn.lock().expect("lock memory sqlite mutex");
            panic!("poison memory sqlite mutex for recovery test");
        }));
        assert!(poison_result.is_err());

        let search = store
            .search(MemorySearchArgs {
                query: "poison recovery marker".to_string(),
                scope: None,
                workdir: None,
                memory_type: None,
                limit: Some(8),
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search should recover poisoned sqlite mutex");

        assert!(
            search
                .matches
                .iter()
                .any(|item| item.slug == "user-concurrency"),
            "search should continue after mutex poison: {:?}",
            search.matches
        );
    }

    #[test]
    fn concurrent_memory_searches_complete_without_lock_errors() {
        let store = Arc::new(test_store());
        store
            .write(MemoryWriteArgs {
                slug: "user-parallel-search".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "并发搜索测试".to_string(),
                body: "parallel search marker should be visible to every concurrent search"
                    .to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write memory");

        let mut handles = Vec::new();
        for _ in 0..16 {
            let store = Arc::clone(&store);
            handles.push(std::thread::spawn(move || {
                store
                    .search(MemorySearchArgs {
                        query: "parallel search marker".to_string(),
                        scope: None,
                        workdir: None,
                        memory_type: None,
                        limit: Some(8),
                        include_history: None,
                        history_since: None,
                        history_until: None,
                        history_date_local: None,
                        history_time_mode: None,
                    })
                    .expect("concurrent memory search")
            }));
        }

        for handle in handles {
            let search = handle.join().expect("search thread joined");
            assert!(
                search
                    .matches
                    .iter()
                    .any(|item| item.slug == "user-parallel-search"),
                "concurrent search should find memory: {:?}",
                search.matches
            );
        }
    }

    #[test]
    fn concurrent_daily_append_preserves_all_entries() {
        let store = Arc::new(test_store());
        let slug = "daily-2026-05-14".to_string();
        let mut handles = Vec::new();
        for index in 0..16 {
            let store = Arc::clone(&store);
            let slug = slug.clone();
            handles.push(std::thread::spawn(move || {
                store
                    .update(MemoryUpdateArgs {
                        slug,
                        scope: Some("global".to_string()),
                        workdir: None,
                        workdir_hash: None,
                        memory_type: None,
                        description: None,
                        body: Some(format!("## {index:02}:00\n- append-{index}")),
                        mode: Some("append".to_string()),
                        actor: None,
                        conversation_id: None,
                        model: None,
                    })
                    .expect("append daily from thread");
            }));
        }
        for handle in handles {
            handle.join().expect("thread joined");
        }

        let read = store
            .read(MemoryReadArgs {
                slug: slug.clone(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read daily");
        for index in 0..16 {
            assert!(read.body.contains(&format!("append-{index}")));
        }

        let list = store
            .list(MemoryListArgs {
                scope: Some("global".to_string()),
                workdir: None,
                include_all_projects: None,
                memory_type: None,
                include_daily: Some(true),
                limit: Some(10),
                offset: None,
            })
            .expect("list daily");
        let entry = list
            .entries
            .iter()
            .find(|entry| entry.slug == slug)
            .expect("daily entry listed");
        assert_eq!(entry.append_count, 16);
    }

    #[test]
    fn project_memory_shadows_global_in_overview() {
        let store = test_store();
        let workdir = std::env::temp_dir().join(format!("liveagent-memory-test-{}", now_ms()));
        fs::create_dir_all(&workdir).expect("create workdir");
        let workdir_text = workdir.to_string_lossy().to_string();

        store
            .write(MemoryWriteArgs {
                slug: "project-style".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "全局说明".to_string(),
                body: "global".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write global");
        store
            .write(MemoryWriteArgs {
                slug: "project-style".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_text.clone()),
                memory_type: "project".to_string(),
                description: "项目说明".to_string(),
                body: "project".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project");

        let overview = store.overview(Some(workdir_text)).expect("overview");
        assert!(overview
            .project
            .iter()
            .any(|entry| entry.slug == "project-style"));
        assert!(!overview
            .global
            .iter()
            .any(|entry| entry.slug == "project-style"));
    }

    #[test]
    fn overview_includes_unreviewed_user_hypotheses_but_excludes_unreviewed_feedback() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "user-major-unreviewed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "用户可能是计算机专业学生".to_string(),
                body: [
                    "---",
                    r#"confidence: medium"#,
                    r#"source_quote: "我是计算机专业学生""#,
                    r#"reasoning: "用户陈述了身份信息""#,
                    "---",
                    "",
                    "用户可能是计算机专业学生。",
                ]
                .join("\n"),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write unreviewed user");
        store
            .write(MemoryWriteArgs {
                slug: "feedback-unreviewed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "feedback".to_string(),
                description: "未审核偏好".to_string(),
                body: "以后默认使用测试口吻。".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write unreviewed feedback");
        store
            .write(MemoryWriteArgs {
                slug: "reference-unreviewed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "未审核引用".to_string(),
                body: "参考入口仍可作为弱证据。".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write unreviewed reference");

        let overview = store.overview(None).expect("overview");
        assert!(overview.user.iter().any(|entry| {
            entry.slug == "user-major-unreviewed"
                && entry.unreviewed
                && entry.confidence == "medium"
        }));
        assert!(!overview
            .user
            .iter()
            .any(|entry| entry.slug == "feedback-unreviewed"));
        assert!(overview
            .global
            .iter()
            .any(|entry| entry.slug == "reference-unreviewed" && entry.unreviewed));
    }

    #[test]
    fn direct_write_applies_hard_and_soft_risk_filters() {
        let store = test_store();
        let hard = store
            .write(MemoryWriteArgs {
                slug: "secret-token".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "secret".to_string(),
                body: "API key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA must be saved".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect_err("hard secret-like content should be blocked");
        assert!(hard.contains("risk_hard_blocked"));

        store
            .write(MemoryWriteArgs {
                slug: "soft-risk-note".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "soft risk".to_string(),
                body: "排障步骤里提到 sudo apt install。".to_string(),
                actor: Some("tool".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("soft risk note should be stored as unreviewed");
        let read = store
            .read(MemoryReadArgs {
                slug: "soft-risk-note".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read soft risk note");
        assert!(read.meta.unreviewed);
        assert_eq!(
            read.meta.source.get("risk_flag").and_then(Value::as_str),
            Some("low")
        );
    }

    #[test]
    fn project_search_is_limited_to_current_workdir() {
        let store = test_store();
        let workdir_a = std::env::temp_dir().join(format!("liveagent-memory-a-{}", now_ms()));
        let workdir_b = std::env::temp_dir().join(format!("liveagent-memory-b-{}", now_ms()));
        fs::create_dir_all(&workdir_a).expect("create workdir a");
        fs::create_dir_all(&workdir_b).expect("create workdir b");
        let workdir_a = workdir_a.to_string_lossy().to_string();
        let workdir_b = workdir_b.to_string_lossy().to_string();

        store
            .write(MemoryWriteArgs {
                slug: "project-alpha".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a.clone()),
                memory_type: "project".to_string(),
                description: "alpha sharedprojectmarker".to_string(),
                body: "sharedprojectmarker belongs to project alpha".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project a");
        store
            .write(MemoryWriteArgs {
                slug: "project-beta".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b),
                memory_type: "project".to_string(),
                description: "beta sharedprojectmarker".to_string(),
                body: "sharedprojectmarker belongs to project beta".to_string(),
                actor: None,
                conversation_id: None,
                model: None,
            })
            .expect("write project b");

        let search = store
            .search(MemorySearchArgs {
                query: "sharedprojectmarker".to_string(),
                scope: None,
                workdir: Some(workdir_a),
                memory_type: None,
                limit: Some(10),
                include_history: None,
                history_since: None,
                history_until: None,
                history_date_local: None,
                history_time_mode: None,
            })
            .expect("search current project");

        assert!(search
            .matches
            .iter()
            .any(|item| item.slug == "project-alpha"));
        assert!(!search
            .matches
            .iter()
            .any(|item| item.slug == "project-beta"));
    }

    #[test]
    fn recent_rejections_only_returns_user_deletions_for_current_scope() {
        let store = test_store();
        let workdir_a = std::env::temp_dir().join(format!("liveagent-reject-a-{}", now_ms()));
        let workdir_b = std::env::temp_dir().join(format!("liveagent-reject-b-{}", now_ms()));
        fs::create_dir_all(&workdir_a).expect("create workdir a");
        fs::create_dir_all(&workdir_b).expect("create workdir b");
        let workdir_a = workdir_a.to_string_lossy().to_string();
        let workdir_b = workdir_b.to_string_lossy().to_string();

        store
            .write(MemoryWriteArgs {
                slug: "user-career".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "职业方向".to_string(),
                body: "用户计划转销售".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write global");
        store
            .delete(MemoryDeleteArgs {
                slug: "user-career".to_string(),
                scope: "global".to_string(),
                workdir: None,
                workdir_hash: None,
                actor: Some("user".to_string()),
                reason: Some("用户不想保留这个旧结论".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete global as user");

        store
            .write(MemoryWriteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a.clone()),
                memory_type: "project".to_string(),
                description: "当前项目计划".to_string(),
                body: "project A".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write project a");
        store
            .delete(MemoryDeleteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_a.clone()),
                workdir_hash: None,
                actor: Some("user".to_string()),
                reason: Some("project A rejection".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete project a as user");

        store
            .write(MemoryWriteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b.clone()),
                memory_type: "project".to_string(),
                description: "其他项目计划".to_string(),
                body: "project B".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write project b");
        store
            .delete(MemoryDeleteArgs {
                slug: "project-plan".to_string(),
                scope: "project".to_string(),
                workdir: Some(workdir_b),
                workdir_hash: None,
                actor: Some("user".to_string()),
                reason: Some("project B rejection".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete project b as user");

        store
            .write(MemoryWriteArgs {
                slug: "tool-removed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "工具清理".to_string(),
                body: "tool removed".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write tool cleanup");
        store
            .delete(MemoryDeleteArgs {
                slug: "tool-removed".to_string(),
                scope: "global".to_string(),
                workdir: None,
                workdir_hash: None,
                actor: Some("tool".to_string()),
                reason: Some("tool cleanup".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("delete global as tool");

        let response = store
            .recent_rejections(MemoryRecentRejectionsArgs {
                since_days: Some(7),
                limit: Some(10),
                workdir: Some(workdir_a),
            })
            .expect("recent rejections");

        assert_eq!(response.entries.len(), 2);
        assert!(response
            .entries
            .iter()
            .any(|entry| entry.slug == "user-career" && entry.scope == "global"));
        assert!(response.entries.iter().any(|entry| {
            entry.slug == "project-plan"
                && entry.scope == "project"
                && entry.reason.as_deref() == Some("project A rejection")
        }));
        assert!(!response
            .entries
            .iter()
            .any(|entry| entry.reason.as_deref() == Some("project B rejection")));
        assert!(!response
            .entries
            .iter()
            .any(|entry| entry.slug == "tool-removed"));
    }

    #[test]
    fn extractor_upsert_reports_created_and_marks_unreviewed() {
        let store = test_store();
        let first = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: Some("conversation-memory-test".to_string()),
                trigger: Some("end".to_string()),
                model: Some("test-model".to_string()),
                local_date: Some("2026-05-13".to_string()),
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "user-test-major".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("用户是计算机专业学生".to_string()),
                    body: Some("用户是计算机专业的大学生。".to_string()),
                    reason: None,
                    group_id: None,
                }]),
            })
            .expect("first extractor batch");
        assert_eq!(first.created, vec!["user-test-major".to_string()]);
        assert!(first.updated.is_empty());

        let read = store
            .read(MemoryReadArgs {
                slug: "user-test-major".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read extractor memory");
        assert!(read.meta.unreviewed);

        let second = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: Some("conversation-memory-test".to_string()),
                trigger: Some("end".to_string()),
                model: Some("test-model".to_string()),
                local_date: Some("2026-05-13".to_string()),
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "user-test-major".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("用户仍是计算机专业学生".to_string()),
                    body: Some("用户是计算机专业的大学生，偏好工程化回答。".to_string()),
                    reason: None,
                    group_id: None,
                }]),
            })
            .expect("second extractor batch");
        assert!(second.created.is_empty());
        assert_eq!(second.updated, vec!["user-test-major".to_string()]);
    }

    #[test]
    fn memory_organize_apply_batch_snapshots_before_update_and_delete() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "organize-target".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "整理目标".to_string(),
                body: "旧内容".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write organize target");
        store
            .write(MemoryWriteArgs {
                slug: "organize-delete".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "user".to_string(),
                description: "整理删除".to_string(),
                body: "将被删除".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write organize delete target");

        let updated = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-organize".to_string()),
                model: Some("organizer-model".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "upsert".to_string(),
                    slug: "organize-target".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: Some("user".to_string()),
                    description: Some("整理目标更新".to_string()),
                    body: Some("新内容".to_string()),
                    reason: Some("test update snapshot".to_string()),
                    group_id: None,
                }]),
            })
            .expect("organizer update batch");
        assert_eq!(updated.updated, vec!["organize-target".to_string()]);
        let replaced = store
            .read(MemoryReadArgs {
                slug: "organize-target".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("read organizer replacement");
        assert_eq!(replaced.body, "新内容");

        let deleted = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-organize".to_string()),
                model: Some("organizer-model".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![MemoryDecisionArgs {
                    op: "delete".to_string(),
                    slug: "organize-delete".to_string(),
                    scope: Some("global".to_string()),
                    workdir_hash: None,
                    memory_type: None,
                    description: None,
                    body: None,
                    reason: Some("test delete snapshot".to_string()),
                    group_id: None,
                }]),
            })
            .expect("organizer delete batch");
        assert_eq!(deleted.deleted, vec!["organize-delete".to_string()]);

        let snapshot_dir = store.root.join("global").join(".organize-snapshots");
        let snapshot_count = fs::read_dir(snapshot_dir)
            .expect("snapshot dir")
            .filter_map(Result::ok)
            .count();
        assert_eq!(snapshot_count, 2);
    }

    #[test]
    fn memory_organize_group_skips_deletes_when_update_fails() {
        let store = test_store();
        store
            .write(MemoryWriteArgs {
                slug: "organize-large-target".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "整理目标".to_string(),
                body: "旧内容".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write large target");
        store
            .write(MemoryWriteArgs {
                slug: "organize-large-source".to_string(),
                scope: "global".to_string(),
                workdir: None,
                memory_type: "reference".to_string(),
                description: "整理来源".to_string(),
                body: "来源内容".to_string(),
                actor: Some("extractor".to_string()),
                conversation_id: None,
                model: None,
            })
            .expect("write large source");

        let response = store
            .apply_batch(MemoryBatchArgs {
                workdir: None,
                conversation_id: None,
                trigger: Some("memory-organize".to_string()),
                model: Some("organizer-model".to_string()),
                local_date: None,
                daily_append: None,
                decisions: Some(vec![
                    MemoryDecisionArgs {
                        op: "upsert".to_string(),
                        slug: "organize-large-target".to_string(),
                        scope: Some("global".to_string()),
                        workdir_hash: None,
                        memory_type: Some("reference".to_string()),
                        description: Some("整理目标更新".to_string()),
                        body: Some("x".repeat(MAX_BODY_BYTES + 1)),
                        reason: Some("oversized grouped update".to_string()),
                        group_id: Some("merge-test-group".to_string()),
                    },
                    MemoryDecisionArgs {
                        op: "delete".to_string(),
                        slug: "organize-large-source".to_string(),
                        scope: Some("global".to_string()),
                        workdir_hash: None,
                        memory_type: None,
                        description: None,
                        body: None,
                        reason: Some("merged into target".to_string()),
                        group_id: Some("merge-test-group".to_string()),
                    },
                ]),
            })
            .expect("organizer grouped batch");

        assert!(response.updated.is_empty());
        assert!(response.deleted.is_empty());
        assert!(response
            .warning_details
            .iter()
            .any(|warning| warning.code == "body_too_large"));
        assert!(response
            .warning_details
            .iter()
            .any(|warning| warning.code == "group_upsert_failed"));
        store
            .read(MemoryReadArgs {
                slug: "organize-large-source".to_string(),
                scope: Some("global".to_string()),
                workdir: None,
                workdir_hash: None,
                offset: None,
                length: None,
            })
            .expect("source should remain after grouped update failure");
    }
}
