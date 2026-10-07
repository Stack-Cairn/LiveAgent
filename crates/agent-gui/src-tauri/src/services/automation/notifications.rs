//! 定时任务运行结束 → 桌面系统通知。失败与超时归入「定时任务失败」（默认开），
//! 成功归入「定时任务成功」（默认关），跳过不通知。同一任务同一结果 5 分钟内只弹一次，
//! 避免每分钟执行的任务刷屏。

use std::sync::Arc;

use tauri::Manager;

use crate::services::notifications::{Notice, NotificationKind, NotificationService};

pub const RUN_NOTICE_MIN_INTERVAL_MS: i64 = 5 * 60_000;
const OUTPUT_EXCERPT_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFinished {
    pub task_id: String,
    pub task_name: String,
    pub success: bool,
    /// 输出摘要（失败原因 / 超时说明）。
    pub excerpt: String,
}

/// 运行输出的摘要：优先 stderr / stdout 段落的首行（bash 输出以元信息开头），
/// 否则取首个非空行；最多 200 字符。
pub fn output_excerpt(output: &str) -> String {
    let lines: Vec<&str> = output.lines().map(str::trim).collect();
    let after_marker = |marker: &str| {
        lines
            .iter()
            .position(|line| *line == marker)
            .and_then(|index| lines[index + 1..].iter().find(|line| !line.is_empty()))
            .copied()
    };
    after_marker("stderr:")
        .or_else(|| after_marker("stdout:"))
        .or_else(|| lines.iter().find(|line| !line.is_empty()).copied())
        .unwrap_or_default()
        .chars()
        .take(OUTPUT_EXCERPT_MAX_CHARS)
        .collect()
}

pub fn build_notice(run: &RunFinished, service: &NotificationService) -> Notice {
    let name = [("name", run.task_name.as_str())];
    let (kind, title) = if run.success {
        (
            NotificationKind::CronSuccess,
            service.label("cronSuccessTitle", "Scheduled task finished: {name}", &name),
        )
    } else {
        (
            NotificationKind::CronFailure,
            service.label("cronFailureTitle", "Scheduled task failed: {name}", &name),
        )
    };
    Notice::new(kind, title, run.excerpt.clone()).throttled(
        format!("cron:{}:{}", run.task_id, run.success),
        RUN_NOTICE_MIN_INTERVAL_MS,
    )
}

pub fn notify_run_finished(app: &tauri::AppHandle, run: &RunFinished) {
    let Some(service) = app.try_state::<Arc<NotificationService>>() else {
        return;
    };
    if let Err(error) = service.notify(build_notice(run, &service)) {
        eprintln!("cron run notification failed: {error}");
    }
}
