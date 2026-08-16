use serde_json::json;

use super::db;
use super::store::AutomationStore;
use super::types::*;
use super::validate::validate_cron_expression;

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
fn queue_prompt_run_lease_uses_task_timeout() {
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

    assert!(matches!(
        store
            .queue_prompt_run(&task, "", true)
            .expect("queue prompt run"),
        super::store::PromptQueueOutcome::Queued
    ));
    let claims = store.claim_prompt_runs().expect("claim");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].lease_expires_at - claims[0].started_at, 30_000);
}
