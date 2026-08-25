//! `CodeIndexService`：对外编排。持有已打开的 per-workspace store 缓存、
//! 索引 worker 线程编排、workspace watch 失效队列。
//!
//! 进程级单例（`global_code_index_service`）——workspace_watch 的 sink 与
//! Tauri command 共享同一实例，无需 State 注入即可从 watcher 线程触达。

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use super::chunker::{chunk_source, language_for_path};
use super::embedder;
use super::jobs::{self, INDEX_CANCELLED_ERROR};
use super::paths::project_db_path;
use super::search;
use super::store::{delete_project_index_dir, CodeIndexStore};
use super::types::*;
use super::walker::{self, read_text_file, sha256_hex, WalkedFile};

/// watch 失效的静默窗：最后一次变更后等这么久再跑小增量（编辑器保存风暴合并）。
const INVALIDATION_QUIET_MS: u64 = 2_000;

pub struct CodeIndexService {
    /// 已打开的 store 按 workdir 缓存（打开含 integrity_check，非无成本）。
    stores: Mutex<HashMap<String, Arc<CodeIndexStore>>>,
    /// watch 失效队列：workdir → 待增量的相对路径集。
    pending_invalidations: Mutex<HashMap<String, BTreeSet<String>>>,
    /// 失效消费线程在跑。
    invalidation_worker_active: AtomicBool,
}

static GLOBAL_SERVICE: OnceLock<Arc<CodeIndexService>> = OnceLock::new();

pub fn global_code_index_service() -> Arc<CodeIndexService> {
    GLOBAL_SERVICE
        .get_or_init(|| {
            Arc::new(CodeIndexService {
                stores: Mutex::new(HashMap::new()),
                pending_invalidations: Mutex::new(HashMap::new()),
                invalidation_worker_active: AtomicBool::new(false),
            })
        })
        .clone()
}

impl CodeIndexService {
    /// 索引库存在（enable 过）才返回 store；不存在返回 None（不隐式建库）。
    fn store_if_indexed(&self, workdir: &str) -> Result<Option<Arc<CodeIndexStore>>, String> {
        let normalized = normalize_workdir(workdir)?;
        {
            let stores = self
                .stores
                .lock()
                .map_err(|_| "代码索引 store 缓存锁被污染".to_string())?;
            if let Some(store) = stores.get(&normalized) {
                return Ok(Some(store.clone()));
            }
        }
        if !project_db_path(&normalized)?.exists() {
            return Ok(None);
        }
        self.open_store(&normalized).map(Some)
    }

    fn open_store(&self, normalized_workdir: &str) -> Result<Arc<CodeIndexStore>, String> {
        let store = Arc::new(CodeIndexStore::open(normalized_workdir)?);
        let mut stores = self
            .stores
            .lock()
            .map_err(|_| "代码索引 store 缓存锁被污染".to_string())?;
        Ok(stores
            .entry(normalized_workdir.to_string())
            .or_insert(store)
            .clone())
    }

    fn evict_store(&self, normalized_workdir: &str) {
        if let Ok(mut stores) = self.stores.lock() {
            stores.remove(normalized_workdir);
        }
    }

    // ---- 对外 API（commands 层直接调用）----

