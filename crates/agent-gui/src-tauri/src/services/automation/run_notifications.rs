//! System notifications for finished cron runs.
//!
//! Cron tasks run inside K-Brain, which has no "run finished" event yet, so the
//! desktop polls each task's recent runs and notifies the ones that finished
//! since it started watching. Only an already running K-Brain is queried: a
//! timer must never launch the backend (e.g. while the app is exiting).
//!
//! Not notified: runs finished before the app started or while the switch was
//! off, manual "run now" executions and skipped overlaps (`counted == false`),
//! and cancelled runs. The same task + outcome notifies at most once per
//! [`THROTTLE_MS`]; a failed delivery is retried a few times and does not use
//! up the throttle.
//!
//! K-Brain lists a task's runs newest first, with no "since" filter. A busy
//! task (many runs or skipped overlaps per poll) can push a just-finished run
//! out of the small default window, so a window only counts when it reaches
//! back to the newest run the previous poll saw and still holds every run seen
//! in progress; otherwise the task is re-queried with wider windows. A task is
//! read in full the first time and after watching pauses.

use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};
use crate::services::notification_prefs::{self, Category, NotificationLabels};
use crate::services::planning::notification;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

const POLL_INTERVAL: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RUNS_WINDOW: usize = 5;
/// K-Brain keeps at most 200 runs, so this window holds every remaining one.
const RUNS_FULL_WINDOW: usize = 200;
/// Windows tried in turn until one reaches back to what the last poll saw.
const RUNS_WINDOWS: [usize; 4] = [RUNS_WINDOW, 25, 100, RUNS_FULL_WINDOW];
const THROTTLE_MS: i64 = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS: u32 = 3;
const BODY_MAX_CHARS: usize = 200;

