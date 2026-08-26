//! Embedder：fastembed(ONNX) 进程级单例，懒初始化。
//!
//! 首次使用会从 HuggingFace 下载 multilingual-e5-small（数百 MB）到
//! `~/.liveagent/code-index/models/`，此后完全离线。
//!
//! 状态机（state 锁只做短临界区，初始化/推理都不持有它）：
//! - 索引 job 走 [`ensure_ready`]：失败状态可重试（断网首启后重连即恢复，
//!   不再是进程级一锤定音）；并发调用只有一个线程真正初始化，其余等待。
//! - 检索路走 [`availability`]（非阻塞探测）与 [`embed_query`]（限时等模型锁，
//!   索引批量嵌入进行中时短等后放弃，由调用方降级词法），绝不被首启的模型
//!   下载拖住。
//!
//! e5 前缀约定（fastembed 不自动加）：入库块 `passage: `，查询 `query: `。

use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use super::paths::models_cache_dir;
use super::schema::EMBEDDING_DIM;

/// 索引批量大小：单批 embed 的块数。
pub(crate) const EMBED_BATCH_SIZE: usize = 64;
/// 后台索引不与前台抢核。
const INTRA_THREADS: usize = 4;
/// 检索路等模型锁的上限：索引批量嵌入约秒级，超时说明该降级词法了。
const QUERY_LOCK_WAIT: Duration = Duration::from_secs(2);
const QUERY_LOCK_POLL: Duration = Duration::from_millis(50);

#[derive(Clone)]
enum EmbedderPhase {
    Idle,
    Initializing,
    Ready,
    Failed(String),
}

/// 检索路的非阻塞可用性视图。
pub(crate) enum EmbedderAvailability {
    Ready,
    /// 有线程正在下载/加载模型。
    Initializing,
    Unavailable(String),
}

struct EmbedderShared {
    phase: Mutex<EmbedderPhase>,
    phase_changed: Condvar,
    model: Mutex<Option<TextEmbedding>>,
}

static EMBEDDER: OnceLock<EmbedderShared> = OnceLock::new();

fn shared() -> &'static EmbedderShared {
    EMBEDDER.get_or_init(|| EmbedderShared {
        phase: Mutex::new(EmbedderPhase::Idle),
        phase_changed: Condvar::new(),
        model: Mutex::new(None),
    })
}

fn init_embedder() -> Result<TextEmbedding, String> {
    let cache_dir = models_cache_dir()?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建模型缓存目录失败：{e}"))?;
    TextEmbedding::try_new(
        InitOptions::new(EmbeddingModel::MultilingualE5Small)
            .with_cache_dir(cache_dir)
            .with_intra_threads(INTRA_THREADS),
    )
    .map_err(|e| format!("初始化 embedding 模型失败（首次使用需联网下载模型）：{e}"))
}

/// 确保模型就绪（必要时初始化/下载，阻塞）。索引 job 专用；上次失败会重试。
pub(crate) fn ensure_ready() -> Result<(), String> {
    let state = shared();
    {
        let mut phase = state
            .phase
            .lock()
            .map_err(|_| "embedding 状态锁被污染".to_string())?;
        loop {
            match &*phase {
                EmbedderPhase::Ready => return Ok(()),
                EmbedderPhase::Initializing => {
                    phase = state
                        .phase_changed
                        .wait(phase)
                        .map_err(|_| "embedding 状态锁被污染".to_string())?;
                }
                EmbedderPhase::Idle | EmbedderPhase::Failed(_) => {
                    *phase = EmbedderPhase::Initializing;
                    break;
                }
            }
        }
    }
    // 本线程负责初始化；不持有 phase 锁做下载/加载。init panic 必须被截住：
    // 否则 phase 永远停在 Initializing，等待者在 condvar 上无限阻塞。
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(init_embedder))
        .unwrap_or_else(|_| Err("embedding 模型初始化线程 panic".to_string()));
    let mut phase = state
        .phase
        .lock()
        .map_err(|_| "embedding 状态锁被污染".to_string())?;
    let outcome = match result {
        Ok(model) => {
            // 上次 embed panic 可能毒化过 model 锁：poison 只是标记，装入
            // 新模型即恢复。
            let mut slot = match state.model.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            *slot = Some(model);
            drop(slot);
            state.model.clear_poison();
            *phase = EmbedderPhase::Ready;
            Ok(())
        }
        Err(error) => {
            eprintln!("code index embedder init failed: {error}");
            *phase = EmbedderPhase::Failed(error.clone());
            Err(error)
        }
    };
    state.phase_changed.notify_all();
    outcome
}

