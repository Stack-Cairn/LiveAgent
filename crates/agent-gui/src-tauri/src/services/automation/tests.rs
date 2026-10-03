use serde_json::json;

use super::db;
use super::store::AutomationStore;
use super::types::*;
use super::validate::{parse_cron, validate_cron_expression};

fn apply_input(base_revision: u64, ops: Vec<AutomationOp>) -> AutomationApplyInput {
    AutomationApplyInput { base_revision, ops }
}

fn create_bash_task_op(id: &str, name: &str) -> AutomationOp {
    AutomationOp::Create {
        item: json!({
            "id": id,
            "name": name,
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "bash",
            "script": "echo hello",
        }),
    }
}

fn create_prompt_task_op(id: &str) -> AutomationOp {
    AutomationOp::Create {
        item: json!({
            "id": id,
            "name": "Prompt task",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "prompt",
            "prompt": "Summarize the repo",
            "selectedModel": { "customProviderId": "provider-a", "model": "gpt-5" },
        }),
    }
}

fn store_with_task(op: AutomationOp) -> (AutomationStore, CronTask) {
    let store = AutomationStore::open_in_memory().expect("open store");
    let base = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(base, vec![op]))
        .expect("apply create");
    assert_eq!(response.status, ApplyStatus::Ok);
    let task = response.cron.tasks[0].clone();
    (store, task)
}

#[test]
fn validate_cron_expression_accepts_six_field_syntax() {
    validate_cron_expression("0 * * * * *").expect("validate six-field cron");
}

#[test]
fn validate_cron_expression_rejects_five_field_syntax() {
    let error = validate_cron_expression("* * * * *").expect_err("reject five-field cron");
    assert!(error.contains("六段"));
}

#[test]
fn parse_cron_rejects_five_fields_and_accepts_six() {
    assert!(parse_cron("* * * * *").unwrap_err().contains("六段"));
    assert!(parse_cron("   ").is_err());
    assert!(parse_cron("0 0 25 * * *").is_err());
    parse_cron(" 0 */5 * * * * ").expect("six-field cron with surrounding spaces");
}

#[test]
fn parse_cron_evaluates_in_the_given_time_zone() {
    use chrono::{Datelike, TimeZone, Timelike, Weekday};
    let tz: chrono_tz::Tz = "Asia/Shanghai".parse().unwrap();
    let cron = parse_cron("0 0 9 * * MON").expect("parse weekly cron");
    // 2026-09-29 is a Tuesday; the next Monday 09:00 in Shanghai is 2026-10-05.
    let start = tz.with_ymd_and_hms(2026, 9, 29, 12, 0, 0).unwrap();
    let next = cron.iter_after(start).next().expect("next occurrence");
    assert_eq!(next.weekday(), Weekday::Mon);
    assert_eq!((next.hour(), next.minute(), next.second()), (9, 0, 0));
    assert_eq!(next.date_naive().to_string(), "2026-10-05");
    assert_eq!(next.with_timezone(&chrono::Utc).hour(), 1);
}

#[test]
fn cron_run_now_response_uses_camel_case() {
    let value = serde_json::to_value(CronRunNowResponse { started_at: 1234 })
        .expect("serialize run-now response");
    assert_eq!(value, json!({ "startedAt": 1234 }));
}

#[test]
fn cron_apply_rejects_stale_revision() {
    let store = AutomationStore::open_in_memory().expect("open store");
    let base = store.snapshot().expect("snapshot").cron.revision;
    store
        .cron_apply(apply_input(base, vec![create_bash_task_op("a", "First")]))
        .expect("first apply");

    let stale = store
        .cron_apply(apply_input(base, vec![create_bash_task_op("b", "Second")]))
        .expect("stale apply returns");
    assert_eq!(stale.status, ApplyStatus::Conflict);
    assert_eq!(stale.cron.tasks.len(), 1);

    let fresh = store
        .cron_apply(apply_input(
            stale.cron.revision,
            vec![create_bash_task_op("b", "Second")],
        ))
        .expect("rebased apply");
    assert_eq!(fresh.status, ApplyStatus::Ok);
    assert_eq!(fresh.cron.tasks.len(), 2);
}

#[test]
fn cron_apply_update_patches_only_named_fields() {
    let (store, task) = store_with_task(create_bash_task_op("a", "First"));
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "name": "Renamed" }),
            }],
        ))
        .expect("apply update");
    assert_eq!(response.status, ApplyStatus::Ok);
    let updated = &response.cron.tasks[0];
    assert_eq!(updated.name, "Renamed");
    assert_eq!(updated.script.as_deref(), Some("echo hello"));
    assert!(updated.enabled);
}

#[test]
fn cron_apply_update_switching_kind_drops_stale_config() {
    let (store, task) = store_with_task(create_bash_task_op("a", "First"));
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({
                    "type": "http",
                    "requests": [{ "url": "https://example.com/ping", "method": "GET" }],
                }),
            }],
        ))
        .expect("apply kind switch");
    let updated = &response.cron.tasks[0];
    assert_eq!(updated.kind, "http");
    assert!(updated.script.is_none());
    assert_eq!(updated.requests.as_ref().map(Vec::len), Some(1));
}

