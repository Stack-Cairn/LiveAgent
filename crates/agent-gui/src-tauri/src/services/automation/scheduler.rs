use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Local;
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio_cron_scheduler::{Job, JobScheduler};
use uuid::Uuid;

use crate::runtime::sandbox;
use crate::runtime::shell_runner::{run_shell_script_with_envs, ShellRunResponse};
use crate::runtime::task_runner::{
    build_http_client, resolve_workdir, run_single_http_request, HttpExecutionFailure,
    HttpExecutionResult, HttpRequestInput,
};

use super::db::now_ms;
use super::store::{AutomationStore, PromptQueueOutcome};
use super::types::{CompletedRun, CronRunNowResponse, CronTask, HttpRequestSpec};

const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct ScheduledJob {
    job_id: Uuid,
    cron: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunTrigger {
    Scheduled,
    Manual,
}

impl RunTrigger {
    fn counted(self) -> bool {
        matches!(self, Self::Scheduled)
    }
}

pub struct AutomationScheduler {
    store: Arc<AutomationStore>,
    scheduler: AsyncMutex<Option<JobScheduler>>,
    jobs: AsyncMutex<HashMap<String, ScheduledJob>>,
    active_runs: Mutex<HashSet<String>>,
    reload_notify: Notify,
    reload_pending: AtomicBool,
}

impl AutomationScheduler {
    pub fn new(store: Arc<AutomationStore>) -> Self {
        Self {
            store,
            scheduler: AsyncMutex::new(None),
            jobs: AsyncMutex::new(HashMap::new()),
            active_runs: Mutex::new(HashSet::new()),
            reload_notify: Notify::new(),
            reload_pending: AtomicBool::new(false),
        }
    }

    pub fn start(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            self.run_loop().await;
        });
    }

    pub fn request_reload(&self) {
        self.reload_pending.store(true, Ordering::SeqCst);
        self.reload_notify.notify_one();
    }

    async fn run_loop(self: Arc<Self>) {
        {
            let store = Arc::clone(&self.store);
            let recovered = tauri::async_runtime::spawn_blocking(move || {
                store.recover_interrupted_prompt_runs()
            })
            .await;
            match recovered {
                Ok(Ok(count)) if count > 0 => {
                    eprintln!("automation: expired {count} prompt run(s) interrupted by restart");
                }
                Ok(Err(error)) => eprintln!("automation prompt run recovery failed: {error}"),
                Err(error) => eprintln!("automation prompt run recovery join failed: {error}"),
                _ => {}
            }
        }

        if let Err(error) = self.ensure_scheduler().await {
            eprintln!("启动 automation scheduler 失败：{error}");
            return;
        }
        self.request_reload();

        let mut sweep = tokio::time::interval(SWEEP_INTERVAL);
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = self.reload_notify.notified() => {
                    while self.reload_pending.swap(false, Ordering::SeqCst) {
                        if let Err(error) = self.reload().await {
                            eprintln!("热重载 automation cron 任务失败：{error}");
                        }
                    }
                }
                _ = sweep.tick() => {
                    let store = Arc::clone(&self.store);
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        store.sweep_expired_prompt_runs()
                    })
                    .await;
                    match result {
                        Ok(Err(error)) => eprintln!("automation prompt sweep failed: {error}"),
                        Err(error) => eprintln!("automation prompt sweep join failed: {error}"),
                        _ => {}
                    }
                }
            }
        }
    }

    async fn ensure_scheduler(&self) -> Result<(), String> {
        let mut guard = self.scheduler.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let scheduler = JobScheduler::new()
            .await
            .map_err(|e| format!("创建 cron scheduler 失败：{e}"))?;
        scheduler
            .start()
            .await
            .map_err(|e| format!("启动 cron scheduler 失败：{e}"))?;
        *guard = Some(scheduler);
        Ok(())
    }

    /// Diff-based reload: only touched tasks are removed/added, and a task
    /// with an unparsable schedule only disables itself (recorded in
    /// `last_error`) instead of freezing the whole scheduler.
    async fn reload(self: &Arc<Self>) -> Result<(), String> {
        self.ensure_scheduler().await?;

        let store = Arc::clone(&self.store);
        let tasks = tauri::async_runtime::spawn_blocking(move || store.runnable_cron_tasks())
            .await
            .map_err(|e| format!("automation reload join 失败：{e}"))??;

        let desired: HashMap<String, CronTask> = tasks
            .into_iter()
            .map(|task| (task.id.clone(), task))
            .collect();

        let mut scheduler_guard = self.scheduler.lock().await;
        let scheduler = scheduler_guard
            .as_mut()
            .ok_or_else(|| "cron scheduler 尚未初始化".to_string())?;
        let mut jobs = self.jobs.lock().await;

        let stale: Vec<String> = jobs
            .iter()
            .filter(|(task_id, scheduled)| {
                desired
                    .get(*task_id)
                    .map(|task| task.cron.trim() != scheduled.cron)
                    .unwrap_or(true)
            })
            .map(|(task_id, _)| task_id.clone())
            .collect();
        for task_id in stale {
            let Some(scheduled) = jobs.get(&task_id).cloned() else {
                continue;
            };
            match scheduler.remove(&scheduled.job_id).await {
                Ok(()) => {
                    jobs.remove(&task_id);
                }
                Err(error) => {
                    // Keep the map entry so the next reload retries the
                    // removal — dropping it here would orphan a live job.
                    eprintln!("移除 cron 任务失败：{task_id} ({error})");
                }
            }
        }

        for (task_id, task) in &desired {
            if jobs.contains_key(task_id) {
                continue;
            }
            let cron_expr = task.cron.trim().to_string();
            let job = {
                let manager = Arc::clone(self);
                let task_id = task_id.clone();
                // Only the id is captured: the task itself (and its workdir)
                // is re-read from the store at fire time, so edits that keep
                // the cron expression apply to the next fire without a job
                // rebuild.
                Job::new_async_tz(cron_expr.as_str(), Local, move |_job_id, _lock| {
                    let manager = Arc::clone(&manager);
                    let task_id = task_id.clone();
                    Box::pin(async move {
                        manager.fire(task_id).await;
                    })
                })
            };
            match job {
                Ok(job) => {
                    let job_id = job.guid();
                    match scheduler.add(job).await {
                        Ok(_) => {
                            jobs.insert(
                                task_id.clone(),
                                ScheduledJob {
                                    job_id,
                                    cron: cron_expr,
                                },
                            );
                            self.report_task_error(task_id, None);
                        }
                        Err(error) => {
                            self.report_task_error(
                                task_id,
                                Some(format!("注册 Cron 任务失败：{error}")),
                            );
                        }
                    }
                }
                Err(error) => {
                    self.report_task_error(task_id, Some(format!("无效 Cron 表达式：{error}")));
                }
            }
        }

        Ok(())
    }

    fn report_task_error(self: &Arc<Self>, task_id: &str, error: Option<String>) {
        let store = Arc::clone(&self.store);
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || {
                store.set_task_error(&task_id, error.as_deref())
            })
            .await;
            match result {
                Ok(Err(error)) => eprintln!("记录 cron 任务错误失败：{error}"),
                Err(error) => eprintln!("记录 cron 任务错误 join 失败：{error}"),
                _ => {}
            }
        });
    }

    async fn fire(self: &Arc<Self>, task_id: String) {
        let fresh = {
            let store = Arc::clone(&self.store);
            let task_id = task_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                store.cron_task_for_scheduled_fire(&task_id)
            })
            .await
        };
        match fresh {
            Ok(Ok(Some((workdir, task)))) => {
                if !self.start_fire(task.clone(), workdir, RunTrigger::Scheduled) {
                    self.record_run_detached(skipped_run(&task.id));
                }
            }
            // Task deleted since the job was registered; the next reload
            // drops the job.
            Ok(Ok(None)) => {}
            Ok(Err(error)) => {
                self.record_run_detached(failed_run(
                    &task_id,
                    format!("Cron task fire read failed: {error}"),
                    false,
                ));
            }
            Err(error) => {
                self.record_run_detached(failed_run(
                    &task_id,
                    format!("Cron task fire read join failed: {error}"),
                    false,
                ));
            }
        }
    }

    pub fn run_now(self: &Arc<Self>, task_id: &str) -> Result<CronRunNowResponse, String> {
        let (workdir, task) = self.store.cron_task_for_manual_run(task_id)?;
        let started_at = now_ms();
        if !self.start_fire(task, workdir, RunTrigger::Manual) {
            return Err("Cron task is already running.".to_string());
        }
        Ok(CronRunNowResponse { started_at })
    }

    fn start_fire(self: &Arc<Self>, task: CronTask, workdir: String, trigger: RunTrigger) -> bool {
        {
            let mut active = match self.active_runs.lock() {
                Ok(guard) => guard,
                Err(_) => return false,
            };
            if !active.insert(task.id.clone()) {
                return false;
            }
        }

        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            manager.execute_fire(task, workdir, trigger).await;
        });
        true
    }

    async fn execute_fire(self: Arc<Self>, task: CronTask, workdir: String, trigger: RunTrigger) {
        let task_id = task.id.clone();

        if trigger == RunTrigger::Scheduled {
            let can_run = {
                let store = Arc::clone(&self.store);
                let task_id = task_id.clone();
                tauri::async_runtime::spawn_blocking(move || store.task_can_run(&task_id)).await
            };
            match can_run {
                Ok(Ok(true)) => {}
                Ok(Ok(false)) => {
                    self.clear_active(&task_id);
                    return;
                }
                Ok(Err(error)) => {
                    self.record_run_detached(failed_run(
                        &task_id,
                        format!("Cron task state check failed: {error}"),
                        false,
                    ));
                    self.clear_active(&task_id);
                    return;
                }
                Err(error) => {
                    self.record_run_detached(failed_run(
                        &task_id,
                        format!("Cron task state check join failed: {error}"),
                        false,
                    ));
                    self.clear_active(&task_id);
                    return;
                }
            }
        }

        // A pinned workspace must exist before any execution; a vanished pin
        // fails this run and disables the task so it stops re-firing into a
        // directory that no longer exists. Follow-global tasks keep the
        // legacy behavior (bash/prompt fail the run without disabling).
        let workdir = match task.workdir.as_deref().map(str::trim) {
            Some(pin) if !pin.is_empty() => match resolve_workdir(Some(pin.to_string())) {
                Ok(resolved) => resolved.display().to_string(),
                Err(error) => {
                    let message = format!("Cron task workspace is unavailable ({pin}): {error}");
                    self.record_run_detached(failed_run(
                        &task_id,
                        message.clone(),
                        trigger.counted(),
                    ));
                    self.disable_task_detached(&task_id, message);
                    self.clear_active(&task_id);
                    return;
                }
            },
            _ => workdir,
        };

        if task.kind == "prompt" {
            let store = Arc::clone(&self.store);
            let queue_task = task.clone();
            let queue_workdir = workdir.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                store.queue_prompt_run(&queue_task, &queue_workdir, trigger.counted())
            })
            .await;
            match result {
                Ok(Ok(PromptQueueOutcome::Queued)) => {}
                Ok(Ok(PromptQueueOutcome::SkippedActiveRun)) => {
                    self.record_run_detached(skipped_run(&task_id));
                }
                Ok(Err(error)) => {
                    self.record_run_detached(failed_run(&task_id, error, trigger.counted()));
                }
                Err(error) => {
                    self.record_run_detached(failed_run(
                        &task_id,
                        format!("Cron prompt queue join failed: {error}"),
                        false,
                    ));
                }
            }
            // The prompt run row owns the task's activity from here on.
            self.clear_active(&task_id);
            return;
        }

        let run = tauri::async_runtime::spawn_blocking(move || {
            let mut run = execute_blocking(task, workdir);
            run.counted = trigger.counted();
            run
        })
        .await
        .unwrap_or_else(|error| {
            failed_run(
                &task_id,
                format!("Cron task execution join failed: {error}"),
                false,
            )
        });
        self.record_run_detached(run);
        self.clear_active(&task_id);
    }

    fn clear_active(&self, task_id: &str) {
        if let Ok(mut active) = self.active_runs.lock() {
            active.remove(task_id);
        }
    }

    fn disable_task_detached(&self, task_id: &str, error: String) {
        let store = Arc::clone(&self.store);
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || {
                store.disable_task_with_error(&task_id, &error)
            })
            .await;
            match result {
                Ok(Err(error)) => eprintln!("禁用 cron 任务失败：{error}"),
                Err(error) => eprintln!("禁用 cron 任务 join 失败：{error}"),
                _ => {}
            }
        });
    }

    fn record_run_detached(&self, run: CompletedRun) {
        let store = Arc::clone(&self.store);
        tauri::async_runtime::spawn(async move {
            let result =
                tauri::async_runtime::spawn_blocking(move || store.record_completed_run(run)).await;
            match result {
                Ok(Err(error)) => eprintln!("Cron run 记录失败：{error}"),
                Err(error) => eprintln!("Cron run 记录 join 失败：{error}"),
                _ => {}
            }
        });
    }
}

