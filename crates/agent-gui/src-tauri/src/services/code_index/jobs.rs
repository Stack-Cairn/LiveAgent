//! 后台索引 job：skills/jobs.rs 同款——进程级注册表、进度快照、
//! `AtomicBool` 协作式取消、完成后保留 1 小时、前端轮询。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use uuid::Uuid;

use super::now_ms;
use super::types::CodeIndexJobSnapshot;

pub(crate) const INDEX_CANCELLED_ERROR: &str = "__CODE_INDEX_CANCELLED__";

#[derive(Debug, Clone)]
pub(crate) struct CodeIndexJobState {
    pub(crate) job_id: String,
    pub(crate) workdir: String,
    pub(crate) phase: String,
    pub(crate) total_files: u64,
    pub(crate) processed_files: u64,
    pub(crate) indexed_chunks: u64,
    pub(crate) message: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) started_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) finished_at: Option<i64>,
    pub(crate) cancel_requested: Arc<AtomicBool>,
}

static CODE_INDEX_JOBS: OnceLock<Mutex<HashMap<String, CodeIndexJobState>>> = OnceLock::new();

fn code_index_jobs() -> &'static Mutex<HashMap<String, CodeIndexJobState>> {
    CODE_INDEX_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn job_snapshot(job: &CodeIndexJobState) -> CodeIndexJobSnapshot {
    CodeIndexJobSnapshot {
        job_id: job.job_id.clone(),
        workdir: job.workdir.clone(),
        phase: job.phase.clone(),
        total_files: job.total_files,
        processed_files: job.processed_files,
        indexed_chunks: job.indexed_chunks,
        message: job.message.clone(),
        error: job.error.clone(),
        started_at: job.started_at,
        updated_at: job.updated_at,
        finished_at: job.finished_at,
    }
}

fn prune_old_jobs(jobs: &mut HashMap<String, CodeIndexJobState>, now: i64) {
    const RETENTION_MS: i64 = 60 * 60 * 1000;
    jobs.retain(|_, job| {
        job.finished_at
            .map(|finished_at| now.saturating_sub(finished_at) <= RETENTION_MS)
            .unwrap_or(true)
    });
}

/// 同一 workdir 最多一个进行中的 job（enable/rebuild/watch 增量互斥）。
pub(crate) fn active_job_for_workdir(workdir: &str) -> Option<CodeIndexJobSnapshot> {
    let jobs = code_index_jobs().lock().ok()?;
    jobs.values()
        .find(|job| job.workdir == workdir && job.finished_at.is_none())
        .map(job_snapshot)
}

pub(crate) fn insert_job(workdir: &str) -> Result<(CodeIndexJobSnapshot, Arc<AtomicBool>), String> {
    let mut jobs = code_index_jobs()
        .lock()
        .map_err(|_| "代码索引任务表锁被污染".to_string())?;
    let now = now_ms();
    prune_old_jobs(&mut jobs, now);
    if let Some(active) = jobs
        .values()
        .find(|job| job.workdir == workdir && job.finished_at.is_none())
    {
        return Err(format!(
            "该工作区已有进行中的索引任务：{}（phase: {}）",
            active.job_id, active.phase
        ));
    }
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let job = CodeIndexJobState {
        job_id: Uuid::new_v4().to_string(),
        workdir: workdir.to_string(),
        phase: "queued".to_string(),
        total_files: 0,
        processed_files: 0,
        indexed_chunks: 0,
        message: Some("Queued code indexing".to_string()),
        error: None,
        started_at: now,
        updated_at: now,
        finished_at: None,
        cancel_requested: cancel_requested.clone(),
    };
    let snapshot = job_snapshot(&job);
    jobs.insert(job.job_id.clone(), job);
    Ok((snapshot, cancel_requested))
}

pub(crate) fn update_job<F>(job_id: &str, updater: F) -> Result<CodeIndexJobSnapshot, String>
where
    F: FnOnce(&mut CodeIndexJobState),
{
    let mut jobs = code_index_jobs()
        .lock()
        .map_err(|_| "代码索引任务表锁被污染".to_string())?;
    let job = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("代码索引任务不存在：{job_id}"))?;
    updater(job);
    job.updated_at = now_ms();
    Ok(job_snapshot(job))
}

pub(crate) fn get_job_snapshot(job_id: &str) -> Result<CodeIndexJobSnapshot, String> {
    let mut jobs = code_index_jobs()
        .lock()
        .map_err(|_| "代码索引任务表锁被污染".to_string())?;
    prune_old_jobs(&mut jobs, now_ms());
    let job = jobs
        .get(job_id)
        .ok_or_else(|| format!("代码索引任务不存在：{job_id}"))?;
    Ok(job_snapshot(job))
}

pub(crate) fn cancel_job(job_id: &str) -> Result<CodeIndexJobSnapshot, String> {
    let mut jobs = code_index_jobs()
        .lock()
        .map_err(|_| "代码索引任务表锁被污染".to_string())?;
    let job = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("代码索引任务不存在：{job_id}"))?;
    if job.finished_at.is_some() {
        return Err(format!("代码索引任务已结束：{job_id}"));
    }
    job.cancel_requested.store(true, Ordering::Relaxed);
    job.message = Some("Cancelling code indexing".to_string());
    job.updated_at = now_ms();
    Ok(job_snapshot(job))
}

/// 收尾三态：done / cancelled / error。worker 统一从这里落终态。
pub(crate) fn finish_job(job_id: &str, result: Result<(), String>) {
    let _ = update_job(job_id, |job| {
        job.finished_at = Some(now_ms());
        match &result {
            Ok(()) => {
                job.phase = "done".to_string();
                job.message = Some("Code index up to date".to_string());
                job.error = None;
            }
            Err(error) if error == INDEX_CANCELLED_ERROR => {
                job.phase = "cancelled".to_string();
                job.message = Some("Code indexing cancelled".to_string());
                job.error = None;
            }
            Err(error) => {
                job.phase = "error".to_string();
                job.message = Some("Code indexing failed".to_string());
                job.error = Some(error.clone());
            }
        }
    });
}