#[test]
fn cron_apply_reorder_requires_full_permutation() {
    let store = AutomationStore::open_in_memory().expect("open store");
    let base = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            base,
            vec![create_bash_task_op("a", "A"), create_bash_task_op("b", "B")],
        ))
        .expect("seed");

    let error = store
        .cron_apply(apply_input(
            response.cron.revision,
            vec![AutomationOp::Reorder {
                ids: vec!["a".to_string()],
            }],
        ))
        .expect_err("partial reorder rejected");
    assert!(error.contains("全部"));

    let reordered = store
        .cron_apply(apply_input(
            response.cron.revision,
            vec![AutomationOp::Reorder {
                ids: vec!["b".to_string(), "a".to_string()],
            }],
        ))
        .expect("full reorder");
    let ids: Vec<&str> = reordered.cron.tasks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["b", "a"]);
}

#[test]
fn record_completed_run_decrements_and_disables_at_zero() {
    let store = AutomationStore::open_in_memory().expect("open store");
    let base = store.snapshot().expect("snapshot").cron.revision;
    store
        .cron_apply(apply_input(
            base,
            vec![AutomationOp::Create {
                item: json!({
                    "id": "finite",
                    "name": "Finite",
                    "cron": "0 * * * * *",
                    "enabled": true,
                    "remainingExecutions": 1,
                    "type": "bash",
                    "script": "echo finite",
                }),
            }],
        ))
        .expect("seed finite task");

    store
        .record_completed_run(CompletedRun {
            task_id: "finite".to_string(),
            success: true,
            started_at: db::now_ms(),
            duration_ms: 5,
            exit_code: Some(0),
            output: "ok".to_string(),
            counted: true,
            skipped: false,
        })
        .expect("record run");

    let snapshot = store.snapshot().expect("snapshot").cron;
    let task = &snapshot.tasks[0];
    assert_eq!(task.remaining_executions, Some(0));
    assert!(!task.enabled);
    let runs = store.list_runs("finite", 10).expect("list runs");
    assert_eq!(runs.len(), 1);
    assert!(runs[0].success);
}

#[test]
fn prompt_run_lifecycle_queue_claim_complete() {
    let (store, task) = store_with_task(create_prompt_task_op("p1"));

    assert!(matches!(
        store
            .queue_prompt_run(&task, "", true)
            .expect("queue prompt run"),
        super::store::PromptQueueOutcome::Queued
    ));

    let pending_runs = store.list_runs("p1", 10).expect("list pending runs");
    assert_eq!(pending_runs.len(), 1);
    assert_eq!(pending_runs[0].state, RunState::Pending);

    // Second fire while pending is skipped.
    assert!(matches!(
        store
            .queue_prompt_run(&task, "", true)
            .expect("second queue"),
        super::store::PromptQueueOutcome::SkippedActiveRun
    ));

    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims.len(), 1);
    let execution_id = claims[0].execution_id.clone();

    // Claim is consuming: a second claim returns nothing.
    assert!(store.claim_prompt_runs().expect("second claim").is_empty());

    let completion = store
        .complete_prompt_run(CompletePromptRunInput {
            execution_id: execution_id.clone(),
            success: true,
            duration_ms: 1200,
            output: "conclusion".to_string(),
        })
        .expect("complete");
    assert_eq!(completion.status, PromptCompletionStatus::Completed);

    let repeat = store
        .complete_prompt_run(CompletePromptRunInput {
            execution_id: execution_id.clone(),
            success: true,
            duration_ms: 1200,
            output: "late".to_string(),
        })
        .expect("repeat complete");
    assert_eq!(repeat.status, PromptCompletionStatus::AlreadyFinished);

    let runs = store.list_runs("p1", 10).expect("list runs");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].output, "conclusion");
}

#[test]
fn complete_prompt_run_input_uses_camel_case_wire_fields() {
    let input: CompletePromptRunInput = serde_json::from_value(json!({
        "executionId": "execution-1",
        "success": true,
        "durationMs": 1200,
        "output": "conclusion",
    }))
    .expect("deserialize camelCase completion input");
    assert_eq!(input.execution_id, "execution-1");
    assert_eq!(input.duration_ms, 1200);

    let error = serde_json::from_value::<CompletePromptRunInput>(json!({
        "execution_id": "execution-1",
        "success": true,
        "duration_ms": 1200,
        "output": "conclusion",
    }))
    .expect_err("reject snake_case completion input");
    assert!(error.to_string().contains("executionId"));

    let legacy_request: PromptRunRequest = serde_json::from_value(json!({
        "executionId": "execution-1",
        "taskId": "task-1",
        "taskName": "Task",
        "prompt": "Run",
        "providerId": "provider-a",
        "model": "gpt-5",
        "startedAt": 100,
        "leaseExpiresAt": 200,
    }))
    .expect("deserialize legacy prompt request");
    assert!(legacy_request.counted);
    assert_eq!(legacy_request.workdir, "");
}

#[test]
fn manual_prompt_run_does_not_consume_remaining_execution() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "manual-prompt",
            "name": "Manual Prompt",
            "cron": "0 * * * * *",
            "enabled": true,
            "remainingExecutions": 1,
            "type": "prompt",
            "prompt": "Summarize the repo",
            "selectedModel": { "customProviderId": "provider-a", "model": "gpt-5" },
        }),
    });

    store
        .queue_prompt_run(&task, "", false)
        .expect("queue manual prompt run");
    let claims = store.claim_prompt_runs().expect("claim manual prompt run");
    assert_eq!(claims.len(), 1);
    assert!(!claims[0].counted);
    store
        .complete_prompt_run(CompletePromptRunInput {
            execution_id: claims[0].execution_id.clone(),
            success: true,
            duration_ms: 10,
            output: "manual conclusion".to_string(),
        })
        .expect("complete manual prompt run");

    let snapshot = store.snapshot().expect("snapshot after manual run").cron;
    assert_eq!(snapshot.tasks[0].remaining_executions, Some(1));
    assert!(snapshot.tasks[0].enabled);
}

