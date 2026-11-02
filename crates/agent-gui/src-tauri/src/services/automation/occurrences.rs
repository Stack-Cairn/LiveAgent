//! 日程页「定时任务」图层的数据结构。计算已由 K-brain 后端负责，
//! 本地只保留命令与前端共用的线格式类型。

use serde::{Deserialize, Serialize};

use super::types::RunState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronOccurrenceQuery {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunSummary {
    pub id: String,
    pub task_id: String,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub state: RunState,
    pub success: bool,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub output_preview: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronOccurrenceTask {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub kind: String,
    pub remaining_executions: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<CronRunSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronOccurrence {
    pub task_id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDaySummary {
    pub task_id: String,
    /// 全局默认时区下的本地日期(YYYY-MM-DD)。
    pub date: String,
    pub planned: u32,
    /// 计划次数达到单日展开上限,真实次数更多。
    pub planned_truncated: bool,
    pub ran: u32,
    pub failed: u32,
    pub first_at: i64,
    pub last_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronOccurrencesResponse {
    pub time_zone: String,
    pub now: i64,
    pub tasks: Vec<CronOccurrenceTask>,
    pub occurrences: Vec<CronOccurrence>,
    pub runs: Vec<CronRunSummary>,
    pub summaries: Vec<CronDaySummary>,
}
