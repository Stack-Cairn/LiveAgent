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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_confidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_downgraded: Option<bool>,
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
    pub phase: Option<String>,
    pub final_count: i64,
    pub compression_ratio: Option<f64>,
    pub compression_target: Option<i64>,
    pub dry_run: bool,
    pub token_usage_total: i64,
    pub quota_headroom_at_start: Option<i64>,
    pub override_reviewed: bool,
    pub report: Value,
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

#[derive(Debug, Clone, Deserialize, Default)]
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
    pub phase: Option<String>,
    pub final_count: Option<i64>,
    pub compression_ratio: Option<f64>,
    pub compression_target: Option<i64>,
    pub dry_run: Option<bool>,
    pub token_usage_total: Option<i64>,
    pub quota_headroom_at_start: Option<i64>,
    pub override_reviewed: Option<bool>,
    pub report: Option<Value>,
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

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvidenceArgs {
    pub confidence: Option<String>,
    pub source_quote: Option<String>,
    pub reasoning: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub conflicts_with: Option<Vec<String>>,
    pub supersedes: Option<String>,
    pub override_reject: Option<String>,
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
    pub evidence: Option<MemoryEvidenceArgs>,
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
    pub evidence: Option<MemoryEvidenceArgs>,
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
    pub mode: Option<String>,
    pub reason: Option<String>,
    pub group_id: Option<String>,
    pub evidence: Option<MemoryEvidenceArgs>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryQuotaSummaryArgs {
    pub workdir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryQuotaSummaryResponse {
    pub scopes: Vec<MemoryQuotaScopeSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryQuotaScopeSummary {
    pub scope: String,
    pub workdir_hash: String,
    pub used: usize,
    pub limit: usize,
    pub headroom: usize,
    pub archived_count: usize,
    pub unreviewed_count: usize,
    pub oldest_unreviewed_age_days: Option<f64>,
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