#[test]
fn interrupted_manual_prompt_run_does_not_consume_remaining_execution() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "manual-prompt",
            "name": "Manual Prompt",
            "cron": "0 * * * * *",
            "enabled": true,
            "remainingExecutions": 1,
            "type": "prompt",
            "prompt": "Summarize the repo",
            "selectedModel": { "customProviderId": "provider-a", "model": "gpt-5" },
        }),
    });

    store
        .queue_prompt_run(&task, "", false)
        .expect("queue manual prompt run");
    assert_eq!(
        store
            .recover_interrupted_prompt_runs()
            .expect("expire manual prompt run"),
        1
    );

    let snapshot = store.snapshot().expect("snapshot after manual expiry").cron;
    assert_eq!(snapshot.tasks[0].remaining_executions, Some(1));
    assert!(snapshot.tasks[0].enabled);
}

#[test]
fn manual_run_context_allows_disabled_exhausted_task() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "manual-bash",
            "name": "Manual Bash",
            "cron": "0 * * * * *",
            "enabled": false,
            "remainingExecutions": 0,
            "type": "bash",
            "script": "echo manual",
        }),
    });

    let (_, manual_task) = store
        .cron_task_for_manual_run(&task.id)
        .expect("load disabled exhausted task for manual run");
    assert!(!manual_task.enabled);
    assert_eq!(manual_task.remaining_executions, Some(0));
}

#[test]
fn released_prompt_run_returns_to_pending() {
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    assert!(matches!(
        store.queue_prompt_run(&task, "", true).expect("queue"),
        super::store::PromptQueueOutcome::Queued
    ));
    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims.len(), 1);
    let execution_id = claims[0].execution_id.clone();
    store.release_prompt_run(&execution_id).expect("release");
    let reclaimed = store.claim_prompt_runs().expect("reclaim");
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].execution_id, execution_id);
}

#[test]
fn recover_marks_interrupted_runs_expired() {
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    store.queue_prompt_run(&task, "", true).expect("queue");
    let recovered = store.recover_interrupted_prompt_runs().expect("recover");
    assert_eq!(recovered, 1);

    let runs = store.list_runs("p1", 10).expect("list runs");
    assert_eq!(runs.len(), 1);
    assert!(matches!(runs[0].state, RunState::Expired));
    assert!(runs[0].output.contains("restart"));

    // Completion after expiry is idempotent.
    let completion = store
        .complete_prompt_run(CompletePromptRunInput {
            execution_id: runs[0].id.clone(),
            success: true,
            duration_ms: 10,
            output: "late".to_string(),
        })
        .expect("late completion");
    assert_eq!(completion.status, PromptCompletionStatus::AlreadyFinished);
}

#[test]
fn run_retention_prunes_old_rows() {
    let (store, _task) = store_with_task(create_bash_task_op("a", "A"));
    for index in 0..(db::RUN_RETENTION_PER_TASK + 25) {
        store
            .record_completed_run(CompletedRun {
                task_id: "a".to_string(),
                success: true,
                started_at: db::now_ms() + index as i64,
                duration_ms: 1,
                exit_code: Some(0),
                output: format!("run {index}"),
                counted: false,
                skipped: false,
            })
            .expect("record run");
    }
    let runs = store.list_runs("a", 500).expect("list runs");
    assert_eq!(runs.len(), db::RUN_RETENTION_PER_TASK as usize);
}

#[test]
fn masked_headers_round_trip_keeps_stored_secret() {
    let store = AutomationStore::open_in_memory().expect("open store");
    let base = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            base,
            vec![AutomationOp::Create {
                item: json!({
                    "id": "h1",
                    "name": "Http",
                    "cron": "0 * * * * *",
                    "type": "http",
                    "requests": [{
                        "id": "r1",
                        "url": "https://example.com/hook",
                        "method": "POST",
                        "headers": { "Authorization": "Bearer secret-token" },
                    }],
                }),
            }],
        ))
        .expect("seed http task");

    // A remote client edits the URL and round-trips masked headers.
    let masked = store
        .cron_apply(apply_input(
            response.cron.revision,
            vec![AutomationOp::Update {
                id: "h1".to_string(),
                patch: json!({
                    "requests": [{
                        "id": "r1",
                        "url": "https://example.com/hook-v2",
                        "method": "POST",
                        "headers": { "Authorization": MASKED_HEADER_VALUE },
                    }],
                }),
            }],
        ))
        .expect("masked update");

    let task = &masked.cron.tasks[0];
    let headers = task.requests.as_ref().unwrap()[0].headers.as_ref().unwrap();
    assert_eq!(
        headers.get("Authorization").map(String::as_str),
        Some("Bearer secret-token")
    );
    assert_eq!(
        task.requests.as_ref().unwrap()[0].url,
        "https://example.com/hook-v2"
    );
}

