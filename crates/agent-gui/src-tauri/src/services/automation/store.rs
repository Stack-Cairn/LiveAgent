use std::sync::{Mutex, Weak};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use tauri::Emitter;
use uuid::Uuid;

use crate::services::gateway::GatewayController;

use super::db;
use super::scheduler::AutomationScheduler;
use super::types::*;
use super::validate;

/// Fan-out target for store mutations. All change notifications originate
/// here so every writer (UI apply, LLM tool, gateway relay, executor
/// decrement) produces exactly the same broadcast.
pub struct AutomationNotifier {
    pub app_handle: tauri::AppHandle,
    pub gateway: Weak<GatewayController>,
    pub scheduler: Weak<AutomationScheduler>,
}

impl AutomationNotifier {
    fn cron_changed(&self, snapshot: &CronSnapshot) {
        if let Err(error) = self.app_handle.emit(CRON_CHANGED_EVENT, snapshot) {
            eprintln!("emit {CRON_CHANGED_EVENT} failed: {error}");
        }
        if let Some(scheduler) = self.scheduler.upgrade() {
            scheduler.request_reload();
        }
        self.refresh_gateway();
    }

    fn hooks_changed(&self, snapshot: &HooksSnapshot) {
        if let Err(error) = self.app_handle.emit(HOOKS_CHANGED_EVENT, snapshot) {
            eprintln!("emit {HOOKS_CHANGED_EVENT} failed: {error}");
        }
        self.refresh_gateway();
    }

    fn prompt_pending(&self) {
        if let Err(error) = self.app_handle.emit(PROMPT_PENDING_EVENT, ()) {
            eprintln!("emit {PROMPT_PENDING_EVENT} failed: {error}");
        }
    }

    fn prompt_expired(&self, event: &PromptExpiredEvent) {
        if let Err(error) = self.app_handle.emit(PROMPT_EXPIRED_EVENT, event) {
            eprintln!("emit {PROMPT_EXPIRED_EVENT} failed: {error}");
        }
    }

    fn refresh_gateway(&self) {
        let Some(gateway) = self.gateway.upgrade() else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            if let Err(error) = gateway.refresh_settings_sync_from_db().await {
                eprintln!("refresh gateway settings sync after automation change failed: {error}");
            }
        });
    }
}

enum CronMutationEffect {
    None,
    Changed,
}

/// How long a queued prompt run may sit unclaimed before the sweep expires
/// it. The task's own `timeout_seconds` only starts counting at claim time,
/// so queue latency (webview reload, slow startup) never eats into the
/// execution budget.
pub const PROMPT_PENDING_CLAIM_WINDOW_MS: i64 = 10 * 60_000;

pub enum PromptQueueOutcome {
    Queued,
    SkippedActiveRun,
}

pub struct AutomationStore {
    conn: Mutex<Connection>,
    notifier: Mutex<Option<AutomationNotifier>>,
}

