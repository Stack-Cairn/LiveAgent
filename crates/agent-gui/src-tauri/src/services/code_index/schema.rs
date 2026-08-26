//! Schema 与连接管理。memory/schema.rs 同款纪律：busy_timeout + integrity_check，
//! 损坏整库隔离到 `.quarantine/corrupt-<ts>/` 后重建；版本不匹配 DROP 重建
//! （索引是缓存，重建无数据损失，不做 ALTER 迁移）。
//!
//! sqlite-vec 经 `sqlite3_auto_extension` 进程级注册（幂等，Once 保护）——对
//! memory/history 等其他 rusqlite 连接无副作用：vec0 模块可用但不使用即零开销。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Duration;

use rusqlite::Connection;

use super::now_ms;

/// v2：files 增加 has_vectors（词法降级期索引的文件待模型就绪后回填向量）。
pub(crate) const SCHEMA_VERSION: i64 = 2;
/// multilingual-e5-small 的输出维度；写死进 DDL，换模型即换 schema 版本重建。
pub(crate) const EMBEDDING_DIM: usize = 384;
pub(crate) const EMBEDDING_MODEL_ID: &str = "multilingual-e5-small";

const CODE_INDEX_SCHEMA_DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
    id           INTEGER PRIMARY KEY,
    path         TEXT    NOT NULL UNIQUE,
    mtime_ms     INTEGER NOT NULL,
    size_bytes   INTEGER NOT NULL,
    content_hash TEXT    NOT NULL,
    language     TEXT    NOT NULL,
    has_vectors  INTEGER NOT NULL DEFAULT 0,
    indexed_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id         INTEGER PRIMARY KEY,
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    start_line INTEGER NOT NULL,
    end_line   INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    symbol     TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    symbol,
    path      UNINDEXED,
    chunk_id  UNINDEXED,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    embedding float[384]
);

CREATE TABLE IF NOT EXISTS code_index_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

static REGISTER_VEC_EXTENSION: Once = Once::new();

pub(crate) fn register_sqlite_vec() {
    REGISTER_VEC_EXTENSION.call_once(|| unsafe {
        // sqlite-vec 官方 rusqlite 集成方式（crate 自带测试同款）。
        #[allow(clippy::missing_transmute_annotations)]
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

pub(crate) fn open_code_index_connection(db_path: &Path) -> Result<Connection, String> {
    register_sqlite_vec();
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建代码索引目录失败：{e}"))?;
    }
    let conn = open_raw(db_path)?;
    if let Err(error) = integrity_check(&conn) {
        drop(conn);
        quarantine_db_files(db_path)?;
        let conn = open_raw(db_path)?;
        init_schema(&conn)?;
        eprintln!("code index was quarantined and rebuilt: {error}");
        return Ok(conn);
    }
    init_schema(&conn)?;
    Ok(conn)
}

fn open_raw(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开代码索引数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置代码索引 busy_timeout 失败：{e}"))?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    if schema_needs_rebuild(conn)? {
        conn.execute_batch(
            "DROP TABLE IF EXISTS chunks_fts;
             DROP TABLE IF EXISTS chunks_vec;
             DROP TABLE IF EXISTS chunks;
             DROP TABLE IF EXISTS files;
             DROP TABLE IF EXISTS code_index_meta;",
        )
        .map_err(|e| format!("重建旧版代码索引表失败：{e}"))?;
    }
    conn.execute_batch(CODE_INDEX_SCHEMA_DDL)
        .map_err(|e| format!("初始化代码索引表失败：{e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO code_index_meta (key, value) VALUES ('schema_version', ?1)",
        [SCHEMA_VERSION.to_string()],
    )
    .map_err(|e| format!("写入代码索引 schema 版本失败：{e}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO code_index_meta (key, value) VALUES ('embedding_model', ?1)",
        [EMBEDDING_MODEL_ID],
    )
    .map_err(|e| format!("写入代码索引模型标记失败：{e}"))?;
    Ok(())
}

fn schema_needs_rebuild(conn: &Connection) -> Result<bool, String> {
    let has_meta: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'code_index_meta')",
            [],
            |row| row.get::<_, i64>(0).map(|value| value != 0),
        )
        .map_err(|e| format!("检查代码索引表失败：{e}"))?;
    if !has_meta {
        // 全新库（或残缺到连 meta 都没有）：DROP IF EXISTS 幂等清场即可。
        return Ok(true);
    }
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM code_index_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取代码索引 schema 版本失败：{other}")),
        })?;
    let model: Option<String> = conn
        .query_row(
            "SELECT value FROM code_index_meta WHERE key = 'embedding_model'",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取代码索引模型标记失败：{other}")),
        })?;
    Ok(version.as_deref() != Some(&SCHEMA_VERSION.to_string()[..])
        || model.as_deref() != Some(EMBEDDING_MODEL_ID))
}

fn integrity_check(conn: &Connection) -> Result<(), String> {
    let result = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| format!("代码索引 integrity_check 失败：{e}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("代码索引 integrity_check 异常：{result}"))
    }
}

pub(crate) fn quarantine_db_files(db_path: &Path) -> Result<(), String> {
    let root = db_path
        .parent()
        .ok_or_else(|| "code index db path has no parent".to_string())?;
    let quarantine_root = root.join(".quarantine");
    let quarantine = quarantine_root.join(format!("corrupt-{}", now_ms()));
    fs::create_dir_all(&quarantine).map_err(|e| format!("创建代码索引隔离目录失败：{e}"))?;
    for suffix in ["", "-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{suffix}", db_path.to_string_lossy()));
        if src.exists() {
            let file_name = src
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_else(|| format!("{}{suffix}", DB_QUARANTINE_STEM).into());
            fs::rename(&src, quarantine.join(file_name))
                .map_err(|e| format!("隔离损坏代码索引失败：{e}"))?;
        }
    }
    prune_quarantine_dirs(&quarantine_root);
    Ok(())
}

/// 隔离区只留最近 N 份：损坏是异常路径，留最近现场足够排障，别让磁盘无界增长。
const MAX_QUARANTINE_DIRS: usize = 2;

fn prune_quarantine_dirs(quarantine_root: &Path) {
    let Ok(entries) = fs::read_dir(quarantine_root) else {
        return;
    };
    // corrupt-<ms 时间戳> 目录名按字典序即按时间序（同位数时间戳）。
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();
    if dirs.len() <= MAX_QUARANTINE_DIRS {
        return;
    }
    for dir in &dirs[..dirs.len() - MAX_QUARANTINE_DIRS] {
        if let Err(error) = fs::remove_dir_all(dir) {
            eprintln!("code index: prune quarantine {} failed: {error}", dir.display());
        }
    }
}

/// 健康库的重建（rebuild）直接删除 db 文件——quarantine 只留给损坏路径，
/// 否则每次重建都会在磁盘上永久复制一整份索引。
pub(crate) fn remove_db_files(db_path: &Path) -> Result<(), String> {
    for suffix in ["", "-wal", "-shm"] {
        let target = PathBuf::from(format!("{}{suffix}", db_path.to_string_lossy()));
        if target.exists() {
            fs::remove_file(&target).map_err(|e| format!("删除代码索引库文件失败：{e}"))?;
        }
    }
    Ok(())
}

const DB_QUARANTINE_STEM: &str = "code-index.sqlite3";