#[derive(Debug, Deserialize)]
struct CronTaskRef {
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct CronSnapshotRef {
    #[serde(default)]
    tasks: Vec<CronTaskRef>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CronRunRef {
    pub id: String,
    pub task_id: String,
    pub state: String,
    pub success: bool,
    pub counted: bool,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub output: String,
    pub termination_reason: String,
}

#[derive(Debug, Deserialize)]
struct RunsResponse {
    #[serde(default)]
    runs: Vec<CronRunRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RunOutcome {
    Succeeded,
    Failed,
    TimedOut,
}

fn is_finished(run: &CronRunRef) -> bool {
    run.state == "done" || run.state == "expired"
}

/// The outcome to notify for a run, or `None` when it must stay silent.
pub fn classify(run: &CronRunRef) -> Option<RunOutcome> {
    if !is_finished(run) || !run.counted || run.termination_reason == "cancelled" {
        return None;
    }
    // `expired` without a reason is a run interrupted by a backend restart.
    if run.termination_reason == "timeout" {
        return Some(RunOutcome::TimedOut);
    }
    Some(if run.success && run.state == "done" {
        RunOutcome::Succeeded
    } else {
        RunOutcome::Failed
    })
}

fn finished_at(run: &CronRunRef) -> i64 {
    run.finished_at.unwrap_or(run.started_at)
}

/// A notification waiting to be (re)delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub run: CronRunRef,
    pub outcome: RunOutcome,
    pub attempts: u32,
}

/// Which runs are new since the watcher started, with per-task throttling.
#[derive(Debug)]
pub struct RunWatcher {
    /// Runs finished at or before this instant are history, never notified.
    floor: i64,
    /// Per task: latest finish time handled and the run ids handled at it.
    handled: HashMap<String, (i64, Vec<String>)>,
    /// Per task: counted runs seen in progress and not yet seen finished.
    in_flight: HashMap<String, HashSet<String>>,
    /// Tasks whose full run list was read since watching (re)started. Until
    /// then a long run may already sit outside the small window unseen.
    scanned: HashSet<String>,
    /// Per task: the newest run id of the previous query.
    newest_seen: HashMap<String, String>,
    last_sent: HashMap<(String, RunOutcome), i64>,
    retry: Vec<Candidate>,
}

impl RunWatcher {
    pub fn new(now: i64) -> Self {
        Self {
            floor: now,
            handled: HashMap::new(),
            in_flight: HashMap::new(),
            scanned: HashSet::new(),
            newest_seen: HashMap::new(),
            last_sent: HashMap::new(),
            retry: Vec::new(),
        }
    }

    /// The window to query a task with first: in full until it was scanned.
    pub fn first_window(&self, task_id: &str) -> usize {
        if self.scanned.contains(task_id) {
            RUNS_WINDOW
        } else {
            RUNS_FULL_WINDOW
        }
    }

    /// Whether `runs`, queried with `limit`, covers everything since the last
    /// poll: it is the whole list, or it reaches back to the newest run seen
    /// last time and still holds every run seen in progress.
    pub fn window_is_enough(&self, task_id: &str, runs: &[CronRunRef], limit: usize) -> bool {
        if limit >= RUNS_FULL_WINDOW || runs.len() < limit {
            return true;
        }
        if !self.scanned.contains(task_id) {
            return false;
        }
        let holds = |id: &String| runs.iter().any(|run| &run.id == id);
        self.newest_seen.get(task_id).is_some_and(holds)
            && self
                .in_flight
                .get(task_id)
                .is_none_or(|ids| ids.iter().all(holds))
    }

    /// Records a full run list: forgets in-progress runs absent even from it
    /// (cleared or pruned), so they stop forcing wide queries.
    pub fn mark_scanned(&mut self, task_id: &str, runs: &[CronRunRef]) {
        self.scanned.insert(task_id.to_string());
        if let Some(ids) = self.in_flight.get_mut(task_id) {
            ids.retain(|id| runs.iter().any(|run| &run.id == id));
        }
    }

    /// Watching paused (switch off, backend unavailable): runs may start and
    /// slip out of the small window meanwhile, so rescan every task.
    pub fn pause(&mut self) {
        self.scanned.clear();
        self.newest_seen.clear();
    }

    fn throttled(&self, task_id: &str, outcome: RunOutcome, now: i64) -> bool {
        self.last_sent
            .get(&(task_id.to_string(), outcome))
            .is_some_and(|sent| now - sent < THROTTLE_MS)
    }

    /// Returns the runs of one task to notify, oldest first, and marks every
    /// finished run as handled. `suppressed(finished_at)` drops runs that
    /// finished while the switch was off.
    pub fn collect(
        &mut self,
        task_id: &str,
        runs: &[CronRunRef],
        now: i64,
        suppressed: impl Fn(i64) -> bool,
    ) -> Vec<Candidate> {
        // K-Brain lists newest first.
        if let Some(newest) = runs.iter().find(|run| run.task_id == task_id) {
            self.newest_seen
                .insert(task_id.to_string(), newest.id.clone());
        }
        let in_flight = self.in_flight.entry(task_id.to_string()).or_default();
        for run in runs.iter().filter(|run| run.task_id == task_id) {
            if is_finished(run) {
                in_flight.remove(&run.id);
            } else if run.counted {
                in_flight.insert(run.id.clone());
            }
        }
        let mut finished: Vec<&CronRunRef> = runs
            .iter()
            .filter(|run| run.task_id == task_id && is_finished(run))
            .collect();
        finished.sort_by_key(|run| finished_at(run));
        let mut out: Vec<Candidate> = Vec::new();
        let (mark, ids) = self
            .handled
            .entry(task_id.to_string())
            .or_insert_with(|| (i64::MIN, Vec::new()));
        for run in finished {
            let at = finished_at(run);
            if at <= self.floor || at < *mark || (at == *mark && ids.contains(&run.id)) {
                continue;
            }
            if at > *mark {
                *mark = at;
                ids.clear();
            }
            ids.push(run.id.clone());
            let Some(outcome) = classify(run) else {
                continue;
            };
            if suppressed(at) || out.iter().any(|candidate| candidate.outcome == outcome) {
                continue;
            }
            out.push(Candidate {
                run: run.clone(),
                outcome,
                attempts: 0,
            });
        }
        out.retain(|candidate| !self.throttled(task_id, candidate.outcome, now));
        out
    }

    /// Records a delivered notification; only these count for throttling.
    pub fn mark_sent(&mut self, candidate: &Candidate, now: i64) {
        self.last_sent
            .insert((candidate.run.task_id.clone(), candidate.outcome), now);
    }

    /// Queues a failed delivery for the next poll, up to the attempt limit.
    pub fn schedule_retry(&mut self, mut candidate: Candidate) {
        candidate.attempts += 1;
        if candidate.attempts < MAX_DELIVERY_ATTEMPTS {
            self.retry.push(candidate);
        }
    }

    pub fn take_retries(&mut self) -> Vec<Candidate> {
        std::mem::take(&mut self.retry)
    }

    /// Drops state of tasks that no longer exist.
    pub fn retain_tasks(&mut self, task_ids: &[&str]) {
        let keep = |id: &str| task_ids.contains(&id);
        self.handled.retain(|id, _| keep(id));
        self.in_flight.retain(|id, _| keep(id));
        self.scanned.retain(|id| keep(id));
        self.newest_seen.retain(|id, _| keep(id));
        self.last_sent.retain(|(id, _), _| keep(id));
        self.retry.retain(|candidate| keep(&candidate.run.task_id));
    }
}

pub fn notification_title(labels: &NotificationLabels, outcome: RunOutcome) -> String {
    let (label, fallback) = match outcome {
        RunOutcome::Succeeded => (&labels.cron_succeeded, "Scheduled task finished"),
        RunOutcome::Failed => (&labels.cron_failed, "Scheduled task failed"),
        RunOutcome::TimedOut => (&labels.cron_timed_out, "Scheduled task timed out"),
    };
    if label.is_empty() {
        fallback.to_string()
    } else {
        label.clone()
    }
}

/// Marker after which K-Brain puts a bash run's combined output, preceded by
/// `shell=…`, `exit=…` and `timed_out=…` header lines.
const BASH_OUTPUT_MARKER: &str = "\nstdout/stderr:\n";

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// The line worth showing: for bash runs the first script output line (or
/// the exit status when the script printed nothing), else the first line.
fn output_summary(output: &str) -> &str {
    let trimmed = output.trim_start();
    if trimmed.starts_with("shell=") {
        if let Some((header, body)) = trimmed.split_once(BASH_OUTPUT_MARKER) {
            let line = first_line(body);
            if !line.is_empty() {
                return line;
            }
            return header
                .lines()
                .find_map(|line| line.strip_prefix("exit="))
                .map(str::trim)
                .unwrap_or("");
        }
    }
    first_line(output)
}

/// `任务名: 输出首行`, the first meaningful output line, at most 200 chars.
pub fn notification_body(task_name: &str, output: &str) -> String {
    let name = task_name.trim();
    let line = output_summary(output);
    let body = match (name.is_empty(), line.is_empty()) {
        (false, false) => format!("{name}: {line}"),
        (false, true) => name.to_string(),
        (true, _) => line.to_string(),
    };
    let mut chars = body.chars();
    let clipped: String = chars.by_ref().take(BODY_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{clipped}…")
    } else {
        clipped
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn get_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    connection: &KBrainBackendConnection,
    path: &str,
) -> Result<T, String> {
    let response = client
        .get(format!(
            "{}{path}",
            connection.base_url.trim_end_matches('/')
        ))
        .bearer_auth(&connection.token)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !response.status().is_success() {
        return Err(format!("K-brain {path} returned {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

async fn fetch_runs(
    client: &reqwest::Client,
    connection: &KBrainBackendConnection,
    task_id: &str,
    limit: usize,
) -> Result<Vec<CronRunRef>, String> {
    let path = format!(
        "/v1/cron/{}/runs?limit={limit}",
        urlencoding::encode(task_id)
    );
    Ok(get_json::<RunsResponse>(client, connection, &path)
        .await?
        .runs)
}

/// A task's runs, widening the window until it covers everything since the
/// last poll. Also returns how many queries that took.
async fn fetch_covering_runs(
    client: &reqwest::Client,
    connection: &KBrainBackendConnection,
    watcher: &mut RunWatcher,
    task_id: &str,
) -> Result<(Vec<CronRunRef>, usize), String> {
    let mut limit = watcher.first_window(task_id);
    let mut queries = 0;
    loop {
        let runs = fetch_runs(client, connection, task_id, limit).await?;
        queries += 1;
        if watcher.window_is_enough(task_id, &runs, limit) {
            if limit >= RUNS_FULL_WINDOW || runs.len() < limit {
                watcher.mark_scanned(task_id, &runs);
            }
            return Ok((runs, queries));
        }
        limit = next_window(limit);
    }
}

fn next_window(limit: usize) -> usize {
    RUNS_WINDOWS
        .into_iter()
        .find(|window| *window > limit)
        .unwrap_or(RUNS_FULL_WINDOW)
}

fn cron_allowed_now() -> bool {
    notification_prefs::allows(Category::Cron) == Some(true)
}

/// Delivers candidates in order; stops (dropping the rest) once the switch is
/// turned off mid-way, and queues failures for a retry.
async fn deliver_all(
    app: &tauri::AppHandle,
    watcher: &mut RunWatcher,
    names: &HashMap<String, String>,
    candidates: Vec<Candidate>,
) {
    for candidate in candidates {
        if !cron_allowed_now() {
            return;
        }
        let run = &candidate.run;
        if notification_prefs::suppressed(Category::Cron, finished_at(run))
            || watcher.throttled(&run.task_id, candidate.outcome, now_ms())
        {
            continue;
        }
        let labels = notification_prefs::labels();
        let name = names.get(&run.task_id).map(String::as_str).unwrap_or("");
        let delivery = notification::deliver(
            app,
            format!("cron-run:{}:{}", run.task_id, run.id),
            notification_title(&labels, candidate.outcome),
            notification_body(name, &run.output),
            true,
        )
        .await;
        match delivery {
            Ok(()) => watcher.mark_sent(&candidate, now_ms()),
            Err(error) => {
                eprintln!("[cron] run notification delivery failed: {error}");
                watcher.schedule_retry(candidate);
            }
        }
    }
}

async fn poll_once(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    watcher: &mut RunWatcher,
) -> Result<(), String> {
    // Runs finishing while unknown or off fall in an off window and stay silent.
    if !cron_allowed_now() || notification::disabled() {
        watcher.pause();
        return Ok(());
    }
    let Some(state) = app.try_state::<Arc<KBrainBackendState>>() else {
        return Ok(());
    };
    let Some(connection) = state.running_connection() else {
        watcher.pause();
        return Ok(());
    };
    let snapshot: CronSnapshotRef = match get_json(client, &connection, "/v1/cron").await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            watcher.pause();
            return Err(error);
        }
    };
    let ids: Vec<&str> = snapshot.tasks.iter().map(|task| task.id.as_str()).collect();
    watcher.retain_tasks(&ids);
    let names: HashMap<String, String> = snapshot
        .tasks
        .iter()
        .map(|task| (task.id.clone(), task.name.clone()))
        .collect();

    let mut candidates = watcher.take_retries();
    for task in &snapshot.tasks {
        let runs = match fetch_covering_runs(client, &connection, watcher, &task.id).await {
            Ok((runs, _)) => runs,
            Err(error) => {
                // Collecting a partial window would move the watermark past a
                // missing run; retry the whole task next poll.
                eprintln!(
                    "[cron] run notification query failed for {}: {error}",
                    task.id
                );
                continue;
            }
        };
        candidates.extend(watcher.collect(&task.id, &runs, now_ms(), |at| {
            notification_prefs::suppressed(Category::Cron, at)
        }));
    }
    deliver_all(app, watcher, &names, candidates).await;
    Ok(())
}

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                eprintln!("[cron] run notifications disabled: {error}");
                return;
            }
        };
        let mut watcher = RunWatcher::new(now_ms());
        let mut timer = tokio::time::interval(POLL_INTERVAL);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            if let Err(error) = poll_once(&app, &client, &mut watcher).await {
                eprintln!("[cron] run notification poll failed: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, finished: i64) -> CronRunRef {
        CronRunRef {
            id: id.into(),
            task_id: "t1".into(),
            state: "done".into(),
            success: true,
            counted: true,
            started_at: finished - 1_000,
            finished_at: Some(finished),
            ..CronRunRef::default()
        }
    }

    fn running(id: &str, started: i64) -> CronRunRef {
        CronRunRef {
            state: "leased".into(),
            finished_at: None,
            started_at: started,
            ..run(id, started)
        }
    }

    fn skipped(id: &str, at: i64) -> CronRunRef {
        CronRunRef {
            success: false,
            counted: false,
            output: "Skipped: previous run is still in progress.".into(),
            ..run(id, at)
        }
    }

    fn never(_: i64) -> bool {
        false
    }

    fn ids(candidates: &[Candidate]) -> Vec<&str> {
        candidates.iter().map(|c| c.run.id.as_str()).collect()
    }

    /// Collects and treats every candidate as delivered.
    fn collect_sent(watcher: &mut RunWatcher, runs: &[CronRunRef], now: i64) -> Vec<String> {
        let out = watcher.collect("t1", runs, now, never);
        for candidate in &out {
            watcher.mark_sent(candidate, now);
        }
        out.into_iter().map(|c| c.run.id).collect()
    }

    #[test]
    fn classify_covers_outcomes_and_silent_runs() {
        assert_eq!(classify(&run("a", 10)), Some(RunOutcome::Succeeded));
        let failed = CronRunRef {
            success: false,
            ..run("b", 10)
        };
        assert_eq!(classify(&failed), Some(RunOutcome::Failed));
        let timeout = CronRunRef {
            state: "expired".into(),
            success: false,
            termination_reason: "timeout".into(),
            ..run("c", 10)
        };
        assert_eq!(classify(&timeout), Some(RunOutcome::TimedOut));
        // Interrupted by a K-Brain restart: expired without a reason.
        let interrupted = CronRunRef {
            state: "expired".into(),
            ..run("d", 10)
        };
        assert_eq!(classify(&interrupted), Some(RunOutcome::Failed));
        let cancelled = CronRunRef {
            state: "expired".into(),
            termination_reason: "cancelled".into(),
            ..run("e", 10)
        };
        assert_eq!(classify(&cancelled), None);
        let manual = CronRunRef {
            counted: false,
            ..run("f", 10)
        };
        assert_eq!(classify(&manual), None);
        assert_eq!(classify(&skipped("g", 10)), None);
        assert_eq!(classify(&running("h", 10)), None);
    }

    #[test]
    fn runs_before_start_are_history() {
        let mut watcher = RunWatcher::new(1_000);
        assert!(collect_sent(&mut watcher, &[run("old", 900)], 2_000).is_empty());
        let fresh = collect_sent(&mut watcher, &[run("old", 900), run("new", 1_500)], 2_000);
        assert_eq!(fresh, ["new"]);
    }

    #[test]
    fn each_run_notifies_once_including_same_millisecond() {
        let mut watcher = RunWatcher::new(0);
        assert_eq!(collect_sent(&mut watcher, &[run("a", 100)], 1_000), ["a"]);
        let failed_same_ms = CronRunRef {
            success: false,
            ..run("b", 100)
        };
        assert_eq!(
            collect_sent(&mut watcher, &[run("a", 100), failed_same_ms], 1_000),
            ["b"]
        );
        assert!(collect_sent(&mut watcher, &[run("a", 100), run("b", 100)], 1_000).is_empty());
    }

    #[test]
    fn same_outcome_is_throttled_per_task_after_a_delivery() {
        let mut watcher = RunWatcher::new(0);
        assert_eq!(collect_sent(&mut watcher, &[run("a", 100)], 1_000), ["a"]);
        assert!(collect_sent(&mut watcher, &[run("b", 200)], 2_000).is_empty());
        let failed = CronRunRef {
            success: false,
            ..run("c", 300)
        };
        assert_eq!(collect_sent(&mut watcher, &[failed], 3_000), ["c"]);
        assert_eq!(
            collect_sent(&mut watcher, &[run("d", 400)], 1_000 + THROTTLE_MS),
            ["d"]
        );
    }

    #[test]
    fn one_poll_yields_one_notification_per_outcome() {
        let mut watcher = RunWatcher::new(0);
        let out = watcher.collect("t1", &[run("a", 100), run("b", 200)], 1_000, never);
        assert_eq!(ids(&out), ["a"]);
    }

    #[test]
    fn failed_delivery_does_not_use_up_the_throttle_and_is_retried() {
        let mut watcher = RunWatcher::new(0);
        let out = watcher.collect("t1", &[run("a", 100)], 1_000, never);
        assert_eq!(ids(&out), ["a"]);
        watcher.schedule_retry(out[0].clone());
        // Not marked sent: a later success of the same task is not throttled.
        assert_eq!(
            ids(&watcher.collect("t1", &[run("b", 200)], 2_000, never)),
            ["b"]
        );
        let retries = watcher.take_retries();
        assert_eq!(ids(&retries), ["a"]);
        assert_eq!(retries[0].attempts, 1);
        assert!(watcher.take_retries().is_empty());
    }

    #[test]
    fn retries_stop_after_the_attempt_limit() {
        let mut watcher = RunWatcher::new(0);
        let mut candidate = watcher.collect("t1", &[run("a", 100)], 1_000, never)[0].clone();
        for _ in 1..MAX_DELIVERY_ATTEMPTS {
            watcher.schedule_retry(candidate);
            candidate = watcher.take_retries().pop().expect("queued for retry");
        }
        watcher.schedule_retry(candidate);
        assert!(watcher.take_retries().is_empty());
    }

    #[test]
    fn runs_finished_while_off_stay_silent() {
        let mut watcher = RunWatcher::new(0);
        let off = |at: i64| (300..600).contains(&at);
        assert!(watcher
            .collect("t1", &[run("a", 400)], 1_000, off)
            .is_empty());
        assert_eq!(
            ids(&watcher.collect("t1", &[run("a", 400), run("b", 700)], 1_000, off)),
            ["b"]
        );
    }

    /// What [`fetch_covering_runs`] does, against an in-memory run list
    /// (newest first): returns the window that was accepted.
    fn covering_window(watcher: &mut RunWatcher, all: &[CronRunRef]) -> usize {
        let mut limit = watcher.first_window("t1");
        loop {
            let runs: Vec<CronRunRef> = all.iter().take(limit).cloned().collect();
            if watcher.window_is_enough("t1", &runs, limit) {
                if limit >= RUNS_FULL_WINDOW || runs.len() < limit {
                    watcher.mark_scanned("t1", &runs);
                }
                return limit;
            }
            limit = next_window(limit);
        }
    }

    /// Prepends `runs` (given oldest first) to a newest-first list.
    fn push_newest(all: &mut Vec<CronRunRef>, runs: impl IntoIterator<Item = CronRunRef>) {
        for run in runs {
            all.insert(0, run);
        }
    }

    #[test]
    fn a_task_is_read_in_full_first_and_after_a_pause() {
        let mut watcher = RunWatcher::new(0);
        assert_eq!(watcher.first_window("t1"), RUNS_FULL_WINDOW);
        assert_eq!(covering_window(&mut watcher, &[]), RUNS_FULL_WINDOW);
        assert_eq!(watcher.first_window("t1"), RUNS_WINDOW);
        watcher.pause();
        assert_eq!(watcher.first_window("t1"), RUNS_FULL_WINDOW);
    }

    #[test]
    fn quiet_task_stays_on_the_small_window() {
        let mut watcher = RunWatcher::new(0);
        let mut all = vec![run("a", 100)];
        covering_window(&mut watcher, &all);
        watcher.collect("t1", &all, 200, never);
        push_newest(&mut all, [run("b", 300)]);
        assert_eq!(covering_window(&mut watcher, &all), RUNS_WINDOW);
    }

    #[test]
    fn run_finished_and_buried_between_polls_is_still_found() {
        // Codex round 3: a run starts and finishes between two polls, then
        // more than a window of skipped overlaps pushes it out.
        let mut watcher = RunWatcher::new(0);
        let mut all: Vec<CronRunRef> = Vec::new();
        push_newest(&mut all, (0..3).map(|i| run(&format!("old{i}"), 10 + i)));
        covering_window(&mut watcher, &all);
        watcher.collect("t1", &all, 50, never);
        push_newest(&mut all, [run("quick", 900)]);
        push_newest(
            &mut all,
            (0..2 * RUNS_WINDOW).map(|i| skipped(&format!("s{i}"), 1_000 + i as i64)),
        );
        let limit = covering_window(&mut watcher, &all);
        assert!(limit > RUNS_WINDOW);
        let runs: Vec<CronRunRef> = all.iter().take(limit).cloned().collect();
        assert_eq!(ids(&watcher.collect("t1", &runs, 2_000, never)), ["quick"]);
    }

    #[test]
    fn long_run_pushed_out_of_the_window_triggers_a_wider_query() {
        let mut watcher = RunWatcher::new(0);
        let mut all = vec![running("long", 100)];
        covering_window(&mut watcher, &all);
        watcher.collect("t1", &all, 200, never);
        // Each poll sees a few skips, so continuity alone would be satisfied.
        for poll in 0..3 {
            push_newest(
                &mut all,
                (0..2).map(|i| skipped(&format!("s{poll}-{i}"), 300 + poll * 10 + i)),
            );
            let limit = covering_window(&mut watcher, &all);
            let runs: Vec<CronRunRef> = all.iter().take(limit).cloned().collect();
            watcher.collect("t1", &runs, 400, never);
        }
        let long = all.iter().position(|r| r.id == "long").unwrap();
        all[long] = run("long", 900);
        let limit = covering_window(&mut watcher, &all);
        assert!(
            limit > RUNS_WINDOW,
            "the long run sits outside the small window"
        );
        let runs: Vec<CronRunRef> = all.iter().take(limit).cloned().collect();
        assert_eq!(ids(&watcher.collect("t1", &runs, 1_000, never)), ["long"]);
    }

    #[test]
    fn long_run_started_before_watching_is_found_by_the_first_scan() {
        let mut watcher = RunWatcher::new(500);
        let mut all = vec![running("long", 100)];
        push_newest(
            &mut all,
            (0..RUNS_WINDOW).map(|i| skipped(&format!("s{i}"), 600 + i as i64)),
        );
        assert_eq!(covering_window(&mut watcher, &all), RUNS_FULL_WINDOW);
        watcher.collect("t1", &all, 700, never);
        let long = all.iter().position(|r| r.id == "long").unwrap();
        all[long] = run("long", 900);
        let limit = covering_window(&mut watcher, &all);
        let runs: Vec<CronRunRef> = all.iter().take(limit).cloned().collect();
        assert_eq!(ids(&watcher.collect("t1", &runs, 1_000, never)), ["long"]);
    }

    #[test]
    fn in_flight_runs_missing_from_the_full_list_are_forgotten() {
        let mut watcher = RunWatcher::new(0);
        watcher.mark_scanned("t1", &[]);
        watcher.collect("t1", &[running("gone", 100)], 200, never);
        watcher.mark_scanned("t1", &[]);
        assert!(watcher.in_flight.get("t1").is_none_or(HashSet::is_empty));
    }

    #[test]
    fn bash_header_is_skipped_in_the_body() {
        let output =
            "shell=bash\nexit=(exit: exit status 3)\ntimed_out=false\nstdout/stderr:\nboom\n";
        assert_eq!(notification_body("Backup", output), "Backup: boom");
        let silent = "shell=bash\nexit=(exit: exit status 3)\ntimed_out=false\nstdout/stderr:\n";
        assert_eq!(
            notification_body("Backup", silent),
            "Backup: (exit: exit status 3)"
        );
        assert_eq!(
            notification_body("Ping", "Request 1: status=200\n{}"),
            "Ping: Request 1: status=200"
        );
    }

    /// Runs the real query + classification against a live K-Brain:
    /// `KBRAIN_E2E_URL=http://127.0.0.1:18765 KBRAIN_E2E_TOKEN=… cargo test --lib
    /// live_kbrain_cron_runs -- --ignored --nocapture`. It creates four
    /// second-level tasks (ok / fail / timeout / long overlapping run).
    const E2E_TASKS: [&str; 4] = ["e2e-ok", "e2e-fail", "e2e-timeout", "e2e-long"];

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a running K-Brain (KBRAIN_E2E_URL / KBRAIN_E2E_TOKEN)"]
    async fn live_kbrain_cron_runs() {
        let connection = KBrainBackendConnection {
            base_url: std::env::var("KBRAIN_E2E_URL").expect("KBRAIN_E2E_URL"),
            token: std::env::var("KBRAIN_E2E_TOKEN").expect("KBRAIN_E2E_TOKEN"),
            protocol_version: String::new(),
            storage_id: String::new(),
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap();
        let task = |id: &str, cron: &str, script: &str, timeout: u64| {
            serde_json::json!({"op": "create", "item": {
                "id": id, "name": id, "description": "", "cron": cron, "enabled": true,
                "timeoutSeconds": timeout, "type": "bash", "script": script,
            }})
        };
        let snapshot: serde_json::Value = get_json(&client, &connection, "/v1/cron").await.unwrap();
        // Leftovers from an interrupted run are replaced in the same apply.
        let mut ops: Vec<serde_json::Value> = snapshot["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|task| task["id"].as_str())
            .filter(|id| E2E_TASKS.contains(id))
            .map(|id| serde_json::json!({"op": "delete", "id": id}))
            .collect();
        ops.extend([
            task("e2e-ok", "*/3 * * * * *", "echo ok-line", 30),
            task("e2e-fail", "*/3 * * * * *", "echo boom >&2; exit 3", 30),
            task("e2e-timeout", "*/4 * * * * *", "sleep 5", 1),
            task("e2e-long", "* * * * * *", "sleep 9; echo long-done", 30),
        ]);
        let response = client
            .put(format!("{}/v1/cron", connection.base_url))
            .bearer_auth(&connection.token)
            .json(&serde_json::json!({"baseRevision": snapshot["revision"], "ops": ops}))
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "{}",
            response.text().await.unwrap()
        );

        let mut watcher = RunWatcher::new(now_ms());
        let mut seen: HashMap<String, Vec<RunOutcome>> = HashMap::new();
        let mut wide_queries = 0;
        let deadline = now_ms() + 30_000;
        while now_ms() < deadline {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let snapshot: CronSnapshotRef =
                get_json(&client, &connection, "/v1/cron").await.unwrap();
            for task in &snapshot.tasks {
                let first_scan = watcher.first_window(&task.id) == RUNS_FULL_WINDOW;
                let (runs, queries) =
                    fetch_covering_runs(&client, &connection, &mut watcher, &task.id)
                        .await
                        .unwrap();
                if !first_scan && queries > 1 {
                    wide_queries += 1;
                }
                for candidate in watcher.collect(&task.id, &runs, now_ms(), never) {
                    println!(
                        "{} -> {:?}: {:?}",
                        task.id,
                        candidate.outcome,
                        notification_body(&task.name, &candidate.run.output)
                    );
                    seen.entry(task.id.clone())
                        .or_default()
                        .push(candidate.outcome);
                    watcher.mark_sent(&candidate, now_ms());
                }
            }
        }
        // Stop the tasks so the backend goes quiet.
        let snapshot: serde_json::Value = get_json(&client, &connection, "/v1/cron").await.unwrap();
        let ops: Vec<serde_json::Value> = E2E_TASKS
            .iter()
            .map(|id| serde_json::json!({"op": "delete", "id": id}))
            .collect();
        let _ = client
            .put(format!("{}/v1/cron", connection.base_url))
            .bearer_auth(&connection.token)
            .json(&serde_json::json!({"baseRevision": snapshot["revision"], "ops": ops}))
            .send()
            .await;
        println!("seen: {seen:?}, wide queries: {wide_queries}");
        // Throttling: each task notifies its outcome once in the 30 s window.
        assert_eq!(seen.get("e2e-ok"), Some(&vec![RunOutcome::Succeeded]));
        assert_eq!(seen.get("e2e-fail"), Some(&vec![RunOutcome::Failed]));
        assert_eq!(seen.get("e2e-timeout"), Some(&vec![RunOutcome::TimedOut]));
        assert_eq!(seen.get("e2e-long"), Some(&vec![RunOutcome::Succeeded]));
        assert!(
            wide_queries > 0,
            "the long run should fall out of the small window"
        );
    }

    #[test]
    fn body_uses_first_non_empty_line_and_clips() {
        assert_eq!(
            notification_body("Backup", "\n  done ok \nmore"),
            "Backup: done ok"
        );
        assert_eq!(notification_body("Backup", ""), "Backup");
        let long = "x".repeat(300);
        let body = notification_body("", &long);
        assert_eq!(body.chars().count(), BODY_MAX_CHARS + 1);
        assert!(body.ends_with('…'));
    }

    #[test]
    fn title_falls_back_to_english() {
        let labels = NotificationLabels {
            cron_failed: "定时任务失败".into(),
            ..NotificationLabels::default()
        };
        assert_eq!(
            notification_title(&labels, RunOutcome::Failed),
            "定时任务失败"
        );
        assert_eq!(
            notification_title(&labels, RunOutcome::Succeeded),
            "Scheduled task finished"
        );
    }
}
