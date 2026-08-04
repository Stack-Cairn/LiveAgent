//! 后台安装任务：任务注册表、进度快照与 install_start 工作线程。

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use uuid::Uuid;

use super::*;

#[derive(Debug, Clone)]
pub(crate) struct SkillInstallJobState {
    pub(crate) job_id: String,
    pub(crate) phase: String,
    pub(crate) source: String,
    pub(crate) label: Option<String>,
    pub(crate) slug: Option<String>,
    pub(crate) owner_handle: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) message: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) installed: Option<Vec<SystemSkillInstallResult>>,
    pub(crate) started_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) finished_at: Option<u64>,
    /// Cooperative cancellation flag checked by the worker's download and
    /// per-skill install loops; surfaced to clients as `phase: "cancelled"`.
    pub(crate) cancel_requested: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillInstallProgressUpdate {
    pub(crate) phase: &'static str,
    pub(crate) downloaded_bytes: Option<u64>,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) message: Option<String>,
}

static SKILL_INSTALL_JOBS: OnceLock<Mutex<HashMap<String, SkillInstallJobState>>> = OnceLock::new();

pub(crate) fn skill_install_jobs() -> &'static Mutex<HashMap<String, SkillInstallJobState>> {
    SKILL_INSTALL_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn install_job_snapshot(job: &SkillInstallJobState) -> SystemSkillInstallJobSnapshot {
    SystemSkillInstallJobSnapshot {
        job_id: job.job_id.clone(),
        phase: job.phase.clone(),
        source: job.source.clone(),
        label: job.label.clone(),
        slug: job.slug.clone(),
        owner_handle: job.owner_handle.clone(),
        version: job.version.clone(),
        downloaded_bytes: job.downloaded_bytes,
        total_bytes: job.total_bytes,
        message: job.message.clone(),
        error: job.error.clone(),
        installed: job.installed.clone(),
        started_at: job.started_at,
        updated_at: job.updated_at,
        finished_at: job.finished_at,
    }
}

pub(crate) fn prune_old_install_jobs(jobs: &mut HashMap<String, SkillInstallJobState>, now: u64) {
    const RETENTION_MS: u64 = 60 * 60 * 1000;
    jobs.retain(|_, job| {
        job.finished_at
            .map(|finished_at| now.saturating_sub(finished_at) <= RETENTION_MS)
            .unwrap_or(true)
    });
}

pub(crate) fn insert_install_job(
    job: SkillInstallJobState,
) -> Result<SystemSkillInstallJobSnapshot, String> {
    let snapshot = install_job_snapshot(&job);
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    prune_old_install_jobs(&mut jobs, now_millis());
    jobs.insert(job.job_id.clone(), job);
    Ok(snapshot)
}

pub(crate) fn update_install_job<F>(
    job_id: &str,
    updater: F,
) -> Result<SystemSkillInstallJobSnapshot, String>
where
    F: FnOnce(&mut SkillInstallJobState),
{
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    let job = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("Skill install job not found: {job_id}"))?;
    updater(job);
    job.updated_at = now_millis();
    Ok(install_job_snapshot(job))
}

pub(crate) fn get_install_job_snapshot(
    job_id: &str,
) -> Result<SystemSkillInstallJobSnapshot, String> {
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    prune_old_install_jobs(&mut jobs, now_millis());
    let job = jobs
        .get(job_id)
        .ok_or_else(|| format!("Skill install job not found: {job_id}"))?;
    Ok(install_job_snapshot(job))
}

pub(crate) fn cancel_install_job(job_id: &str) -> Result<SystemSkillInstallJobSnapshot, String> {
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    let job = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("Skill install job not found: {job_id}"))?;
    if job.finished_at.is_some() {
        return Err(format!("Skill install job already finished: {job_id}"));
    }
    job.cancel_requested.store(true, Ordering::Relaxed);
    job.message = Some("Cancelling Skill install".to_string());
    job.updated_at = now_millis();
    Ok(install_job_snapshot(job))
}

pub(crate) fn start_install_job_from_payload(
    root: PathBuf,
    payload: &serde_json::Map<String, Value>,
) -> Result<SystemSkillInstallJobSnapshot, String> {
    let source = object_string(payload, "source")
        .ok_or_else(|| "SkillsManager install_start requires source".to_string())?
        .to_string();
    let label = object_string(payload, "label").map(ToOwned::to_owned);
    let slug = object_string(payload, "slug").map(ToOwned::to_owned);
    let owner_handle = object_string(payload, "ownerHandle")
        .or_else(|| object_string(payload, "owner"))
        .map(ToOwned::to_owned);
    let version = object_string(payload, "version").map(ToOwned::to_owned);
    normalize_conflict(object_string(payload, "conflict"), "backup")?;
    normalize_method(object_string(payload, "method"))?;

    let job_id = Uuid::new_v4().to_string();
    let now = now_millis();
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let snapshot = insert_install_job(SkillInstallJobState {
        job_id: job_id.clone(),
        phase: "queued".to_string(),
        source,
        label,
        slug,
        owner_handle,
        version,
        downloaded_bytes: 0,
        total_bytes: None,
        message: Some("Queued Skill install".to_string()),
        error: None,
        installed: None,
        started_at: now,
        updated_at: now,
        finished_at: None,
        cancel_requested: cancel_requested.clone(),
    })?;

    let thread_job_id = job_id.clone();
    let payload = payload.clone();
    thread::spawn(move || {
        let progress_job_id = thread_job_id.clone();
        let should_cancel = || cancel_requested.load(Ordering::Relaxed);
        let result = install_source_from_payload_with_progress(
            &root,
            &payload,
            move |update| {
                let _ = update_install_job(&progress_job_id, |job| {
                    job.phase = update.phase.to_string();
                    if update.phase == "downloading" {
                        job.total_bytes = update.total_bytes;
                    }
                    if let Some(downloaded_bytes) = update.downloaded_bytes {
                        job.downloaded_bytes = downloaded_bytes;
                    }
                    if let Some(message) = update.message {
                        job.message = Some(message);
                    }
                    job.error = None;
                });
            },
            &should_cancel,
        );

        match result {
            Ok(installed) => {
                let _ = update_install_job(&thread_job_id, |job| {
                    job.phase = "done".to_string();
                    job.message = Some("Skill installed".to_string());
                    job.error = None;
                    job.installed = Some(installed);
                    job.finished_at = Some(now_millis());
                });
            }
            Err(error) if error == INSTALL_CANCELLED_ERROR => {
                let _ = update_install_job(&thread_job_id, |job| {
                    job.phase = "cancelled".to_string();
                    job.message = Some("Skill install cancelled".to_string());
                    job.error = None;
                    job.finished_at = Some(now_millis());
                });
            }
            Err(error) => {
                let _ = update_install_job(&thread_job_id, |job| {
                    job.phase = "error".to_string();
                    job.message = Some("Skill install failed".to_string());
                    job.error = Some(error);
                    job.finished_at = Some(now_millis());
                });
            }
        }
    });

    Ok(snapshot)
}