    /// 启用索引：建库 + 后台全量索引 job。幂等（已启用则跑一次增量 job）。
    pub fn enable(&self, args: CodeIndexEnableArgs) -> Result<CodeIndexJobSnapshot, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let store = self.open_store(&workdir)?;
        self.spawn_index_job(store, IndexJobKind::Incremental)
    }

    /// 关闭索引：删除该 workspace 的整个索引目录。
    pub fn disable(&self, args: CodeIndexDisableArgs) -> Result<(), String> {
        let workdir = normalize_workdir(&args.workdir)?;
        if let Some(active) = jobs::active_job_for_workdir(&workdir) {
            jobs::cancel_job(&active.job_id).ok();
            // 给 worker 一点时间放开数据库句柄（协作式取消非即时）。
            for _ in 0..50 {
                if jobs::active_job_for_workdir(&workdir).is_none() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        self.evict_store(&workdir);
        if let Ok(mut pending) = self.pending_invalidations.lock() {
            pending.remove(&workdir);
        }
        delete_project_index_dir(&workdir)
    }

    /// 重建：quarantine 现库 + 全量 job。
    pub fn rebuild(&self, args: CodeIndexRebuildArgs) -> Result<CodeIndexJobSnapshot, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let store = self
            .store_if_indexed(&workdir)?
            .ok_or_else(|| "该工作区未启用代码索引".to_string())?;
        store.reset()?;
        self.spawn_index_job(store, IndexJobKind::Full)
    }

    pub fn status(&self, args: CodeIndexStatusArgs) -> Result<CodeIndexStatusResponse, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let active_job = jobs::active_job_for_workdir(&workdir);
        match self.store_if_indexed(&workdir)? {
            Some(store) => {
                let (file_count, chunk_count, db_size_bytes) = store.stats()?;
                let last_full_index_at = store
                    .get_meta("last_full_index_at")?
                    .and_then(|value| value.parse::<i64>().ok());
                Ok(CodeIndexStatusResponse {
                    indexed: true,
                    file_count,
                    chunk_count,
                    db_size_bytes,
                    last_full_index_at,
                    embedding_model: store.get_meta("embedding_model")?,
                    active_job,
                })
            }
            None => Ok(CodeIndexStatusResponse {
                indexed: false,
                file_count: 0,
                chunk_count: 0,
                db_size_bytes: 0,
                last_full_index_at: None,
                embedding_model: None,
                active_job,
            }),
        }
    }

    pub fn job_status(&self, args: CodeIndexJobStatusArgs) -> Result<CodeIndexJobSnapshot, String> {
        jobs::get_job_snapshot(&args.job_id)
    }

    pub fn job_cancel(&self, args: CodeIndexJobCancelArgs) -> Result<CodeIndexJobSnapshot, String> {
        jobs::cancel_job(&args.job_id)
    }

    pub fn search(&self, args: CodeIndexSearchArgs) -> Result<CodeIndexSearchResponse, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let store = self
            .store_if_indexed(&workdir)?
            .ok_or_else(|| "该工作区未启用代码索引。请在工作区设置中开启后重试。".to_string())?;
        search::search(&store, &args)
    }

    // ---- workspace watch 失效（emit_activity 第三 sink）----

    /// watcher 线程直呼；绝不能阻塞（内部只做入队 + 必要时起消费线程）。
    pub fn notify_workspace_activity(
        &self,
        workdir: &str,
        changed_paths: &[String],
        truncated: bool,
    ) {
        let Ok(normalized) = normalize_workdir(workdir) else {
            return;
        };
        // 只关心已启用索引的 workdir；db 存在性检查是一次 stat，可接受。
        let Ok(db_path) = project_db_path(&normalized) else {
            return;
        };
        if !db_path.exists() {
            return;
        }
        {
            let Ok(mut pending) = self.pending_invalidations.lock() else {
                return;
            };
            let set = pending.entry(normalized).or_default();
            if truncated {
                // 变更清单被截断：标记整树扫描（空 path 哨兵）。
                set.insert(String::new());
            } else {
                for path in changed_paths {
                    if !path.starts_with(".git/") {
                        set.insert(path.clone());
                    }
                }
            }
            if set.is_empty() {
                return;
            }
        }
        self.ensure_invalidation_worker();
    }

    fn ensure_invalidation_worker(&self) {
        if self
            .invalidation_worker_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let service = global_code_index_service();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(INVALIDATION_QUIET_MS));
                let batch: Vec<(String, BTreeSet<String>)> = {
                    let Ok(mut pending) = service.pending_invalidations.lock() else {
                        break;
                    };
                    pending.drain().collect()
                };
                if batch.is_empty() {
                    service
                        .invalidation_worker_active
                        .store(false, Ordering::SeqCst);
                    // drain 与置 false 之间可能有新入队：再看一眼，有就复活。
                    let has_pending = service
                        .pending_invalidations
                        .lock()
                        .map(|pending| !pending.is_empty())
                        .unwrap_or(false);
                    if has_pending {
                        service.ensure_invalidation_worker();
                    }
                    break;
                }
                for (workdir, paths) in batch {
                    if jobs::active_job_for_workdir(&workdir).is_some() {
                        // 全量 job 在跑，它自会覆盖这些路径；丢弃即可。
                        continue;
                    }
                    let Ok(Some(store)) = service.store_if_indexed(&workdir) else {
                        continue;
                    };
                    if paths.contains("") {
                        // 截断哨兵：起一次后台增量 job（全树对账）。
                        let _ = service.spawn_index_job(store, IndexJobKind::Incremental);
                        continue;
                    }
                    if let Err(error) = incremental_update_paths(&store, &paths) {
                        eprintln!("code index incremental update failed: {error}");
                    }
                }
            }
        });
    }

    // ---- 索引 worker ----

    fn spawn_index_job(
        &self,
        store: Arc<CodeIndexStore>,
        kind: IndexJobKind,
    ) -> Result<CodeIndexJobSnapshot, String> {
        let (snapshot, cancel_requested) = jobs::insert_job(&store.workdir)?;
        let job_id = snapshot.job_id.clone();
        thread::spawn(move || {
            let should_cancel = || cancel_requested.load(Ordering::Relaxed);
            let result = run_index_job(&job_id, &store, kind, &should_cancel);
            jobs::finish_job(&job_id, result);
        });
        Ok(snapshot)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum IndexJobKind {
    /// 全量：库刚 reset 过（rebuild），所有文件都要重索引。
    Full,
    /// 增量：mtime/hash 对账，只处理变化文件（enable 幂等路径也走这里）。
    Incremental,
}

fn normalize_workdir(workdir: &str) -> Result<String, String> {
    let trimmed = workdir.trim();
    if trimmed.is_empty() {
        return Err("workdir 不能为空".to_string());
    }
    Ok(trimmed.trim_end_matches(['/', '\\']).to_string())
}

/// 全量/增量索引主流程（job worker 线程）。
fn run_index_job(
    job_id: &str,
    store: &CodeIndexStore,
    kind: IndexJobKind,
    should_cancel: &dyn Fn() -> bool,
) -> Result<(), String> {
    // 阶段 1：模型预热（首次要下载，最耗时且用户最需要感知的阶段）。
    let _ = jobs::update_job(job_id, |job| {
        job.phase = "downloading-model".to_string();
        job.message = Some("Preparing embedding model (first run downloads it)".to_string());
    });
    let semantic_active = embedder::embedder_available();
    if !semantic_active {
        // 语义路不可用不阻塞词法索引；错误进 message 提示。
        let reason = embedder::embedder_error().unwrap_or_default();
        let _ = jobs::update_job(job_id, |job| {
            job.message = Some(format!(
                "Embedding model unavailable, lexical-only index: {reason}"
            ));
        });
    }
    if should_cancel() {
        return Err(INDEX_CANCELLED_ERROR.to_string());
    }

    // 阶段 2：遍历。
    let _ = jobs::update_job(job_id, |job| {
        job.phase = "walking".to_string();
        job.message = Some("Scanning workspace files".to_string());
    });
    let workdir_path = PathBuf::from(&store.workdir);
    let outcome = walker::walk_workspace(&workdir_path, should_cancel)?;
    let total = outcome.files.len() as u64;
    let _ = jobs::update_job(job_id, |job| {
        job.total_files = total;
    });

    // 消失文件对账：索引里有、磁盘上无 → 删除。
    let walked_paths: BTreeSet<&str> = outcome
        .files
        .iter()
        .map(|file| file.rel_path.as_str())
        .collect();
    for indexed_path in store.all_indexed_paths()? {
        if !walked_paths.contains(indexed_path.as_str()) {
            store.remove_file(&indexed_path)?;
        }
    }

    // 阶段 3：逐文件切块 + 嵌入 + 落库。
    let _ = jobs::update_job(job_id, |job| {
        job.phase = if semantic_active {
            "embedding"
        } else {
            "chunking"
        }
        .to_string();
        job.message = None;
    });
    let mut processed: u64 = 0;
    let mut indexed_chunks: u64 = 0;
    for file in &outcome.files {
        if should_cancel() {
            return Err(INDEX_CANCELLED_ERROR.to_string());
        }
        match index_one_file(store, file, kind, semantic_active) {
            Ok(chunk_count) => indexed_chunks += chunk_count,
            Err(error) => {
                // 单文件失败不打断整个 job（记录后继续）。
                eprintln!("code index: failed to index {}: {error}", file.rel_path);
            }
        }
        processed += 1;
        if processed.is_multiple_of(20) || processed == total {
            let _ = jobs::update_job(job_id, |job| {
                job.processed_files = processed;
                job.indexed_chunks = indexed_chunks;
            });
        }
    }

    store.set_meta("last_full_index_at", &super::now_ms().to_string())?;
    Ok(())
}

/// 单文件索引：增量判定（mtime → 内容哈希两级短路）+ 切块 + 嵌入 + replace。
/// 返回本文件产出的块数；未变化返回 0。
fn index_one_file(
    store: &CodeIndexStore,
    file: &WalkedFile,
    kind: IndexJobKind,
    semantic_active: bool,
) -> Result<u64, String> {
    let existing = store.file_meta(&file.rel_path)?;
    if kind == IndexJobKind::Incremental {
        if let Some(meta) = &existing {
            if meta.mtime_ms == file.mtime_ms {
                return Ok(0);
            }
        }
    }
    let Some(content) = read_text_file(&file.abs_path) else {
        // 非 UTF-8：曾索引过（后来变二进制）则清掉。
        if existing.is_some() {
            store.remove_file(&file.rel_path)?;
        }
        return Ok(0);
    };
    let content_hash = sha256_hex(content.as_bytes());
    if kind == IndexJobKind::Incremental {
        if let Some(meta) = &existing {
            if meta.content_hash == content_hash {
                store.touch_file_mtime(meta.id, file.mtime_ms)?;
                return Ok(0);
            }
        }
    }

    let language = language_for_path(&file.rel_path);
    let chunks = chunk_source(&file.rel_path, language, &content);
    if chunks.is_empty() {
        if existing.is_some() {
            store.remove_file(&file.rel_path)?;
        }
        return Ok(0);
    }

    let embeddings = if semantic_active {
        let texts: Vec<String> = chunks.iter().map(|chunk| chunk.content.clone()).collect();
        match embedder::embed_passages(&texts) {
            Ok(embeddings) => embeddings,
            Err(error) => {
                // 语义路中途失败：本文件降级词法（不整个 job 失败）。
                eprintln!(
                    "code index: embedding failed for {}: {error}",
                    file.rel_path
                );
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    store.replace_file(
        &file.rel_path,
        file.mtime_ms,
        file.size_bytes,
        &content_hash,
        language,
        &chunks,
        &embeddings,
    )?;
    Ok(chunks.len() as u64)
}

/// watch 小增量：只处理给定相对路径（新增/修改/删除三态各自收敛）。
fn incremental_update_paths(
    store: &CodeIndexStore,
    rel_paths: &BTreeSet<String>,
) -> Result<(), String> {
    let workdir = PathBuf::from(&store.workdir);
    let semantic_active = embedder::embedder_available();
    for rel_path in rel_paths {
        if rel_path.is_empty() {
            continue;
        }
        let abs = workdir.join(rel_path);
        let Ok(metadata) = std::fs::metadata(&abs) else {
            // 文件已删除（或不可读）：索引里有则清掉。
            if store.file_meta(rel_path)?.is_some() {
                store.remove_file(rel_path)?;
            }
            continue;
        };
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > walker::MAX_FILE_BYTES {
            continue;
        }
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        let file = WalkedFile {
            rel_path: rel_path.clone(),
            abs_path: abs,
            mtime_ms,
            size_bytes: metadata.len(),
        };
        if let Err(error) = index_one_file(store, &file, IndexJobKind::Incremental, semantic_active)
        {
            eprintln!("code index: watch update failed for {rel_path}: {error}");
        }
    }
    Ok(())
}
