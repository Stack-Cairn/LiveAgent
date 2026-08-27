//! Embedder：fastembed(ONNX) 进程级单例，懒初始化。
//!
//! 首次使用会从 HuggingFace 下载 multilingual-e5-small（数百 MB）到
//! `~/.liveagent/code-index/models/`，此后完全离线。
//!
//! 状态机（state 锁只做短临界区，初始化/推理都不持有它）：
//! - 索引 job 走 [`ensure_ready`]：失败状态可重试（断网首启后重连即恢复，
//!   不再是进程级一锤定音）；并发调用只有一个线程真正初始化，其余等待。
//! - 检索路走 [`availability`]（非阻塞探测）与 [`embed_query`]（限时等模型锁，
//!   超时放弃，由调用方降级词法），绝不被首启的模型下载拖住。
//! - 模型锁按**单批**拿放（[`embed_passages`] 内部分批），批间对等锁的查询
//!   让路（查询优先）：整文件一次锁几十秒会把检索路的限时等待全部耗尽——
//!   后台索引期间 hybrid 全数降级词法、semantic 直接失败。让路是必需的，
//!   Mutex 不公平，索引线程放锁后微秒级就能抢回，轮询中的查询几乎永远输。
//!
//! e5 前缀约定（fastembed 不自动加）：入库块 `passage: `，查询 `query: `。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use super::paths::models_cache_dir;
use super::schema::EMBEDDING_DIM;

/// 索引批量大小：单批 embed 的块数，也是模型锁的持有粒度。
pub(crate) const EMBED_BATCH_SIZE: usize = 64;
/// 后台索引不与前台抢核。
const INTRA_THREADS: usize = 4;
/// 检索路等模型锁的上限：锁粒度是单批推理（慢机上约秒级），加上索引批间
/// 让路，正常拿锁远快于此；超时说明确有异常，降级词法。
const QUERY_LOCK_WAIT: Duration = Duration::from_secs(5);
const QUERY_LOCK_POLL: Duration = Duration::from_millis(50);
/// 索引批间让路的上限：查询嵌入毫秒级，正常一两个轮询周期就清空；
/// 达到上限说明查询侧卡住，不再让索引挨饿。
const INDEX_YIELD_MAX: Duration = Duration::from_secs(5);
const INDEX_YIELD_POLL: Duration = Duration::from_millis(10);

/// 正在等模型锁的查询数（进程级，跨 workspace——embedder 本身就是进程单例）。
static QUERY_WAITERS: AtomicUsize = AtomicUsize::new(0);

/// 等锁查询的 RAII 登记：Drop 归还计数，覆盖超时/毒化/成功全部退出路径。
struct QueryWaiterGuard;

impl QueryWaiterGuard {
    fn register() -> Self {
        QUERY_WAITERS.fetch_add(1, Ordering::AcqRel);
        QueryWaiterGuard
    }
}

impl Drop for QueryWaiterGuard {
    fn drop(&mut self) {
        QUERY_WAITERS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 索引路批间让路：有查询在等就暂停，直到等待队列清空或达到上限。
fn yield_to_waiting_queries() {
    if QUERY_WAITERS.load(Ordering::Acquire) == 0 {
        return;
    }
    let deadline = Instant::now() + INDEX_YIELD_MAX;
    while QUERY_WAITERS.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
        std::thread::sleep(INDEX_YIELD_POLL);
    }
}

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
    let mut embeddings = embeddings;
    for embedding in &mut embeddings {
        if embedding.len() != EMBEDDING_DIM {
            return Err(format!(
                "embedding 维度异常：期望 {EMBEDDING_DIM}，得到 {}",
                embedding.len()
            ));
        }
        // 显式 L2 归一化：检索路的相关性阈值（search::SEMANTIC_MAX_DISTANCE）
        // 建立在"vec0 的 L2 距离 ↔ 余弦相似度"换算上，该换算只对单位向量成立。
        // fastembed 对 e5 系通常已归一化，这里再归一是幂等兜底，不赌上游行为。
        l2_normalize(embedding);
    }
    Ok(embeddings)
}

/// 归一化为单位向量；零向量（理论不可达）保持原样避免除零。
fn l2_normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for value in vector.iter_mut() {
            *value /= norm;
        }
    }
}

