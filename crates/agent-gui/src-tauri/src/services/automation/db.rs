use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::types::{
    CronRunRecord, CronSnapshot, CronTask, HookDef, HooksSnapshot, HttpRequestSpec, RunState,
    SelectedModelRef, DEFAULT_CRON_TIMEOUT_SECONDS,
};

pub const RUN_RETENTION_PER_TASK: u32 = 200;
pub const RUN_RETENTION_MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const MAX_RUN_OUTPUT_CHARS: usize = 50_000;

const SCHEMA_VERSION: i64 = 1;

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

pub fn truncate_run_output(text: &str) -> String {
    if text.chars().count() <= MAX_RUN_OUTPUT_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_RUN_OUTPUT_CHARS).collect();
    out.push_str("\n...[log truncated]");
    out
}

pub fn open_automation_connection() -> Result<Connection, String> {
    let db_path = crate::commands::settings::config_db_path()?;
    let conn = Connection::open(db_path).map_err(|e| format!("打开 automation 数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置 SQLite busy_timeout 失败：{e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("启用 SQLite WAL 失败：{e}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("设置 SQLite synchronous 失败：{e}"))?;
    Ok(conn)
}

pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS automation_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_cron_tasks (
            task_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            cron_expr TEXT NOT NULL,
            kind TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            remaining_runs INTEGER,
            config_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            last_error TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_hooks (
            hook_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            event TEXT NOT NULL,
            kind TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            timeout_ms INTEGER,
            config_json TEXT NOT NULL,
            sort_index INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_cron_runs (
            execution_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            state TEXT NOT NULL,
            success INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            exit_code INTEGER,
            output TEXT NOT NULL DEFAULT '',
            lease_expires_at INTEGER,
            request_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_automation_cron_runs_task
            ON automation_cron_runs (task_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_cron_runs_state
            ON automation_cron_runs (state);
        ",
    )
    .map_err(|e| format!("初始化 automation 表失败：{e}"))?;
    Ok(())
}

fn meta_read_i64(conn: &Connection, key: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT value FROM automation_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("读取 automation_meta.{key} 失败：{e}"))?
    .map(|raw| {
        raw.parse::<i64>()
            .map_err(|e| format!("解析 automation_meta.{key} 失败：{e}"))
    })
    .transpose()
}

pub fn meta_write_i64(conn: &Connection, key: &str, value: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )
    .map_err(|e| format!("写入 automation_meta.{key} 失败：{e}"))?;
    Ok(())
}

pub fn read_revision(conn: &Connection, key: &str) -> Result<u64, String> {
    Ok(meta_read_i64(conn, key)?.unwrap_or(0).max(0) as u64)
}

pub fn bump_revision(conn: &Connection, key: &str) -> Result<u64, String> {
    let next = read_revision(conn, key)? + 1;
    meta_write_i64(conn, key, next as i64)?;
    Ok(next)
}

pub const CRON_REVISION_KEY: &str = "cron_revision";
pub const HOOKS_REVISION_KEY: &str = "hooks_revision";

/// Creates the automation tables and stamps the schema version. Idempotent.
pub fn initialize(conn: &Connection) -> Result<(), String> {
    ensure_schema(conn)?;
    if meta_read_i64(conn, "schema_version")?.is_none() {
        meta_write_i64(conn, "schema_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

fn task_config_json(task: &CronTask) -> Result<String, String> {
    let mut config = Map::new();
    if let Some(script) = &task.script {
        config.insert("script".to_string(), Value::String(script.clone()));
    }
    if let Some(requests) = &task.requests {
        config.insert(
            "requests".to_string(),
            serde_json::to_value(requests)
                .map_err(|e| format!("序列化 cron requests 失败：{e}"))?,
        );
    }
    if let Some(prompt) = &task.prompt {
        config.insert("prompt".to_string(), Value::String(prompt.clone()));
    }
    if let Some(selected_model) = &task.selected_model {
        config.insert(
            "selectedModel".to_string(),
            serde_json::to_value(selected_model)
                .map_err(|e| format!("序列化 cron selectedModel 失败：{e}"))?,
        );
    }
    if let Some(reasoning) = &task.reasoning {
        config.insert("reasoning".to_string(), Value::String(reasoning.clone()));
    }
    if let Some(workdir) = &task.workdir {
        config.insert("workdir".to_string(), Value::String(workdir.clone()));
    }
    config.insert(
        "timeoutSeconds".to_string(),
        Value::Number(task.timeout_seconds.into()),
    );
    serde_json::to_string(&Value::Object(config))
        .map_err(|e| format!("序列化 cron config 失败：{e}"))
}

fn hook_config_json(hook: &HookDef) -> Result<String, String> {
    let mut config = Map::new();
    if let Some(script) = &hook.script {
        config.insert("script".to_string(), Value::String(script.clone()));
    }
    if let Some(requests) = &hook.requests {
        config.insert(
            "requests".to_string(),
            serde_json::to_value(requests)
                .map_err(|e| format!("序列化 hook requests 失败：{e}"))?,
        );
    }
    serde_json::to_string(&Value::Object(config))
        .map_err(|e| format!("序列化 hook config 失败：{e}"))
}

pub fn insert_cron_task(conn: &Connection, task: &CronTask, sort_index: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_cron_tasks
            (task_id, name, description, cron_expr, kind, enabled, remaining_runs,
             config_json, sort_index, last_error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            task.id,
            task.name,
            task.description,
            task.cron,
            task.kind,
            task.enabled as i64,
            task.remaining_executions.map(|value| value as i64),
            task_config_json(task)?,
            sort_index,
            task.last_error,
            now_ms(),
        ],
    )
    .map_err(|e| format!("写入 automation_cron_tasks 失败：{e}"))?;
    Ok(())
}

pub fn update_cron_task_row(conn: &Connection, task: &CronTask) -> Result<usize, String> {
    conn.execute(
        "UPDATE automation_cron_tasks
         SET name = ?2, description = ?3, cron_expr = ?4, kind = ?5, enabled = ?6,
             remaining_runs = ?7, config_json = ?8, last_error = ?9, updated_at = ?10
         WHERE task_id = ?1",
        params![
            task.id,
            task.name,
            task.description,
            task.cron,
            task.kind,
            task.enabled as i64,
            task.remaining_executions.map(|value| value as i64),
            task_config_json(task)?,
            task.last_error,
            now_ms(),
        ],
    )
    .map_err(|e| format!("更新 automation_cron_tasks 失败：{e}"))
}

pub fn insert_hook(conn: &Connection, hook: &HookDef, sort_index: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_hooks
            (hook_id, name, description, event, kind, enabled, timeout_ms,
             config_json, sort_index, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            hook.id,
            hook.name,
            hook.description,
            hook.event,
            hook.kind,
            hook.enabled as i64,
            hook.timeout_ms.map(|value| value as i64),
            hook_config_json(hook)?,
            sort_index,
            now_ms(),
        ],
    )
    .map_err(|e| format!("写入 automation_hooks 失败：{e}"))?;
    Ok(())
}

pub fn update_hook_row(conn: &Connection, hook: &HookDef) -> Result<usize, String> {
    conn.execute(
        "UPDATE automation_hooks
         SET name = ?2, description = ?3, event = ?4, kind = ?5, enabled = ?6,
             timeout_ms = ?7, config_json = ?8, updated_at = ?9
         WHERE hook_id = ?1",
        params![
            hook.id,
            hook.name,
            hook.description,
            hook.event,
            hook.kind,
            hook.enabled as i64,
            hook.timeout_ms.map(|value| value as i64),
            hook_config_json(hook)?,
            now_ms(),
        ],
    )
    .map_err(|e| format!("更新 automation_hooks 失败：{e}"))
}

struct TaskConfig {
    script: Option<String>,
    requests: Option<Vec<HttpRequestSpec>>,
    prompt: Option<String>,
    selected_model: Option<SelectedModelRef>,
    reasoning: Option<String>,
    workdir: Option<String>,
    timeout_seconds: Option<u64>,
}

fn parse_task_config(config_json: &str) -> TaskConfig {
    let map = serde_json::from_str::<Value>(config_json)
        .ok()
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    TaskConfig {
        script: map
            .get("script")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        requests: map
            .get("requests")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        prompt: map
            .get("prompt")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        selected_model: map
            .get("selectedModel")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        reasoning: map
            .get("reasoning")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        workdir: map
            .get("workdir")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        timeout_seconds: map.get("timeoutSeconds").and_then(Value::as_u64),
    }
}

fn cron_task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CronTask> {
    let config_json: String = row.get("config_json")?;
    let config = parse_task_config(&config_json);
    Ok(CronTask {
        id: row.get("task_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        cron: row.get("cron_expr")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        remaining_executions: row
            .get::<_, Option<i64>>("remaining_runs")?
            .map(|value| value.max(0) as u64),
        timeout_seconds: config
            .timeout_seconds
            .unwrap_or(DEFAULT_CRON_TIMEOUT_SECONDS),
        kind: row.get("kind")?,
        script: config.script,
        requests: config.requests,
        prompt: config.prompt,
        selected_model: config.selected_model,
        reasoning: config.reasoning,
        workdir: config.workdir,
        last_error: row.get("last_error")?,
    })
}

fn hook_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HookDef> {
    let config_json: String = row.get("config_json")?;
    let config = parse_task_config(&config_json);
    Ok(HookDef {
        id: row.get("hook_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        event: row.get("event")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        kind: row.get("kind")?,
        script: config.script,
        requests: config.requests,
        timeout_ms: row
            .get::<_, Option<i64>>("timeout_ms")?
            .map(|value| value.max(0) as u64),
    })
}

pub fn read_cron_tasks(conn: &Connection) -> Result<Vec<CronTask>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT task_id, name, description, cron_expr, kind, enabled, remaining_runs,
                    config_json, last_error
             FROM automation_cron_tasks
             ORDER BY sort_index ASC, task_id ASC",
        )
        .map_err(|e| format!("准备读取 automation_cron_tasks 失败：{e}"))?;
    let rows = stmt
        .query_map([], cron_task_from_row)
        .map_err(|e| format!("读取 automation_cron_tasks 失败：{e}"))?;
    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row.map_err(|e| format!("读取 automation_cron_tasks 行失败：{e}"))?);
    }
    Ok(tasks)
}

