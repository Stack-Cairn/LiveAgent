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
use super::paths::{
    clear_disabled_marker, disabled_marker_exists, project_db_path, write_disabled_marker,
};
use super::search;
use super::store::{delete_project_index_dir, CodeIndexStore};
use super::types::*;
use super::walker::{self, read_text_file, sha256_hex, WalkedFile, WatchPathFilter};

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
        // disable 删除失败留下的残留库：对 search/status/rebuild 一律视为已关闭，
        // 不能只拦 watch 路——否则半删除状态下功能照常在线。
        if disabled_marker_exists(&normalized) {
            self.evict_store(&normalized);
            return Ok(None);
        }
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
        // 缓存里可能残留指向已删除文件的旧连接（disable 与并发 re-open 竞争的
        // 遗留）：先逐出，保证本次 enable 写进磁盘上的新库而非游离 inode。
        self.evict_store(&workdir);
        let store = self.open_store(&workdir)?;
        // 上次 disable 删除失败留下的标记：重新启用即清除，恢复 watch 增量。
        clear_disabled_marker(&workdir);
        self.spawn_index_job(store, IndexJobKind::Incremental)
    }

    /// 关闭索引：删除该 workspace 的整个索引目录。
    pub fn disable(&self, args: CodeIndexDisableArgs) -> Result<(), String> {
        let workdir = normalize_workdir(&args.workdir)?;
        // 先撤掉待处理的失效队列，避免消费线程在删除期间重开库。
        if let Ok(mut pending) = self.pending_invalidations.lock() {
            pending.remove(&workdir);
        }
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
        let result = delete_project_index_dir(&workdir);
        // 删除与上面 evict 之间可能有并发 status/search re-open 又塞回缓存：
        // 再逐出一次，避免陈旧 Arc 继续服务已删除（或待删除）的库。
        self.evict_store(&workdir);
        // 工作区目录已从磁盘消失时，canonicalize 失败会退回原始拼写，目录 hash
        // 可能与 enable 时（canonical 拼写）不同——按 .workdir.json 记录的路径
        // 反查兜底，避免整份索引成为无人认领的孤儿。
        if std::path::Path::new(&workdir).canonicalize().is_err() {
            super::paths::delete_project_dirs_recorded_for(&workdir);
        }
        if let Err(error) = result {
            // 删除失败（如 Windows 上 job 仍握着句柄）：落盘 disabled 标记，
            // 阻断 watch 增量与 search/status 对残留库的使用；enable 时清除，
            // 用户重试 disable 亦可完成清理。
            write_disabled_marker(&workdir);
            return Err(error);
        }
        Ok(())
    }

    /// 重建：全量 job（reset 在 job 里做——先过“同 workdir 单 job”闸门再清库，
    /// 避免和进行中的 job 竞争时白白毁掉现有索引）。
    pub fn rebuild(&self, args: CodeIndexRebuildArgs) -> Result<CodeIndexJobSnapshot, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let store = self
            .store_if_indexed(&workdir)?
            .ok_or_else(|| "该工作区未启用代码索引".to_string())?;
        self.spawn_index_job(store, IndexJobKind::Full)
    }

    pub fn status(&self, args: CodeIndexStatusArgs) -> Result<CodeIndexStatusResponse, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let active_job = jobs::active_job_for_workdir(&workdir);
        let last_job = jobs::last_finished_job_for_workdir(&workdir);
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
                    last_job,
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
                last_job,
            }),
        }
    }

    pub fn job_cancel(&self, args: CodeIndexJobCancelArgs) -> Result<CodeIndexJobSnapshot, String> {
        jobs::cancel_job(&args.job_id)
    }

    pub fn search(&self, args: CodeIndexSearchArgs) -> Result<CodeIndexSearchResponse, String> {
        let workdir = normalize_workdir(&args.workdir)?;
        let store = self
            .store_if_indexed(&workdir)?
            // “未启用代码索引”是 TS 工具层对账（自动 enable）的匹配标识，
            // 改文案需同步 codeSearchTools.ts。
            .ok_or_else(|| "该工作区未启用代码索引。请在工作区设置中开启后重试。".to_string())?;
        // 索引自愈（都不阻塞本次检索，均按 workdir 节流）：
        // - 库是空的（schema/模型版本升级时 DROP 重建过，但 status 仍 indexed）
        //   → 拉起增量 job 重建，否则空库会永远安静地返回零结果；
        // - 模型不可用（如离线首启的缓存失败）→ 后台节流重试初始化；
        // - 模型已就绪但存量文件缺向量（词法降级期入库）→ 安排增量 job 回填。
        let index_is_empty = store
            .stats()
            .map(|(file_count, _, _)| file_count == 0)
            .unwrap_or(false);
        let needs_backfill = matches!(
            embedder::availability(),
            embedder::EmbedderAvailability::Ready
        ) && store.vectorless_file_count().unwrap_or(0) > 0;
        if matches!(
            embedder::availability(),
            embedder::EmbedderAvailability::Unavailable(_)
        ) {
            embedder::spawn_background_init();
        }
        if (index_is_empty || needs_backfill)
            && jobs::active_job_for_workdir(&workdir).is_none()
            && self_heal_throttle_ok(&workdir)
        {
            let _ = self.spawn_index_job(store.clone(), IndexJobKind::Incremental);
        }
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
        // disable 删除目录失败时的残留库：标记在场即视为已关闭，不再复活索引。
        if disabled_marker_exists(&normalized) {
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
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                service.run_invalidation_loop();
            }));
            if result.is_err() {
                // panic 逃逸会让 active 标志永远卡 true，进程级失活 watch 增量；
                // 这里兜底复位，有积压则复活。panic 还可能毒化某个 store 的连接
                // 锁（不知道具体是哪个），整体清空缓存，下次访问重开连接。
                eprintln!("code index invalidation worker panicked; resetting");
                if let Ok(mut stores) = service.stores.lock() {
                    stores.clear();
                }
                service
                    .invalidation_worker_active
                    .store(false, Ordering::SeqCst);
                let has_pending = service
                    .pending_invalidations
                    .lock()
                    .map(|pending| !pending.is_empty())
                    .unwrap_or(false);
                if has_pending {
                    service.ensure_invalidation_worker();
                }
            }
        });
    }

    fn run_invalidation_loop(&self) {
        loop {
            thread::sleep(Duration::from_millis(INVALIDATION_QUIET_MS));
            let batch: Vec<(String, BTreeSet<String>)> = {
                let Ok(mut pending) = self.pending_invalidations.lock() else {
                    self.invalidation_worker_active
                        .store(false, Ordering::SeqCst);
                    break;
                };
                pending.drain().collect()
            };
            if batch.is_empty() {
                self.invalidation_worker_active
                    .store(false, Ordering::SeqCst);
                // drain 与置 false 之间可能有新入队：再看一眼，有就复活。
                let has_pending = self
                    .pending_invalidations
                    .lock()
                    .map(|pending| !pending.is_empty())
                    .unwrap_or(false);
                if has_pending {
                    self.ensure_invalidation_worker();
                }
                break;
            }
            for (workdir, paths) in batch {
                if jobs::active_job_for_workdir(&workdir).is_some() {
                    // 全量 job 在跑，它自会覆盖这些路径；丢弃即可。
                    continue;
                }
                if disabled_marker_exists(&workdir) {
                    continue;
                }
                let Ok(Some(store)) = self.store_if_indexed(&workdir) else {
                    continue;
                };
                if paths.contains("") {
                    // 截断哨兵：起一次后台增量 job（全树对账）。
                    let _ = self.spawn_index_job(store, IndexJobKind::Incremental);
                    continue;
                }
                if let Err(error) = incremental_update_paths(&store, &paths) {
                    eprintln!("code index incremental update failed: {error}");
                }
            }
        }
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
            // panic 必须落回 finish_job：否则 job 永远“进行中”，该 workdir 的
            // enable/rebuild 被单 job 闸门永久拒绝，只能重启进程。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_index_job(&job_id, &store, kind, &should_cancel)
            }))
            .unwrap_or_else(|panic| {
                // panic 可能把 store 的连接锁毒化：逐出缓存，下次访问重开连接。
                global_code_index_service().evict_store(&store.workdir);
                Err(format!("索引任务异常终止：{}", panic_message(&panic)))
            });
            jobs::finish_job(&job_id, result);
        });
        Ok(snapshot)
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// 自愈 job 的节流（按 workdir）：嵌入持续失败/库反复为空等病态下，避免每次
/// 检索都重启一轮重索引。10 分钟一次足够——正常情况下一轮即收敛。
fn self_heal_throttle_ok(workdir: &str) -> bool {
    static LAST_ATTEMPT_MS: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    let map = LAST_ATTEMPT_MS.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut guard) = map.lock() else {
        return false;
    };
    let now = super::now_ms();
    let last = guard.get(workdir).copied().unwrap_or(0);
    if now.saturating_sub(last) < 10 * 60 * 1000 {
        return false;
    }
    guard.insert(workdir.to_string(), now);
    true
}