#[test]
fn hooks_apply_validates_event_and_conflicts() {
    let store = AutomationStore::open_in_memory().expect("open store");
    let base = store.snapshot().expect("snapshot").hooks.revision;

    let error = store
        .hooks_apply(apply_input(
            base,
            vec![AutomationOp::Create {
                item: json!({
                    "id": "bad",
                    "name": "Bad",
                    "event": "message_update",
                    "type": "command",
                    "script": "echo hi",
                }),
            }],
        ))
        .expect_err("unsupported event rejected");
    assert!(error.contains("event"));

    let ok = store
        .hooks_apply(apply_input(
            base,
            vec![AutomationOp::Create {
                item: json!({
                    "id": "good",
                    "name": "Good",
                    "event": "agent_end",
                    "enabled": true,
                    "type": "command",
                    "script": "echo done",
                }),
            }],
        ))
        .expect("create hook");
    assert_eq!(ok.status, ApplyStatus::Ok);

    let conflict = store
        .hooks_apply(apply_input(base, vec![]))
        .expect("stale hooks apply");
    assert_eq!(conflict.status, ApplyStatus::Conflict);
}

#[test]
fn cron_apply_persists_and_trims_workdir() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "pinned-bash",
            "name": "Pinned Bash",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "bash",
            "script": "pwd",
            "workdir": "  /tmp/pinned-workspace  ",
        }),
    });
    assert_eq!(task.workdir.as_deref(), Some("/tmp/pinned-workspace"));

    let (_, empty_task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "unpinned-bash",
            "name": "Unpinned Bash",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "bash",
            "script": "pwd",
            "workdir": "",
        }),
    });
    assert!(empty_task.workdir.is_none());

    // Round-trips through config_json.
    let reread = store
        .cron_task_for_manual_run("pinned-bash")
        .expect("reload pinned task")
        .1;
    assert_eq!(reread.workdir.as_deref(), Some("/tmp/pinned-workspace"));
}

#[test]
fn cron_apply_update_empty_workdir_clears_pin() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "pinned",
            "name": "Pinned",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "bash",
            "script": "pwd",
            "workdir": "/tmp/pinned-workspace",
        }),
    });

    // A patch without the workdir key keeps the stored pin (old clients).
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let kept = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "name": "Renamed" }),
            }],
        ))
        .expect("patch without workdir");
    assert_eq!(
        kept.cron.tasks[0].workdir.as_deref(),
        Some("/tmp/pinned-workspace")
    );

    // An explicit empty string clears the pin (follow the active workspace).
    let cleared = store
        .cron_apply(apply_input(
            kept.cron.revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "workdir": "" }),
            }],
        ))
        .expect("patch clearing workdir");
    assert!(cleared.cron.tasks[0].workdir.is_none());
}

#[test]
fn cron_apply_http_task_drops_workdir() {
    let (_, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "http-task",
            "name": "Http",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "http",
            "requests": [{ "url": "https://example.com/ping", "method": "GET" }],
            "workdir": "/tmp/pinned-workspace",
        }),
    });
    assert!(task.workdir.is_none());
}

#[test]
fn manual_run_resolves_task_workdir() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "pinned",
            "name": "Pinned",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "bash",
            "script": "pwd",
            "workdir": "/tmp/pinned-workspace",
        }),
    });
    let (workdir, _) = store
        .cron_task_for_manual_run(&task.id)
        .expect("manual run context");
    assert_eq!(workdir, "/tmp/pinned-workspace");

    // Without a pin the resolution falls back to the global workdir, which is
    // empty in the in-memory store (no system_settings table).
    let (unpinned_store, unpinned) = store_with_task(create_bash_task_op("plain", "Plain"));
    let (fallback_workdir, _) = unpinned_store
        .cron_task_for_manual_run(&unpinned.id)
        .expect("manual run context without pin");
    assert_eq!(fallback_workdir, "");
}

#[test]
fn scheduled_fire_reads_fresh_task() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "fresh",
            "name": "Fresh",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "bash",
            "script": "pwd",
            "workdir": "/tmp/pinned-workspace",
        }),
    });

    let fired = store
        .cron_task_for_scheduled_fire(&task.id)
        .expect("scheduled fire read");
    let (workdir, fresh) = fired.expect("task exists");
    assert_eq!(workdir, "/tmp/pinned-workspace");
    assert_eq!(fresh.id, task.id);

    // A deleted task resolves to None instead of an error.
    assert!(store
        .cron_task_for_scheduled_fire("missing-task")
        .expect("missing task read")
        .is_none());
}

#[test]
fn queue_prompt_run_stamps_workdir() {
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    store
        .queue_prompt_run(&task, "/tmp/pinned-workspace", true)
        .expect("queue with workdir");
    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].workdir, "/tmp/pinned-workspace");
    // No per-task reasoning configured -> empty (runner default).
    assert_eq!(claims[0].reasoning, "");
}

#[test]
fn cron_apply_validates_and_stamps_prompt_reasoning() {
    let (store, task) = store_with_task(AutomationOp::Create {
        item: json!({
            "id": "thinker",
            "name": "Thinker",
            "cron": "0 * * * * *",
            "enabled": true,
            "type": "prompt",
            "prompt": "Summarize the repo",
            "selectedModel": { "customProviderId": "provider-a", "model": "gpt-5" },
            "reasoning": "xhigh",
        }),
    });
    assert_eq!(task.reasoning.as_deref(), Some("xhigh"));

    // Queue carries the level to the runner.
    store
        .queue_prompt_run(&task, "", true)
        .expect("queue with reasoning");
    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims[0].reasoning, "xhigh");

    // Empty clears back to the runtime default; unknown levels are rejected.
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let cleared = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "reasoning": "" }),
            }],
        ))
        .expect("clear reasoning");
    assert!(cleared.cron.tasks[0].reasoning.is_none());

    let error = store
        .cron_apply(apply_input(
            cleared.cron.revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "reasoning": "ultra" }),
            }],
        ))
        .expect_err("reject unknown reasoning level");
    assert!(error.contains("reasoning"));
}