/// embed panic（推理库边缘场景）毒化 model 锁后，phase 仍是 Ready 会让语义路
/// “看着可用、用必失败”且自愈不触发：这里把 phase 打成 Failed，交给
/// spawn_background_init / 下一次 job 重建模型。
fn mark_model_failed(reason: &str) {
    let state = shared();
    if let Ok(mut phase) = state.phase.lock() {
        *phase = EmbedderPhase::Failed(reason.to_string());
    }
    state.phase_changed.notify_all();
}

/// 非阻塞可用性探测：检索路据此决定语义路走不走，绝不触发下载、绝不等待。
pub(crate) fn availability() -> EmbedderAvailability {
    match shared().phase.lock() {
        Ok(phase) => match &*phase {
            EmbedderPhase::Ready => EmbedderAvailability::Ready,
            EmbedderPhase::Initializing => EmbedderAvailability::Initializing,
            EmbedderPhase::Idle => {
                EmbedderAvailability::Unavailable("embedding 模型尚未初始化".to_string())
            }
            EmbedderPhase::Failed(error) => EmbedderAvailability::Unavailable(error.clone()),
        },
        Err(_) => EmbedderAvailability::Unavailable("embedding 状态锁被污染".to_string()),
    }
}

/// 后台重试初始化：检索路发现模型不可用时触发（不阻塞调用方）。
/// 场景：离线启用后重新联网——若无人再点 enable/rebuild，语义路会一直卡在
/// 缓存的失败态。5 分钟节流，持续离线时不会每次检索都发起下载。
pub(crate) fn spawn_background_init() {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST_ATTEMPT_MS: AtomicI64 = AtomicI64::new(0);
    let now = super::now_ms();
    let last = LAST_ATTEMPT_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < 5 * 60 * 1000 {
        return;
    }
    if LAST_ATTEMPT_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    std::thread::spawn(|| {
        let _ = ensure_ready();
    });
}

fn embed_with_model(
    model: &mut TextEmbedding,
    prefix: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let prefixed: Vec<String> = texts.iter().map(|text| format!("{prefix}{text}")).collect();
    // 推理 panic 在锁内截获，避免毒化 model 锁（毒化后语义路整体瘫痪）。
    let embeddings = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        model.embed(&prefixed, Some(EMBED_BATCH_SIZE))
    })) {
        Ok(Ok(embeddings)) => embeddings,
        Ok(Err(error)) => return Err(format!("embedding 推理失败：{error}")),
        Err(_) => return Err("embedding 推理线程 panic".to_string()),
    };
    for embedding in &embeddings {
        if embedding.len() != EMBEDDING_DIM {
            return Err(format!(
                "embedding 维度异常：期望 {EMBEDDING_DIM}，得到 {}",
                embedding.len()
            ));
        }
    }
    Ok(embeddings)
}

/// 入库块向量化（索引 job 专用：阻塞等模型锁）。
pub(crate) fn embed_passages(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if !matches!(availability(), EmbedderAvailability::Ready) {
        return Err("embedding 模型未就绪".to_string());
    }
    let mut guard = match shared().model.lock() {
        Ok(guard) => guard,
        Err(_) => {
            mark_model_failed("embedding 模型锁被污染，待重建");
            return Err("embedding 模型锁被污染".to_string());
        }
    };
    let model = guard.as_mut().ok_or("embedding 模型未就绪")?;
    embed_with_model(model, "passage: ", texts)
}

/// 查询向量化（检索路：限时等锁，索引批量嵌入占着模型时放弃，调用方降级词法）。
pub(crate) fn embed_query(query: &str) -> Result<Vec<f32>, String> {
    if !matches!(availability(), EmbedderAvailability::Ready) {
        return Err("embedding 模型未就绪".to_string());
    }
    let state = shared();
    let deadline = std::time::Instant::now() + QUERY_LOCK_WAIT;
    let mut guard = loop {
        match state.model.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err("embedding 模型正忙（后台索引批量嵌入中）".to_string());
                }
                std::thread::sleep(QUERY_LOCK_POLL);
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                mark_model_failed("embedding 模型锁被污染，待重建");
                return Err("embedding 模型锁被污染".to_string());
            }
        }
    };
    let model = guard.as_mut().ok_or("embedding 模型未就绪")?;
    let mut embeddings = embed_with_model(model, "query: ", &[query.to_string()])?;
    embeddings
        .pop()
        .ok_or_else(|| "embedding 推理返回空结果".to_string())
}