fn skipped_run(task_id: &str) -> CompletedRun {
    CompletedRun {
        task_id: task_id.to_string(),
        success: false,
        started_at: now_ms(),
        duration_ms: 0,
        exit_code: None,
        output: "Skipped: previous run is still in progress.".to_string(),
        counted: false,
    }
}

fn failed_run(task_id: &str, message: String, counted: bool) -> CompletedRun {
    CompletedRun {
        task_id: task_id.to_string(),
        success: false,
        started_at: now_ms(),
        duration_ms: 0,
        exit_code: None,
        output: message,
        counted,
    }
}

fn execute_blocking(task: CronTask, workdir: String) -> CompletedRun {
    match task.kind.as_str() {
        "bash" => execute_bash(&task, workdir),
        "http" => execute_http(&task),
        other => failed_run(
            &task.id,
            format!("Unsupported cron task kind: {other}"),
            false,
        ),
    }
}

fn execute_bash(task: &CronTask, workdir: String) -> CompletedRun {
    let started_at = now_ms();
    let overall = Instant::now();
    let script = task
        .script
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if script.is_empty() {
        return failed_run(
            &task.id,
            "No Bash script configured for this Cron task.".to_string(),
            true,
        );
    }
    if workdir.trim().is_empty() {
        return failed_run(
            &task.id,
            "Cron bash task requires a project workdir (System -> Workdir).".to_string(),
            true,
        );
    }
    let cwd = match resolve_workdir(Some(workdir)) {
        Ok(cwd) => cwd,
        Err(error) => return failed_run(&task.id, error, true),
    };
    // P1#2:Cron bash 脚本此前恒以 sandbox_options=None 执行,于是"模型建一个 bash
    // 任务 → 调度器无沙箱触发"成为绕过沙箱围栏的持久化通道(还能跨应用重启存活)。
    // 现在与 Bash / ManagedProcess 共用同一个后端下限:回查持久化的
    // commandSafetyMode,读不出来则直接失败,绝不无沙箱执行。
    let sandbox_options = match sandbox::resolve_effective_options(None) {
        Ok(options) => options,
        Err(error) => return failed_run(&task.id, error, true),
    };
    let result = match run_shell_script_with_envs(
        cwd.display().to_string(),
        script.clone(),
        None,
        Some(task.timeout_seconds.saturating_mul(1_000)),
        None,
        None,
        None,
        &[],
        sandbox_options,
    ) {
        Ok(result) => result,
        Err(error) => return failed_run(&task.id, error, true),
    };

    CompletedRun {
        task_id: task.id.clone(),
        success: result.exit_code == 0 && !result.timed_out,
        started_at,
        duration_ms: overall.elapsed().as_millis() as u64,
        exit_code: Some(result.exit_code),
        output: format_shell_result(&script, &result),
        counted: true,
    }
}