#[test]
fn disable_task_with_error_flips_enabled_and_bumps_revision() {
    let (store, task) = store_with_task(create_bash_task_op("a", "First"));
    let before = store.snapshot().expect("snapshot before").cron;
    assert!(before.tasks[0].enabled);

    store
        .disable_task_with_error(&task.id, "Cron task workspace is unavailable")
        .expect("disable task");

    let after = store.snapshot().expect("snapshot after").cron;
    assert_eq!(after.revision, before.revision + 1);
    assert!(!after.tasks[0].enabled);
    assert_eq!(
        after.tasks[0].last_error.as_deref(),
        Some("Cron task workspace is unavailable")
    );

    // Disabling an unknown task is a no-op instead of an error.
    store
        .disable_task_with_error("missing-task", "irrelevant")
        .expect("disable missing task");
    let unchanged = store.snapshot().expect("snapshot unchanged").cron;
    assert_eq!(unchanged.revision, after.revision);
}

#[test]
fn cron_apply_defaults_and_validates_timeout_seconds() {
    // Creates without the field resolve to the default and always serialize it.
    let (store, task) = store_with_task(create_bash_task_op("a", "First"));
    assert_eq!(task.timeout_seconds, DEFAULT_CRON_TIMEOUT_SECONDS);
    let wire = serde_json::to_value(&task).expect("serialize task");
    assert_eq!(wire.get("timeoutSeconds"), Some(&json!(300)));

    let revision = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "timeoutSeconds": 45 }),
            }],
        ))
        .expect("apply timeout update");
    assert_eq!(response.status, ApplyStatus::Ok);
    assert_eq!(response.cron.tasks[0].timeout_seconds, 45);

    // Patches that do not name the field keep the stored value.
    let response = store
        .cron_apply(apply_input(
            response.cron.revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "name": "Renamed" }),
            }],
        ))
        .expect("apply unrelated update");
    assert_eq!(response.cron.tasks[0].timeout_seconds, 45);

    // Out-of-range and non-integer values are rejected, not silently clamped.
    let revision = response.cron.revision;
    for bad in [json!(0), json!(601), json!("300"), json!(-5)] {
        let error = store
            .cron_apply(apply_input(
                revision,
                vec![AutomationOp::Update {
                    id: task.id.clone(),
                    patch: json!({ "timeoutSeconds": bad }),
                }],
            ))
            .expect_err("reject invalid timeout");
        assert!(error.contains("timeoutSeconds"), "error: {error}");
    }
}

#[test]
fn cron_timeout_upper_bound_is_per_kind() {
    // Prompt tasks accept values beyond the bash/http cap, up to one hour.
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "timeoutSeconds": 601 }),
            }],
        ))
        .expect("prompt accepts 601");
    assert_eq!(response.status, ApplyStatus::Ok);
    let response = store
        .cron_apply(apply_input(
            response.cron.revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "timeoutSeconds": 3600 }),
            }],
        ))
        .expect("prompt accepts 3600");
    assert_eq!(response.status, ApplyStatus::Ok);
    assert_eq!(response.cron.tasks[0].timeout_seconds, 3600);

    // Beyond the prompt cap is still rejected.
    let revision = response.cron.revision;
    for bad in [json!(3601), json!(0)] {
        let error = store
            .cron_apply(apply_input(
                revision,
                vec![AutomationOp::Update {
                    id: task.id.clone(),
                    patch: json!({ "timeoutSeconds": bad }),
                }],
            ))
            .expect_err("reject out-of-range prompt timeout");
        assert!(error.contains("timeoutSeconds"), "error: {error}");
    }

    // Switching a long-timeout prompt task to bash re-validates against the
    // bash cap and rejects instead of clamping.
    let error = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "type": "bash", "script": "echo hi" }),
            }],
        ))
        .expect_err("reject kind switch with oversized timeout");
    assert!(error.contains("timeoutSeconds"), "error: {error}");

    // bash/http creations stay capped at 600.
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let error = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Create {
                item: json!({
                    "id": "b1",
                    "name": "Bash",
                    "cron": "0 * * * * *",
                    "type": "bash",
                    "script": "echo hello",
                    "timeoutSeconds": 601,
                }),
            }],
        ))
        .expect_err("bash rejects 601");
    assert!(error.contains("timeoutSeconds"), "error: {error}");
}

#[test]
fn prompt_lease_starts_at_claim_not_enqueue() {
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    let revision = store.snapshot().expect("snapshot").cron.revision;
    let response = store
        .cron_apply(apply_input(
            revision,
            vec![AutomationOp::Update {
                id: task.id.clone(),
                patch: json!({ "timeoutSeconds": 30 }),
            }],
        ))
        .expect("apply timeout update");
    let task = response.cron.tasks[0].clone();

    let before_queue = db::now_ms();
    assert!(matches!(
        store
            .queue_prompt_run(&task, "", true)
            .expect("queue prompt run"),
        super::store::PromptQueueOutcome::Queued
    ));

    // While pending, the row carries the fixed claim window, not the task
    // timeout.
    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims.len(), 1);
    let claim = &claims[0];
    assert_eq!(claim.timeout_seconds, 30);
    let pending_deadline = claim.started_at + super::store::PROMPT_PENDING_CLAIM_WINDOW_MS;
    assert!(
        claim.lease_expires_at < pending_deadline,
        "claim re-stamps the lease from the timeout, not the pending window"
    );

    // The execution lease is stamped at claim time from the timeout snapshot.
    let after_claim = db::now_ms();
    assert!(claim.lease_expires_at >= before_queue + 30_000);
    assert!(claim.lease_expires_at <= after_claim + 30_000);

    // Column and returned request agree.
    let column = store
        .debug_run_lease(&claim.execution_id)
        .expect("read lease column");
    assert_eq!(column, Some(claim.lease_expires_at));
}