#[derive(Clone, Copy, PartialEq)]
enum IndexJobKind {
    /// 全量：job 开始时先 reset 清库（rebuild），所有文件都要重索引。
    Full,
    /// 增量：mtime/hash 对账，只处理变化文件（enable 幂等路径也走这里）。
    Incremental,
}

fn normalize_workdir(workdir: &str) -> Result<String, String> {
    let trimmed = workdir.trim();
    if trimmed.is_empty() {
        return Err("workdir 不能为空".to_string());
    }
    let trimmed = trimmed.trim_end_matches(['/', '\\']);
    // canonicalize 归一符号链接/相对拼写：store 缓存键、单 job 闸门、索引目录
    // hash 三者才会指向同一身份（paths::workdir_hash 也做同样归一）。
    match std::fs::canonicalize(trimmed) {
        Ok(canonical) => Ok(strip_windows_verbatim_prefix(&canonical)),
        Err(_) => Ok(trimmed.to_string()),
    }
}

/// Windows 的 canonicalize 产出 `\\?\` verbatim 路径。verbatim 语义下 `/` 不再
/// 是分隔符——与 watcher 的 POSIX 风格相对路径 join 后 stat 必然失败，watch
/// 增量会把活文件当已删除清掉、片段现读全部落空。去前缀恢复 Win32 常规语义。
pub(crate) fn strip_windows_verbatim_prefix(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.to_string()
    }
}