fn execute_http(task: &CronTask) -> CompletedRun {
    let started_at = now_ms();
    let overall = Instant::now();
    let requests = task.requests.clone().unwrap_or_default();
    if requests.is_empty() {
        return failed_run(
            &task.id,
            "No HTTP requests configured for this Cron task.".to_string(),
            true,
        );
    }
    let client = match build_http_client(Some(task.timeout_seconds.saturating_mul(1_000))) {
        Ok(client) => client,
        Err(error) => return failed_run(&task.id, error, true),
    };

    let mut sections = Vec::new();
    let mut success = true;
    for (index, request) in requests.into_iter().enumerate() {
        let display = format!(
            "{} {}",
            request.method.trim().to_uppercase(),
            request.url.trim()
        );
        match run_single_http_request(&client, to_http_input(request)) {
            Ok(result) => sections.push(format_http_result(index + 1, &display, &result)),
            Err(error) => {
                success = false;
                sections.push(format_http_failure(index + 1, &display, &error));
            }
        }
    }

    CompletedRun {
        task_id: task.id.clone(),
        success,
        started_at,
        duration_ms: overall.elapsed().as_millis() as u64,
        exit_code: None,
        output: sections.join("\n\n"),
        counted: true,
    }
}

pub fn to_http_input(request: HttpRequestSpec) -> HttpRequestInput {
    HttpRequestInput {
        id: request.id,
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
    }
}