#[test]
fn released_prompt_run_gets_fresh_claim_window() {
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    store.queue_prompt_run(&task, "", true).expect("queue");
    let claims = store.claim_prompt_runs().expect("claim");
    let execution_id = claims[0].execution_id.clone();
    let execution_lease = claims[0].lease_expires_at;

    store.release_prompt_run(&execution_id).expect("release");
    let released_lease = store
        .debug_run_lease(&execution_id)
        .expect("read lease after release")
        .expect("lease present");
    // Back to a pending claim window (longer than the 300s execution lease).
    assert!(released_lease > execution_lease);

    // Re-claiming re-stamps the execution lease again.
    let reclaimed = store.claim_prompt_runs().expect("reclaim");
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].execution_id, execution_id);
    assert!(reclaimed[0].lease_expires_at < released_lease);
}

#[test]
fn sweep_distinguishes_unclaimed_from_execution_timeout() {
    // An overdue pending run expires with the "never claimed" message.
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    store.queue_prompt_run(&task, "", false).expect("queue");
    let pending_id = {
        let claims_probe = store.list_runs("p1", 10).expect("list runs");
        claims_probe[0].id.clone()
    };
    store
        .debug_set_run_lease(&pending_id, db::now_ms() - 1_000)
        .expect("force pending expiry");
    let events = store.sweep_expired_prompt_runs().expect("sweep pending");
    assert_eq!(events.len(), 1);
    let runs = store.list_runs("p1", 10).expect("list runs");
    assert!(matches!(runs[0].state, RunState::Expired));
    assert!(
        runs[0].output.contains("before any runner claimed"),
        "output: {}",
        runs[0].output
    );

    // An overdue leased run expires with the execution-timeout message.
    store.queue_prompt_run(&task, "", false).expect("requeue");
    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims.len(), 1);
    store
        .debug_set_run_lease(&claims[0].execution_id, db::now_ms() - 1_000)
        .expect("force leased expiry");
    let events = store.sweep_expired_prompt_runs().expect("sweep leased");
    assert_eq!(events.len(), 1);
    let runs = store.list_runs("p1", 10).expect("list runs");
    let leased_run = runs
        .iter()
        .find(|run| run.id == claims[0].execution_id)
        .expect("find leased run");
    assert!(
        leased_run.output.contains("timed out before the front-end"),
        "output: {}",
        leased_run.output
    );
}

#[test]
fn prompt_run_request_missing_timeout_defaults() {
    // Rows serialized before the timeout snapshot existed resolve to the
    // default instead of failing to parse.
    let request: PromptRunRequest = serde_json::from_value(json!({
        "executionId": "e1",
        "taskId": "t1",
        "taskName": "Old row",
        "prompt": "hi",
        "providerId": "provider-a",
        "model": "gpt-5",
        "startedAt": 1,
        "leaseExpiresAt": 2,
    }))
    .expect("parse legacy request json");
    assert_eq!(request.timeout_seconds, DEFAULT_CRON_TIMEOUT_SECONDS);
}

mod occurrences {
    use super::super::occurrences::*;
    use super::*;
    use chrono::{TimeZone, Timelike};

    fn shanghai() -> chrono_tz::Tz {
        "Asia/Shanghai".parse().unwrap()
    }