/// 全量/增量索引主流程（job worker 线程）。
fn run_index_job(
    job_id: &str,
    store: &CodeIndexStore,
    kind: IndexJobKind,
    should_cancel: &dyn Fn() -> bool,
) -> Result<(), String> {
    // 全量（rebuild）：清库放在 job 内部——已通过单 job 闸门，不会与并发
    // job 竞争；spawn 失败也不会白白毁掉现有索引。清库前先确认根可达：
    // 项目盘已卸载时 rebuild 不应先把手里唯一一份索引销毁再报错。
    if kind == IndexJobKind::Full {
        let root = PathBuf::from(&store.workdir);
        if !root.is_dir() {
            return Err(format!("工作区目录不可访问：{}", store.workdir));
        }
        if let Err(error) = store.reset() {
            // reset 半途失败可能留下无 schema 的占位连接：逐出缓存，下次访问重开。
            global_code_index_service().evict_store(&store.workdir);
            return Err(error);
        }
    }

    // 阶段 1：模型预热（首次要下载，最耗时且用户最需要感知的阶段）。
    // ensure_ready 对上次失败会重试：断网首启后重连，rebuild/enable 即恢复语义路。
    let _ = jobs::update_job(job_id, |job| {
        job.phase = "downloading-model".to_string();
        job.message = Some("Preparing embedding model (first run downloads it)".to_string());
    });
    let semantic_active = match embedder::ensure_ready() {
        Ok(()) => true,
        Err(reason) => {
            // 语义路不可用不阻塞词法索引；错误进 message 提示。
            let _ = jobs::update_job(job_id, |job| {
                job.message = Some(format!(
                    "Embedding model unavailable, lexical-only index: {reason}"
                ));
            });
            false
        }
    };
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

    // 消失文件对账：索引里有、磁盘上无 → 删除。遍历有错误跳过时清单可能
    // 不完整（外置盘卸载、目录权限抖动），此时绝不能做删除——那会把
    // “读不到”当“不存在”，静默清空整个索引。
    if outcome.walk_errors == 0 {
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
    } else {
        eprintln!(
            "code index: {} walk errors in {}, skip removal reconciliation",
            outcome.walk_errors, store.workdir
        );
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
    // 未变化短路的前提：语义路状态没有“亏欠”。词法降级期入库的文件
    // （has_vectors=false）在模型就绪后必须放行到重嵌入，否则永远盲区。
    let up_to_date = |meta: &super::store::IndexedFileMeta| meta.has_vectors || !semantic_active;
    if kind == IndexJobKind::Incremental {
        if let Some(meta) = &existing {
            if meta.mtime_ms == file.mtime_ms && up_to_date(meta) {
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
            if meta.content_hash == content_hash && up_to_date(meta) {
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
/// 排除规则与全量遍历同源（WatchPathFilter）——watcher 不区分 gitignore，
/// 这里必须补判，否则 .env 等被忽略的密钥文件会经增量路进入索引。
fn incremental_update_paths(
    store: &CodeIndexStore,
    rel_paths: &BTreeSet<String>,
) -> Result<(), String> {
    let workdir = PathBuf::from(&store.workdir);
    let filter = WatchPathFilter::new(&workdir, rel_paths);
    // 非阻塞探测：watch 路径绝不触发模型下载；缺向量由下一次 job 回填。
    let semantic_active = matches!(
        embedder::availability(),
        embedder::EmbedderAvailability::Ready
    );
    for rel_path in rel_paths {
        if rel_path.is_empty() {
            continue;
        }
        if !filter.allows(rel_path) {
            // 被排除路径：跳过而不删除。filter 与全量遍历的规则并非严格同集
            //（filter 偏保守），删除会造成“watch 删一次、job 加回来”的振荡；
            // 真该排除的存量行由下一次 job 的消失文件对账清掉。
            continue;
        }
        let abs = workdir.join(rel_path);
        // symlink_metadata：全量遍历不跟随符号链接（follow_links(false)），
        // 增量同样不跟——否则 touch 一个链接就能把工作区外的目标索引进来。
        let Ok(metadata) = std::fs::symlink_metadata(&abs) else {
            // 文件或目录已删除（或不可读）：清掉本路径与其目录前缀下的所有
            // 索引行——目录删除/重命名时 watcher 只报目录路径，不清前缀就
            // 会留下整棵幽灵子树。
            if store.file_meta(rel_path)?.is_some() {
                store.remove_file(rel_path)?;
            }
            store.remove_files_under_dir(rel_path)?;
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() == 0 || metadata.len() > walker::MAX_FILE_BYTES {
            // 变空/超限的文件不再索引；旧块一并清掉，避免行号错位的陈旧命中。
            if store.file_meta(rel_path)?.is_some() {
                store.remove_file(rel_path)?;
            }
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