impl AutomationStore {
    pub fn open() -> Result<Self, String> {
        let conn = db::open_automation_connection()?;
        db::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            notifier: Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        db::initialize(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            notifier: Mutex::new(None),
        })
    }

    /// Test-only: read a run's lease deadline column (not exposed via any
    /// public API).
    #[cfg(test)]
    pub fn debug_run_lease(&self, execution_id: &str) -> Result<Option<i64>, String> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT lease_expires_at FROM automation_cron_runs WHERE execution_id = ?1",
            params![execution_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|e| e.to_string())
    }

    /// Test-only: force a run's lease deadline so sweeps can be exercised
    /// without waiting.
    #[cfg(test)]
    pub fn debug_set_run_lease(&self, execution_id: &str, lease_expires_at: i64) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE automation_cron_runs SET lease_expires_at = ?2 WHERE execution_id = ?1",
            params![execution_id, lease_expires_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_notifier(&self, notifier: AutomationNotifier) {
        if let Ok(mut guard) = self.notifier.lock() {
            *guard = Some(notifier);
        }
    }

    fn with_notifier(&self, f: impl FnOnce(&AutomationNotifier)) {
        if let Ok(guard) = self.notifier.lock() {
            if let Some(notifier) = guard.as_ref() {
                f(notifier);
            }
        }
    }

    pub fn run_cron_task_now(&self, task_id: &str) -> Result<CronRunNowResponse, String> {
        let scheduler = self
            .notifier
            .lock()
            .map_err(|_| "automation notifier lock poisoned".to_string())?
            .as_ref()
            .and_then(|notifier| notifier.scheduler.upgrade())
            .ok_or_else(|| "automation scheduler is unavailable".to_string())?;
        scheduler.run_now(task_id)
    }

    /// 翻转单个 cron 任务的启用状态（托盘菜单开关用）。走唯一的
    /// `cron_apply` 写路径（revision CAS）；读-改窗口内被并发修改时
    /// 用新快照重试一次，仍冲突则报错。返回翻转后的启用状态。
    pub fn toggle_cron_task_enabled(&self, task_id: &str) -> Result<bool, String> {
        for _ in 0..2 {
            let cron = self.snapshot()?.cron;
            let task = cron
                .tasks
                .iter()
                .find(|task| task.id == task_id)
                .ok_or_else(|| format!("cron task 不存在：{task_id}"))?;
            let next_enabled = !task.enabled;
            let response = self.cron_apply(AutomationApplyInput {
                base_revision: cron.revision,
                ops: vec![AutomationOp::Update {
                    id: task_id.to_string(),
                    patch: serde_json::json!({ "enabled": next_enabled }),
                }],
            })?;
            if matches!(response.status, ApplyStatus::Ok) {
                return Ok(next_enabled);
            }
        }
        Err("cron task 状态已被并发修改，请重试".to_string())
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "automation store lock poisoned".to_string())
    }

    pub fn snapshot(&self) -> Result<AutomationSnapshot, String> {
        let conn = self.lock_conn()?;
        Ok(AutomationSnapshot {
            cron: db::read_cron_snapshot(&conn)?,
            hooks: db::read_hooks_snapshot(&conn)?,
        })
    }

    pub fn cron_apply(&self, input: AutomationApplyInput) -> Result<CronApplyResponse, String> {
        let snapshot = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 cron apply 事务失败：{e}"))?;

            let current = db::read_revision(&tx, db::CRON_REVISION_KEY)?;
            if input.base_revision != current {
                let snapshot = db::read_cron_snapshot(&tx)?;
                drop(tx);
                return Ok(CronApplyResponse {
                    status: ApplyStatus::Conflict,
                    cron: snapshot,
                });
            }

            for op in input.ops {
                apply_cron_op(&tx, op)?;
            }
            db::bump_revision(&tx, db::CRON_REVISION_KEY)?;
            let snapshot = db::read_cron_snapshot(&tx)?;
            tx.commit()
                .map_err(|e| format!("提交 cron apply 事务失败：{e}"))?;
            snapshot
        };

        self.with_notifier(|notifier| notifier.cron_changed(&snapshot));
        Ok(CronApplyResponse {
            status: ApplyStatus::Ok,
            cron: snapshot,
        })
    }

    pub fn hooks_apply(&self, input: AutomationApplyInput) -> Result<HooksApplyResponse, String> {
        let snapshot = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 hooks apply 事务失败：{e}"))?;

            let current = db::read_revision(&tx, db::HOOKS_REVISION_KEY)?;
            if input.base_revision != current {
                let snapshot = db::read_hooks_snapshot(&tx)?;
                drop(tx);
                return Ok(HooksApplyResponse {
                    status: ApplyStatus::Conflict,
                    hooks: snapshot,
                });
            }

            for op in input.ops {
                apply_hook_op(&tx, op)?;
            }
            db::bump_revision(&tx, db::HOOKS_REVISION_KEY)?;
            let snapshot = db::read_hooks_snapshot(&tx)?;
            tx.commit()
                .map_err(|e| format!("提交 hooks apply 事务失败：{e}"))?;
            snapshot
        };

        self.with_notifier(|notifier| notifier.hooks_changed(&snapshot));
        Ok(HooksApplyResponse {
            status: ApplyStatus::Ok,
            hooks: snapshot,
        })
    }

    /// Persist a scheduler-detected task error (e.g. an unparsable cron
    /// expression). No-op when the stored value already matches, so the
    /// reload loop converges instead of ping-ponging.
    pub fn set_task_error(&self, task_id: &str, error: Option<&str>) -> Result<(), String> {
        let snapshot = {
            let conn = self.lock_conn()?;
            let stored: Option<Option<String>> = conn
                .query_row(
                    "SELECT last_error FROM automation_cron_tasks WHERE task_id = ?1",
                    params![task_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("读取 automation_cron_tasks.last_error 失败：{e}"))?;
            let Some(stored) = stored else {
                return Ok(());
            };
            if stored.as_deref() == error {
                return Ok(());
            }
            conn.execute(
                "UPDATE automation_cron_tasks SET last_error = ?2, updated_at = ?3 WHERE task_id = ?1",
                params![task_id, error, db::now_ms()],
            )
            .map_err(|e| format!("更新 automation_cron_tasks.last_error 失败：{e}"))?;
            db::bump_revision(&conn, db::CRON_REVISION_KEY)?;
            db::read_cron_snapshot(&conn)?
        };
        self.with_notifier(|notifier| notifier.cron_changed(&snapshot));
        Ok(())
    }

    /// Disable a task after an unrecoverable fire-time failure (e.g. its
    /// pinned workspace directory disappeared) so it stops re-firing until
    /// the user fixes and re-enables it.
    pub fn disable_task_with_error(&self, task_id: &str, error: &str) -> Result<(), String> {
        let snapshot = {
            let conn = self.lock_conn()?;
            let updated = conn
                .execute(
                    "UPDATE automation_cron_tasks
                     SET enabled = 0, last_error = ?2, updated_at = ?3
                     WHERE task_id = ?1",
                    params![task_id, error, db::now_ms()],
                )
                .map_err(|e| format!("禁用 automation_cron_tasks 失败：{e}"))?;
            if updated == 0 {
                return Ok(());
            }
            db::bump_revision(&conn, db::CRON_REVISION_KEY)?;
            db::read_cron_snapshot(&conn)?
        };
        self.with_notifier(|notifier| notifier.cron_changed(&snapshot));
        Ok(())
    }

    /// Fresh enabled/remaining recheck immediately before a fire executes.
    pub fn task_can_run(&self, task_id: &str) -> Result<bool, String> {
        let conn = self.lock_conn()?;
        let row: Option<(i64, Option<i64>)> = conn
            .query_row(
                "SELECT enabled, remaining_runs FROM automation_cron_tasks WHERE task_id = ?1",
                params![task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("读取 automation_cron_tasks 状态失败：{e}"))?;
        Ok(matches!(row, Some((enabled, remaining)) if enabled != 0 && remaining != Some(0)))
    }

    /// Persist a finished bash/http run (or synthesized failure/skip record).
    pub fn record_completed_run(&self, run: CompletedRun) -> Result<(), String> {
        let cron_snapshot = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 run 记录事务失败：{e}"))?;
            insert_finished_run(&tx, &run, RunState::Done)?;
            let effect = if run.counted {
                decrement_remaining(&tx, &run.task_id)?
            } else {
                CronMutationEffect::None
            };
            db::prune_runs(&tx, &run.task_id)?;
            let snapshot = match effect {
                CronMutationEffect::Changed => {
                    db::bump_revision(&tx, db::CRON_REVISION_KEY)?;
                    Some(db::read_cron_snapshot(&tx)?)
                }
                CronMutationEffect::None => None,
            };
            tx.commit()
                .map_err(|e| format!("提交 run 记录事务失败：{e}"))?;
            snapshot
        };

        if let Some(snapshot) = cron_snapshot {
            self.with_notifier(|notifier| notifier.cron_changed(&snapshot));
        }
        Ok(())
    }

    /// Queue a prompt run for the frontend executor. The run row *is* the
    /// pending queue — it survives restarts and carries the lease deadline.
    pub fn queue_prompt_run(
        &self,
        task: &CronTask,
        workdir: &str,
        counted: bool,
    ) -> Result<PromptQueueOutcome, String> {
        let prompt = task
            .prompt
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        if prompt.is_empty() {
            return Err("Auto Prompt task has no prompt content.".to_string());
        }
        let selected_model = task.selected_model.as_ref().ok_or_else(|| {
            "Auto Prompt task is missing the selected model configuration.".to_string()
        })?;
        let provider_id = selected_model.custom_provider_id.trim().to_string();
        let model = selected_model.model.trim().to_string();
        if provider_id.is_empty() || model.is_empty() {
            return Err(
                "Auto Prompt task has an invalid selected model configuration.".to_string(),
            );
        }

        let request = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 prompt 排队事务失败：{e}"))?;

            let active: Option<String> = tx
                .query_row(
                    "SELECT execution_id FROM automation_cron_runs
                     WHERE task_id = ?1 AND state IN ('pending', 'leased') LIMIT 1",
                    params![task.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("检查 prompt 活动运行失败：{e}"))?;
            if active.is_some() {
                return Ok(PromptQueueOutcome::SkippedActiveRun);
            }

            let started_at = db::now_ms();
            let request = PromptRunRequest {
                execution_id: Uuid::new_v4().to_string(),
                task_id: task.id.clone(),
                task_name: task.name.clone(),
                prompt,
                provider_id,
                model,
                started_at,
                // Fixed claim window while pending; re-stamped from the
                // timeout snapshot when a runner claims the row.
                lease_expires_at: started_at + PROMPT_PENDING_CLAIM_WINDOW_MS,
                timeout_seconds: task.timeout_seconds.max(1),
                counted,
                workdir: workdir.to_string(),
                reasoning: task.reasoning.clone().unwrap_or_default(),
            };
            let request_json = serde_json::to_string(&request)
                .map_err(|e| format!("序列化 prompt run 请求失败：{e}"))?;
            tx.execute(
                "INSERT INTO automation_cron_runs
                    (execution_id, task_id, state, success, started_at, duration_ms,
                     output, lease_expires_at, request_json)
                 VALUES (?1, ?2, 'pending', 0, ?3, 0, '', ?4, ?5)",
                params![
                    request.execution_id,
                    request.task_id,
                    request.started_at,
                    request.lease_expires_at,
                    request_json,
                ],
            )
            .map_err(|e| format!("写入 prompt run 失败：{e}"))?;
            tx.commit()
                .map_err(|e| format!("提交 prompt 排队事务失败：{e}"))?;
            request
        };

        let _ = request;
        self.with_notifier(|notifier| notifier.prompt_pending());
        Ok(PromptQueueOutcome::Queued)
    }

    /// Atomically claim all pending prompt runs (pending -> leased). Overdue
    /// runs are expired in the same pass instead of being handed out. The
    /// execution lease starts here: each claimed row is re-stamped to
    /// `now + timeout_seconds` (column and request_json together), so queue
    /// latency never counts against the task's execution budget.
    pub fn claim_prompt_runs(&self) -> Result<Vec<PromptRunRequest>, String> {
        self.sweep_expired_prompt_runs()?;

        let claims = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 prompt claim 事务失败：{e}"))?;
            let mut claims = Vec::new();
            {
                let mut stmt = tx
                    .prepare(
                        "SELECT request_json FROM automation_cron_runs
                         WHERE state = 'pending' AND request_json IS NOT NULL
                         ORDER BY started_at ASC, execution_id ASC",
                    )
                    .map_err(|e| format!("准备读取 pending prompt runs 失败：{e}"))?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(|e| format!("读取 pending prompt runs 失败：{e}"))?;
                for row in rows {
                    let raw = row.map_err(|e| format!("读取 pending prompt run 行失败：{e}"))?;
                    match serde_json::from_str::<PromptRunRequest>(&raw) {
                        Ok(request) => claims.push(request),
                        Err(error) => eprintln!("skip malformed prompt run request: {error}"),
                    }
                }
            }
            let now = db::now_ms();
            for request in &mut claims {
                request.lease_expires_at =
                    now + (request.timeout_seconds.max(1) as i64).saturating_mul(1_000);
                let request_json = serde_json::to_string(request)
                    .map_err(|e| format!("序列化 prompt run 请求失败：{e}"))?;
                tx.execute(
                    "UPDATE automation_cron_runs
                     SET state = 'leased', lease_expires_at = ?2, request_json = ?3
                     WHERE execution_id = ?1",
                    params![request.execution_id, request.lease_expires_at, request_json],
                )
                .map_err(|e| format!("租约 prompt run 失败：{e}"))?;
            }
            tx.commit()
                .map_err(|e| format!("提交 prompt claim 事务失败：{e}"))?;
            claims
        };

        Ok(claims)
    }

    /// Return a claimed-but-never-started run to the pending queue (e.g. the
    /// claiming webview unmounted before executing). Re-stamps a fresh claim
    /// window on the column; the stale lease inside request_json is harmless
    /// because a claim always re-stamps before handing the row out.
    pub fn release_prompt_run(&self, execution_id: &str) -> Result<(), String> {
        let released = {
            let conn = self.lock_conn()?;
            conn.execute(
                "UPDATE automation_cron_runs SET state = 'pending', lease_expires_at = ?2
                 WHERE execution_id = ?1 AND state = 'leased'",
                params![
                    execution_id.trim(),
                    db::now_ms() + PROMPT_PENDING_CLAIM_WINDOW_MS
                ],
            )
            .map_err(|e| format!("释放 prompt run 失败：{e}"))?
        };
        if released > 0 {
            self.with_notifier(|notifier| notifier.prompt_pending());
        }
        Ok(())
    }

    pub fn complete_prompt_run(
        &self,
        input: CompletePromptRunInput,
    ) -> Result<PromptCompletionResponse, String> {
        let execution_id = input.execution_id.trim().to_string();
        if execution_id.is_empty() {
            return Err("executionId cannot be empty.".to_string());
        }

        let cron_snapshot = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 prompt 完成事务失败：{e}"))?;

            let row: Option<(String, String, i64, Option<String>)> = tx
                .query_row(
                    "SELECT task_id, state, started_at, request_json FROM automation_cron_runs
                     WHERE execution_id = ?1",
                    params![execution_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(|e| format!("读取 prompt run 失败：{e}"))?;

            let Some((task_id, state, started_at, request_json)) = row else {
                return Ok(PromptCompletionResponse {
                    status: PromptCompletionStatus::AlreadyFinished,
                });
            };
            if state != "pending" && state != "leased" {
                return Ok(PromptCompletionResponse {
                    status: PromptCompletionStatus::AlreadyFinished,
                });
            }

            let now = db::now_ms();
            let output = if input.output.trim().is_empty() {
                if input.success {
                    "Auto Prompt run produced an empty final conclusion.".to_string()
                } else {
                    "Auto Prompt run failed without an error message.".to_string()
                }
            } else {
                input.output.trim().to_string()
            };
            let duration_ms = if input.duration_ms > 0 {
                input.duration_ms as i64
            } else {
                (now - started_at).max(0)
            };

            tx.execute(
                "UPDATE automation_cron_runs
                 SET state = 'done', success = ?2, finished_at = ?3, duration_ms = ?4,
                     output = ?5, lease_expires_at = NULL, request_json = NULL
                 WHERE execution_id = ?1",
                params![
                    execution_id,
                    input.success as i64,
                    now,
                    duration_ms,
                    db::truncate_run_output(&output),
                ],
            )
            .map_err(|e| format!("写入 prompt 完成结果失败：{e}"))?;

            let effect = if prompt_run_is_counted(request_json.as_deref()) {
                decrement_remaining(&tx, &task_id)?
            } else {
                CronMutationEffect::None
            };
            db::prune_runs(&tx, &task_id)?;
            let snapshot = match effect {
                CronMutationEffect::Changed => {
                    db::bump_revision(&tx, db::CRON_REVISION_KEY)?;
                    Some(db::read_cron_snapshot(&tx)?)
                }
                CronMutationEffect::None => None,
            };
            tx.commit()
                .map_err(|e| format!("提交 prompt 完成事务失败：{e}"))?;
            snapshot
        };

        if let Some(snapshot) = cron_snapshot {
            self.with_notifier(|notifier| notifier.cron_changed(&snapshot));
        }
        Ok(PromptCompletionResponse {
            status: PromptCompletionStatus::Completed,
        })
    }

    /// Expire pending/leased prompt runs whose deadline passed. Emits
    /// `automation:prompt-expired` per run so an in-flight frontend
    /// execution aborts. Pending rows expired here never started executing
    /// (no runner claimed them), so they get a distinct message.
    pub fn sweep_expired_prompt_runs(&self) -> Result<Vec<PromptExpiredEvent>, String> {
        let mut events = self.expire_prompt_runs_where(
            "state = 'pending' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1",
            params![db::now_ms()],
            "Auto Prompt run expired before any runner claimed it.",
        )?;
        events.extend(self.expire_prompt_runs_where(
            "state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1",
            params![db::now_ms()],
            "Auto Prompt run timed out before the front-end completed it.",
        )?);
        Ok(events)
    }

    /// Startup recovery: any queued/leased run from a previous process is
    /// dead — record it as expired instead of silently dropping it.
    pub fn recover_interrupted_prompt_runs(&self) -> Result<usize, String> {
        let expired = self.expire_prompt_runs_where(
            "state IN ('pending', 'leased')",
            params![],
            "Auto Prompt run was interrupted by an app restart.",
        )?;
        Ok(expired.len())
    }

    fn expire_prompt_runs_where(
        &self,
        predicate: &str,
        predicate_params: &[&dyn rusqlite::ToSql],
        message: &str,
    ) -> Result<Vec<PromptExpiredEvent>, String> {
        let (events, cron_snapshot) = {
            let mut conn = self.lock_conn()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| format!("开启 prompt 过期事务失败：{e}"))?;

            let mut rows = Vec::new();
            {
                let mut stmt = tx
                    .prepare(&format!(
                        "SELECT execution_id, task_id, started_at, request_json FROM automation_cron_runs
                         WHERE {predicate}"
                    ))
                    .map_err(|e| format!("准备读取过期 prompt runs 失败：{e}"))?;
                let mapped = stmt
                    .query_map(predicate_params, |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })
                    .map_err(|e| format!("读取过期 prompt runs 失败：{e}"))?;
                for row in mapped {
                    rows.push(row.map_err(|e| format!("读取过期 prompt run 行失败：{e}"))?);
                }
            }
            if rows.is_empty() {
                return Ok(Vec::new());
            }

            let now = db::now_ms();
            let mut changed = false;
            let mut events = Vec::with_capacity(rows.len());
            for (execution_id, task_id, started_at, request_json) in rows {
                tx.execute(
                    "UPDATE automation_cron_runs
                     SET state = 'expired', success = 0, finished_at = ?2, duration_ms = ?3,
                         output = ?4, lease_expires_at = NULL, request_json = NULL
                     WHERE execution_id = ?1",
                    params![execution_id, now, (now - started_at).max(0), message],
                )
                .map_err(|e| format!("标记 prompt run 过期失败：{e}"))?;
                if prompt_run_is_counted(request_json.as_deref())
                    && matches!(
                        decrement_remaining(&tx, &task_id)?,
                        CronMutationEffect::Changed
                    )
                {
                    changed = true;
                }
                db::prune_runs(&tx, &task_id)?;
                events.push(PromptExpiredEvent {
                    execution_id,
                    task_id,
                });
            }
            let snapshot = if changed {
                db::bump_revision(&tx, db::CRON_REVISION_KEY)?;
                Some(db::read_cron_snapshot(&tx)?)
            } else {
                None
            };
            tx.commit()
                .map_err(|e| format!("提交 prompt 过期事务失败：{e}"))?;
            (events, snapshot)
        };

        if let Some(snapshot) = cron_snapshot {
            self.with_notifier(|notifier| notifier.cron_changed(&snapshot));
        }
        for event in &events {
            self.with_notifier(|notifier| notifier.prompt_expired(event));
        }
        Ok(events)
    }

    pub fn list_runs(&self, task_id: &str, limit: usize) -> Result<Vec<CronRunRecord>, String> {
        let conn = self.lock_conn()?;
        if db::read_cron_task(&conn, task_id)?.is_none() {
            return Err(format!("cron task 不存在：{task_id}"));
        }
        db::read_runs(&conn, task_id, limit)
    }

    pub fn clear_runs(&self, task_id: &str) -> Result<usize, String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "DELETE FROM automation_cron_runs
             WHERE task_id = ?1 AND state IN ('done', 'expired')",
            params![task_id],
        )
        .map_err(|e| format!("清理 automation_cron_runs 失败：{e}"))
    }

    /// Enabled, non-exhausted tasks for the scheduler's diff reload. Workdirs
    /// are resolved per task at fire time, not here.
    pub fn runnable_cron_tasks(&self) -> Result<Vec<CronTask>, String> {
        let conn = self.lock_conn()?;
        let tasks = db::read_cron_tasks(&conn)?
            .into_iter()
            .filter(|task| task.enabled && task.remaining_executions != Some(0))
            .collect();
        Ok(tasks)
    }

    /// Fresh task + resolved workdir for a scheduled fire. Returns `Ok(None)`
    /// when the task no longer exists (the next reload drops its job).
    pub fn cron_task_for_scheduled_fire(
        &self,
        task_id: &str,
    ) -> Result<Option<(String, CronTask)>, String> {
        let conn = self.lock_conn()?;
        let Some(task) = db::read_cron_task(&conn, task_id)? else {
            return Ok(None);
        };
        let workdir = task_workdir(&conn, &task)?;
        Ok(Some((workdir, task)))
    }

    pub fn cron_task_for_manual_run(&self, task_id: &str) -> Result<(String, CronTask), String> {
        let task_id = task_id.trim();
        if task_id.is_empty() {
            return Err("cron task id cannot be empty".to_string());
        }
        let conn = self.lock_conn()?;
        let task = db::read_cron_task(&conn, task_id)?
            .ok_or_else(|| format!("cron task 不存在：{task_id}"))?;
        if task.kind == "prompt" {
            let active: Option<String> = conn
                .query_row(
                    "SELECT execution_id FROM automation_cron_runs
                     WHERE task_id = ?1 AND state IN ('pending', 'leased') LIMIT 1",
                    params![task_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("检查 prompt 活动运行失败：{e}"))?;
            if active.is_some() {
                return Err("Cron task is already running.".to_string());
            }
        }
        Ok((task_workdir(&conn, &task)?, task))
    }
}

