use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::commands::{
    delegate::{self, DelegateWorktreeCleanupTarget},
    history_db,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdentityRecord {
    pub parent_conversation_id: String,
    pub logical_agent_id: String,
    pub display_name: String,
    pub role: String,
    pub identity_prompt: String,
    pub agent_id: Option<String>,
    pub template_name: Option<String>,
    pub default_mode: String,
    pub default_task_intent: String,
    pub default_apply_policy: String,
    pub created_parent_tool_call_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSegmentRecord {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunEventRecord {
    pub id: i64,
    pub run_id: String,
    pub event_type: String,
    pub round_index: Option<i64>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_error: bool,
    pub payload_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageRecord {
    pub id: i64,
    pub parent_conversation_id: String,
    pub seq: i64,
    pub sender_agent_id: String,
    pub sender_display_name: Option<String>,
    pub recipient_agent_id: String,
    pub recipient_display_name: Option<String>,
    pub channel: String,
    pub subject: Option<String>,
    pub body_markdown: String,
    pub source_run_id: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunRecord {
    pub id: String,
    pub parent_conversation_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub parent_tool_call_id: String,
    pub parent_tool_name: String,
    pub agent_index: i64,
    pub agent_total: i64,
    pub logical_agent_id: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub description: String,
    pub mode: String,
    pub status: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub workdir: Option<String>,
    pub worktree_root: Option<String>,
    pub branch_name: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub round_count: i64,
    pub tool_call_count: i64,
    pub compaction_count: i64,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub segments: Vec<SubagentRunSegmentRecord>,
    pub events: Vec<SubagentRunEventRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSummary {
    pub id: String,
    pub parent_conversation_id: Option<String>,
    pub parent_tool_call_id: String,
    pub parent_tool_name: String,
    pub agent_index: i64,
    pub agent_total: i64,
    pub logical_agent_id: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub description: String,
    pub mode: String,
    pub status: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub workdir: Option<String>,
    pub worktree_root: Option<String>,
    pub branch_name: Option<String>,
    pub message_count: i64,
    pub round_count: i64,
    pub tool_call_count: i64,
    pub compaction_count: i64,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSegmentInput {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdentityUpsertInput {
    pub parent_conversation_id: Option<String>,
    pub logical_agent_id: String,
    pub display_name: String,
    pub role: String,
    pub identity_prompt: String,
    pub agent_id: Option<String>,
    pub template_name: Option<String>,
    pub default_mode: String,
    pub default_task_intent: String,
    pub default_apply_policy: String,
    pub created_parent_tool_call_id: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdentityListInput {
    pub parent_conversation_id: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunUpsertInput {
    pub id: String,
    pub parent_conversation_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub parent_tool_call_id: String,
    pub parent_tool_name: String,
    pub agent_index: i64,
    pub agent_total: i64,
    pub logical_agent_id: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub description: String,
    pub mode: String,
    pub status: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub workdir: Option<String>,
    pub worktree_root: Option<String>,
    pub branch_name: Option<String>,
    pub context_meta_json: String,
    pub active_segment_index: i64,
    pub total_segment_count: i64,
    pub total_message_count: i64,
    pub round_count: i64,
    pub tool_call_count: i64,
    pub compaction_count: i64,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub created_at: Option<i64>,
    pub updated_at: i64,
    pub segments: Vec<SubagentRunSegmentInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunEventInput {
    pub run_id: String,
    pub event_type: String,
    pub round_index: Option<i64>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_error: Option<bool>,
    pub payload_json: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageAppendInput {
    pub parent_conversation_id: Option<String>,
    pub sender_agent_id: String,
    pub sender_display_name: Option<String>,
    pub recipient_agent_id: String,
    pub recipient_display_name: Option<String>,
    pub channel: String,
    pub subject: Option<String>,
    pub body_markdown: String,
    pub source_run_id: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageListInput {
    pub parent_conversation_id: Option<String>,
    pub recipient_agent_id: Option<String>,
    pub include_shared: Option<bool>,
    pub include_sent: Option<bool>,
    pub after_seq: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunListInput {
    pub parent_conversation_id: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunPruneInput {
    pub parent_conversation_id: String,
    pub keep_parent_tool_call_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunPrunedWorktree {
    pub run_id: String,
    pub worktree_root: String,
    pub branch_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunPruneResult {
    pub parent_conversation_id: String,
    pub kept_parent_tool_call_count: i64,
    pub deleted_run_count: i64,
    pub pruned_worktrees: Vec<SubagentRunPrunedWorktree>,
    pub worktree_cleanup_count: i64,
    pub worktree_cleanup_errors: Vec<String>,
}

fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

fn open_db() -> Result<Connection, String> {
    history_db::open_connection()
}

fn trimmed_opt(value: Option<&String>) -> Option<String> {
    value
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(str::to_string)
}

fn validate_identity_input(input: &SubagentIdentityUpsertInput) -> Result<String, String> {
    let parent = input
        .parent_conversation_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "parentConversationId 不能为空".to_string())?
        .to_string();
    if input.logical_agent_id.trim().is_empty() {
        return Err("logicalAgentId 不能为空".to_string());
    }
    if input.display_name.trim().is_empty() {
        return Err("displayName 不能为空".to_string());
    }
    if input.role.trim().is_empty() {
        return Err("role 不能为空".to_string());
    }
    if input.identity_prompt.trim().is_empty() {
        return Err("identityPrompt 不能为空".to_string());
    }
    if input.default_mode.trim().is_empty() {
        return Err("defaultMode 不能为空".to_string());
    }
    if input.default_task_intent.trim().is_empty() {
        return Err("defaultTaskIntent 不能为空".to_string());
    }
    if input.default_apply_policy.trim().is_empty() {
        return Err("defaultApplyPolicy 不能为空".to_string());
    }
    Ok(parent)
}

fn validate_identity_list_input(input: &SubagentIdentityListInput) -> Result<String, String> {
    input
        .parent_conversation_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "parentConversationId 不能为空".to_string())
}

fn validate_segment_input(segment: &SubagentRunSegmentInput) -> Result<(), String> {
    if segment.segment_index < 0 {
        return Err("segmentIndex 不能小于 0".to_string());
    }
    if segment.segment_id.trim().is_empty() {
        return Err("segmentId 不能为空".to_string());
    }
    if segment.messages_json.trim().is_empty() {
        return Err("messagesJson 不能为空".to_string());
    }
    if segment.message_count < 0 {
        return Err("messageCount 不能小于 0".to_string());
    }
    Ok(())
}

fn validate_upsert_input(input: &SubagentRunUpsertInput) -> Result<(), String> {
    if input.id.trim().is_empty() {
        return Err("子 agent run id 不能为空".to_string());
    }
    if input.parent_tool_call_id.trim().is_empty() {
        return Err("parentToolCallId 不能为空".to_string());
    }
    if input.parent_tool_name.trim().is_empty() {
        return Err("parentToolName 不能为空".to_string());
    }
    if input.description.trim().is_empty() {
        return Err("description 不能为空".to_string());
    }
    if input.mode.trim().is_empty() {
        return Err("mode 不能为空".to_string());
    }
    if input.status.trim().is_empty() {
        return Err("status 不能为空".to_string());
    }
    if input.provider_id.trim().is_empty() {
        return Err("providerId 不能为空".to_string());
    }
    if input.model.trim().is_empty() {
        return Err("model 不能为空".to_string());
    }
    if input.context_meta_json.trim().is_empty() {
        return Err("contextMetaJson 不能为空".to_string());
    }
    if input.agent_index < 0 {
        return Err("agentIndex 不能小于 0".to_string());
    }
    if input.agent_total <= 0 {
        return Err("agentTotal 必须大于 0".to_string());
    }
    if input.logical_agent_id.trim().is_empty() {
        return Err("logicalAgentId 不能为空".to_string());
    }
    if input.active_segment_index < 0 {
        return Err("activeSegmentIndex 不能小于 0".to_string());
    }
    if input.total_segment_count <= 0 {
        return Err("totalSegmentCount 必须大于 0".to_string());
    }
    if input.total_message_count < 0 {
        return Err("totalMessageCount 不能小于 0".to_string());
    }
    if input.round_count < 0 {
        return Err("roundCount 不能小于 0".to_string());
    }
    if input.tool_call_count < 0 {
        return Err("toolCallCount 不能小于 0".to_string());
    }
    if input.compaction_count < 0 {
        return Err("compactionCount 不能小于 0".to_string());
    }
    if input.segments.is_empty() {
        return Err("segments 不能为空".to_string());
    }
    if input.total_segment_count != input.segments.len() as i64 {
        return Err("totalSegmentCount 必须与 segments.length 一致".to_string());
    }
    if input.active_segment_index != input.total_segment_count - 1 {
        return Err("activeSegmentIndex 必须等于 totalSegmentCount - 1".to_string());
    }
    for (index, segment) in input.segments.iter().enumerate() {
        validate_segment_input(segment)?;
        if segment.segment_index != index as i64 {
            return Err(format!(
                "segments 必须按 segmentIndex 从 0 连续递增，发现位置 {} 的 segmentIndex={}",
                index, segment.segment_index
            ));
        }
    }

    Ok(())
}

fn validate_event_input(input: &SubagentRunEventInput) -> Result<(), String> {
    if input.run_id.trim().is_empty() {
        return Err("runId 不能为空".to_string());
    }
    if input.event_type.trim().is_empty() {
        return Err("eventType 不能为空".to_string());
    }
    Ok(())
}

fn validate_message_append_input(input: &SubagentMessageAppendInput) -> Result<String, String> {
    let parent = input
        .parent_conversation_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "parentConversationId 不能为空".to_string())?
        .to_string();
    if input.sender_agent_id.trim().is_empty() {
        return Err("senderAgentId 不能为空".to_string());
    }
    if input.recipient_agent_id.trim().is_empty() {
        return Err("recipientAgentId 不能为空".to_string());
    }
    let channel = input.channel.trim();
    if !matches!(channel, "direct" | "shared" | "decision" | "question") {
        return Err("channel 必须是 direct/shared/decision/question".to_string());
    }
    if input.body_markdown.trim().is_empty() {
        return Err("bodyMarkdown 不能为空".to_string());
    }
    Ok(parent)
}

fn validate_message_list_input(input: &SubagentMessageListInput) -> Result<String, String> {
    input
        .parent_conversation_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "parentConversationId 不能为空".to_string())
}

fn validate_prune_input(input: &SubagentRunPruneInput) -> Result<String, String> {
    let parent = input.parent_conversation_id.trim().to_string();
    if parent.is_empty() {
        return Err("parentConversationId 不能为空".to_string());
    }
    Ok(parent)
}

fn upsert_subagent_run_header(
    conn: &Connection,
    input: &SubagentRunUpsertInput,
) -> Result<(), String> {
    let created_at = input.created_at.unwrap_or_else(now_ms);
    let updated_at = if input.updated_at > 0 {
        input.updated_at
    } else {
        now_ms()
    };

    conn.execute(
        "
        INSERT INTO subagentRun (
            id,
            parent_conversation_id,
            parent_session_id,
            parent_tool_call_id,
            parent_tool_name,
            agent_index,
            agent_total,
            logical_agent_id,
            agent_id,
            agent_name,
            description,
            mode,
            status,
            provider_id,
            model,
            session_id,
            workdir,
            worktree_root,
            branch_name,
            context_meta_json,
            active_segment_index,
            total_segment_count,
            total_message_count,
            round_count,
            tool_call_count,
            compaction_count,
            summary,
            error,
            started_at,
            ended_at,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32)
        ON CONFLICT(id) DO UPDATE SET
            parent_conversation_id = excluded.parent_conversation_id,
            parent_session_id = excluded.parent_session_id,
            parent_tool_call_id = excluded.parent_tool_call_id,
            parent_tool_name = excluded.parent_tool_name,
            agent_index = excluded.agent_index,
            agent_total = excluded.agent_total,
            logical_agent_id = excluded.logical_agent_id,
            agent_id = excluded.agent_id,
            agent_name = excluded.agent_name,
            description = excluded.description,
            mode = excluded.mode,
            status = excluded.status,
            provider_id = excluded.provider_id,
            model = excluded.model,
            session_id = excluded.session_id,
            workdir = excluded.workdir,
            worktree_root = excluded.worktree_root,
            branch_name = excluded.branch_name,
            context_meta_json = excluded.context_meta_json,
            active_segment_index = excluded.active_segment_index,
            total_segment_count = excluded.total_segment_count,
            total_message_count = excluded.total_message_count,
            round_count = excluded.round_count,
            tool_call_count = excluded.tool_call_count,
            compaction_count = excluded.compaction_count,
            summary = excluded.summary,
            error = excluded.error,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            updated_at = excluded.updated_at
        ",
        params![
            input.id.trim(),
            trimmed_opt(input.parent_conversation_id.as_ref()),
            trimmed_opt(input.parent_session_id.as_ref()),
            input.parent_tool_call_id.trim(),
            input.parent_tool_name.trim(),
            input.agent_index,
            input.agent_total,
            input.logical_agent_id.trim(),
            trimmed_opt(input.agent_id.as_ref()),
            trimmed_opt(input.agent_name.as_ref()),
            input.description.trim(),
            input.mode.trim(),
            input.status.trim(),
            input.provider_id.trim(),
            input.model.trim(),
            trimmed_opt(input.session_id.as_ref()),
            trimmed_opt(input.workdir.as_ref()),
            trimmed_opt(input.worktree_root.as_ref()),
            trimmed_opt(input.branch_name.as_ref()),
            input.context_meta_json.trim(),
            input.active_segment_index,
            input.total_segment_count,
            input.total_message_count,
            input.round_count,
            input.tool_call_count,
            input.compaction_count,
            trimmed_opt(input.summary.as_ref()),
            trimmed_opt(input.error.as_ref()),
            input.started_at,
            input.ended_at,
            created_at,
            updated_at,
        ],
    )
    .map_err(|e| format!("写入子 agent run 主表失败：{e}"))?;

    Ok(())
}

fn sync_segments(
    conn: &Connection,
    run_id: &str,
    segments: &[SubagentRunSegmentInput],
    total_segment_count: i64,
) -> Result<(), String> {
    for segment in segments {
        conn.execute(
            "
            INSERT INTO subagentRunSegment (
                run_id,
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(run_id, segment_index) DO UPDATE SET
                segment_id = excluded.segment_id,
                summary_json = excluded.summary_json,
                messages_json = excluded.messages_json,
                message_count = excluded.message_count,
                start_message_id = excluded.start_message_id,
                end_message_id = excluded.end_message_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            ",
            params![
                run_id,
                segment.segment_index,
                segment.segment_id.trim(),
                segment.summary_json.as_deref().map(str::trim),
                segment.messages_json.trim(),
                segment.message_count,
                segment.start_message_id.as_deref().map(str::trim),
                segment.end_message_id.as_deref().map(str::trim),
                segment.created_at,
                segment.updated_at,
            ],
        )
        .map_err(|e| format!("写入子 agent 历史分段失败：{e}"))?;
    }

    conn.execute(
        "
        DELETE FROM subagentRunSegment
        WHERE run_id = ?1
          AND segment_index >= ?2
        ",
        params![run_id, total_segment_count],
    )
    .map_err(|e| format!("清理过期子 agent 历史分段失败：{e}"))?;

    Ok(())
}

fn row_to_identity(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentIdentityRecord> {
    Ok(SubagentIdentityRecord {
        parent_conversation_id: row.get("parent_conversation_id")?,
        logical_agent_id: row.get("logical_agent_id")?,
        display_name: row.get("display_name")?,
        role: row.get("role")?,
        identity_prompt: row.get("identity_prompt")?,
        agent_id: row.get("agent_id")?,
        template_name: row.get("template_name")?,
        default_mode: row.get("default_mode")?,
        default_task_intent: row.get("default_task_intent")?,
        default_apply_policy: row.get("default_apply_policy")?,
        created_parent_tool_call_id: row.get("created_parent_tool_call_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentRunSummary> {
    Ok(SubagentRunSummary {
        id: row.get("id")?,
        parent_conversation_id: row.get("parent_conversation_id")?,
        parent_tool_call_id: row.get("parent_tool_call_id")?,
        parent_tool_name: row.get("parent_tool_name")?,
        agent_index: row.get("agent_index")?,
        agent_total: row.get("agent_total")?,
        logical_agent_id: row.get("logical_agent_id")?,
        agent_id: row.get("agent_id")?,
        agent_name: row.get("agent_name")?,
        description: row.get("description")?,
        mode: row.get("mode")?,
        status: row.get("status")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        workdir: row.get("workdir")?,
        worktree_root: row.get("worktree_root")?,
        branch_name: row.get("branch_name")?,
        message_count: row.get("total_message_count")?,
        round_count: row.get("round_count")?,
        tool_call_count: row.get("tool_call_count")?,
        compaction_count: row.get("compaction_count")?,
        summary: row.get("summary")?,
        error: row.get("error")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentRunRecord> {
    Ok(SubagentRunRecord {
        id: row.get("id")?,
        parent_conversation_id: row.get("parent_conversation_id")?,
        parent_session_id: row.get("parent_session_id")?,
        parent_tool_call_id: row.get("parent_tool_call_id")?,
        parent_tool_name: row.get("parent_tool_name")?,
        agent_index: row.get("agent_index")?,
        agent_total: row.get("agent_total")?,
        logical_agent_id: row.get("logical_agent_id")?,
        agent_id: row.get("agent_id")?,
        agent_name: row.get("agent_name")?,
        description: row.get("description")?,
        mode: row.get("mode")?,
        status: row.get("status")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        workdir: row.get("workdir")?,
        worktree_root: row.get("worktree_root")?,
        branch_name: row.get("branch_name")?,
        context_meta_json: row.get("context_meta_json")?,
        active_segment_index: row.get("active_segment_index")?,
        total_segment_count: row.get("total_segment_count")?,
        total_message_count: row.get("total_message_count")?,
        round_count: row.get("round_count")?,
        tool_call_count: row.get("tool_call_count")?,
        compaction_count: row.get("compaction_count")?,
        summary: row.get("summary")?,
        error: row.get("error")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        segments: Vec::new(),
        events: Vec::new(),
    })
}

fn row_to_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentRunSegmentRecord> {
    Ok(SubagentRunSegmentRecord {
        segment_index: row.get("segment_index")?,
        segment_id: row.get("segment_id")?,
        summary_json: row.get("summary_json")?,
        messages_json: row.get("messages_json")?,
        message_count: row.get("message_count")?,
        start_message_id: row.get("start_message_id")?,
        end_message_id: row.get("end_message_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentRunEventRecord> {
    let is_error: i64 = row.get("is_error")?;
    Ok(SubagentRunEventRecord {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        event_type: row.get("event_type")?,
        round_index: row.get("round_index")?,
        tool_call_id: row.get("tool_call_id")?,
        tool_name: row.get("tool_name")?,
        is_error: is_error != 0,
        payload_json: row.get("payload_json")?,
        created_at: row.get("created_at")?,
    })
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentMessageRecord> {
    Ok(SubagentMessageRecord {
        id: row.get("id")?,
        parent_conversation_id: row.get("parent_conversation_id")?,
        seq: row.get("seq")?,
        sender_agent_id: row.get("sender_agent_id")?,
        sender_display_name: row.get("sender_display_name")?,
        recipient_agent_id: row.get("recipient_agent_id")?,
        recipient_display_name: row.get("recipient_display_name")?,
        channel: row.get("channel")?,
        subject: row.get("subject")?,
        body_markdown: row.get("body_markdown")?,
        source_run_id: row.get("source_run_id")?,
        source_tool_call_id: row.get("source_tool_call_id")?,
        created_at: row.get("created_at")?,
    })
}

fn get_summary_by_id(conn: &Connection, run_id: &str) -> Result<SubagentRunSummary, String> {
    conn.query_row(
        "
        SELECT
            id,
            parent_conversation_id,
            parent_tool_call_id,
            parent_tool_name,
            agent_index,
            agent_total,
            logical_agent_id,
            agent_id,
            agent_name,
            description,
            mode,
            status,
            provider_id,
            model,
            session_id,
            workdir,
            worktree_root,
            branch_name,
            total_message_count,
            round_count,
            tool_call_count,
            compaction_count,
            summary,
            error,
            started_at,
            ended_at,
            updated_at
        FROM subagentRun
        WHERE id = ?1
        ",
        params![run_id],
        row_to_summary,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => "未找到对应的子 agent run".to_string(),
        _ => format!("读取子 agent run 摘要失败：{e}"),
    })
}

fn query_summaries(
    conn: &Connection,
    sql: &str,
    bind_parent: Option<&str>,
    limit: i64,
) -> Result<Vec<SubagentRunSummary>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("准备子 agent run 列表查询失败：{e}"))?;
    let rows = if let Some(parent) = bind_parent {
        stmt.query_map(params![parent, limit], row_to_summary)
            .map_err(|e| format!("查询子 agent run 列表失败：{e}"))?
    } else {
        stmt.query_map(params![limit], row_to_summary)
            .map_err(|e| format!("查询子 agent run 列表失败：{e}"))?
    };
    let mut summaries = Vec::new();
    for row in rows {
        summaries.push(row.map_err(|e| format!("读取子 agent run 列表失败：{e}"))?);
    }
    Ok(summaries)
}

fn list_subagent_runs(input: SubagentRunListInput) -> Result<Vec<SubagentRunSummary>, String> {
    let conn = open_db()?;
    let limit = input.limit.unwrap_or(50).clamp(1, 200);
    let parent = trimmed_opt(input.parent_conversation_id.as_ref());
    let select = "
        SELECT
            id,
            parent_conversation_id,
            parent_tool_call_id,
            parent_tool_name,
            agent_index,
            agent_total,
            logical_agent_id,
            agent_id,
            agent_name,
            description,
            mode,
            status,
            provider_id,
            model,
            session_id,
            workdir,
            worktree_root,
            branch_name,
            total_message_count,
            round_count,
            tool_call_count,
            compaction_count,
            summary,
            error,
            started_at,
            ended_at,
            updated_at
        FROM subagentRun
    ";
    if let Some(parent) = parent.as_deref() {
        query_summaries(
            &conn,
            &format!(
                "{select} WHERE parent_conversation_id = ?1 ORDER BY updated_at DESC LIMIT ?2"
            ),
            Some(parent),
            limit,
        )
    } else {
        query_summaries(
            &conn,
            &format!("{select} ORDER BY updated_at DESC LIMIT ?1"),
            None,
            limit,
        )
    }
}

fn append_subagent_message(
    input: SubagentMessageAppendInput,
) -> Result<SubagentMessageRecord, String> {
    let parent = validate_message_append_input(&input)?;
    let mut conn = open_db()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("开启子 agent message bus 写入事务失败：{e}"))?;
    let seq: i64 = tx
        .query_row(
            "
            SELECT COALESCE(MAX(seq), 0) + 1
            FROM subagentMessageBusEntry
            WHERE parent_conversation_id = ?1
            ",
            params![parent.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| format!("生成子 agent message bus 序号失败：{e}"))?;
    let created_at = input.created_at.unwrap_or_else(now_ms);
    tx.execute(
        "
        INSERT INTO subagentMessageBusEntry (
            parent_conversation_id,
            seq,
            sender_agent_id,
            sender_display_name,
            recipient_agent_id,
            recipient_display_name,
            channel,
            subject,
            body_markdown,
            source_run_id,
            source_tool_call_id,
            created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ",
        params![
            parent.as_str(),
            seq,
            input.sender_agent_id.trim(),
            trimmed_opt(input.sender_display_name.as_ref()),
            input.recipient_agent_id.trim(),
            trimmed_opt(input.recipient_display_name.as_ref()),
            input.channel.trim(),
            trimmed_opt(input.subject.as_ref()),
            input.body_markdown.trim(),
            trimmed_opt(input.source_run_id.as_ref()),
            trimmed_opt(input.source_tool_call_id.as_ref()),
            created_at,
        ],
    )
    .map_err(|e| format!("写入子 agent message bus 失败：{e}"))?;
    let row_id = tx.last_insert_rowid();
    tx.commit()
        .map_err(|e| format!("提交子 agent message bus 写入事务失败：{e}"))?;
    conn.query_row(
        "
        SELECT
            id,
            parent_conversation_id,
            seq,
            sender_agent_id,
            sender_display_name,
            recipient_agent_id,
            recipient_display_name,
            channel,
            subject,
            body_markdown,
            source_run_id,
            source_tool_call_id,
            created_at
        FROM subagentMessageBusEntry
        WHERE id = ?1
        ",
        params![row_id],
        row_to_message,
    )
    .map_err(|e| format!("读取新增子 agent message bus 记录失败：{e}"))
}

fn list_subagent_messages_from_conn(
    conn: &Connection,
    input: SubagentMessageListInput,
) -> Result<Vec<SubagentMessageRecord>, String> {
    let parent = validate_message_list_input(&input)?;
    let limit = input.limit.unwrap_or(80).clamp(1, 200);
    let after_seq = input.after_seq.unwrap_or(0).max(0);
    let include_shared = input.include_shared.unwrap_or(true);
    let include_sent = input.include_sent.unwrap_or(true);
    let recipient = trimmed_opt(input.recipient_agent_id.as_ref());

    let select = "
        SELECT
            id,
            parent_conversation_id,
            seq,
            sender_agent_id,
            sender_display_name,
            recipient_agent_id,
            recipient_display_name,
            channel,
            subject,
            body_markdown,
            source_run_id,
            source_tool_call_id,
            created_at
        FROM subagentMessageBusEntry
    ";

    let mut messages = if let Some(recipient) = recipient.as_deref() {
        let mut stmt = conn
            .prepare(&format!(
                "
                SELECT * FROM (
                    {select}
                    WHERE parent_conversation_id = ?1
                      AND seq > ?2
                      AND (
                        recipient_agent_id = ?3
                        OR (?4 = 1 AND recipient_agent_id = '*')
                        OR (?5 = 1 AND sender_agent_id = ?3)
                      )
                    ORDER BY seq DESC
                    LIMIT ?6
                ) ORDER BY seq ASC
                "
            ))
            .map_err(|e| format!("准备子 agent message bus 查询失败：{e}"))?;
        let rows = stmt
            .query_map(
                params![
                    parent.as_str(),
                    after_seq,
                    recipient,
                    if include_shared { 1 } else { 0 },
                    if include_sent { 1 } else { 0 },
                    limit,
                ],
                row_to_message,
            )
            .map_err(|e| format!("查询子 agent message bus 失败：{e}"))?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| format!("读取子 agent message bus 记录失败：{e}"))?);
        }
        items
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "
                SELECT * FROM (
                    {select}
                    WHERE parent_conversation_id = ?1
                      AND seq > ?2
                    ORDER BY seq DESC
                    LIMIT ?3
                ) ORDER BY seq ASC
                "
            ))
            .map_err(|e| format!("准备子 agent message bus 列表查询失败：{e}"))?;
        let rows = stmt
            .query_map(params![parent.as_str(), after_seq, limit], row_to_message)
            .map_err(|e| format!("查询子 agent message bus 列表失败：{e}"))?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| format!("读取子 agent message bus 列表失败：{e}"))?);
        }
        items
    };

    messages.sort_by_key(|message| message.seq);
    Ok(messages)
}

fn list_subagent_messages(
    input: SubagentMessageListInput,
) -> Result<Vec<SubagentMessageRecord>, String> {
    let conn = open_db()?;
    list_subagent_messages_from_conn(&conn, input)
}

pub(crate) fn prune_subagent_runs_for_parent_tool_calls(
    conn: &Connection,
    parent_conversation_id: &str,
    keep_parent_tool_call_ids: &[String],
) -> Result<SubagentRunPruneResult, String> {
    let keep_parent_tool_call_ids = keep_parent_tool_call_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mut stmt = conn
        .prepare(
            "
            SELECT id, parent_tool_call_id, worktree_root, branch_name
            FROM subagentRun
            WHERE parent_conversation_id = ?1
            ",
        )
        .map_err(|e| format!("准备子 agent 回滚查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![parent_conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| format!("查询子 agent 回滚候选失败：{e}"))?;

    let mut stale_run_ids = Vec::new();
    let mut pruned_worktrees = Vec::new();
    for row in rows {
        let (run_id, parent_tool_call_id, worktree_root, branch_name) =
            row.map_err(|e| format!("读取子 agent 回滚候选失败：{e}"))?;
        if !keep_parent_tool_call_ids.contains(parent_tool_call_id.trim()) {
            if let Some(worktree_root) = worktree_root.as_deref().map(str::trim) {
                if !worktree_root.is_empty() {
                    pruned_worktrees.push(SubagentRunPrunedWorktree {
                        run_id: run_id.clone(),
                        worktree_root: worktree_root.to_string(),
                        branch_name: branch_name
                            .as_deref()
                            .map(str::trim)
                            .filter(|branch| !branch.is_empty())
                            .map(str::to_string),
                    });
                }
            }
            stale_run_ids.push(run_id);
        }
    }
    drop(stmt);

    let mut deleted_run_count = 0_i64;
    for run_id in stale_run_ids {
        conn.execute(
            "
            DELETE FROM subagentMessageBusEntry
            WHERE parent_conversation_id = ?1
              AND source_run_id = ?2
            ",
            params![parent_conversation_id, run_id.trim()],
        )
        .map_err(|e| format!("删除过期子 agent message bus 记录失败：{e}"))?;
        let affected = conn
            .execute(
                "DELETE FROM subagentRun WHERE id = ?1",
                params![run_id.trim()],
            )
            .map_err(|e| format!("删除过期子 agent run 失败：{e}"))?;
        deleted_run_count += affected as i64;
    }

    let mut parent_message_stmt = conn
        .prepare(
            "
            SELECT id, source_tool_call_id
            FROM subagentMessageBusEntry
            WHERE parent_conversation_id = ?1
              AND sender_agent_id = 'parent'
              AND (source_run_id IS NULL OR TRIM(source_run_id) = '')
            ",
        )
        .map_err(|e| format!("准备父 agent message bus 回滚查询失败：{e}"))?;
    let parent_message_rows = parent_message_stmt
        .query_map(params![parent_conversation_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("查询父 agent message bus 回滚候选失败：{e}"))?;
    let mut stale_parent_message_ids = Vec::new();
    for row in parent_message_rows {
        let (message_id, source_tool_call_id) =
            row.map_err(|e| format!("读取父 agent message bus 回滚候选失败：{e}"))?;
        let keep = source_tool_call_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| keep_parent_tool_call_ids.contains(id))
            .unwrap_or(false);
        if !keep {
            stale_parent_message_ids.push(message_id);
        }
    }
    drop(parent_message_stmt);

    for message_id in stale_parent_message_ids {
        conn.execute(
            "
            DELETE FROM subagentMessageBusEntry
            WHERE id = ?1
            ",
            params![message_id],
        )
        .map_err(|e| format!("删除过期父 agent message bus 记录失败：{e}"))?;
    }

    let mut identity_stmt = conn
        .prepare(
            "
            SELECT logical_agent_id, created_parent_tool_call_id
            FROM subagentIdentity
            WHERE parent_conversation_id = ?1
            ",
        )
        .map_err(|e| format!("准备子 agent 身份回滚查询失败：{e}"))?;
    let identity_rows = identity_stmt
        .query_map(params![parent_conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("查询子 agent 身份回滚候选失败：{e}"))?;
    let mut stale_identity_ids = Vec::new();
    for row in identity_rows {
        let (logical_agent_id, created_parent_tool_call_id) =
            row.map_err(|e| format!("读取子 agent 身份回滚候选失败：{e}"))?;
        let keep = created_parent_tool_call_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| keep_parent_tool_call_ids.contains(id))
            .unwrap_or(false);
        if !keep {
            stale_identity_ids.push(logical_agent_id);
        }
    }
    drop(identity_stmt);

    for logical_agent_id in stale_identity_ids {
        conn.execute(
            "
            DELETE FROM subagentIdentity
            WHERE parent_conversation_id = ?1 AND logical_agent_id = ?2
            ",
            params![parent_conversation_id, logical_agent_id.trim()],
        )
        .map_err(|e| format!("删除过期子 agent 身份失败：{e}"))?;
    }

    Ok(SubagentRunPruneResult {
        parent_conversation_id: parent_conversation_id.to_string(),
        kept_parent_tool_call_count: keep_parent_tool_call_ids.len() as i64,
        deleted_run_count,
        pruned_worktrees,
        worktree_cleanup_count: 0,
        worktree_cleanup_errors: Vec::new(),
    })
}

pub(crate) fn delete_subagent_history_for_parent_conversation(
    conn: &Connection,
    parent_conversation_id: &str,
) -> Result<SubagentRunPruneResult, String> {
    let parent = parent_conversation_id.trim();
    if parent.is_empty() {
        return Err("parentConversationId 不能为空".to_string());
    }

    let mut stmt = conn
        .prepare(
            "
            SELECT id, worktree_root, branch_name
            FROM subagentRun
            WHERE parent_conversation_id = ?1
            ",
        )
        .map_err(|e| format!("准备子 agent 删除查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![parent], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("查询子 agent 删除候选失败：{e}"))?;
    let mut pruned_worktrees = Vec::new();
    for row in rows {
        let (run_id, worktree_root, branch_name) =
            row.map_err(|e| format!("读取子 agent 删除候选失败：{e}"))?;
        if let Some(worktree_root) = worktree_root.as_deref().map(str::trim) {
            if !worktree_root.is_empty() {
                pruned_worktrees.push(SubagentRunPrunedWorktree {
                    run_id,
                    worktree_root: worktree_root.to_string(),
                    branch_name: branch_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|branch| !branch.is_empty())
                        .map(str::to_string),
                });
            }
        }
    }
    drop(stmt);

    conn.execute(
        "
        DELETE FROM subagentMessageBusEntry
        WHERE parent_conversation_id = ?1
        ",
        params![parent],
    )
    .map_err(|e| format!("删除子 agent message bus 记录失败：{e}"))?;
    conn.execute(
        "
        DELETE FROM subagentIdentity
        WHERE parent_conversation_id = ?1
        ",
        params![parent],
    )
    .map_err(|e| format!("删除子 agent 身份失败：{e}"))?;
    let deleted_run_count = conn
        .execute(
            "
            DELETE FROM subagentRun
            WHERE parent_conversation_id = ?1
            ",
            params![parent],
        )
        .map_err(|e| format!("删除子 agent run 失败：{e}"))? as i64;

    Ok(SubagentRunPruneResult {
        parent_conversation_id: parent.to_string(),
        kept_parent_tool_call_count: 0,
        deleted_run_count,
        pruned_worktrees,
        worktree_cleanup_count: 0,
        worktree_cleanup_errors: Vec::new(),
    })
}

pub(crate) fn cleanup_pruned_worktrees(result: &mut SubagentRunPruneResult) {
    if result.pruned_worktrees.is_empty() {
        return;
    }
    let targets = result
        .pruned_worktrees
        .iter()
        .map(|worktree| DelegateWorktreeCleanupTarget {
            run_id: Some(worktree.run_id.clone()),
            worktree_root: worktree.worktree_root.clone(),
            branch_name: worktree.branch_name.clone(),
        })
        .collect::<Vec<_>>();
    let cleanup = delegate::cleanup_worktree_targets_blocking(targets, false, true, true);
    result.worktree_cleanup_count = cleanup.cleaned_count as i64;
    result.worktree_cleanup_errors = cleanup
        .items
        .into_iter()
        .filter_map(|item| {
            item.error.map(|error| {
                let run = item.run_id.unwrap_or_else(|| "(unknown run)".to_string());
                format!("{run}: {error}")
            })
        })
        .collect();
}

fn prune_subagent_runs(input: SubagentRunPruneInput) -> Result<SubagentRunPruneResult, String> {
    let parent = validate_prune_input(&input)?;
    let mut conn = open_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启子 agent 回滚事务失败：{e}"))?;
    let mut result =
        prune_subagent_runs_for_parent_tool_calls(&tx, &parent, &input.keep_parent_tool_call_ids)?;
    tx.commit()
        .map_err(|e| format!("提交子 agent 回滚事务失败：{e}"))?;
    cleanup_pruned_worktrees(&mut result);
    Ok(result)
}

fn load_segments(conn: &Connection, run_id: &str) -> Result<Vec<SubagentRunSegmentRecord>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
                segment_index,
                segment_id,
                summary_json,
                messages_json,
                message_count,
                start_message_id,
                end_message_id,
                created_at,
                updated_at
            FROM subagentRunSegment
            WHERE run_id = ?1
            ORDER BY segment_index ASC
            ",
        )
        .map_err(|e| format!("准备子 agent 历史分段查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![run_id], row_to_segment)
        .map_err(|e| format!("查询子 agent 历史分段失败：{e}"))?;

    let mut segments = Vec::new();
    for row in rows {
        segments.push(row.map_err(|e| format!("读取子 agent 历史分段失败：{e}"))?);
    }
    Ok(segments)
}

fn load_events(conn: &Connection, run_id: &str) -> Result<Vec<SubagentRunEventRecord>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT
                id,
                run_id,
                event_type,
                round_index,
                tool_call_id,
                tool_name,
                is_error,
                payload_json,
                created_at
            FROM subagentRunEvent
            WHERE run_id = ?1
            ORDER BY id ASC
            ",
        )
        .map_err(|e| format!("准备子 agent 事件查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![run_id], row_to_event)
        .map_err(|e| format!("查询子 agent 事件失败：{e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("读取子 agent 事件失败：{e}"))?);
    }
    Ok(events)
}

fn upsert_subagent_identity(
    input: SubagentIdentityUpsertInput,
) -> Result<SubagentIdentityRecord, String> {
    let parent = validate_identity_input(&input)?;
    let logical_agent_id = input.logical_agent_id.trim().to_string();
    let conn = open_db()?;
    let created_at = input.created_at.unwrap_or_else(now_ms);
    let updated_at = input.updated_at.unwrap_or_else(now_ms);
    conn.execute(
        "
        INSERT INTO subagentIdentity (
            parent_conversation_id,
            logical_agent_id,
            display_name,
            role,
            identity_prompt,
            agent_id,
            template_name,
            default_mode,
            default_task_intent,
            default_apply_policy,
            created_parent_tool_call_id,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(parent_conversation_id, logical_agent_id) DO UPDATE SET
            updated_at = excluded.updated_at
        ",
        params![
            parent.as_str(),
            logical_agent_id.as_str(),
            input.display_name.trim(),
            input.role.trim(),
            input.identity_prompt.trim(),
            trimmed_opt(input.agent_id.as_ref()),
            trimmed_opt(input.template_name.as_ref()),
            input.default_mode.trim(),
            input.default_task_intent.trim(),
            input.default_apply_policy.trim(),
            trimmed_opt(input.created_parent_tool_call_id.as_ref()),
            created_at,
            updated_at,
        ],
    )
    .map_err(|e| format!("写入子 agent 身份失败：{e}"))?;

    conn.query_row(
        "
        SELECT
            parent_conversation_id,
            logical_agent_id,
            display_name,
            role,
            identity_prompt,
            agent_id,
            template_name,
            default_mode,
            default_task_intent,
            default_apply_policy,
            created_parent_tool_call_id,
            created_at,
            updated_at
        FROM subagentIdentity
        WHERE parent_conversation_id = ?1 AND logical_agent_id = ?2
        ",
        params![parent.as_str(), logical_agent_id.as_str()],
        row_to_identity,
    )
    .map_err(|e| format!("读取子 agent 身份失败：{e}"))
}

fn list_subagent_identities(
    input: SubagentIdentityListInput,
) -> Result<Vec<SubagentIdentityRecord>, String> {
    let conn = open_db()?;
    let parent = validate_identity_list_input(&input)?;
    let limit = input.limit.unwrap_or(100).clamp(1, 500);
    let mut stmt = conn
        .prepare(
            "
            SELECT
                parent_conversation_id,
                logical_agent_id,
                display_name,
                role,
                identity_prompt,
                agent_id,
                template_name,
                default_mode,
                default_task_intent,
                default_apply_policy,
                created_parent_tool_call_id,
                created_at,
                updated_at
            FROM subagentIdentity
            WHERE parent_conversation_id = ?1
            ORDER BY created_at ASC, logical_agent_id ASC
            LIMIT ?2
            ",
        )
        .map_err(|e| format!("准备子 agent 身份列表查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![parent, limit], row_to_identity)
        .map_err(|e| format!("查询子 agent 身份列表失败：{e}"))?;
    let mut identities = Vec::new();
    for row in rows {
        identities.push(row.map_err(|e| format!("读取子 agent 身份列表失败：{e}"))?);
    }
    Ok(identities)
}

fn upsert_subagent_run(input: SubagentRunUpsertInput) -> Result<SubagentRunSummary, String> {
    validate_upsert_input(&input)?;
    let mut conn = open_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启子 agent 历史写入事务失败：{e}"))?;
    upsert_subagent_run_header(&tx, &input)?;
    sync_segments(
        &tx,
        input.id.trim(),
        &input.segments,
        input.total_segment_count,
    )?;
    tx.commit()
        .map_err(|e| format!("提交子 agent 历史写入事务失败：{e}"))?;
    let conn = open_db()?;
    get_summary_by_id(&conn, input.id.trim())
}

fn append_subagent_run_event(
    input: SubagentRunEventInput,
) -> Result<SubagentRunEventRecord, String> {
    validate_event_input(&input)?;
    let conn = open_db()?;
    let created_at = input.created_at.unwrap_or_else(now_ms);
    conn.execute(
        "
        INSERT INTO subagentRunEvent (
            run_id,
            event_type,
            round_index,
            tool_call_id,
            tool_name,
            is_error,
            payload_json,
            created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ",
        params![
            input.run_id.trim(),
            input.event_type.trim(),
            input.round_index,
            input.tool_call_id.as_deref().map(str::trim),
            input.tool_name.as_deref().map(str::trim),
            if input.is_error.unwrap_or(false) {
                1
            } else {
                0
            },
            input.payload_json.as_deref().map(str::trim),
            created_at,
        ],
    )
    .map_err(|e| format!("追加子 agent 事件失败：{e}"))?;
    let event_id = conn.last_insert_rowid();
    conn.query_row(
        "
        SELECT
            id,
            run_id,
            event_type,
            round_index,
            tool_call_id,
            tool_name,
            is_error,
            payload_json,
            created_at
        FROM subagentRunEvent
        WHERE id = ?1
        ",
        params![event_id],
        row_to_event,
    )
    .map_err(|e| format!("读取新增子 agent 事件失败：{e}"))
}

fn get_subagent_run(run_id: &str) -> Result<SubagentRunRecord, String> {
    let conn = open_db()?;
    let mut record = conn
        .query_row(
            "
            SELECT
                id,
                parent_conversation_id,
                parent_session_id,
                parent_tool_call_id,
                parent_tool_name,
                agent_index,
                agent_total,
                logical_agent_id,
                agent_id,
                agent_name,
                description,
                mode,
                status,
                provider_id,
                model,
                session_id,
                workdir,
                worktree_root,
                branch_name,
                context_meta_json,
                active_segment_index,
                total_segment_count,
                total_message_count,
                round_count,
                tool_call_count,
                compaction_count,
                summary,
                error,
                started_at,
                ended_at,
                created_at,
                updated_at
            FROM subagentRun
            WHERE id = ?1
            ",
            params![run_id],
            row_to_record,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => "未找到对应的子 agent run".to_string(),
            _ => format!("读取子 agent run 失败：{e}"),
        })?;
    record.segments = load_segments(&conn, &record.id)?;
    record.events = load_events(&conn, &record.id)?;
    Ok(record)
}

fn get_subagent_run_state(run_id: &str) -> Result<SubagentRunRecord, String> {
    let conn = open_db()?;
    let mut record = conn
        .query_row(
            "
            SELECT
                id,
                parent_conversation_id,
                parent_session_id,
                parent_tool_call_id,
                parent_tool_name,
                agent_index,
                agent_total,
                logical_agent_id,
                agent_id,
                agent_name,
                description,
                mode,
                status,
                provider_id,
                model,
                session_id,
                workdir,
                worktree_root,
                branch_name,
                context_meta_json,
                active_segment_index,
                total_segment_count,
                total_message_count,
                round_count,
                tool_call_count,
                compaction_count,
                summary,
                error,
                started_at,
                ended_at,
                created_at,
                updated_at
            FROM subagentRun
            WHERE id = ?1
            ",
            params![run_id],
            row_to_record,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => "未找到对应的子 agent run".to_string(),
            _ => format!("读取子 agent run 失败：{e}"),
        })?;
    record.segments = load_segments(&conn, &record.id)?;
    record.events = Vec::new();
    Ok(record)
}

#[tauri::command]
pub async fn subagent_identity_upsert(
    input: SubagentIdentityUpsertInput,
) -> Result<SubagentIdentityRecord, String> {
    tauri::async_runtime::spawn_blocking(move || upsert_subagent_identity(input))
        .await
        .map_err(|e| format!("subagent_identity_upsert join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_identity_list(
    input: SubagentIdentityListInput,
) -> Result<Vec<SubagentIdentityRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || list_subagent_identities(input))
        .await
        .map_err(|e| format!("subagent_identity_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_run_upsert(
    input: SubagentRunUpsertInput,
) -> Result<SubagentRunSummary, String> {
    tauri::async_runtime::spawn_blocking(move || upsert_subagent_run(input))
        .await
        .map_err(|e| format!("subagent_run_upsert join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_run_append_event(
    input: SubagentRunEventInput,
) -> Result<SubagentRunEventRecord, String> {
    tauri::async_runtime::spawn_blocking(move || append_subagent_run_event(input))
        .await
        .map_err(|e| format!("subagent_run_append_event join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_message_append(
    input: SubagentMessageAppendInput,
) -> Result<SubagentMessageRecord, String> {
    tauri::async_runtime::spawn_blocking(move || append_subagent_message(input))
        .await
        .map_err(|e| format!("subagent_message_append join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_message_list(
    input: SubagentMessageListInput,
) -> Result<Vec<SubagentMessageRecord>, String> {
    tauri::async_runtime::spawn_blocking(move || list_subagent_messages(input))
        .await
        .map_err(|e| format!("subagent_message_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_run_list(
    input: SubagentRunListInput,
) -> Result<Vec<SubagentRunSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || list_subagent_runs(input))
        .await
        .map_err(|e| format!("subagent_run_list join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_run_get(id: String) -> Result<SubagentRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || get_subagent_run(id.trim()))
        .await
        .map_err(|e| format!("subagent_run_get join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_run_get_state(id: String) -> Result<SubagentRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || get_subagent_run_state(id.trim()))
        .await
        .map_err(|e| format!("subagent_run_get_state join 失败：{e}"))?
}

pub(crate) async fn subagent_run_prune_inner(
    input: SubagentRunPruneInput,
) -> Result<SubagentRunPruneResult, String> {
    tauri::async_runtime::spawn_blocking(move || prune_subagent_runs(input))
        .await
        .map_err(|e| format!("subagent_run_prune join 失败：{e}"))?
}

#[tauri::command]
pub async fn subagent_run_prune(
    input: SubagentRunPruneInput,
) -> Result<SubagentRunPruneResult, String> {
    subagent_run_prune_inner(input).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Result<Connection, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("打开测试子 agent 历史数据库失败：{e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置测试 SQLite busy_timeout 失败：{e}"))?;
        history_db::initialize_connection(&conn)?;
        Ok(conn)
    }

    fn sample_segment(message_count: i64) -> SubagentRunSegmentInput {
        SubagentRunSegmentInput {
            segment_index: 0,
            segment_id: "segment-1".to_string(),
            summary_json: None,
            messages_json: r#"[{"role":"user","content":"Inspect","timestamp":1700000000000}]"#
                .to_string(),
            message_count,
            start_message_id: Some("message-1".to_string()),
            end_message_id: Some("message-1".to_string()),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_100,
        }
    }

    fn sample_run() -> SubagentRunUpsertInput {
        SubagentRunUpsertInput {
            id: "run-1".to_string(),
            parent_conversation_id: Some("conv-1".to_string()),
            parent_session_id: Some("session-1".to_string()),
            parent_tool_call_id: "call-agent".to_string(),
            parent_tool_name: "Agent".to_string(),
            agent_index: 0,
            agent_total: 1,
            logical_agent_id: "agent-1".to_string(),
            agent_id: Some("reviewer".to_string()),
            agent_name: Some("Reviewer".to_string()),
            description: "Inspect implementation".to_string(),
            mode: "readonly".to_string(),
            status: "running".to_string(),
            provider_id: "codex".to_string(),
            model: "gpt-5".to_string(),
            session_id: Some("session-1:subagent:call-agent:1".to_string()),
            workdir: Some("/tmp/work".to_string()),
            worktree_root: None,
            branch_name: None,
            context_meta_json: "{}".to_string(),
            active_segment_index: 0,
            total_segment_count: 1,
            total_message_count: 1,
            round_count: 0,
            tool_call_count: 0,
            compaction_count: 0,
            summary: None,
            error: None,
            started_at: 1_700_000_000_000,
            ended_at: None,
            created_at: Some(1_700_000_000_000),
            updated_at: 1_700_000_000_100,
            segments: vec![sample_segment(1)],
        }
    }

    #[test]
    fn subagent_run_schema_persists_segments_and_events() {
        let conn = open_test_db().expect("open test db");
        let run = sample_run();
        validate_upsert_input(&run).expect("valid run input");
        upsert_subagent_run_header(&conn, &run).expect("upsert run header");
        sync_segments(&conn, &run.id, &run.segments, run.total_segment_count)
            .expect("sync segments");

        let loaded_segments = load_segments(&conn, &run.id).expect("load segments");
        assert_eq!(loaded_segments.len(), 1);
        assert_eq!(loaded_segments[0].message_count, 1);

        conn.execute(
            "
            INSERT INTO subagentRunEvent (
                run_id,
                event_type,
                round_index,
                tool_call_id,
                tool_name,
                is_error,
                payload_json,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ",
            params![
                run.id,
                "turn_start",
                1,
                Option::<String>::None,
                Option::<String>::None,
                0,
                Some("{}"),
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert event");

        let loaded_events = load_events(&conn, "run-1").expect("load events");
        assert_eq!(loaded_events.len(), 1);
        assert_eq!(loaded_events[0].event_type, "turn_start");
        assert_eq!(loaded_events[0].round_index, Some(1));
    }

    #[test]
    fn subagent_run_validation_requires_sequential_segments() {
        let mut run = sample_run();
        run.segments[0].segment_index = 2;

        let error = validate_upsert_input(&run).expect_err("validation should fail");

        assert!(error.contains("segments 必须按 segmentIndex"));
    }

    #[test]
    fn subagent_run_prune_deletes_runs_removed_from_parent_history() {
        let conn = open_test_db().expect("open test db");
        let mut kept = sample_run();
        kept.id = "run-keep".to_string();
        kept.parent_tool_call_id = "call-keep".to_string();
        let mut stale = sample_run();
        stale.id = "run-stale".to_string();
        stale.parent_tool_call_id = "call-stale".to_string();
        stale.worktree_root = Some("/tmp/.liveagent-subagents/repo/agent-stale".to_string());
        stale.branch_name = Some("liveagent/subagent/agent-stale".to_string());

        upsert_subagent_run_header(&conn, &kept).expect("upsert kept run header");
        sync_segments(&conn, &kept.id, &kept.segments, kept.total_segment_count)
            .expect("sync kept segments");
        upsert_subagent_run_header(&conn, &stale).expect("upsert stale run header");
        sync_segments(&conn, &stale.id, &stale.segments, stale.total_segment_count)
            .expect("sync stale segments");
        conn.execute(
            "
            INSERT INTO subagentRunEvent (
                run_id,
                event_type,
                is_error,
                created_at
            ) VALUES (?1, ?2, ?3, ?4)
            ",
            params!["run-stale", "turn_start", 0, 1_700_000_000_200_i64],
        )
        .expect("insert stale event");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                source_run_id,
                source_tool_call_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                "conv-1",
                1_i64,
                "agent-keep",
                "parent",
                "direct",
                "kept message",
                "run-keep",
                "call-child-send-keep",
                1_700_000_000_200_i64,
            ],
        )
        .expect("insert kept message");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                source_run_id,
                source_tool_call_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                "conv-1",
                2_i64,
                "agent-stale",
                "parent",
                "direct",
                "stale message",
                "run-stale",
                "call-child-send-stale",
                1_700_000_000_300_i64,
            ],
        )
        .expect("insert stale message");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                source_tool_call_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ",
            params![
                "conv-1",
                3_i64,
                "parent",
                "agent-keep",
                "direct",
                "kept parent message",
                "call-send-keep",
                1_700_000_000_400_i64,
            ],
        )
        .expect("insert kept parent message");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                source_tool_call_id,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ",
            params![
                "conv-1",
                4_i64,
                "parent",
                "agent-stale",
                "direct",
                "stale parent message",
                "call-send-stale",
                1_700_000_000_500_i64,
            ],
        )
        .expect("insert stale parent message");
        conn.execute(
            "
            INSERT INTO subagentIdentity (
                parent_conversation_id,
                logical_agent_id,
                display_name,
                role,
                identity_prompt,
                default_mode,
                default_task_intent,
                default_apply_policy,
                created_parent_tool_call_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ",
            params![
                "conv-1",
                "agent-keep",
                "Kept Agent",
                "Reviewer",
                "Stable kept identity",
                "readonly",
                "review",
                "none",
                "call-keep",
                1_700_000_000_000_i64,
                1_700_000_000_100_i64,
            ],
        )
        .expect("insert kept identity");
        conn.execute(
            "
            INSERT INTO subagentIdentity (
                parent_conversation_id,
                logical_agent_id,
                display_name,
                role,
                identity_prompt,
                default_mode,
                default_task_intent,
                default_apply_policy,
                created_parent_tool_call_id,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ",
            params![
                "conv-1",
                "agent-stale",
                "Stale Agent",
                "Reviewer",
                "Stable stale identity",
                "readonly",
                "review",
                "none",
                "call-stale",
                1_700_000_000_000_i64,
                1_700_000_000_100_i64,
            ],
        )
        .expect("insert stale identity");

        let keep = vec!["call-keep".to_string(), "call-send-keep".to_string()];
        let result =
            prune_subagent_runs_for_parent_tool_calls(&conn, "conv-1", &keep).expect("prune runs");

        assert_eq!(result.deleted_run_count, 1);
        assert_eq!(result.kept_parent_tool_call_count, 2);
        assert_eq!(result.pruned_worktrees.len(), 1);
        assert_eq!(result.pruned_worktrees[0].run_id, "run-stale");
        assert_eq!(
            result.pruned_worktrees[0].worktree_root,
            "/tmp/.liveagent-subagents/repo/agent-stale"
        );
        assert_eq!(
            result.pruned_worktrees[0].branch_name.as_deref(),
            Some("liveagent/subagent/agent-stale")
        );
        assert!(get_summary_by_id(&conn, "run-keep").is_ok());
        assert!(get_summary_by_id(&conn, "run-stale").is_err());

        let stale_segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRunSegment WHERE run_id = ?1",
                params!["run-stale"],
                |row| row.get(0),
            )
            .expect("count stale segments");
        let stale_event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRunEvent WHERE run_id = ?1",
                params!["run-stale"],
                |row| row.get(0),
            )
            .expect("count stale events");
        let kept_message_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentMessageBusEntry WHERE source_run_id = ?1",
                params!["run-keep"],
                |row| row.get(0),
            )
            .expect("count kept messages");
        let stale_message_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentMessageBusEntry WHERE source_run_id = ?1",
                params!["run-stale"],
                |row| row.get(0),
            )
            .expect("count stale messages");
        let kept_parent_message_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentMessageBusEntry WHERE source_tool_call_id = ?1",
                params!["call-send-keep"],
                |row| row.get(0),
            )
            .expect("count kept parent messages");
        let stale_parent_message_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentMessageBusEntry WHERE source_tool_call_id = ?1",
                params!["call-send-stale"],
                |row| row.get(0),
            )
            .expect("count stale parent messages");
        let kept_identity_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentIdentity WHERE logical_agent_id = ?1",
                params!["agent-keep"],
                |row| row.get(0),
            )
            .expect("count kept identities");
        let stale_identity_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentIdentity WHERE logical_agent_id = ?1",
                params!["agent-stale"],
                |row| row.get(0),
            )
            .expect("count stale identities");
        assert_eq!(stale_segment_count, 0);
        assert_eq!(stale_event_count, 0);
        assert_eq!(kept_message_count, 1);
        assert_eq!(stale_message_count, 0);
        assert_eq!(kept_parent_message_count, 1);
        assert_eq!(stale_parent_message_count, 0);
        assert_eq!(kept_identity_count, 1);
        assert_eq!(stale_identity_count, 0);
    }

    #[test]
    fn subagent_message_list_treats_only_star_recipient_as_shared() {
        let conn = open_test_db().expect("open test db");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "conv-1",
                1_i64,
                "agent-a",
                "parent",
                "shared",
                "legacy-shaped parent message",
                1_700_000_000_000_i64,
            ],
        )
        .expect("insert parent-only shared-channel message");
        conn.execute(
            "
            INSERT INTO subagentMessageBusEntry (
                parent_conversation_id,
                seq,
                sender_agent_id,
                recipient_agent_id,
                channel,
                body_markdown,
                created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ",
            params![
                "conv-1",
                2_i64,
                "agent-a",
                "*",
                "shared",
                "broadcast message",
                1_700_000_000_100_i64,
            ],
        )
        .expect("insert broadcast message");

        let messages = list_subagent_messages_from_conn(
            &conn,
            SubagentMessageListInput {
                parent_conversation_id: Some("conv-1".to_string()),
                recipient_agent_id: Some("agent-b".to_string()),
                include_shared: Some(true),
                include_sent: Some(false),
                after_seq: None,
                limit: None,
            },
        )
        .expect("list messages");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].seq, 2);
        assert_eq!(messages[0].body_markdown, "broadcast message");
    }
}