pub fn read_cron_task(conn: &Connection, task_id: &str) -> Result<Option<CronTask>, String> {
    conn.query_row(
        "SELECT task_id, name, description, cron_expr, kind, enabled, remaining_runs,
                config_json, last_error
         FROM automation_cron_tasks WHERE task_id = ?1",
        params![task_id],
        cron_task_from_row,
    )
    .optional()
    .map_err(|e| format!("读取 automation_cron_tasks.{task_id} 失败：{e}"))
}

pub fn read_hooks(conn: &Connection) -> Result<Vec<HookDef>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT hook_id, name, description, event, kind, enabled, timeout_ms, config_json
             FROM automation_hooks
             ORDER BY sort_index ASC, hook_id ASC",
        )
        .map_err(|e| format!("准备读取 automation_hooks 失败：{e}"))?;
    let rows = stmt
        .query_map([], hook_from_row)
        .map_err(|e| format!("读取 automation_hooks 失败：{e}"))?;
    let mut hooks = Vec::new();
    for row in rows {
        hooks.push(row.map_err(|e| format!("读取 automation_hooks 行失败：{e}"))?);
    }
    Ok(hooks)
}

pub fn read_hook(conn: &Connection, hook_id: &str) -> Result<Option<HookDef>, String> {
    conn.query_row(
        "SELECT hook_id, name, description, event, kind, enabled, timeout_ms, config_json
         FROM automation_hooks WHERE hook_id = ?1",
        params![hook_id],
        hook_from_row,
    )
    .optional()
    .map_err(|e| format!("读取 automation_hooks.{hook_id} 失败：{e}"))
}