fn prompt_run_is_counted(request_json: Option<&str>) -> bool {
    request_json
        .and_then(|raw| serde_json::from_str::<PromptRunRequest>(raw).ok())
        .map(|request| request.counted)
        .unwrap_or(true)
}

fn apply_cron_op(conn: &Connection, op: AutomationOp) -> Result<(), String> {
    match op {
        AutomationOp::Create { item } => {
            let mut item = item;
            ensure_id(&mut item);
            validate::restore_masked_headers(&mut item, None);
            let task = validate::validate_cron_task(item, "cron task")?;
            if db::read_cron_task(conn, &task.id)?.is_some() {
                return Err(format!("cron task 已存在：{}", task.id));
            }
            let sort_index = next_sort_index(conn, "automation_cron_tasks")?;
            db::insert_cron_task(conn, &task, sort_index)?;
        }
        AutomationOp::Update { id, patch } => {
            let stored = db::read_cron_task(conn, id.trim())?
                .ok_or_else(|| format!("cron task 不存在：{id}"))?;
            let mut merged = validate::merge_patch(&stored, patch, "cron task")?;
            validate::restore_masked_headers(&mut merged, stored.requests.as_deref());
            let mut task = validate::validate_cron_task(merged, "cron task")?;
            task.id = stored.id;
            // A successful edit clears the scheduler-reported error; the next
            // reload re-validates and re-reports if it still fails.
            task.last_error = None;
            db::update_cron_task_row(conn, &task)?;
        }
        AutomationOp::Delete { id } => {
            let deleted = conn
                .execute(
                    "DELETE FROM automation_cron_tasks WHERE task_id = ?1",
                    params![id.trim()],
                )
                .map_err(|e| format!("删除 cron task 失败：{e}"))?;
            if deleted == 0 {
                return Err(format!("cron task 不存在：{id}"));
            }
            conn.execute(
                "DELETE FROM automation_cron_runs WHERE task_id = ?1",
                params![id.trim()],
            )
            .map_err(|e| format!("删除 cron task 运行记录失败：{e}"))?;
        }
        AutomationOp::Reorder { ids } => {
            reorder_rows(conn, "automation_cron_tasks", "task_id", &ids)?;
        }
    }
    Ok(())
}

