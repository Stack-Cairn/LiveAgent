//! `CodeIndexStore`：单 workspace 索引库的持有者。memory/store.rs 同款
//! 单连接 + `Mutex`；写路径都在索引 job 线程或 watch 增量线程上（spawn_blocking /
//! 专用线程），锁竞争面小。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};

use super::chunker::CodeChunk;
use super::now_ms;
use super::paths::{db_size_bytes, ensure_project_dir, project_db_path, DB_FILENAME};
use super::schema::{open_code_index_connection, remove_db_files};

pub(crate) struct CodeIndexStore {
    pub(crate) workdir: String,
    db_path: PathBuf,
    conn: Mutex<Connection>,
}

/// files 表一行的增量判定视图。
pub(crate) struct IndexedFileMeta {
    pub(crate) id: i64,
    pub(crate) mtime_ms: i64,
    pub(crate) content_hash: String,
    /// 该文件的块已带向量入库。false = 词法降级期索引，待模型就绪后回填。
    pub(crate) has_vectors: bool,
}

impl CodeIndexStore {
    pub(crate) fn open(workdir: &str) -> Result<Self, String> {
        ensure_project_dir(workdir)?;
        let db_path = project_db_path(workdir)?;
        Self::open_at(workdir, db_path)
    }

    /// 测试用：绕开 `~/.liveagent` 布局，直接在给定路径开库。
    pub(crate) fn open_at(workdir: &str, db_path: PathBuf) -> Result<Self, String> {
        let conn = open_code_index_connection(&db_path)?;
        Ok(Self {
            workdir: workdir.to_string(),
            db_path,
            conn: Mutex::new(conn),
        })
    }

    pub(crate) fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "代码索引数据库锁被污染".to_string())
    }

    /// 清空当前库并换上全新连接。rebuild 用：健康库直接删文件（quarantine
    /// 只留给损坏路径，避免每次重建都在磁盘复制一份完整索引）。
    pub(crate) fn reset(&self) -> Result<(), String> {
        let mut guard = self.lock_conn()?;
        // 先换成内存连接释放文件句柄，再删旧文件、开新库。
        let placeholder =
            Connection::open_in_memory().map_err(|e| format!("创建代码索引占位连接失败：{e}"))?;
        let old = std::mem::replace(&mut *guard, placeholder);
        drop(old);
        let removal = remove_db_files(&self.db_path);
        // 无论删除是否成功都要重开真库：占位连接没有 schema，留在 guard 里
        // 会让后续所有 status/search 报 “no such table”。
        match open_code_index_connection(&self.db_path) {
            Ok(conn) => {
                *guard = conn;
                removal
            }
            Err(open_error) => {
                removal?;
                Err(open_error)
            }
        }
    }

    pub(crate) fn file_meta(&self, path: &str) -> Result<Option<IndexedFileMeta>, String> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT id, mtime_ms, content_hash, has_vectors FROM files WHERE path = ?1",
            [path],
            |row| {
                Ok(IndexedFileMeta {
                    id: row.get(0)?,
                    mtime_ms: row.get(1)?,
                    content_hash: row.get(2)?,
                    has_vectors: row.get::<_, i64>(3)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("读取代码索引文件元数据失败：{e}"))
    }

    pub(crate) fn touch_file_mtime(&self, file_id: i64, mtime_ms: i64) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE files SET mtime_ms = ?1, indexed_at = ?2 WHERE id = ?3",
            params![mtime_ms, now_ms(), file_id],
        )
        .map_err(|e| format!("更新代码索引文件 mtime 失败：{e}"))?;
        Ok(())
    }

    pub(crate) fn all_indexed_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare("SELECT path FROM files")
            .map_err(|e| format!("准备代码索引路径查询失败：{e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询代码索引路径失败：{e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取代码索引路径失败：{e}"))
    }

    /// 整文件重索引：删旧行（chunks/fts/vec 同事务级联）+ 插入新块与向量。
    /// `embeddings[i]` 对应 `chunks[i]`；语义路降级时传空切片，只建词法索引。
    pub(crate) fn replace_file(
        &self,
        path: &str,
        mtime_ms: i64,
        size_bytes: u64,
        content_hash: &str,
        language: &str,
        chunks: &[CodeChunk],
        embeddings: &[Vec<f32>],
    ) -> Result<(), String> {
        let mut guard = self.lock_conn()?;
        let tx = guard
            .transaction()
            .map_err(|e| format!("开启代码索引事务失败：{e}"))?;

        delete_file_rows(&tx, path)?;
        tx.execute(
            "INSERT INTO files (path, mtime_ms, size_bytes, content_hash, language, has_vectors, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                path,
                mtime_ms,
                size_bytes as i64,
                content_hash,
                language,
                (!embeddings.is_empty()) as i64,
                now_ms()
            ],
        )
        .map_err(|e| format!("写入代码索引文件行失败：{e}"))?;
        let file_id = tx.last_insert_rowid();

        for (index, chunk) in chunks.iter().enumerate() {
            tx.execute(
                "INSERT INTO chunks (file_id, start_line, end_line, kind, symbol)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    file_id,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.kind,
                    chunk.symbol
                ],
            )
            .map_err(|e| format!("写入代码块失败：{e}"))?;
            let chunk_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO chunks_fts (content, symbol, path, chunk_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![chunk.content, chunk.symbol, path, chunk_id],
            )
            .map_err(|e| format!("写入代码块 FTS 失败：{e}"))?;
            if let Some(embedding) = embeddings.get(index) {
                tx.execute(
                    "INSERT INTO chunks_vec (rowid, embedding) VALUES (?1, ?2)",
                    params![chunk_id, embedding_bytes(embedding)],
                )
                .map_err(|e| format!("写入代码块向量失败：{e}"))?;
            }
        }

        tx.commit()
            .map_err(|e| format!("提交代码索引事务失败：{e}"))
    }

    pub(crate) fn remove_file(&self, path: &str) -> Result<(), String> {
        let mut guard = self.lock_conn()?;
        let tx = guard
            .transaction()
            .map_err(|e| format!("开启代码索引删除事务失败：{e}"))?;
        delete_file_rows(&tx, path)?;
        tx.commit()
            .map_err(|e| format!("提交代码索引删除事务失败：{e}"))
    }

    /// 删除目录前缀下的全部文件行（watch 收到目录删除/重命名时清幽灵数据）。
    /// `dir_rel_path` 不带尾部斜杠。返回删除的文件数。
    pub(crate) fn remove_files_under_dir(&self, dir_rel_path: &str) -> Result<usize, String> {
        let paths: Vec<String> = {
            let conn = self.lock_conn()?;
            let like = format!("{}/%", escape_like(dir_rel_path));
            let mut stmt = conn
                .prepare("SELECT path FROM files WHERE path LIKE ?1 ESCAPE '\\'")
                .map_err(|e| format!("准备目录清理查询失败：{e}"))?;
            let rows = stmt
                .query_map([like], |row| row.get::<_, String>(0))
                .map_err(|e| format!("查询目录下索引文件失败：{e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("读取目录下索引文件失败：{e}"))?
        };
        let mut guard = self.lock_conn()?;
        let tx = guard
            .transaction()
            .map_err(|e| format!("开启目录清理事务失败：{e}"))?;
        for path in &paths {
            delete_file_rows(&tx, path)?;
        }
        tx.commit()
            .map_err(|e| format!("提交目录清理事务失败：{e}"))?;
        Ok(paths.len())
    }

    /// 尚无向量的文件数（词法降级期入库的存量，模型就绪后由增量 job 回填）。
    pub(crate) fn vectorless_file_count(&self) -> Result<u64, String> {
        let conn = self.lock_conn()?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE has_vectors = 0",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("统计缺向量文件失败：{e}"))?;
        Ok(count.max(0) as u64)
    }

    pub(crate) fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO code_index_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| format!("写入代码索引元数据失败：{e}"))?;
        Ok(())
    }

    pub(crate) fn get_meta(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT value FROM code_index_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取代码索引元数据失败：{e}"))
    }

    pub(crate) fn stats(&self) -> Result<(u64, u64, u64), String> {
        let conn = self.lock_conn()?;
        let file_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .map_err(|e| format!("统计代码索引文件数失败：{e}"))?;
        let chunk_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))
            .map_err(|e| format!("统计代码块数失败：{e}"))?;
        drop(conn);
        Ok((
            file_count.max(0) as u64,
            chunk_count.max(0) as u64,
            db_size_bytes(&self.db_path),
        ))
    }
}