    fn ms(tz: chrono_tz::Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        tz.with_ymd_and_hms(y, m, d, h, min, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn task(id: &str, cron: &str, enabled: bool, remaining: Option<u64>) -> CronTask {
        let mut value = json!({
            "id": id,
            "name": format!("Task {id}"),
            "cron": cron,
            "enabled": enabled,
            "type": "bash",
            "script": "true",
        });
        if let Some(remaining) = remaining {
            value["remainingExecutions"] = json!(remaining);
        }
        serde_json::from_value(value).expect("cron task")
    }

    fn run(
        id: &str,
        task_id: &str,
        started_at: i64,
        state: RunState,
        success: bool,
    ) -> CronRunRecord {
        CronRunRecord {
            id: id.into(),
            task_id: task_id.into(),
            state,
            success,
            started_at,
            finished_at: Some(started_at + 1_000),
            duration_ms: 1_000,
            exit_code: Some(if success { 0 } else { 1 }),
            output: "x".repeat(400),
        }
    }

    fn query(from: i64, to: i64) -> CronOccurrenceQuery {
        CronOccurrenceQuery { from, to }
    }

    #[test]
    fn daily_task_expands_to_local_nine_oclock() {
        let tz = shanghai();
        let from = ms(tz, 2026, 10, 1, 0, 0);
        let to = ms(tz, 2026, 10, 4, 0, 0);
        let now = from - 86_400_000;
        let tasks = [task("daily", "0 0 9 * * *", true, None)];
        let result = compute(&tasks, &[], &[], query(from, to), tz, now).unwrap();
        assert_eq!(result.time_zone, "Asia/Shanghai");
        assert_eq!(result.occurrences.len(), 3);
        for (index, occurrence) in result.occurrences.iter().enumerate() {
            let local = tz.timestamp_millis_opt(occurrence.at).unwrap();
            assert_eq!((local.hour(), local.minute()), (9, 0));
            assert_eq!(occurrence.at, ms(tz, 2026, 10, 1 + index as u32, 9, 0));
        }
        assert!(result.summaries.is_empty());
    }

    #[test]
    fn remaining_executions_limit_the_expansion() {
        let tz = shanghai();
        let from = ms(tz, 2026, 10, 1, 0, 0);
        let to = ms(tz, 2026, 10, 8, 0, 0);
        let tasks = [task("limited", "0 0 9 * * *", true, Some(2))];
        let result = compute(&tasks, &[], &[], query(from, to), tz, from).unwrap();
        assert_eq!(result.occurrences.len(), 2);
        assert_eq!(result.tasks[0].remaining_executions, Some(2));
    }

    #[test]
    fn disabled_and_exhausted_tasks_are_hidden_with_their_runs() {
        let tz = shanghai();
        let from = ms(tz, 2026, 10, 1, 0, 0);
        let to = ms(tz, 2026, 10, 3, 0, 0);
        let now = ms(tz, 2026, 10, 2, 0, 0);
        let tasks = [
            task("off", "0 0 9 * * *", false, None),
            task("done", "0 0 9 * * *", true, Some(0)),
            task("on", "0 0 9 * * *", true, None),
        ];
        let runs = [
            run(
                "r-off",
                "off",
                ms(tz, 2026, 10, 1, 9, 0),
                RunState::Done,
                true,
            ),
            run(
                "r-done",
                "done",
                ms(tz, 2026, 10, 1, 9, 0),
                RunState::Done,
                true,
            ),
            run(
                "r-on",
                "on",
                ms(tz, 2026, 10, 1, 9, 0),
                RunState::Done,
                true,
            ),
        ];
        let result = compute(&tasks, &runs, &runs, query(from, to), tz, now).unwrap();
        let ids: Vec<_> = result.tasks.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, ["on"]);
        assert!(result.occurrences.iter().all(|o| o.task_id == "on"));
        assert_eq!(result.occurrences.len(), 1);
        let run_ids: Vec<_> = result.runs.iter().map(|run| run.id.as_str()).collect();
        assert_eq!(run_ids, ["r-on"]);
        assert_eq!(result.runs[0].output_preview.chars().count(), 300);
    }

    #[test]
    fn high_frequency_tasks_are_summarized_per_day() {
        let tz = shanghai();
        let from = ms(tz, 2026, 10, 1, 0, 0);
        let to = ms(tz, 2026, 10, 3, 0, 0);
        let tasks = [
            task("minutely", "0 * * * * *", true, None),
            task("secondly", "* * * * * *", true, None),
        ];
        let result = compute(&tasks, &[], &[], query(from, to), tz, from).unwrap();
        assert!(result.occurrences.is_empty());
        let minutely: Vec<_> = result
            .summaries
            .iter()
            .filter(|summary| summary.task_id == "minutely")
            .collect();
        assert_eq!(minutely.len(), 2);
        assert_eq!(minutely[0].date, "2026-10-01");
        assert_eq!(minutely[0].planned, 1440);
        assert!(!minutely[0].planned_truncated);
        assert_eq!(minutely[0].first_at, from);
        assert_eq!(minutely[0].last_at, ms(tz, 2026, 10, 1, 23, 59));
        let secondly: Vec<_> = result
            .summaries
            .iter()
            .filter(|summary| summary.task_id == "secondly")
            .collect();
        assert_eq!(secondly.len(), 2);
        assert!(secondly.iter().all(|summary| summary.planned_truncated));
        assert!(secondly
            .iter()
            .all(|summary| summary.planned == MAX_OCCURRENCES_PER_DAY));
    }

    #[test]
    fn invalid_ranges_are_rejected() {
        let tz = shanghai();
        assert_eq!(
            compute(&[], &[], &[], query(10, 10), tz, 0).unwrap_err(),
            "E:cron_range"
        );
        assert_eq!(
            compute(&[], &[], &[], query(10, 5), tz, 0).unwrap_err(),
            "E:cron_range"
        );
        assert_eq!(
            compute(&[], &[], &[], query(0, MAX_RANGE_MS + 1), tz, 0).unwrap_err(),
            "E:cron_range"
        );
        assert!(compute(&[], &[], &[], query(0, MAX_RANGE_MS), tz, 0).is_ok());
    }

    #[test]
    fn runs_only_cover_the_past_part_of_the_range() {
        let tz = shanghai();
        let from = ms(tz, 2026, 10, 1, 0, 0);
        let to = ms(tz, 2026, 10, 3, 0, 0);
        let now = ms(tz, 2026, 10, 2, 12, 0);
        let tasks = [task("daily", "0 0 9 * * *", true, None)];
        let runs = [
            run("before", "daily", from - 1, RunState::Done, true),
            run(
                "first",
                "daily",
                ms(tz, 2026, 10, 1, 9, 0),
                RunState::Done,
                false,
            ),
            run(
                "second",
                "daily",
                ms(tz, 2026, 10, 2, 9, 0),
                RunState::Expired,
                false,
            ),
            run("future", "daily", now + 1, RunState::Pending, false),
        ];
        let result = compute(&tasks, &runs, &[], query(from, to), tz, now).unwrap();
        let run_ids: Vec<_> = result.runs.iter().map(|run| run.id.as_str()).collect();
        assert_eq!(run_ids, ["first", "second"]);
        // Past 09:00 slots are covered by runs; only the future slot on 10-02 remains planned.
        assert!(result.occurrences.is_empty());
    }

    #[test]
    fn last_run_is_the_latest_completed_run() {
        let tz = shanghai();
        let from = ms(tz, 2026, 10, 1, 0, 0);
        let to = ms(tz, 2026, 10, 2, 0, 0);
        let now = ms(tz, 2026, 10, 1, 12, 0);
        let tasks = [task("daily", "0 0 9 * * *", true, None)];
        let recent = [
            run("old", "daily", from - 3 * 86_400_000, RunState::Done, true),
            run(
                "expired",
                "daily",
                from - 86_400_000,
                RunState::Expired,
                false,
            ),
        ];
        let in_range = [run(
            "leased",
            "daily",
            now - 60_000,
            RunState::Leased,
            false,
        )];
        let result = compute(&tasks, &in_range, &recent, query(from, to), tz, now).unwrap();
        let last = result.tasks[0].last_run.as_ref().expect("last run");
        assert_eq!(last.id, "expired");
        assert_eq!(last.state, RunState::Expired);
    }

    #[test]
    fn store_reads_runs_and_computes_occurrences() {
        let (store, created) = store_with_task(create_bash_task_op("cron-1", "Daily"));
        let now = db::now_ms();
        let result = store
            .cron_occurrences(query(now - 3_600_000, now + 2 * 86_400_000))
            .expect("occurrences");
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].id, created.id);
        assert!(!result.time_zone.is_empty());
        assert!(store.cron_occurrences(query(now, now)).is_err());
    }
}