fn apply_hook_op(conn: &Connection, op: AutomationOp) -> Result<(), String> {
    match op {
        AutomationOp::Create { item } => {
            let mut item = item;
            ensure_id(&mut item);
            validate::restore_masked_headers(&mut item, None);
            let hook = validate::validate_hook(item, "hook")?;
            if db::read_hook(conn, &hook.id)?.is_some() {
                return Err(format!("hook 已存在：{}", hook.id));
            }
            let sort_index = next_sort_index(conn, "automation_hooks")?;
            db::insert_hook(conn, &hook, sort_index)?;
        }
        AutomationOp::Update { id, patch } => {
            let stored =
                db::read_hook(conn, id.trim())?.ok_or_else(|| format!("hook 不存在：{id}"))?;
            let mut merged = validate::merge_patch(&stored, patch, "hook")?;
            validate::restore_masked_headers(&mut merged, stored.requests.as_deref());
            let mut hook = validate::validate_hook(merged, "hook")?;
            hook.id = stored.id;
            db::update_hook_row(conn, &hook)?;
        }
        AutomationOp::Delete { id } => {
            let deleted = conn
                .execute(
                    "DELETE FROM automation_hooks WHERE hook_id = ?1",
                    params![id.trim()],
                )
                .map_err(|e| format!("删除 hook 失败：{e}"))?;
            if deleted == 0 {
                return Err(format!("hook 不存在：{id}"));
            }
        }
        AutomationOp::Reorder { ids } => {
            reorder_rows(conn, "automation_hooks", "hook_id", &ids)?;
        }
    }
    Ok(())
}