/// 入库块向量化（索引 job 专用：阻塞等模型锁）。
///
/// 锁按单批（[`EMBED_BATCH_SIZE`]）拿放而非整个文件持有：大文件几百块一次
/// 锁几十秒，检索路的限时等锁必然全部超时。每批前先对等锁查询让路——
/// 查询是毫秒级、批是秒级，让路对索引吞吐的影响可忽略。
pub(crate) fn embed_passages(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let state = shared();
    let mut all = Vec::with_capacity(texts.len());
    for batch in texts.chunks(EMBED_BATCH_SIZE) {
        yield_to_waiting_queries();
        // 就绪检查进循环：批间查询若毒化了锁并标记 Failed，索引应立即止损。
        if !matches!(availability(), EmbedderAvailability::Ready) {
            return Err("embedding 模型未就绪".to_string());
        }
        let mut guard = match state.model.lock() {
            Ok(guard) => guard,
            Err(_) => {
                mark_model_failed("embedding 模型锁被污染，待重建");
                return Err("embedding 模型锁被污染".to_string());
            }
        };
        let model = guard.as_mut().ok_or("embedding 模型未就绪")?;
        all.extend(embed_with_model(model, "passage: ", batch)?);
    }
    Ok(all)
}

/// 查询向量化（检索路：限时等锁，超时放弃，调用方降级词法）。
/// 等待期间通过 [`QueryWaiterGuard`] 登记——索引路批间看到有查询在等会让路，
/// 所以正常最多等当前一批推理完成。
pub(crate) fn embed_query(query: &str) -> Result<Vec<f32>, String> {
    if !matches!(availability(), EmbedderAvailability::Ready) {
        return Err("embedding 模型未就绪".to_string());
    }
    let state = shared();
    let _waiter = QueryWaiterGuard::register();
    let deadline = Instant::now() + QUERY_LOCK_WAIT;
    let mut guard = loop {
        match state.model.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 让路计数是进程级共享的，测试并行跑会互相干扰：串行化本模块的测试。
    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    /// 归一化后为单位向量（阈值换算的前提）；零向量不除零。
    #[test]
    fn l2_normalize_produces_unit_vectors() {
        let mut vector = vec![3.0_f32, 4.0];
        l2_normalize(&mut vector);
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6, "norm = {norm}");
        // 已归一的向量再归一是幂等。
        let snapshot = vector.clone();
        l2_normalize(&mut vector);
        assert_eq!(vector, snapshot);
        let mut zero = vec![0.0_f32; 4];
        l2_normalize(&mut zero);
        assert!(zero.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn query_waiter_guard_counts_all_exit_paths() {
        let _serial = TEST_SERIAL.lock().unwrap();
        let before = QUERY_WAITERS.load(Ordering::Acquire);
        {
            let _guard = QueryWaiterGuard::register();
            assert_eq!(QUERY_WAITERS.load(Ordering::Acquire), before + 1);
            let _second = QueryWaiterGuard::register();
            assert_eq!(QUERY_WAITERS.load(Ordering::Acquire), before + 2);
        }
        assert_eq!(QUERY_WAITERS.load(Ordering::Acquire), before);
    }

    /// 无查询等待时，批间让路必须是零开销快路径（不 sleep）。
    #[test]
    fn yield_is_immediate_without_waiters() {
        let _serial = TEST_SERIAL.lock().unwrap();
        let start = Instant::now();
        yield_to_waiting_queries();
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    /// 有查询在等时索引让路，查询侧释放后索引立刻恢复（不等满上限）。
    #[test]
    fn yield_waits_until_query_waiters_drain() {
        let _serial = TEST_SERIAL.lock().unwrap();
        let guard = QueryWaiterGuard::register();
        let handle = std::thread::spawn(|| {
            let start = Instant::now();
            yield_to_waiting_queries();
            start.elapsed()
        });
        std::thread::sleep(Duration::from_millis(50));
        drop(guard);
        let waited = handle.join().expect("yield thread panicked");
        assert!(
            waited >= Duration::from_millis(40),
            "让路未生效：{waited:?}"
        );
        assert!(
            waited < INDEX_YIELD_MAX,
            "让路未随队列清空提前结束：{waited:?}"
        );
    }
}
