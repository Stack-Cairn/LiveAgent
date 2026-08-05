use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CRON_CHANGED_EVENT: &str = "automation:cron-changed";
pub const HOOKS_CHANGED_EVENT: &str = "automation:hooks-changed";
pub const PROMPT_PENDING_EVENT: &str = "automation:prompt-pending";
pub const PROMPT_EXPIRED_EVENT: &str = "automation:prompt-expired";

/// Sentinel written in place of HTTP header values when a snapshot leaves the
/// desktop (gateway sync / web clients). Apply ops carrying this sentinel keep
/// the currently stored value, so remote clients can edit a request without
/// ever seeing or re-sending the secret.
pub const MASKED_HEADER_VALUE: &str = "__liveagent-masked__";

pub const CRON_TASK_KINDS: &[&str] = &["bash", "http", "prompt"];
pub const CRON_REASONING_LEVELS: &[&str] =
    &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// Per-task execution timeout applied to bash scripts, each http request and
/// the prompt run lease. Tasks stored before the field existed resolve to it.
pub const DEFAULT_CRON_TIMEOUT_SECONDS: u64 = 300;

pub fn default_cron_timeout_seconds() -> u64 {
    DEFAULT_CRON_TIMEOUT_SECONDS
}
pub const HOOK_KINDS: &[&str] = &["command", "http"];
pub const HOOK_EVENTS: &[&str] = &[
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
    "agent_end",
];
pub const HTTP_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

pub fn http_method_can_have_body(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    pub id: String,
    pub url: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedModelRef {
    pub custom_provider_id: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub cron: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_executions: Option<u64>,
    /// Execution timeout in seconds (bash script / each http request / prompt
    /// run lease). Always serialized; missing input defaults to 300.
    #[serde(default = "default_cron_timeout_seconds")]
    pub timeout_seconds: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests: Option<Vec<HttpRequestSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<SelectedModelRef>,
    /// Thinking level for prompt tasks; None/empty means the runtime default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Workspace path pinned for this task; None/empty means "follow the
    /// globally active workspace" (the pre-existing behavior).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub event: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests: Option<Vec<HttpRequestSpec>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronSnapshot {
    pub revision: u64,
    pub tasks: Vec<CronTask>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksSnapshot {
    pub revision: u64,
    pub hooks: Vec<HookDef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSnapshot {
    pub cron: CronSnapshot,
    pub hooks: HooksSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum AutomationOp {
    Create {
        #[serde(rename = "item")]
        item: Value,
    },
    Update {
        id: String,
        patch: Value,
    },
    Delete {
        id: String,
    },
    Reorder {
        ids: Vec<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationApplyInput {
    pub base_revision: u64,
    pub ops: Vec<AutomationOp>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronApplyResponse {
    pub status: ApplyStatus,
    pub cron: CronSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksApplyResponse {
    pub status: ApplyStatus,
    pub hooks: HooksSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyStatus {
    Ok,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Pending,
    Leased,
    Done,
    Expired,
}

impl RunState {
    pub fn as_str(self) -> &'static str {
        match self {
            RunState::Pending => "pending",
            RunState::Leased => "leased",
            RunState::Done => "done",
            RunState::Expired => "expired",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(RunState::Pending),
            "leased" => Ok(RunState::Leased),
            "done" => Ok(RunState::Done),
            "expired" => Ok(RunState::Expired),
            other => Err(format!("unknown automation run state: {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunNowResponse {
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    pub id: String,
    pub task_id: String,
    pub state: RunState,
    pub success: bool,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRunRequest {
    pub execution_id: String,
    pub task_id: String,
    pub task_name: String,
    pub prompt: String,
    pub provider_id: String,
    pub model: String,
    pub started_at: i64,
    pub lease_expires_at: i64,
    #[serde(default = "default_true")]
    pub counted: bool,
    /// Resolved at queue time (task pin or global workdir). Empty on rows
    /// queued before this field existed; the runner falls back to the global
    /// workdir then.
    #[serde(default)]
    pub workdir: String,
    /// Task thinking level; empty means the runner's default.
    #[serde(default)]
    pub reasoning: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletePromptRunInput {
    pub execution_id: String,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptCompletionStatus {
    Completed,
    AlreadyFinished,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCompletionResponse {
    pub status: PromptCompletionStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptExpiredEvent {
    pub execution_id: String,
    pub task_id: String,
}

/// Outcome of a finished bash/http run (or a synthesized failure/skip record)
/// persisted by the scheduler.
#[derive(Debug, Clone)]
pub struct CompletedRun {
    pub task_id: String,
    pub success: bool,
    pub started_at: i64,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub output: String,
    /// Counted runs decrement `remaining_executions`; skip records do not.
    pub counted: bool,
}