fn ensure_id(item: &mut Value) {
    let Some(map) = item.as_object_mut() else {
        return;
    };
    let missing = map
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .is_empty();
    if missing {
        map.insert("id".to_string(), Value::String(Uuid::new_v4().to_string()));
    }
}

fn next_sort_index(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COALESCE(MAX(sort_index), -1) + 1 FROM {table}"),
        [],
        |row| row.get(0),
    )
    .map_err(|e| format!("读取 {table} 排序索引失败：{e}"))
}

fn reorder_rows(
    conn: &Connection,
    table: &str,
    id_column: &str,
    ids: &[String],
) -> Result<(), String> {
    let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("读取 {table} 数量失败：{e}"))?;
    if count as usize != ids.len() {
        return Err(format!("reorder 必须包含全部 {count} 个条目"));
    }
    for (index, id) in ids.iter().enumerate() {
        let updated = conn
            .execute(
                &format!("UPDATE {table} SET sort_index = ?1 WHERE {id_column} = ?2"),
                params![index as i64, id.trim()],
            )
            .map_err(|e| format!("更新 {table} 排序失败：{e}"))?;
        if updated == 0 {
            return Err(format!("reorder 引用了不存在的条目：{id}"));
        }
    }
    Ok(())
}

fn insert_finished_run(
    conn: &Connection,
    run: &CompletedRun,
    state: RunState,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO automation_cron_runs
            (execution_id, task_id, state, success, started_at, finished_at,
             duration_ms, exit_code, output)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            Uuid::new_v4().to_string(),
            run.task_id,
            state.as_str(),
            run.success as i64,
            run.started_at,
            db::now_ms(),
            run.duration_ms as i64,
            run.exit_code,
            db::truncate_run_output(&run.output),
        ],
    )
    .map_err(|e| format!("写入 automation_cron_runs 失败：{e}"))?;
    Ok(())
}

