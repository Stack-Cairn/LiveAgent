use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::commands::{
    history_db,
    subagent_worktree::{self, SubagentWorktreeCleanupTarget},
};

const SUBAGENT_MODES: [&str; 2] = ["readonly", "worktree"];
const SUBAGENT_RUN_STATUSES: [&str; 4] = ["running", "completed", "failed", "cancelled"];
const SUBAGENT_MESSAGE_CHANNELS: [&str; 4] = ["direct", "shared", "decision", "question"];

const IDENTITY_LIST_DEFAULT_LIMIT: i64 = 64;
const IDENTITY_LIST_MAX_LIMIT: i64 = 256;
const RUN_LIST_DEFAULT_LIMIT: i64 = 64;
const RUN_LIST_MAX_LIMIT: i64 = 256;
const MESSAGE_LIST_DEFAULT_LIMIT: i64 = 80;
const MESSAGE_LIST_MAX_LIMIT: i64 = 400;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdentityRecord {
    pub parent_conversation_id: String,
    pub agent_id: String,
    pub name: String,
    pub role: String,
    pub identity_prompt: String,
    pub template_id: Option<String>,
    pub last_mode: String,
    pub created_tool_call_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunRecord {
    pub id: String,
    pub parent_conversation_id: String,
    pub parent_tool_call_id: String,
    pub agent_id: String,
    pub agent_index: i64,
    pub agent_total: i64,
    pub prompt: String,
    pub mode: String,
    pub status: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub workdir: Option<String>,
    pub worktree_root: Option<String>,
    pub branch_name: Option<String>,
    pub context_schema_version: i64,
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
pub struct SubagentRunStateRecord {
    pub run: SubagentRunRecord,
    pub segments: Vec<SubagentRunSegmentRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageRecord {
    pub id: i64,
    pub parent_conversation_id: String,
    pub seq: i64,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub recipient_id: String,
    pub recipient_name: Option<String>,
    pub channel: String,
    pub subject: Option<String>,
    pub body_markdown: String,
    pub source_run_id: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPruneResult {
    pub removed_run_ids: Vec<String>,
    pub removed_message_count: i64,
    pub removed_identity_count: i64,
    pub worktree_cleanup_errors: Vec<String>,
    #[serde(skip)]
    pub cleanup_targets: Vec<SubagentWorktreeCleanupTarget>,
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdentityUpsertInput {
    pub parent_conversation_id: String,
    pub agent_id: String,
    pub name: String,
    pub role: String,
    pub identity_prompt: String,
    pub template_id: Option<String>,
    pub last_mode: String,
    pub created_tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentIdentityListInput {
    pub parent_conversation_id: String,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSaveHeader {
    pub id: String,
    pub parent_conversation_id: String,
    pub parent_tool_call_id: String,
    pub agent_id: String,
    pub agent_index: i64,
    pub agent_total: i64,
    pub prompt: String,
    pub mode: String,
    pub status: String,
    pub provider_id: String,
    pub model: String,
    pub session_id: Option<String>,
    pub workdir: Option<String>,
    pub worktree_root: Option<String>,
    pub branch_name: Option<String>,
    pub context_schema_version: i64,
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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSegmentSaveInput {
    pub segment_index: i64,
    pub segment_id: String,
    pub summary_json: Option<String>,
    pub messages_json: String,
    pub message_count: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunSaveInput {
    pub run: SubagentRunSaveHeader,
    pub segments: Vec<SubagentRunSegmentSaveInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunListInput {
    pub parent_conversation_id: String,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunLoadInput {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentRunPruneInput {
    pub parent_conversation_id: String,
    pub keep_parent_tool_call_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageAppendInput {
    pub parent_conversation_id: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub recipient_id: String,
    pub recipient_name: Option<String>,
    pub channel: String,
    pub subject: Option<String>,
    pub body_markdown: String,
    pub source_run_id: Option<String>,
    pub source_tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMessageListInput {
    pub parent_conversation_id: String,
    pub for_agent_id: Option<String>,
    pub limit: Option<i64>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
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

fn require_non_empty(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(trimmed.to_string())
}

fn validate_mode(mode: &str) -> Result<String, String> {
    let trimmed = mode.trim();
    if !SUBAGENT_MODES.contains(&trimmed) {
        return Err(format!("mode must be one of {}", SUBAGENT_MODES.join("/")));
    }
    Ok(trimmed.to_string())
}

fn validate_status(status: &str) -> Result<String, String> {
    let trimmed = status.trim();
    if !SUBAGENT_RUN_STATUSES.contains(&trimmed) {
        return Err(format!(
            "status must be one of {}",
            SUBAGENT_RUN_STATUSES.join("/")
        ));
    }
    Ok(trimmed.to_string())
}

fn keep_set(ids: &[String]) -> HashSet<String> {
    ids.iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

fn row_to_identity(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentIdentityRecord> {
    Ok(SubagentIdentityRecord {
        parent_conversation_id: row.get("parent_conversation_id")?,
        agent_id: row.get("agent_id")?,
        name: row.get("name")?,
        role: row.get("role")?,
        identity_prompt: row.get("identity_prompt")?,
        template_id: row.get("template_id")?,
        last_mode: row.get("last_mode")?,
        created_tool_call_id: row.get("created_tool_call_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentRunRecord> {
    Ok(SubagentRunRecord {
        id: row.get("id")?,
        parent_conversation_id: row.get("parent_conversation_id")?,
        parent_tool_call_id: row.get("parent_tool_call_id")?,
        agent_id: row.get("agent_id")?,
        agent_index: row.get("agent_index")?,
        agent_total: row.get("agent_total")?,
        prompt: row.get("prompt")?,
        mode: row.get("mode")?,
        status: row.get("status")?,
        provider_id: row.get("provider_id")?,
        model: row.get("model")?,
        session_id: row.get("session_id")?,
        workdir: row.get("workdir")?,
        worktree_root: row.get("worktree_root")?,
        branch_name: row.get("branch_name")?,
        context_schema_version: row.get("context_schema_version")?,
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
        updated_at: row.get("updated_at")?,
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

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubagentMessageRecord> {
    Ok(SubagentMessageRecord {
        id: row.get("id")?,
        parent_conversation_id: row.get("parent_conversation_id")?,
        seq: row.get("seq")?,
        sender_id: row.get("sender_id")?,
        sender_name: row.get("sender_name")?,
        recipient_id: row.get("recipient_id")?,
        recipient_name: row.get("recipient_name")?,
        channel: row.get("channel")?,
        subject: row.get("subject")?,
        body_markdown: row.get("body_markdown")?,
        source_run_id: row.get("source_run_id")?,
        source_tool_call_id: row.get("source_tool_call_id")?,
        created_at: row.get("created_at")?,
    })
}

const RUN_HEADER_COLUMNS: &str = "
    id,
    parent_conversation_id,
    parent_tool_call_id,
    agent_id,
    agent_index,
    agent_total,
    prompt,
    mode,
    status,
    provider_id,
    model,
    session_id,
    workdir,
    worktree_root,
    branch_name,
    context_schema_version,
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
    updated_at
";

const IDENTITY_COLUMNS: &str = "
    parent_conversation_id,
    agent_id,
    name,
    role,
    identity_prompt,
    template_id,
    last_mode,
    created_tool_call_id,
    created_at,
    updated_at
";

const MESSAGE_COLUMNS: &str = "
    id,
    parent_conversation_id,
    seq,
    sender_id,
    sender_name,
    recipient_id,
    recipient_name,
    channel,
    subject,
    body_markdown,
    source_run_id,
    source_tool_call_id,
    created_at
";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

pub(crate) fn upsert_subagent_identity_sync(
    conn: &Connection,
    input: &SubagentIdentityUpsertInput,
) -> Result<SubagentIdentityRecord, String> {
    let parent = require_non_empty(&input.parent_conversation_id, "parentConversationId")?;
    let agent_id = require_non_empty(&input.agent_id, "agentId")?;
    let name = require_non_empty(&input.name, "name")?;
    let role = require_non_empty(&input.role, "role")?;
    let last_mode = validate_mode(&input.last_mode)
        .map_err(|_| format!("lastMode must be one of {}", SUBAGENT_MODES.join("/")))?;
    let now = now_ms();

    conn.execute(
        "
        INSERT INTO subagentIdentity (
            parent_conversation_id,
            agent_id,
            name,
            role,
            identity_prompt,
            template_id,
            last_mode,
            created_tool_call_id,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(parent_conversation_id, agent_id) DO UPDATE SET
            name = excluded.name,
            role = excluded.role,
            identity_prompt = excluded.identity_prompt,
            template_id = excluded.template_id,
            last_mode = excluded.last_mode,
            updated_at = excluded.updated_at
        ",
        params![
            parent.as_str(),
            agent_id.as_str(),
            name.as_str(),
            role.as_str(),
            input.identity_prompt.trim(),
            trimmed_opt(input.template_id.as_ref()),
            last_mode.as_str(),
            trimmed_opt(input.created_tool_call_id.as_ref()),
            now,
            now,
        ],
    )
    .map_err(|e| format!("failed to upsert subagent identity: {e}"))?;

    conn.query_row(
        &format!(
            "SELECT {IDENTITY_COLUMNS} FROM subagentIdentity
             WHERE parent_conversation_id = ?1 AND agent_id = ?2"
        ),
        params![parent.as_str(), agent_id.as_str()],
        row_to_identity,
    )
    .map_err(|e| format!("failed to read upserted subagent identity: {e}"))
}

pub(crate) fn list_subagent_identities_sync(
    conn: &Connection,
    input: &SubagentIdentityListInput,
) -> Result<Vec<SubagentIdentityRecord>, String> {
    let parent = require_non_empty(&input.parent_conversation_id, "parentConversationId")?;
    let limit = input
        .limit
        .unwrap_or(IDENTITY_LIST_DEFAULT_LIMIT)
        .clamp(1, IDENTITY_LIST_MAX_LIMIT);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {IDENTITY_COLUMNS} FROM subagentIdentity
             WHERE parent_conversation_id = ?1
             ORDER BY updated_at DESC
             LIMIT ?2"
        ))
        .map_err(|e| format!("failed to prepare subagent identity list query: {e}"))?;
    let rows = stmt
        .query_map(params![parent.as_str(), limit], row_to_identity)
        .map_err(|e| format!("failed to query subagent identities: {e}"))?;
    let mut identities = Vec::new();
    for row in rows {
        identities.push(row.map_err(|e| format!("failed to read subagent identity row: {e}"))?);
    }
    Ok(identities)
}

// ---------------------------------------------------------------------------
// Run save / list / load
// ---------------------------------------------------------------------------

fn validate_run_save_input(input: &SubagentRunSaveInput) -> Result<(), String> {
    let run = &input.run;
    require_non_empty(&run.id, "run id")?;
    require_non_empty(&run.parent_conversation_id, "parentConversationId")?;
    require_non_empty(&run.parent_tool_call_id, "parentToolCallId")?;
    require_non_empty(&run.agent_id, "agentId")?;
    require_non_empty(&run.prompt, "prompt")?;
    validate_mode(&run.mode)?;
    validate_status(&run.status)?;

    if input.segments.is_empty() {
        return Err("segments must not be empty".to_string());
    }
    for (index, segment) in input.segments.iter().enumerate() {
        if segment.segment_index != index as i64 {
            return Err(format!(
                "segments must be contiguous from 0: found segmentIndex={} at position {}",
                segment.segment_index, index
            ));
        }
        if segment.segment_id.trim().is_empty() {
            return Err(format!("segmentId must not be empty at index {index}"));
        }
        if segment.messages_json.trim().is_empty() {
            return Err(format!("messagesJson must not be empty at index {index}"));
        }
        if segment.message_count < 0 {
            return Err(format!(
                "messageCount must not be negative at index {index}"
            ));
        }
    }
    let segment_count = input.segments.len() as i64;
    if run.total_segment_count != segment_count {
        return Err(format!(
            "totalSegmentCount ({}) must equal segments.length ({segment_count})",
            run.total_segment_count
        ));
    }
    if run.active_segment_index != segment_count - 1 {
        return Err(format!(
            "activeSegmentIndex ({}) must equal segments.length - 1 ({})",
            run.active_segment_index,
            segment_count - 1
        ));
    }
    let message_sum: i64 = input
        .segments
        .iter()
        .map(|segment| segment.message_count)
        .sum();
    if run.total_message_count != message_sum {
        return Err(format!(
            "totalMessageCount ({}) must equal the sum of segment messageCount ({message_sum})",
            run.total_message_count
        ));
    }
    Ok(())
}

fn upsert_run_header(
    conn: &Connection,
    run: &SubagentRunSaveHeader,
    updated_at: i64,
) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO subagentRun (
            id,
            parent_conversation_id,
            parent_tool_call_id,
            agent_id,
            agent_index,
            agent_total,
            prompt,
            mode,
            status,
            provider_id,
            model,
            session_id,
            workdir,
            worktree_root,
            branch_name,
            context_schema_version,
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
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)
        ON CONFLICT(id) DO UPDATE SET
            parent_conversation_id = excluded.parent_conversation_id,
            parent_tool_call_id = excluded.parent_tool_call_id,
            agent_id = excluded.agent_id,
            agent_index = excluded.agent_index,
            agent_total = excluded.agent_total,
            prompt = excluded.prompt,
            mode = excluded.mode,
            status = excluded.status,
            provider_id = excluded.provider_id,
            model = excluded.model,
            session_id = excluded.session_id,
            workdir = excluded.workdir,
            worktree_root = excluded.worktree_root,
            branch_name = excluded.branch_name,
            context_schema_version = excluded.context_schema_version,
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
            run.id.trim(),
            run.parent_conversation_id.trim(),
            run.parent_tool_call_id.trim(),
            run.agent_id.trim(),
            run.agent_index,
            run.agent_total,
            run.prompt.trim(),
            run.mode.trim(),
            run.status.trim(),
            run.provider_id.trim(),
            run.model.trim(),
            trimmed_opt(run.session_id.as_ref()),
            trimmed_opt(run.workdir.as_ref()),
            trimmed_opt(run.worktree_root.as_ref()),
            trimmed_opt(run.branch_name.as_ref()),
            run.context_schema_version,
            run.active_segment_index,
            run.total_segment_count,
            run.total_message_count,
            run.round_count,
            run.tool_call_count,
            run.compaction_count,
            trimmed_opt(run.summary.as_ref()),
            trimmed_opt(run.error.as_ref()),
            run.started_at,
            run.ended_at,
            updated_at,
        ],
    )
    .map_err(|e| format!("failed to upsert subagent run header: {e}"))?;
    Ok(())
}

fn sync_run_segments(
    conn: &Connection,
    run_id: &str,
    segments: &[SubagentRunSegmentSaveInput],
    now: i64,
) -> Result<(), String> {
    // Remove stale trailing segments first (e.g. after compaction shrank the
    // segment list) so their segment ids cannot collide with re-used indexes.
    conn.execute(
        "DELETE FROM subagentRunSegment WHERE run_id = ?1 AND segment_index >= ?2",
        params![run_id, segments.len() as i64],
    )
    .map_err(|e| format!("failed to delete stale subagent run segments: {e}"))?;

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
                now,
                now,
            ],
        )
        .map_err(|e| format!("failed to upsert subagent run segment: {e}"))?;
    }
    Ok(())
}

pub(crate) fn save_subagent_run_sync(
    conn: &mut Connection,
    input: &SubagentRunSaveInput,
) -> Result<(), String> {
    validate_run_save_input(input)?;
    let now = now_ms();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("failed to begin subagent run save transaction: {e}"))?;
    upsert_run_header(&tx, &input.run, now)?;
    sync_run_segments(&tx, input.run.id.trim(), &input.segments, now)?;
    tx.commit()
        .map_err(|e| format!("failed to commit subagent run save transaction: {e}"))?;
    Ok(())
}

pub(crate) fn list_subagent_runs_sync(
    conn: &Connection,
    input: &SubagentRunListInput,
) -> Result<Vec<SubagentRunRecord>, String> {
    let parent = require_non_empty(&input.parent_conversation_id, "parentConversationId")?;
    let limit = input
        .limit
        .unwrap_or(RUN_LIST_DEFAULT_LIMIT)
        .clamp(1, RUN_LIST_MAX_LIMIT);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_HEADER_COLUMNS} FROM subagentRun
             WHERE parent_conversation_id = ?1
             ORDER BY updated_at DESC
             LIMIT ?2"
        ))
        .map_err(|e| format!("failed to prepare subagent run list query: {e}"))?;
    let rows = stmt
        .query_map(params![parent.as_str(), limit], row_to_run)
        .map_err(|e| format!("failed to query subagent runs: {e}"))?;
    let mut runs = Vec::new();
    for row in rows {
        runs.push(row.map_err(|e| format!("failed to read subagent run row: {e}"))?);
    }
    Ok(runs)
}

pub(crate) fn load_subagent_run_sync(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<SubagentRunStateRecord>, String> {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return Err("run id must not be empty".to_string());
    }
    let run = conn
        .query_row(
            &format!("SELECT {RUN_HEADER_COLUMNS} FROM subagentRun WHERE id = ?1"),
            params![run_id],
            row_to_run,
        )
        .optional()
        .map_err(|e| format!("failed to read subagent run: {e}"))?;
    let Some(run) = run else {
        return Ok(None);
    };

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
        .map_err(|e| format!("failed to prepare subagent run segment query: {e}"))?;
    let rows = stmt
        .query_map(params![run_id], row_to_segment)
        .map_err(|e| format!("failed to query subagent run segments: {e}"))?;
    let mut segments = Vec::new();
    for row in rows {
        segments.push(row.map_err(|e| format!("failed to read subagent run segment row: {e}"))?);
    }
    Ok(Some(SubagentRunStateRecord { run, segments }))
}

// ---------------------------------------------------------------------------
// Prune / delete
// ---------------------------------------------------------------------------

pub(crate) fn prune_subagent_runs_sync(
    conn: &Connection,
    parent_conversation_id: &str,
    keep_parent_tool_call_ids: &[String],
) -> Result<SubagentPruneResult, String> {
    let keep = keep_set(keep_parent_tool_call_ids);

    // 1. Runs whose parent tool call has been removed from parent history.
    let mut run_stmt = conn
        .prepare(
            "
            SELECT id, parent_tool_call_id, worktree_root, branch_name
            FROM subagentRun
            WHERE parent_conversation_id = ?1
            ",
        )
        .map_err(|e| format!("failed to prepare subagent run prune query: {e}"))?;
    let run_rows = run_stmt
        .query_map(params![parent_conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| format!("failed to query subagent run prune candidates: {e}"))?;

    let mut removed_run_ids = Vec::new();
    let mut cleanup_targets = Vec::new();
    for row in run_rows {
        let (run_id, parent_tool_call_id, worktree_root, branch_name) =
            row.map_err(|e| format!("failed to read subagent run prune candidate: {e}"))?;
        if keep.contains(parent_tool_call_id.trim()) {
            continue;
        }
        if let Some(worktree_root) = worktree_root
            .as_deref()
            .map(str::trim)
            .filter(|root| !root.is_empty())
        {
            cleanup_targets.push(SubagentWorktreeCleanupTarget {
                run_id: Some(run_id.clone()),
                worktree_root: worktree_root.to_string(),
                branch_name: branch_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|branch| !branch.is_empty())
                    .map(str::to_string),
            });
        }
        removed_run_ids.push(run_id);
    }
    drop(run_stmt);

    for run_id in &removed_run_ids {
        conn.execute("DELETE FROM subagentRun WHERE id = ?1", params![run_id])
            .map_err(|e| format!("failed to delete pruned subagent run: {e}"))?;
    }

    // 2. Messages sourced from removed tool calls.
    let mut message_stmt = conn
        .prepare(
            "
            SELECT id, source_tool_call_id
            FROM subagentMessage
            WHERE parent_conversation_id = ?1
              AND source_tool_call_id IS NOT NULL
              AND TRIM(source_tool_call_id) != ''
            ",
        )
        .map_err(|e| format!("failed to prepare subagent message prune query: {e}"))?;
    let message_rows = message_stmt
        .query_map(params![parent_conversation_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("failed to query subagent message prune candidates: {e}"))?;
    let mut stale_message_ids = Vec::new();
    for row in message_rows {
        let (message_id, source_tool_call_id) =
            row.map_err(|e| format!("failed to read subagent message prune candidate: {e}"))?;
        if !keep.contains(source_tool_call_id.trim()) {
            stale_message_ids.push(message_id);
        }
    }
    drop(message_stmt);

    let mut removed_message_count = 0_i64;
    for message_id in stale_message_ids {
        removed_message_count += conn
            .execute(
                "DELETE FROM subagentMessage WHERE id = ?1",
                params![message_id],
            )
            .map_err(|e| format!("failed to delete pruned subagent message: {e}"))?
            as i64;
    }

    // 3. Identities created by removed tool calls with no remaining runs.
    let mut identity_stmt = conn
        .prepare(
            "
            SELECT agent_id, created_tool_call_id
            FROM subagentIdentity
            WHERE parent_conversation_id = ?1
              AND created_tool_call_id IS NOT NULL
              AND TRIM(created_tool_call_id) != ''
            ",
        )
        .map_err(|e| format!("failed to prepare subagent identity prune query: {e}"))?;
    let identity_rows = identity_stmt
        .query_map(params![parent_conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("failed to query subagent identity prune candidates: {e}"))?;
    let mut stale_identity_ids = Vec::new();
    for row in identity_rows {
        let (agent_id, created_tool_call_id) =
            row.map_err(|e| format!("failed to read subagent identity prune candidate: {e}"))?;
        if !keep.contains(created_tool_call_id.trim()) {
            stale_identity_ids.push(agent_id);
        }
    }
    drop(identity_stmt);

    let mut removed_identity_count = 0_i64;
    for agent_id in stale_identity_ids {
        let remaining_runs: i64 = conn
            .query_row(
                "
                SELECT COUNT(*) FROM subagentRun
                WHERE parent_conversation_id = ?1 AND agent_id = ?2
                ",
                params![parent_conversation_id, agent_id.as_str()],
                |row| row.get(0),
            )
            .map_err(|e| format!("failed to count remaining subagent runs: {e}"))?;
        if remaining_runs > 0 {
            continue;
        }
        removed_identity_count += conn
            .execute(
                "
                DELETE FROM subagentIdentity
                WHERE parent_conversation_id = ?1 AND agent_id = ?2
                ",
                params![parent_conversation_id, agent_id.as_str()],
            )
            .map_err(|e| format!("failed to delete pruned subagent identity: {e}"))?
            as i64;
    }

    Ok(SubagentPruneResult {
        removed_run_ids,
        removed_message_count,
        removed_identity_count,
        worktree_cleanup_errors: Vec::new(),
        cleanup_targets,
    })
}

pub(crate) fn delete_subagent_history_for_parent_conversation(
    conn: &Connection,
    parent_conversation_id: &str,
) -> Result<SubagentPruneResult, String> {
    let parent = parent_conversation_id.trim();
    if parent.is_empty() {
        return Err("parentConversationId must not be empty".to_string());
    }

    let mut run_stmt = conn
        .prepare(
            "
            SELECT id, worktree_root, branch_name
            FROM subagentRun
            WHERE parent_conversation_id = ?1
            ",
        )
        .map_err(|e| format!("failed to prepare subagent run delete query: {e}"))?;
    let run_rows = run_stmt
        .query_map(params![parent], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| format!("failed to query subagent run delete candidates: {e}"))?;
    let mut removed_run_ids = Vec::new();
    let mut cleanup_targets = Vec::new();
    for row in run_rows {
        let (run_id, worktree_root, branch_name) =
            row.map_err(|e| format!("failed to read subagent run delete candidate: {e}"))?;
        if let Some(worktree_root) = worktree_root
            .as_deref()
            .map(str::trim)
            .filter(|root| !root.is_empty())
        {
            cleanup_targets.push(SubagentWorktreeCleanupTarget {
                run_id: Some(run_id.clone()),
                worktree_root: worktree_root.to_string(),
                branch_name: branch_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|branch| !branch.is_empty())
                    .map(str::to_string),
            });
        }
        removed_run_ids.push(run_id);
    }
    drop(run_stmt);

    let removed_message_count =
        conn.execute(
            "DELETE FROM subagentMessage WHERE parent_conversation_id = ?1",
            params![parent],
        )
        .map_err(|e| format!("failed to delete subagent messages: {e}"))? as i64;
    let removed_identity_count =
        conn.execute(
            "DELETE FROM subagentIdentity WHERE parent_conversation_id = ?1",
            params![parent],
        )
        .map_err(|e| format!("failed to delete subagent identities: {e}"))? as i64;
    conn.execute(
        "DELETE FROM subagentRun WHERE parent_conversation_id = ?1",
        params![parent],
    )
    .map_err(|e| format!("failed to delete subagent runs: {e}"))?;

    Ok(SubagentPruneResult {
        removed_run_ids,
        removed_message_count,
        removed_identity_count,
        worktree_cleanup_errors: Vec::new(),
        cleanup_targets,
    })
}

pub(crate) fn cleanup_pruned_worktrees(result: &mut SubagentPruneResult) {
    if result.cleanup_targets.is_empty() {
        return;
    }
    let targets = std::mem::take(&mut result.cleanup_targets);
    let cleanup = subagent_worktree::cleanup_worktree_targets_blocking(targets, false, true, true);
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

fn prune_subagent_runs(input: SubagentRunPruneInput) -> Result<SubagentPruneResult, String> {
    let parent = require_non_empty(&input.parent_conversation_id, "parentConversationId")?;
    let mut conn = open_db()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("failed to begin subagent prune transaction: {e}"))?;
    let mut result = prune_subagent_runs_sync(&tx, &parent, &input.keep_parent_tool_call_ids)?;
    tx.commit()
        .map_err(|e| format!("failed to commit subagent prune transaction: {e}"))?;
    cleanup_pruned_worktrees(&mut result);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------

pub(crate) fn append_subagent_message_sync(
    conn: &mut Connection,
    input: &SubagentMessageAppendInput,
) -> Result<SubagentMessageRecord, String> {
    let parent = require_non_empty(&input.parent_conversation_id, "parentConversationId")?;
    let sender_id = require_non_empty(&input.sender_id, "senderId")?;
    let recipient_id = require_non_empty(&input.recipient_id, "recipientId")?;
    let body_markdown = require_non_empty(&input.body_markdown, "bodyMarkdown")?;
    let channel = input.channel.trim();
    if !SUBAGENT_MESSAGE_CHANNELS.contains(&channel) {
        return Err(format!(
            "channel must be one of {}",
            SUBAGENT_MESSAGE_CHANNELS.join("/")
        ));
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("failed to begin subagent message transaction: {e}"))?;
    let seq: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM subagentMessage WHERE parent_conversation_id = ?1",
            params![parent.as_str()],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to allocate subagent message seq: {e}"))?;
    tx.execute(
        "
        INSERT INTO subagentMessage (
            parent_conversation_id,
            seq,
            sender_id,
            sender_name,
            recipient_id,
            recipient_name,
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
            sender_id.as_str(),
            trimmed_opt(input.sender_name.as_ref()),
            recipient_id.as_str(),
            trimmed_opt(input.recipient_name.as_ref()),
            channel,
            trimmed_opt(input.subject.as_ref()),
            body_markdown.as_str(),
            trimmed_opt(input.source_run_id.as_ref()),
            trimmed_opt(input.source_tool_call_id.as_ref()),
            now_ms(),
        ],
    )
    .map_err(|e| format!("failed to append subagent message: {e}"))?;
    let row_id = tx.last_insert_rowid();
    tx.commit()
        .map_err(|e| format!("failed to commit subagent message transaction: {e}"))?;

    conn.query_row(
        &format!("SELECT {MESSAGE_COLUMNS} FROM subagentMessage WHERE id = ?1"),
        params![row_id],
        row_to_message,
    )
    .map_err(|e| format!("failed to read appended subagent message: {e}"))
}

pub(crate) fn list_subagent_messages_sync(
    conn: &Connection,
    input: &SubagentMessageListInput,
) -> Result<Vec<SubagentMessageRecord>, String> {
    let parent = require_non_empty(&input.parent_conversation_id, "parentConversationId")?;
    let limit = input
        .limit
        .unwrap_or(MESSAGE_LIST_DEFAULT_LIMIT)
        .clamp(1, MESSAGE_LIST_MAX_LIMIT);
    let for_agent_id = trimmed_opt(input.for_agent_id.as_ref());

    let mut messages = Vec::new();
    if let Some(agent_id) = for_agent_id.as_deref() {
        let mut stmt = conn
            .prepare(&format!(
                "
                SELECT * FROM (
                    SELECT {MESSAGE_COLUMNS} FROM subagentMessage
                    WHERE parent_conversation_id = ?1
                      AND (
                        recipient_id = ?2
                        OR sender_id = ?2
                        OR recipient_id = '*'
                      )
                    ORDER BY seq DESC
                    LIMIT ?3
                ) ORDER BY seq ASC
                "
            ))
            .map_err(|e| format!("failed to prepare subagent message list query: {e}"))?;
        let rows = stmt
            .query_map(params![parent.as_str(), agent_id, limit], row_to_message)
            .map_err(|e| format!("failed to query subagent messages: {e}"))?;
        for row in rows {
            messages.push(row.map_err(|e| format!("failed to read subagent message row: {e}"))?);
        }
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "
                SELECT * FROM (
                    SELECT {MESSAGE_COLUMNS} FROM subagentMessage
                    WHERE parent_conversation_id = ?1
                    ORDER BY seq DESC
                    LIMIT ?2
                ) ORDER BY seq ASC
                "
            ))
            .map_err(|e| format!("failed to prepare subagent message list query: {e}"))?;
        let rows = stmt
            .query_map(params![parent.as_str(), limit], row_to_message)
            .map_err(|e| format!("failed to query subagent messages: {e}"))?;
        for row in rows {
            messages.push(row.map_err(|e| format!("failed to read subagent message row: {e}"))?);
        }
    }
    Ok(messages)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

pub async fn subagent_identity_upsert(
    input: SubagentIdentityUpsertInput,
) -> Result<SubagentIdentityRecord, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        upsert_subagent_identity_sync(&conn, &input)
    })
    .await
    .map_err(|e| format!("subagent_identity_upsert join failed: {e}"))?
}

pub async fn subagent_identity_list(
    input: SubagentIdentityListInput,
) -> Result<Vec<SubagentIdentityRecord>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        list_subagent_identities_sync(&conn, &input)
    })
    .await
    .map_err(|e| format!("subagent_identity_list join failed: {e}"))?
}

pub async fn subagent_run_save(input: SubagentRunSaveInput) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        save_subagent_run_sync(&mut conn, &input)
    })
    .await
    .map_err(|e| format!("subagent_run_save join failed: {e}"))?
}

pub async fn subagent_run_list(
    input: SubagentRunListInput,
) -> Result<Vec<SubagentRunRecord>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        list_subagent_runs_sync(&conn, &input)
    })
    .await
    .map_err(|e| format!("subagent_run_list join failed: {e}"))?
}

pub async fn subagent_run_load(
    input: SubagentRunLoadInput,
) -> Result<Option<SubagentRunStateRecord>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        load_subagent_run_sync(&conn, &input.id)
    })
    .await
    .map_err(|e| format!("subagent_run_load join failed: {e}"))?
}

