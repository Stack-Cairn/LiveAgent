//! Embedder：fastembed(ONNX) 进程级单例，懒初始化。
//!
//! 首次使用会从 HuggingFace 下载 multilingual-e5-small（数百 MB）到
//! `~/.liveagent/code-index/models/`，此后完全离线。初始化失败不 poison
//! 全局状态——记录错误，检索路降级纯词法，索引 job 报错提示网络。
//!
//! e5 前缀约定（fastembed 不自动加）：入库块 `passage: `，查询 `query: `。

use std::sync::{Mutex, OnceLock};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

use super::paths::models_cache_dir;
use super::schema::EMBEDDING_DIM;

/// 索引批量大小：单批 embed 的块数。
pub(crate) const EMBED_BATCH_SIZE: usize = 64;
/// 后台索引不与前台抢核。
const INTRA_THREADS: usize = 4;

static EMBEDDER: OnceLock<Mutex<Result<TextEmbedding, String>>> = OnceLock::new();

fn embedder() -> &'static Mutex<Result<TextEmbedding, String>> {
    EMBEDDER.get_or_init(|| {
        Mutex::new(init_embedder().map_err(|error| {
            eprintln!("code index embedder init failed: {error}");
            error
        }))
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

/// 模型已就绪或本次能初始化成功。检索路用它决定语义路是否可用。
pub(crate) fn embedder_available() -> bool {
    embedder()
        .lock()
        .map(|guard| guard.is_ok())
        .unwrap_or(false)
}

/// 上次初始化失败的原因（可读提示用）。
pub(crate) fn embedder_error() -> Option<String> {
    embedder()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().err().cloned())
}

fn embed_with_prefix(prefix: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let prefixed: Vec<String> = texts.iter().map(|text| format!("{prefix}{text}")).collect();
    let mut guard = embedder()
        .lock()
        .map_err(|_| "embedding 模型锁被污染".to_string())?;
    let model = guard.as_mut().map_err(|error| error.clone())?;
    let embeddings = model
        .embed(&prefixed, Some(EMBED_BATCH_SIZE))
        .map_err(|e| format!("embedding 推理失败：{e}"))?;
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

/// 入库块向量化。
pub(crate) fn embed_passages(texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    embed_with_prefix("passage: ", texts)
}

/// 查询向量化。
pub(crate) fn embed_query(query: &str) -> Result<Vec<f32>, String> {
    let mut embeddings = embed_with_prefix("query: ", &[query.to_string()])?;
    embeddings
        .pop()
        .ok_or_else(|| "embedding 推理返回空结果".to_string())
}