fn format_shell_result(script: &str, result: &ShellRunResponse) -> String {
    let mut lines = vec![
        format!("shell={}", result.shell),
        format!("exit={}", result.exit_code),
        format!("timed_out={}", result.timed_out),
        format!("duration={}ms", result.duration_ms),
        "script:".to_string(),
        script.to_string(),
    ];
    if !result.stdout.trim().is_empty() {
        lines.push("stdout:".to_string());
        lines.push(result.stdout.trim().to_string());
    }
    if !result.stderr.trim().is_empty() {
        lines.push("stderr:".to_string());
        lines.push(result.stderr.trim().to_string());
    }
    if result.stdout_truncated {
        lines.push("stdout_truncated=true".to_string());
    }
    if result.stderr_truncated {
        lines.push("stderr_truncated=true".to_string());
    }
    lines.join("\n")
}

fn format_http_result(index: usize, display: &str, result: &HttpExecutionResult) -> String {
    let mut lines = vec![
        format!("Request {index}: {display}"),
        format!("status={}", result.status),
        format!("duration={}ms", result.duration_ms),
    ];
    if !result.response_body.trim().is_empty() {
        lines.push("response:".to_string());
        lines.push(result.response_body.trim().to_string());
    }
    lines.join("\n")
}

fn format_http_failure(index: usize, display: &str, error: &HttpExecutionFailure) -> String {
    [
        format!("Request {index}: {display}"),
        "status=failed".to_string(),
        format!("duration={}ms", error.duration_ms),
        error.to_string(),
    ]
    .join("\n")
}