pub async fn subagent_run_prune(
    input: SubagentRunPruneInput,
) -> Result<SubagentPruneResult, String> {
    tokio::task::spawn_blocking(move || prune_subagent_runs(input))
        .await
        .map_err(|e| format!("subagent_run_prune join failed: {e}"))?
}

pub async fn subagent_message_append(
    input: SubagentMessageAppendInput,
) -> Result<SubagentMessageRecord, String> {
    tokio::task::spawn_blocking(move || {
        let mut conn = open_db()?;
        append_subagent_message_sync(&mut conn, &input)
    })
    .await
    .map_err(|e| format!("subagent_message_append join failed: {e}"))?
}

pub async fn subagent_message_list(
    input: SubagentMessageListInput,
) -> Result<Vec<SubagentMessageRecord>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        list_subagent_messages_sync(&conn, &input)
    })
    .await
    .map_err(|e| format!("subagent_message_list join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory subagent store db");
        conn.busy_timeout(Duration::from_secs(5))
            .expect("set test SQLite busy_timeout");
        history_db::initialize_connection(&conn).expect("initialize history db");
        conn
    }

    fn table_exists(conn: &Connection, table_name: &str) -> bool {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table_name],
                |row| row.get(0),
            )
            .expect("query table existence");
        count > 0
    }

    fn table_columns(conn: &Connection, table_name: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table_name})"))
            .expect("prepare table info");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info");
        rows.map(|row| row.expect("read column name")).collect()
    }

    fn sample_identity_input() -> SubagentIdentityUpsertInput {
        SubagentIdentityUpsertInput {
            parent_conversation_id: "conv-1".to_string(),
            agent_id: "agent-a".to_string(),
            name: "Reviewer".to_string(),
            role: "code review".to_string(),
            identity_prompt: "You review code.".to_string(),
            template_id: Some("tpl-review".to_string()),
            last_mode: "readonly".to_string(),
            created_tool_call_id: Some("call-create".to_string()),
        }
    }

    fn sample_segment(index: i64, message_count: i64) -> SubagentRunSegmentSaveInput {
        SubagentRunSegmentSaveInput {
            segment_index: index,
            segment_id: format!("segment-{index}"),
            summary_json: None,
            messages_json: format!(r#"[{{"role":"user","content":"segment {index}"}}]"#),
            message_count,
            start_message_id: Some(format!("m-{index}-start")),
            end_message_id: Some(format!("m-{index}-end")),
        }
    }

    fn sample_run_header(id: &str, parent_tool_call_id: &str) -> SubagentRunSaveHeader {
        SubagentRunSaveHeader {
            id: id.to_string(),
            parent_conversation_id: "conv-1".to_string(),
            parent_tool_call_id: parent_tool_call_id.to_string(),
            agent_id: "agent-a".to_string(),
            agent_index: 0,
            agent_total: 1,
            prompt: "Inspect implementation".to_string(),
            mode: "readonly".to_string(),
            status: "running".to_string(),
            provider_id: "codex".to_string(),
            model: "gpt-5".to_string(),
            session_id: Some("session-1".to_string()),
            workdir: Some("/tmp/work".to_string()),
            worktree_root: None,
            branch_name: None,
            context_schema_version: 1,
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
        }
    }

    fn sample_save_input(id: &str, parent_tool_call_id: &str) -> SubagentRunSaveInput {
        SubagentRunSaveInput {
            run: sample_run_header(id, parent_tool_call_id),
            segments: vec![sample_segment(0, 1)],
        }
    }

    // -- schema bootstrap ----------------------------------------------------

    #[test]
    fn subagent_schema_bootstraps_on_fresh_db() {
        let conn = open_test_db();
        for table_name in [
            "subagentMeta",
            "subagentIdentity",
            "subagentRun",
            "subagentRunSegment",
            "subagentMessage",
        ] {
            assert!(table_exists(&conn, table_name), "{table_name} should exist");
        }
        let version: String = conn
            .query_row(
                "SELECT value FROM subagentMeta WHERE key = 'schemaVersion'",
                [],
                |row| row.get(0),
            )
            .expect("read subagent schema version");
        assert_eq!(version, "2");
    }

    #[test]
    fn subagent_schema_drops_and_recreates_v1_tables() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "
            CREATE TABLE subagentRun (
                id TEXT PRIMARY KEY,
                parent_tool_call_id TEXT NOT NULL,
                parent_tool_name TEXT NOT NULL,
                logical_agent_id TEXT NOT NULL,
                description TEXT NOT NULL,
                context_meta_json TEXT NOT NULL
            );
            CREATE TABLE subagentRunEvent (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                event_type TEXT NOT NULL
            );
            CREATE TABLE subagentMessageBusEntry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_conversation_id TEXT NOT NULL,
                seq INTEGER NOT NULL
            );
            INSERT INTO subagentRun VALUES ('run-old', 'call-old', 'Agent', 'agent-old', 'old', '{}');
            ",
        )
        .expect("create fake v1 subagent schema");

        history_db::initialize_connection(&conn).expect("initialize over v1 schema");

        assert!(!table_exists(&conn, "subagentRunEvent"));
        assert!(!table_exists(&conn, "subagentMessageBusEntry"));
        assert!(table_exists(&conn, "subagentMessage"));
        let columns = table_columns(&conn, "subagentRun");
        assert!(columns.contains(&"prompt".to_string()));
        assert!(columns.contains(&"context_schema_version".to_string()));
        assert!(!columns.contains(&"logical_agent_id".to_string()));
        let run_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM subagentRun", [], |row| row.get(0))
            .expect("count runs after recreate");
        assert_eq!(run_count, 0, "old rows are deliberately dropped");
    }

    #[test]
    fn subagent_schema_bootstrap_is_idempotent() {
        let mut conn = open_test_db();
        save_subagent_run_sync(&mut conn, &sample_save_input("run-1", "call-1"))
            .expect("save run before re-bootstrap");

        history_db::initialize_connection(&conn).expect("second initialize");

        let run_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM subagentRun", [], |row| row.get(0))
            .expect("count runs after second bootstrap");
        assert_eq!(run_count, 1, "same-version bootstrap must keep data");
    }

    // -- identity ------------------------------------------------------------

    #[test]
    fn identity_upsert_inserts_then_updates() {
        let conn = open_test_db();
        let inserted = upsert_subagent_identity_sync(&conn, &sample_identity_input())
            .expect("insert identity");
        assert_eq!(inserted.parent_conversation_id, "conv-1");
        assert_eq!(inserted.agent_id, "agent-a");
        assert_eq!(inserted.name, "Reviewer");
        assert_eq!(inserted.template_id.as_deref(), Some("tpl-review"));
        assert_eq!(
            inserted.created_tool_call_id.as_deref(),
            Some("call-create")
        );

        // Backdate timestamps so the update visibly bumps updated_at only.
        conn.execute(
            "UPDATE subagentIdentity SET created_at = 1000, updated_at = 1000",
            [],
        )
        .expect("backdate identity timestamps");

        let mut update = sample_identity_input();
        update.name = "Renamed Reviewer".to_string();
        update.role = "architecture review".to_string();
        update.identity_prompt = "You review architecture.".to_string();
        update.template_id = None;
        update.last_mode = "worktree".to_string();
        update.created_tool_call_id = Some("call-other".to_string());

        let updated = upsert_subagent_identity_sync(&conn, &update).expect("update identity");
        assert_eq!(updated.name, "Renamed Reviewer");
        assert_eq!(updated.role, "architecture review");
        assert_eq!(updated.identity_prompt, "You review architecture.");
        assert_eq!(updated.template_id, None);
        assert_eq!(updated.last_mode, "worktree");
        assert_eq!(
            updated.created_tool_call_id.as_deref(),
            Some("call-create"),
            "createdToolCallId must only be set on insert"
        );
        assert_eq!(updated.created_at, 1000, "createdAt preserved on update");
        assert!(updated.updated_at > 1000, "updatedAt bumped on update");
    }

    #[test]
    fn identity_upsert_validates_input() {
        let conn = open_test_db();
        let mut input = sample_identity_input();
        input.last_mode = "yolo".to_string();
        let error = upsert_subagent_identity_sync(&conn, &input).expect_err("invalid lastMode");
        assert!(error.contains("lastMode"), "{error}");

        let mut input = sample_identity_input();
        input.agent_id = "  ".to_string();
        let error = upsert_subagent_identity_sync(&conn, &input).expect_err("empty agentId");
        assert!(error.contains("agentId"), "{error}");
    }

    // -- run save / load -----------------------------------------------------

    #[test]
    fn run_save_and_load_roundtrip_with_two_segments() {
        let mut conn = open_test_db();
        let mut input = sample_save_input("run-1", "call-1");
        input.segments = vec![sample_segment(0, 2), sample_segment(1, 3)];
        input.run.active_segment_index = 1;
        input.run.total_segment_count = 2;
        input.run.total_message_count = 5;
        input.run.worktree_root = Some("/tmp/.liveagent-subagents/repo/agent-a".to_string());
        input.run.branch_name = Some("liveagent/subagent/agent-a".to_string());
        input.run.mode = "worktree".to_string();
        input.run.status = "completed".to_string();
        input.run.summary = Some("done".to_string());
        input.run.ended_at = Some(1_700_000_005_000);

        save_subagent_run_sync(&mut conn, &input).expect("save run");
        let state = load_subagent_run_sync(&conn, "run-1")
            .expect("load run")
            .expect("run exists");

        assert_eq!(state.run.id, "run-1");
        assert_eq!(state.run.parent_conversation_id, "conv-1");
        assert_eq!(state.run.parent_tool_call_id, "call-1");
        assert_eq!(state.run.agent_id, "agent-a");
        assert_eq!(state.run.prompt, "Inspect implementation");
        assert_eq!(state.run.mode, "worktree");
        assert_eq!(state.run.status, "completed");
        assert_eq!(state.run.provider_id, "codex");
        assert_eq!(state.run.model, "gpt-5");
        assert_eq!(state.run.session_id.as_deref(), Some("session-1"));
        assert_eq!(state.run.workdir.as_deref(), Some("/tmp/work"));
        assert_eq!(
            state.run.worktree_root.as_deref(),
            Some("/tmp/.liveagent-subagents/repo/agent-a")
        );
        assert_eq!(
            state.run.branch_name.as_deref(),
            Some("liveagent/subagent/agent-a")
        );
        assert_eq!(state.run.context_schema_version, 1);
        assert_eq!(state.run.active_segment_index, 1);
        assert_eq!(state.run.total_segment_count, 2);
        assert_eq!(state.run.total_message_count, 5);
        assert_eq!(state.run.summary.as_deref(), Some("done"));
        assert_eq!(state.run.started_at, 1_700_000_000_000);
        assert_eq!(state.run.ended_at, Some(1_700_000_005_000));
        assert!(state.run.updated_at > 0, "server stamps updatedAt");

        assert_eq!(state.segments.len(), 2);
        assert_eq!(state.segments[0].segment_index, 0);
        assert_eq!(state.segments[0].segment_id, "segment-0");
        assert_eq!(state.segments[0].message_count, 2);
        assert_eq!(state.segments[1].segment_index, 1);
        assert_eq!(state.segments[1].segment_id, "segment-1");
        assert_eq!(state.segments[1].message_count, 3);
        assert_eq!(
            state.segments[1].start_message_id.as_deref(),
            Some("m-1-start")
        );
    }

    #[test]
    fn run_load_returns_none_when_missing() {
        let conn = open_test_db();
        let state = load_subagent_run_sync(&conn, "run-missing").expect("load missing run");
        assert!(state.is_none());
    }

    #[test]
    fn run_save_rejects_empty_segments() {
        let mut conn = open_test_db();
        let mut input = sample_save_input("run-1", "call-1");
        input.segments.clear();
        let error = save_subagent_run_sync(&mut conn, &input).expect_err("empty segments");
        assert!(error.contains("segments must not be empty"), "{error}");
    }

    #[test]
    fn run_save_rejects_non_contiguous_segments() {
        let mut conn = open_test_db();
        let mut input = sample_save_input("run-1", "call-1");
        input.segments = vec![sample_segment(0, 1), sample_segment(2, 1)];
        input.run.active_segment_index = 1;
        input.run.total_segment_count = 2;
        input.run.total_message_count = 2;
        let error = save_subagent_run_sync(&mut conn, &input).expect_err("non-contiguous");
        assert!(error.contains("contiguous"), "{error}");
    }

    #[test]
    fn run_save_rejects_active_segment_index_mismatch() {
        let mut conn = open_test_db();
        let mut input = sample_save_input("run-1", "call-1");
        input.run.active_segment_index = 1;
        input.run.total_segment_count = 1;
        let error = save_subagent_run_sync(&mut conn, &input).expect_err("index mismatch");
        assert!(error.contains("activeSegmentIndex"), "{error}");
    }

    #[test]
    fn run_save_rejects_total_message_count_mismatch() {
        let mut conn = open_test_db();
        let mut input = sample_save_input("run-1", "call-1");
        input.run.total_message_count = 9;
        let error = save_subagent_run_sync(&mut conn, &input).expect_err("count mismatch");
        assert!(error.contains("totalMessageCount"), "{error}");
    }

    #[test]
    fn run_incremental_resave_grows_then_compacts_segments() {
        let mut conn = open_test_db();
        let mut input = sample_save_input("run-1", "call-1");
        input.segments = vec![sample_segment(0, 1), sample_segment(1, 2)];
        input.run.active_segment_index = 1;
        input.run.total_segment_count = 2;
        input.run.total_message_count = 3;
        save_subagent_run_sync(&mut conn, &input).expect("initial save");

        let first = load_subagent_run_sync(&conn, "run-1")
            .expect("load")
            .expect("exists");
        let segment_created_at = first.segments[1].created_at;

        // Active segment grows: message_count 2 -> 5.
        let mut grown = input.clone();
        grown.segments[1].message_count = 5;
        grown.segments[1].messages_json =
            r#"[{"role":"user","content":"grown"},{"role":"assistant","content":"ok"}]"#
                .to_string();
        grown.run.total_message_count = 6;
        save_subagent_run_sync(&mut conn, &grown).expect("grown save");

        let after_growth = load_subagent_run_sync(&conn, "run-1")
            .expect("load")
            .expect("exists");
        assert_eq!(after_growth.segments.len(), 2);
        assert_eq!(after_growth.segments[1].message_count, 5);
        assert!(after_growth.segments[1].messages_json.contains("grown"));
        assert_eq!(
            after_growth.segments[1].created_at, segment_created_at,
            "segment createdAt preserved across upsert"
        );

        // Compaction-style re-save with fewer segments.
        let mut compacted = sample_save_input("run-1", "call-1");
        compacted.segments = vec![SubagentRunSegmentSaveInput {
            segment_index: 0,
            segment_id: "segment-compacted".to_string(),
            summary_json: Some(r#"{"summary":"compacted"}"#.to_string()),
            messages_json: r#"[{"role":"user","content":"compacted"}]"#.to_string(),
            message_count: 4,
            start_message_id: None,
            end_message_id: None,
        }];
        compacted.run.active_segment_index = 0;
        compacted.run.total_segment_count = 1;
        compacted.run.total_message_count = 4;
        compacted.run.compaction_count = 1;
        save_subagent_run_sync(&mut conn, &compacted).expect("compacted save");

        let after_compaction = load_subagent_run_sync(&conn, "run-1")
            .expect("load")
            .expect("exists");
        assert_eq!(
            after_compaction.segments.len(),
            1,
            "stale trailing segment must be deleted"
        );
        assert_eq!(after_compaction.segments[0].segment_id, "segment-compacted");
        assert_eq!(after_compaction.run.compaction_count, 1);
        let raw_segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRunSegment WHERE run_id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .expect("count segments");
        assert_eq!(raw_segment_count, 1);
    }

    #[test]
    fn run_list_orders_by_updated_at_desc_and_limits() {
        let mut conn = open_test_db();
        for (id, call) in [
            ("run-1", "call-1"),
            ("run-2", "call-2"),
            ("run-3", "call-3"),
        ] {
            save_subagent_run_sync(&mut conn, &sample_save_input(id, call)).expect("save run");
        }
        // Deterministic ordering regardless of wall-clock resolution.
        conn.execute(
            "UPDATE subagentRun SET updated_at = 100 WHERE id = 'run-1'",
            [],
        )
        .expect("stamp run-1");
        conn.execute(
            "UPDATE subagentRun SET updated_at = 300 WHERE id = 'run-2'",
            [],
        )
        .expect("stamp run-2");
        conn.execute(
            "UPDATE subagentRun SET updated_at = 200 WHERE id = 'run-3'",
            [],
        )
        .expect("stamp run-3");

        let listed = list_subagent_runs_sync(
            &conn,
            &SubagentRunListInput {
                parent_conversation_id: "conv-1".to_string(),
                limit: None,
            },
        )
        .expect("list runs");
        assert_eq!(
            listed.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
            vec!["run-2", "run-3", "run-1"]
        );

        let limited = list_subagent_runs_sync(
            &conn,
            &SubagentRunListInput {
                parent_conversation_id: "conv-1".to_string(),
                limit: Some(2),
            },
        )
        .expect("list runs limited");
        assert_eq!(
            limited
                .iter()
                .map(|run| run.id.as_str())
                .collect::<Vec<_>>(),
            vec!["run-2", "run-3"]
        );
    }

    // -- prune ---------------------------------------------------------------

    #[test]
    fn prune_removes_stale_runs_messages_and_identities() {
        let mut conn = open_test_db();

        let mut kept = sample_save_input("run-keep", "call-keep");
        kept.run.agent_id = "agent-keep".to_string();
        save_subagent_run_sync(&mut conn, &kept).expect("save kept run");

        let mut stale = sample_save_input("run-stale", "call-stale");
        stale.run.agent_id = "agent-stale".to_string();
        stale.run.mode = "worktree".to_string();
        stale.run.worktree_root = Some("/tmp/.liveagent-subagents/repo/agent-stale".to_string());
        stale.run.branch_name = Some("liveagent/subagent/agent-stale".to_string());
        save_subagent_run_sync(&mut conn, &stale).expect("save stale run");

        let mut kept_identity = sample_identity_input();
        kept_identity.agent_id = "agent-keep".to_string();
        kept_identity.created_tool_call_id = Some("call-keep".to_string());
        upsert_subagent_identity_sync(&conn, &kept_identity).expect("insert kept identity");
        let mut stale_identity = sample_identity_input();
        stale_identity.agent_id = "agent-stale".to_string();
        stale_identity.created_tool_call_id = Some("call-stale".to_string());
        upsert_subagent_identity_sync(&conn, &stale_identity).expect("insert stale identity");

        for (sender, source_call) in [
            ("agent-keep", Some("call-keep")),
            ("agent-stale", Some("call-stale")),
            ("agent-keep", None),
        ] {
            append_subagent_message_sync(
                &mut conn,
                &SubagentMessageAppendInput {
                    parent_conversation_id: "conv-1".to_string(),
                    sender_id: sender.to_string(),
                    sender_name: None,
                    recipient_id: "parent".to_string(),
                    recipient_name: None,
                    channel: "direct".to_string(),
                    subject: None,
                    body_markdown: format!("from {sender}"),
                    source_run_id: None,
                    source_tool_call_id: source_call.map(str::to_string),
                },
            )
            .expect("append message");
        }

        let result =
            prune_subagent_runs_sync(&conn, "conv-1", &["call-keep".to_string()]).expect("prune");

        assert_eq!(result.removed_run_ids, vec!["run-stale".to_string()]);
        assert_eq!(result.removed_message_count, 1);
        assert_eq!(result.removed_identity_count, 1);
        assert_eq!(result.cleanup_targets.len(), 1);
        assert_eq!(
            result.cleanup_targets[0].worktree_root,
            "/tmp/.liveagent-subagents/repo/agent-stale"
        );
        assert_eq!(
            result.cleanup_targets[0].branch_name.as_deref(),
            Some("liveagent/subagent/agent-stale")
        );
        assert_eq!(
            result.cleanup_targets[0].run_id.as_deref(),
            Some("run-stale")
        );

        // Kept run intact with its segments.
        let kept_state = load_subagent_run_sync(&conn, "run-keep")
            .expect("load kept")
            .expect("kept run exists");
        assert_eq!(kept_state.segments.len(), 1);
        assert!(load_subagent_run_sync(&conn, "run-stale")
            .expect("load stale")
            .is_none());
        let stale_segment_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM subagentRunSegment WHERE run_id = 'run-stale'",
                [],
                |row| row.get(0),
            )
            .expect("count stale segments");
        assert_eq!(stale_segment_count, 0, "run delete cascades segments");

        let identities = list_subagent_identities_sync(
            &conn,
            &SubagentIdentityListInput {
                parent_conversation_id: "conv-1".to_string(),
                limit: None,
            },
        )
        .expect("list identities");
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].agent_id, "agent-keep");

        let messages = list_subagent_messages_sync(
            &conn,
            &SubagentMessageListInput {
                parent_conversation_id: "conv-1".to_string(),
                for_agent_id: None,
                limit: None,
            },
        )
        .expect("list messages");
        assert_eq!(messages.len(), 2);
        assert!(messages
            .iter()
            .all(|message| message.sender_id != "agent-stale"));
    }

    #[test]
    fn prune_keeps_identity_with_remaining_runs() {
        let mut conn = open_test_db();
        let mut kept_run = sample_save_input("run-keep", "call-keep");
        kept_run.run.agent_id = "agent-a".to_string();
        save_subagent_run_sync(&mut conn, &kept_run).expect("save kept run");
        let mut stale_run = sample_save_input("run-stale", "call-stale");
        stale_run.run.agent_id = "agent-a".to_string();
        save_subagent_run_sync(&mut conn, &stale_run).expect("save stale run");

        let mut identity = sample_identity_input();
        identity.agent_id = "agent-a".to_string();
        identity.created_tool_call_id = Some("call-stale".to_string());
        upsert_subagent_identity_sync(&conn, &identity).expect("insert identity");

        let result =
            prune_subagent_runs_sync(&conn, "conv-1", &["call-keep".to_string()]).expect("prune");

        assert_eq!(result.removed_run_ids, vec!["run-stale".to_string()]);
        assert_eq!(
            result.removed_identity_count, 0,
            "identity with a remaining run must survive even if its creating call was pruned"
        );
    }

    #[test]
    fn delete_for_parent_conversation_removes_everything() {
        let mut conn = open_test_db();
        let mut run = sample_save_input("run-1", "call-1");
        run.run.worktree_root = Some("/tmp/.liveagent-subagents/repo/agent-a".to_string());
        run.run.branch_name = Some("liveagent/subagent/agent-a".to_string());
        save_subagent_run_sync(&mut conn, &run).expect("save run");
        upsert_subagent_identity_sync(&conn, &sample_identity_input()).expect("insert identity");
        append_subagent_message_sync(
            &mut conn,
            &SubagentMessageAppendInput {
                parent_conversation_id: "conv-1".to_string(),
                sender_id: "agent-a".to_string(),
                sender_name: None,
                recipient_id: "parent".to_string(),
                recipient_name: None,
                channel: "direct".to_string(),
                subject: None,
                body_markdown: "hello".to_string(),
                source_run_id: Some("run-1".to_string()),
                source_tool_call_id: None,
            },
        )
        .expect("append message");

        let result = delete_subagent_history_for_parent_conversation(&conn, "conv-1")
            .expect("delete conversation subagent history");

        assert_eq!(result.removed_run_ids, vec!["run-1".to_string()]);
        assert_eq!(result.removed_message_count, 1);
        assert_eq!(result.removed_identity_count, 1);
        assert_eq!(result.cleanup_targets.len(), 1);
        for table_name in [
            "subagentRun",
            "subagentRunSegment",
            "subagentIdentity",
            "subagentMessage",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
                    row.get(0)
                })
                .expect("count rows");
            assert_eq!(count, 0, "{table_name} should be empty");
        }
    }

    // -- messages ------------------------------------------------------------

    #[test]
    fn message_seq_is_monotonic_per_conversation() {
        let mut conn = open_test_db();
        let base = SubagentMessageAppendInput {
            parent_conversation_id: "conv-1".to_string(),
            sender_id: "agent-a".to_string(),
            sender_name: Some("Agent A".to_string()),
            recipient_id: "parent".to_string(),
            recipient_name: None,
            channel: "direct".to_string(),
            subject: Some("status".to_string()),
            body_markdown: "first".to_string(),
            source_run_id: None,
            source_tool_call_id: None,
        };
        let first = append_subagent_message_sync(&mut conn, &base).expect("append first");
        let second = append_subagent_message_sync(&mut conn, &base).expect("append second");
        let mut other = base.clone();
        other.parent_conversation_id = "conv-2".to_string();
        let other_first = append_subagent_message_sync(&mut conn, &other).expect("append other");

        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        assert_eq!(other_first.seq, 1, "seq is per conversation");
        assert_eq!(first.sender_name.as_deref(), Some("Agent A"));
        assert_eq!(first.subject.as_deref(), Some("status"));
    }

    #[test]
    fn message_append_validates_channel_and_required_fields() {
        let mut conn = open_test_db();
        let mut input = SubagentMessageAppendInput {
            parent_conversation_id: "conv-1".to_string(),
            sender_id: "agent-a".to_string(),
            sender_name: None,
            recipient_id: "agent-b".to_string(),
            recipient_name: None,
            channel: "gossip".to_string(),
            subject: None,
            body_markdown: "hello".to_string(),
            source_run_id: None,
            source_tool_call_id: None,
        };
        let error = append_subagent_message_sync(&mut conn, &input).expect_err("bad channel");
        assert!(error.contains("channel"), "{error}");

        input.channel = "direct".to_string();
        input.body_markdown = "  ".to_string();
        let error = append_subagent_message_sync(&mut conn, &input).expect_err("empty body");
        assert!(error.contains("bodyMarkdown"), "{error}");
    }

    #[test]
    fn message_list_filters_by_agent_and_broadcast() {
        let mut conn = open_test_db();
        let mut direct_to_a = SubagentMessageAppendInput {
            parent_conversation_id: "conv-1".to_string(),
            sender_id: "agent-b".to_string(),
            sender_name: None,
            recipient_id: "agent-a".to_string(),
            recipient_name: None,
            channel: "direct".to_string(),
            subject: None,
            body_markdown: "direct to a".to_string(),
            source_run_id: None,
            source_tool_call_id: None,
        };
        append_subagent_message_sync(&mut conn, &direct_to_a).expect("append direct");

        // A shared-channel message addressed to a concrete recipient is NOT a
        // broadcast; only recipient '*' is.
        direct_to_a.recipient_id = "parent".to_string();
        direct_to_a.channel = "shared".to_string();
        direct_to_a.body_markdown = "shared-channel to parent".to_string();
        append_subagent_message_sync(&mut conn, &direct_to_a).expect("append shared-to-parent");

        direct_to_a.recipient_id = "*".to_string();
        direct_to_a.channel = "shared".to_string();
        direct_to_a.body_markdown = "broadcast".to_string();
        append_subagent_message_sync(&mut conn, &direct_to_a).expect("append broadcast");

        let list_for = |conn: &Connection, agent: Option<&str>| {
            list_subagent_messages_sync(
                conn,
                &SubagentMessageListInput {
                    parent_conversation_id: "conv-1".to_string(),
                    for_agent_id: agent.map(str::to_string),
                    limit: None,
                },
            )
            .expect("list messages")
        };

        let for_a = list_for(&conn, Some("agent-a"));
        assert_eq!(
            for_a
                .iter()
                .map(|message| message.body_markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["direct to a", "broadcast"],
            "recipient sees direct + broadcast"
        );

        let for_b = list_for(&conn, Some("agent-b"));
        assert_eq!(
            for_b.len(),
            3,
            "sender sees own sent messages plus broadcast"
        );

        let for_c = list_for(&conn, Some("agent-c"));
        assert_eq!(
            for_c
                .iter()
                .map(|message| message.body_markdown.as_str())
                .collect::<Vec<_>>(),
            vec!["broadcast"],
            "uninvolved agent only sees '*' broadcasts"
        );

        let all = list_for(&conn, None);
        assert_eq!(all.len(), 3, "no forAgentId returns everything");
        assert!(all.windows(2).all(|pair| pair[0].seq < pair[1].seq));
    }

    #[test]
    fn message_list_returns_latest_messages_in_ascending_order() {
        let mut conn = open_test_db();
        for index in 0..5 {
            append_subagent_message_sync(
                &mut conn,
                &SubagentMessageAppendInput {
                    parent_conversation_id: "conv-1".to_string(),
                    sender_id: "agent-a".to_string(),
                    sender_name: None,
                    recipient_id: "*".to_string(),
                    recipient_name: None,
                    channel: "shared".to_string(),
                    subject: None,
                    body_markdown: format!("message {index}"),
                    source_run_id: None,
                    source_tool_call_id: None,
                },
            )
            .expect("append message");
        }

        let messages = list_subagent_messages_sync(
            &conn,
            &SubagentMessageListInput {
                parent_conversation_id: "conv-1".to_string(),
                for_agent_id: None,
                limit: Some(2),
            },
        )
        .expect("list limited messages");
        assert_eq!(
            messages
                .iter()
                .map(|message| message.seq)
                .collect::<Vec<_>>(),
            vec![4, 5],
            "limit keeps the latest messages, returned ascending"
        );
    }
}