fn decrement_remaining(conn: &Connection, task_id: &str) -> Result<CronMutationEffect, String> {
    let row: Option<(Option<i64>, i64)> = conn
        .query_row(
            "SELECT remaining_runs, enabled FROM automation_cron_tasks WHERE task_id = ?1",
            params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取 remaining_runs 失败：{e}"))?;
    let Some((remaining, enabled)) = row else {
        return Ok(CronMutationEffect::None);
    };
    let Some(remaining) = remaining else {
        return Ok(CronMutationEffect::None);
    };

    let next = remaining.saturating_sub(1).max(0);
    let next_enabled = if next == 0 { 0 } else { enabled };
    if next == remaining && next_enabled == enabled {
        return Ok(CronMutationEffect::None);
    }
    conn.execute(
        "UPDATE automation_cron_tasks
         SET remaining_runs = ?2, enabled = ?3, updated_at = ?4
         WHERE task_id = ?1",
        params![task_id, next, next_enabled, db::now_ms()],
    )
    .map_err(|e| format!("更新 remaining_runs 失败：{e}"))?;
    Ok(CronMutationEffect::Changed)
}

/// Single resolution point for a cron task's working directory: the task's
/// pinned workspace path when set, otherwise the global system workdir.
fn task_workdir(conn: &Connection, task: &CronTask) -> Result<String, String> {
    match task.workdir.as_deref().map(str::trim) {
        Some(workdir) if !workdir.is_empty() => Ok(workdir.to_string()),
        _ => read_system_workdir(conn),
    }
}

fn read_system_workdir(conn: &Connection) -> Result<String, String> {
    let has_table: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'system_settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("检查 system_settings 表失败：{e}"))?;
    if has_table.is_none() {
        return Ok(String::new());
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM system_settings WHERE setting_key = 'workdir' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("读取 system_settings.workdir 失败：{e}"))?;
    let Some(raw) = raw else {
        return Ok(String::new());
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::String(value)) => Ok(value.trim().to_string()),
        Ok(Value::Null) | Err(_) => Ok(String::new()),
        Ok(_) => Ok(String::new()),
    }
}