/// 同事务内删除一个文件的全部行：files 行（chunks 级联）+ FTS + 向量。
/// FTS/vec 虚表不参与外键级联，须显式按收集到的 chunk id 删除。
fn delete_file_rows(tx: &rusqlite::Transaction<'_>, path: &str) -> Result<(), String> {
    let chunk_ids: Vec<i64> = {
        let mut stmt = tx
            .prepare(
                "SELECT chunks.id FROM chunks
                 JOIN files ON files.id = chunks.file_id
                 WHERE files.path = ?1",
            )
            .map_err(|e| format!("准备代码块清理查询失败：{e}"))?;
        let rows = stmt
            .query_map([path], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("查询待清理代码块失败：{e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取待清理代码块失败：{e}"))?
    };
    for chunk_id in &chunk_ids {
        tx.execute("DELETE FROM chunks_fts WHERE chunk_id = ?1", [chunk_id])
            .map_err(|e| format!("清理代码块 FTS 失败：{e}"))?;
        tx.execute("DELETE FROM chunks_vec WHERE rowid = ?1", [chunk_id])
            .map_err(|e| format!("清理代码块向量失败：{e}"))?;
    }
    tx.execute("DELETE FROM files WHERE path = ?1", [path])
        .map_err(|e| format!("清理代码索引文件行失败：{e}"))?;
    Ok(())
}

/// sqlite-vec 接受 float32 小端字节串作为向量字面量。
pub(crate) fn embedding_bytes(embedding: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(embedding.len() * 4);
    for value in embedding {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// LIKE 通配符转义（路径来自模型参数或索引行，防御 % 与 _）。
pub(crate) fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// disable 时整目录删除（含模型无关的 db/wal/标记文件）。
pub(crate) fn delete_project_index_dir(workdir: &str) -> Result<(), String> {
    let dir = super::paths::project_dir(workdir)?;
    if dir.exists() {
        // 防御：确认目录里确实是我们的库文件布局，避免误删。
        let expected = dir.join(DB_FILENAME);
        let marker = dir.join(".workdir.json");
        if !expected.exists() && !marker.exists() {
            return Err(format!("拒绝删除疑似非代码索引目录：{}", dir.display()));
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除代码索引目录失败：{e}"))?;
    }
    Ok(())
}