#[test]
fn automation_reports_finished_runs_but_not_skips_or_restart_recovery() {
    let (store, task) = store_with_task(create_bash_task_op("b1", "Backup"));
    let run = |success: bool, skipped: bool, output: &str| CompletedRun {
        task_id: task.id.clone(),
        success,
        started_at: db::now_ms(),
        duration_ms: 5,
        exit_code: Some(if success { 0 } else { 3 }),
        output: output.to_string(),
        counted: !skipped,
        skipped,
    };
    store
        .record_completed_run(run(false, false, "Command: x\nstderr:\n\nboom\n"))
        .expect("record failure");
    store
        .record_completed_run(run(
            false,
            true,
            "Skipped: previous run is still in progress.",
        ))
        .expect("record skip");
    store
        .record_completed_run(run(true, false, "ok"))
        .expect("record success");
    let finished = store.debug_finished_runs();
    assert_eq!(finished.len(), 2, "skips are not reported: {finished:?}");
    assert_eq!(finished[0].task_name, "Backup");
    assert!(!finished[0].success);
    assert_eq!(finished[0].excerpt, "boom");
    assert!(finished[1].success);

    // Prompt runs: completion and timeout are reported, restart recovery is not.
    let (store, task) = store_with_task(create_prompt_task_op("p1"));
    store.queue_prompt_run(&task, "", false).expect("queue");
    let claims = store.claim_prompt_runs().expect("claim");
    store
        .complete_prompt_run(CompletePromptRunInput {
            execution_id: claims[0].execution_id.clone(),
            success: false,
            duration_ms: 10,
            output: "model error".to_string(),
        })
        .expect("complete");
    store.queue_prompt_run(&task, "", false).expect("requeue");
    let claims = store.claim_prompt_runs().expect("claim again");
    store
        .debug_set_run_lease(&claims[0].execution_id, db::now_ms() - 1_000)
        .expect("force expiry");
    store.sweep_expired_prompt_runs().expect("sweep");
    store
        .queue_prompt_run(&task, "", false)
        .expect("queue before restart");
    store
        .recover_interrupted_prompt_runs()
        .expect("recover after restart");
    let finished = store.debug_finished_runs();
    assert_eq!(finished.len(), 2, "{finished:?}");
    assert_eq!(finished[0].excerpt, "model error");
    assert!(finished[1].excerpt.contains("timed out"));
}

#[test]
fn automation_run_notice_maps_outcome_to_category_and_throttles_per_task() {
    use super::notifications::{
        build_notice, output_excerpt, RunFinished, RUN_NOTICE_MIN_INTERVAL_MS,
    };
    use crate::services::notifications::{NotificationKind, NotificationService};

    let service = NotificationService::new();
    let failed = RunFinished {
        task_id: "t1".into(),
        task_name: "Backup".into(),
        success: false,
        excerpt: "exit 3".into(),
    };
    let notice = build_notice(&failed, &service);
    assert_eq!(notice.kind, NotificationKind::CronFailure);
    assert_eq!(notice.title, "Scheduled task failed: Backup");
    assert_eq!(notice.body, "exit 3");
    assert_eq!(
        notice.throttle,
        Some(("cron:t1:false".to_string(), RUN_NOTICE_MIN_INTERVAL_MS))
    );
    let succeeded = RunFinished {
        success: true,
        ..failed
    };
    let notice = build_notice(&succeeded, &service);
    assert_eq!(notice.kind, NotificationKind::CronSuccess);
    assert_eq!(notice.title, "Scheduled task finished: Backup");

    assert_eq!(output_excerpt("Command: x\nstdout:\nhello\n"), "hello");
    assert_eq!(output_excerpt("\n  first line \nsecond"), "first line");
    assert_eq!(output_excerpt(&"x".repeat(300)).chars().count(), 200);
}