pub fn read_cron_snapshot(conn: &Connection) -> Result<CronSnapshot, String> {
    Ok(CronSnapshot {
        revision: read_revision(conn, CRON_REVISION_KEY)?,
        tasks: read_cron_tasks(conn)?,
    })
}

pub fn read_hooks_snapshot(conn: &Connection) -> Result<HooksSnapshot, String> {
    Ok(HooksSnapshot {
        revision: read_revision(conn, HOOKS_REVISION_KEY)?,
        hooks: read_hooks(conn)?,
    })
}

fn run_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CronRunRecord> {
    let state_raw: String = row.get("state")?;
    Ok(CronRunRecord {
        id: row.get("execution_id")?,
        task_id: row.get("task_id")?,
        state: RunState::parse(&state_raw).unwrap_or(RunState::Done),
        success: row.get::<_, i64>("success")? != 0,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get::<_, i64>("duration_ms")?.max(0) as u64,
        exit_code: row.get("exit_code")?,
        output: row.get("output")?,
    })
}

pub fn read_runs(
    conn: &Connection,
    task_id: &str,
    limit: usize,
) -> Result<Vec<CronRunRecord>, String> {
    let limit = limit.clamp(1, 500) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT execution_id, task_id, state, success, started_at, finished_at,
                    duration_ms, exit_code, output
             FROM automation_cron_runs
             WHERE task_id = ?1
             ORDER BY started_at DESC, execution_id DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("准备读取 automation_cron_runs 失败：{e}"))?;
    let rows = stmt
        .query_map(params![task_id, limit], run_record_from_row)
        .map_err(|e| format!("读取 automation_cron_runs 失败：{e}"))?;
    let mut runs = Vec::new();
    for row in rows {
        runs.push(row.map_err(|e| format!("读取 automation_cron_runs 行失败：{e}"))?);
    }
    Ok(runs)
}

/// Deletes finished runs beyond the per-task retention window plus anything
/// older than the global age cap. Called inside the same transaction as the
/// insert that grows the table.
pub fn prune_runs(conn: &Connection, task_id: &str) -> Result<(), String> {
    conn.execute(
        &format!(
            "DELETE FROM automation_cron_runs
             WHERE task_id = ?1 AND state IN ('done', 'expired') AND execution_id NOT IN (
                 SELECT execution_id FROM automation_cron_runs
                 WHERE task_id = ?1 AND state IN ('done', 'expired')
                 ORDER BY started_at DESC, execution_id DESC
                 LIMIT {RUN_RETENTION_PER_TASK}
             )"
        ),
        params![task_id],
    )
    .map_err(|e| format!("修剪 automation_cron_runs 失败：{e}"))?;
    conn.execute(
        "DELETE FROM automation_cron_runs
         WHERE state IN ('done', 'expired') AND started_at < ?1",
        params![now_ms() - RUN_RETENTION_MAX_AGE_MS],
    )
    .map_err(|e| format!("按时限修剪 automation_cron_runs 失败：{e}"))?;
    Ok(())
}
