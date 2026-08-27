//! 对外 DTO。全部 camelCase 序列化，与 memory 服务的 command 约定一致。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexEnableArgs {
    pub workdir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexDisableArgs {
    pub workdir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexStatusArgs {
    pub workdir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexRebuildArgs {
    pub workdir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexJobCancelArgs {
    pub job_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexWarmArgs {
    pub workdir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexSearchArgs {
    pub workdir: String,
    pub query: String,
    /// "hybrid"（默认）| "semantic" | "lexical"
    pub mode: Option<String>,
    /// workspace 相对路径前缀过滤。
    pub path: Option<String>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexJobSnapshot {
    pub job_id: String,
    pub workdir: String,
    /// queued | downloading-model | walking | chunking | embedding | done | cancelled | error
    pub phase: String,
    pub total_files: u64,
    pub processed_files: u64,
    pub indexed_chunks: u64,
    pub message: Option<String>,
    pub error: Option<String>,
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexStatusResponse {
    /// 索引库存在（enable 过且未 disable）。
    pub indexed: bool,
    pub file_count: u64,
    pub chunk_count: u64,
    pub db_size_bytes: u64,
    pub last_full_index_at: Option<i64>,
    pub embedding_model: Option<String>,
    /// 该 workdir 当前进行中的 job（若有）。
    pub active_job: Option<CodeIndexJobSnapshot>,
    /// 最近一个已完结的 job（1 小时保留期内）。UI 靠它展示失败终态——
    /// activeJob 只包含进行中的 job，error/cancelled 完结即从那里消失。
    pub last_job: Option<CodeIndexJobSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexSearchMatch {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    /// "function" | "class" | "method" | "window"
    pub kind: String,
    pub symbol: String,
    /// 现读文件的片段（可能截断）。索引落后磁盘时可能为空。
    pub snippet: String,
    /// RRF 融合得分。
    pub score: f64,
    /// "lexical" | "semantic" | "both"
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexSearchResponse {
    pub matches: Vec<CodeIndexSearchMatch>,
    pub mode: String,
    /// 语义路不可用（模型未就绪等）而降级为纯词法时置位并说明。
    pub degraded: Option<String>,
    /// 索引冷启动/重建/增量进行中（或索引为空）时置位并说明：结果可能
    /// 不完整、排序会随索引增长漂移。调用方（Agent）据此决定是否稍后重试，
    /// 而不是把构建期的局部结果当成全量事实。
    pub indexing: Option<String>,
}
