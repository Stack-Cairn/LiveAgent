//! 日程页「定时任务」只读图层的数据源:在全局默认时区下展开 cron 任务的未来
//! 触发时间,并合并过去时段的真实运行记录。高频任务按(任务, 本地日期)汇总,
//! 避免一次返回成千上万条明细。

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use croner::{Cron, Direction};
use serde::{Deserialize, Serialize};

use super::types::{CronRunRecord, CronTask, RunState};
use super::validate::parse_cron;

/// 单个任务单日「计划 + 运行」超过该值时只返回当日汇总。
pub const AGGREGATE_THRESHOLD_PER_DAY: u32 = 8;
/// 单次查询允许的最大时间跨度(93 天,覆盖月视图前后补齐的整周)。
pub const MAX_RANGE_MS: i64 = 93 * 24 * 60 * 60 * 1000;
/// 单个任务单日最多展开的计划次数;超出时汇总标记为截断(前端显示「+」)。
pub const MAX_OCCURRENCES_PER_DAY: u32 = 1440;
/// 一次查询最多读取的运行记录条数。
pub const MAX_RUNS: usize = 2000;
/// 运行输出预览的最大字符数。
const OUTPUT_PREVIEW_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CronOccurrenceQuery {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronOccurrence {
    pub task_id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronOccurrencesResponse {
    pub time_zone: String,
    pub now: i64,
    pub tasks: Vec<CronOccurrenceTask>,
    pub occurrences: Vec<CronOccurrence>,
    pub runs: Vec<CronRunSummary>,
    pub summaries: Vec<CronDaySummary>,
}

pub fn validate_range(query: &CronOccurrenceQuery) -> Result<(), String> {
    if query.to <= query.from || query.to - query.from > MAX_RANGE_MS {
        return Err("E:cron_range".into());
    }
    Ok(())
}

fn task_visible(task: &CronTask) -> bool {
    task.enabled && task.remaining_executions != Some(0)
}

fn run_failed(run: &CronRunRecord) -> bool {
    run.state == RunState::Expired || (run.state == RunState::Done && !run.success)
}

fn run_completed(run: &CronRunRecord) -> bool {
    matches!(run.state, RunState::Done | RunState::Expired)
}

fn summarize_run(run: &CronRunRecord) -> CronRunSummary {
    CronRunSummary {
        id: run.id.clone(),
        task_id: run.task_id.clone(),
        started_at: run.started_at,
        finished_at: run.finished_at,
        state: run.state,
        success: run.success,
        duration_ms: run.duration_ms,
        exit_code: run.exit_code,
        output_preview: run.output.chars().take(OUTPUT_PREVIEW_CHARS).collect(),
    }
}

fn at(tz: &Tz, ms: i64) -> DateTime<Tz> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(tz)
}

fn local_date(tz: &Tz, ms: i64) -> NaiveDate {
    at(tz, ms).date_naive()
}

/// 本地日期的起点;午夜因夏令时缺失时取当天第一个有效分钟。
fn day_start_ms(tz: &Tz, day: NaiveDate) -> i64 {
    let midnight = day.and_hms_opt(0, 0, 0).expect("valid midnight");
    for minute in 0..180 {
        if let Some(time) = tz
            .from_local_datetime(&(midnight + Duration::minutes(minute)))
            .earliest()
        {
            return time.timestamp_millis();
        }
    }
    Utc.from_utc_datetime(&midnight).timestamp_millis()
}

#[derive(Default)]
struct Bucket {
    occurrences: Vec<i64>,
    planned_truncated: bool,
    runs: Vec<CronRunSummary>,
    failed: u32,
}

/// 在 `[start, to)` 内按本地日期展开一个任务的计划触发时间。
fn expand_task(
    cron: &Cron,
    tz: &Tz,
    start: i64,
    to: i64,
    mut budget: u64,
    mut emit: impl FnMut(NaiveDate, Vec<i64>, bool),
) {
    // croner 以秒为粒度:把游标上取整到整秒,避免返回早于起点的时间。
    let mut cursor = start.div_euclid(1000) * 1000 + if start % 1000 == 0 { 0 } else { 1000 };
    while budget > 0 && cursor < to {
        let Ok(next) = cron.find_next_occurrence(&at(tz, cursor), true) else {
            break;
        };
        let next_ms = next.timestamp_millis();
        if next_ms >= to {
            break;
        }
        let day = next.date_naive();
        let day_end = day
            .succ_opt()
            .map(|next_day| day_start_ms(tz, next_day))
            .unwrap_or(i64::MAX)
            .min(to);
        let mut items = Vec::new();
        let mut truncated = false;
        for time in cron.iter_from(next, Direction::Forward) {
            let ms = time.timestamp_millis();
            if ms >= day_end || budget == 0 {
                break;
            }
            if items.len() as u32 >= MAX_OCCURRENCES_PER_DAY {
                truncated = true;
                break;
            }
            items.push(ms);
            budget -= 1;
        }
        emit(day, items, truncated);
        if day_end <= cursor {
            break;
        }
        cursor = day_end;
    }
}

/// 纯函数:由任务、运行记录、查询范围、时区与当前时间计算图层数据。
///
/// - `runs_in_range`:`started_at ∈ [from, min(to, now))` 的运行记录;
/// - `recent_runs`:各任务最近的运行记录,仅用于求 `lastRun`。
pub fn compute(
    tasks: &[CronTask],
    runs_in_range: &[CronRunRecord],
    recent_runs: &[CronRunRecord],
    query: CronOccurrenceQuery,
    tz: Tz,
    now: i64,
) -> Result<CronOccurrencesResponse, String> {
    validate_range(&query)?;
    let visible: Vec<&CronTask> = tasks.iter().filter(|task| task_visible(task)).collect();
    let visible_ids: HashMap<&str, ()> =
        visible.iter().map(|task| (task.id.as_str(), ())).collect();

    let mut buckets: BTreeMap<(String, NaiveDate), Bucket> = BTreeMap::new();

    // 未来的计划触发。
    let future_from = query.from.max(now);
    if future_from < query.to {
        for task in &visible {
            let Ok(cron) = parse_cron(&task.cron) else {
                continue;
            };
            let budget = task.remaining_executions.unwrap_or(u64::MAX);
            expand_task(
                &cron,
                &tz,
                future_from,
                query.to,
                budget,
                |day, items, truncated| {
                    let bucket = buckets.entry((task.id.clone(), day)).or_default();
                    bucket.occurrences.extend(items);
                    bucket.planned_truncated |= truncated;
                },
            );
        }
    }

    // 过去时段的真实运行记录。
    let run_to = query.to.min(now);
    for run in runs_in_range {
        if run.started_at < query.from
            || run.started_at >= run_to
            || !visible_ids.contains_key(run.task_id.as_str())
        {
            continue;
        }
        let bucket = buckets
            .entry((run.task_id.clone(), local_date(&tz, run.started_at)))
            .or_default();
        if run_failed(run) {
            bucket.failed += 1;
        }
        bucket.runs.push(summarize_run(run));
    }

    let mut occurrences = Vec::new();
    let mut runs = Vec::new();
    let mut summaries = Vec::new();
    for ((task_id, day), bucket) in buckets {
        let planned = bucket.occurrences.len() as u32;
        let ran = bucket.runs.len() as u32;
        if planned == 0 && ran == 0 {
            continue;
        }
        if planned + ran > AGGREGATE_THRESHOLD_PER_DAY || bucket.planned_truncated {
            let times = bucket
                .occurrences
                .iter()
                .copied()
                .chain(bucket.runs.iter().map(|run| run.started_at));
            let first_at = times.clone().min().unwrap_or_default();
            let last_at = times.max().unwrap_or_default();
            summaries.push(CronDaySummary {
                task_id,
                date: day.format("%Y-%m-%d").to_string(),
                planned,
                planned_truncated: bucket.planned_truncated,
                ran,
                failed: bucket.failed,
                first_at,
                last_at,
            });
            continue;
        }
        occurrences.extend(bucket.occurrences.into_iter().map(|at| CronOccurrence {
            task_id: task_id.clone(),
            at,
        }));
        runs.extend(bucket.runs);
    }
    occurrences.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.task_id.cmp(&b.task_id)));
    runs.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    summaries.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then_with(|| a.first_at.cmp(&b.first_at))
            .then_with(|| a.task_id.cmp(&b.task_id))
    });

    let mut last_runs: HashMap<&str, &CronRunRecord> = HashMap::new();
    for run in recent_runs.iter().chain(runs_in_range.iter()) {
        if !run_completed(run) || run.started_at > now {
            continue;
        }
        let entry = last_runs.entry(run.task_id.as_str()).or_insert(run);
        if (run.started_at, run.id.as_str()) > (entry.started_at, entry.id.as_str()) {
            *entry = run;
        }
    }

    let tasks = visible
        .iter()
        .map(|task| CronOccurrenceTask {
            id: task.id.clone(),
            name: task.name.clone(),
            cron: task.cron.trim().to_string(),
            kind: task.kind.clone(),
            remaining_executions: task.remaining_executions,
            last_run: last_runs
                .get(task.id.as_str())
                .map(|run| summarize_run(run)),
        })
        .collect();

    Ok(CronOccurrencesResponse {
        time_zone: tz.name().to_string(),
        now,
        tasks,
        occurrences,
        runs,
        summaries,
    })
}
