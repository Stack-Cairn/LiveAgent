//! 代码库索引服务（docs/design/code-index.md）。
//!
//! Per-workspace 语义检索/代码索引：`ignore` walker 增量遍历、tree-sitter
//! 语法切块、fastembed(ONNX) 本地向量化、SQLite（FTS5 + sqlite-vec）双索引、
//! BM25 + 向量余弦 RRF 融合检索。基建模式与 memory-index / skills jobs 同款。
//!
//! - [`types`]：对外 DTO（serde camelCase）
//! - [`paths`]：`~/.liveagent/code-index/` 根目录、per-workspace hash 目录
//! - [`schema`]：DDL、连接打开、integrity_check + quarantine 重建
//! - [`store`]：`CodeIndexStore`（单连接 + Mutex，文件/块 upsert 与统计；
//!   FTS 写入侧 CJK bigram 预切分，与查询侧同源）
//! - [`walker`]：`ignore` 遍历 + mtime/内容哈希增量判定 + 生成物头部标记探测
//! - [`chunker`]：tree-sitter 函数/类切块，无 grammar 语言滑窗回退
//! - [`embedder`]：fastembed 进程级单例（懒初始化，首次下载模型；输出显式
//!   L2 归一化，语义路距离阈值的前提）
//! - [`search`]：FTS5 BM25 + vec0 KNN（带相关性阈值），RRF 融合，片段现读；
//!   响应携带 degraded（语义路降级）与 indexing（构建期状态）说明
//! - [`jobs`]：后台索引 job（进度快照 + `AtomicBool` 协作式取消）
//! - [`service`]：`CodeIndexService` 对外编排（enable/disable/rebuild/search/watch 失效）

mod chunker;
mod embedder;
mod jobs;
mod paths;
mod schema;
mod search;
mod service;
mod store;
#[cfg(test)]
mod tests;
mod types;
mod walker;

pub use service::global_code_index_service;
pub use types::*;

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
