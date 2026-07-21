use super::{
    build_chat_event_envelope, build_chat_runtime_snapshot_envelope,
    build_gateway_runtime_status_envelope, build_local_settings_update_event_payload,
    chat_event_is_terminal, gateway_connection_needs_restart, gateway_connection_stale_after,
    gateway_reconnect_backoff, history_share_resolve_error_code, is_chat_runtime_wake_request_id,
    merge_settings_sync_snapshot, merge_settings_update_into_snapshot, proto,
    required_terminal_project_path_key, set_disconnected_status, GatewayChatRequestEvent,
    GatewayChatRuntimeSnapshot, GatewayController, GatewayStatusSnapshot, RemoteChatInboxRecord,
    GATEWAY_CHAT_LEASE_MS, GATEWAY_CHAT_RUNNING_LEASE_MS, GATEWAY_RECONNECT_MAX,
    GATEWAY_RECONNECT_MIN, GATEWAY_RECONNECT_STABLE_AFTER,
    GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE,
};
use crate::commands::settings::RemoteSettingsPayload;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn gateway_chat_request(
    request_id: &str,
    client_request_id: &str,
    conversation_id: &str,
    message: &str,
) -> GatewayChatRequestEvent {
    GatewayChatRequestEvent {
        request_id: request_id.to_string(),
        conversation_id: conversation_id.to_string(),
        client_request_id: client_request_id.to_string(),
        message: message.to_string(),
        rebased: false,
        base_message_ref: None,
        selected_model: None,
        runtime_controls: None,
        execution_mode: String::new(),
        workdir: String::new(),
        selected_system_tools: Vec::new(),
        uploaded_files: Vec::new(),
        queue_policy: String::new(),
    }
}

fn remote_chat_record(
    request: GatewayChatRequestEvent,
    state: &str,
    started: bool,
    now: Instant,
) -> RemoteChatInboxRecord {
    RemoteChatInboxRecord {
        request,
        state: state.to_string(),
        lease_owner: Some("worker-1".to_string()),
        lease_expires_at: Some(now + Duration::from_secs(30)),
        attempt: 1,
        started,
        last_error: None,
        created_at: now - Duration::from_secs(10),
        updated_at: now,
    }
}

#[test]
fn gateway_chat_command_mapping_preserves_rebase_signal() {
    let request = proto::ChatRequest {
        conversation_id: "conversation-1".to_string(),
        client_request_id: "client-1".to_string(),
        message: "edited".to_string(),
        execution_mode: "tools".to_string(),
        workdir: "/workspace".to_string(),
        selected_system_tools: vec!["http_get_test".to_string()],
        ..Default::default()
    };

    let event = GatewayController::build_gateway_chat_request_event(
        "run-1".to_string(),
        request,
        true,
        Some(proto::ChatMessageRef {
            segment_index: 2,
            message_index: 4,
            segment_id: "segment-c".to_string(),
            message_id: "user-c".to_string(),
            role: "user".to_string(),
            content_hash: "fnv1a32:00000000".to_string(),
        }),
    );

    assert_eq!(event.request_id, "run-1");
    assert_eq!(event.conversation_id, "conversation-1");
    assert_eq!(event.client_request_id, "client-1");
    assert_eq!(event.message, "edited");
    assert!(event.rebased);
    let base_message_ref = event
        .base_message_ref
        .as_ref()
        .expect("base message ref should be preserved");
    assert_eq!(base_message_ref.segment_index, 2);
    assert_eq!(base_message_ref.message_index, 4);
    assert_eq!(base_message_ref.segment_id, "segment-c");
    assert_eq!(base_message_ref.message_id, "user-c");
    assert_eq!(base_message_ref.role, "user");
    assert_eq!(base_message_ref.content_hash, "fnv1a32:00000000");
    assert_eq!(event.execution_mode, "tools");
    assert_eq!(event.workdir, "/workspace");
    assert_eq!(event.selected_system_tools, vec!["http_get_test"]);
}

#[test]
fn chat_runtime_snapshot_envelope_preserves_live_projection() {
    let envelope = build_chat_runtime_snapshot_envelope(GatewayChatRuntimeSnapshot {
        conversation_id: " conversation-1 ".to_string(),
        run_id: " run-1 ".to_string(),
        client_request_id: Some("client-1".to_string()),
        worker_id: Some("worker-1".to_string()),
        state: " running ".to_string(),
        cwd: Some("/workspace".to_string()),
        updated_at: 1_772_000_000_000,
        revision: 7,
        entries_json: r#"[{"id":"u1","kind":"user","text":"hello","attachments":[]}]"#.to_string(),
        tool_status: Some("Thinking...".to_string()),
        tool_status_is_compaction: true,
    })
    .expect("runtime snapshot envelope should be valid");

    assert_eq!(envelope.request_id, "chat-runtime-snapshot-run-1-7");
    match envelope.payload {
        Some(proto::agent_envelope::Payload::ChatRuntimeSnapshot(snapshot)) => {
            assert_eq!(snapshot.conversation_id, "conversation-1");
            assert_eq!(snapshot.run_id, "run-1");
            assert_eq!(snapshot.client_request_id, "client-1");
            assert_eq!(snapshot.worker_id, "worker-1");
            assert_eq!(snapshot.state, "running");
            assert_eq!(snapshot.cwd, "/workspace");
            assert_eq!(snapshot.updated_at, 1_772_000_000_000);
            assert_eq!(snapshot.revision, 7);
            assert!(snapshot.entries_json.contains("hello"));
            assert_eq!(snapshot.tool_status, "Thinking...");
            assert!(snapshot.tool_status_is_compaction);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
}

#[test]
fn chat_runtime_snapshot_envelope_rejects_missing_identity() {
    let err = build_chat_runtime_snapshot_envelope(GatewayChatRuntimeSnapshot {
        conversation_id: "conversation-1".to_string(),
        run_id: " ".to_string(),
        client_request_id: None,
        worker_id: None,
        state: "running".to_string(),
        cwd: None,
        updated_at: 0,
        revision: 1,
        entries_json: String::new(),
        tool_status: None,
        tool_status_is_compaction: false,
    })
    .expect_err("empty run id should be rejected");

    assert!(err.contains("run_id"));
}

#[test]
fn remote_chat_started_records_use_running_lease() {
    let now = Instant::now();
    let queued = remote_chat_record(
        gateway_chat_request("request-1", "client-1", "conversation-1", "hello"),
        "queued",
        false,
        now,
    );
    let running = remote_chat_record(
        gateway_chat_request("request-2", "client-2", "conversation-2", "hello"),
        "running",
        true,
        now,
    );

    assert_eq!(
        GatewayController::remote_chat_record_lease_ms(&queued),
        GATEWAY_CHAT_LEASE_MS
    );
    assert_eq!(
        GatewayController::remote_chat_record_lease_ms(&running),
        GATEWAY_CHAT_RUNNING_LEASE_MS
    );
    assert!(GATEWAY_CHAT_RUNNING_LEASE_MS > GATEWAY_CHAT_LEASE_MS);
}

#[test]
fn duplicate_remote_chat_request_preserves_running_record() {
    let now = Instant::now();
    let mut record = remote_chat_record(
        gateway_chat_request("request-1", "client-1", "conversation-1", "first"),
        "running",
        true,
        now,
    );
    let original_lease_owner = record.lease_owner.clone();
    let original_lease_expires_at = record.lease_expires_at;

    GatewayController::merge_duplicate_remote_chat_request(
        &mut record,
        gateway_chat_request("request-2", "client-1", "conversation-2", "replayed"),
        now + Duration::from_secs(1),
    );

    assert_eq!(record.request.request_id, "request-1");
    assert_eq!(record.request.client_request_id, "client-1");
    assert_eq!(record.request.conversation_id, "conversation-1");
    assert_eq!(record.request.message, "first");
    assert_eq!(record.state, "running");
    assert!(record.started);
    assert_eq!(record.lease_owner, original_lease_owner);
    assert_eq!(record.lease_expires_at, original_lease_expires_at);
    assert_eq!(
        GatewayController::remote_chat_record_control_type(&record),
        "started"
    );
    assert!(!GatewayController::remote_chat_record_should_wake_runtime(
        &record,
        now + Duration::from_secs(1),
    ));
}

#[test]
fn duplicate_queued_remote_chat_request_keeps_canonical_request_id() {
    let now = Instant::now();
    let mut record = remote_chat_record(
        gateway_chat_request("request-1", "client-1", "conversation-1", "first"),
        "queued",
        false,
        now,
    );
    record.lease_owner = None;
    record.lease_expires_at = None;

    GatewayController::merge_duplicate_remote_chat_request(
        &mut record,
        gateway_chat_request("request-2", "client-1", "conversation-2", "replayed"),
        now + Duration::from_secs(1),
    );

    assert_eq!(record.request.request_id, "request-1");
    assert_eq!(record.request.client_request_id, "client-1");
    assert_eq!(record.request.conversation_id, "conversation-2");
    assert_eq!(record.request.message, "replayed");
    assert_eq!(record.state, "queued");
    assert!(!record.started);
    assert!(GatewayController::remote_chat_record_should_wake_runtime(
        &record,
        now + Duration::from_secs(1),
    ));
}

#[test]
fn conversation_cancel_preserves_gui_queued_remote_requests() {
    let now = Instant::now();
    let queued_in_gui = remote_chat_record(
        gateway_chat_request("request-1", "client-1", "conversation-1", "first"),
        "queued_in_gui",
        false,
        now,
    );
    let queued = remote_chat_record(
        gateway_chat_request("request-2", "client-2", "conversation-1", "second"),
        "queued",
        false,
        now,
    );
    let claimed = remote_chat_record(
        gateway_chat_request("request-3", "client-3", "conversation-1", "third"),
        "claimed",
        false,
        now,
    );
    let running = remote_chat_record(
        gateway_chat_request("request-4", "client-4", "conversation-1", "fourth"),
        "running",
        true,
        now,
    );

    assert!(!GatewayController::remote_chat_record_should_cancel_for_conversation(&queued_in_gui));
    assert!(!GatewayController::remote_chat_record_should_cancel_for_conversation(&queued));
    assert!(GatewayController::remote_chat_record_should_cancel_for_conversation(&claimed));
    assert!(GatewayController::remote_chat_record_should_cancel_for_conversation(&running));
}

#[test]
fn history_share_resolve_error_code_maps_public_share_failures() {
    assert_eq!(history_share_resolve_error_code("分享 token 不能为空"), 400);
    assert_eq!(
        history_share_resolve_error_code("分享链接不存在或已关闭"),
        404
    );
    assert_eq!(
        history_share_resolve_error_code("未找到对应的历史对话"),
        404
    );
    assert_eq!(
        history_share_resolve_error_code("读取历史对话分享链接失败：db"),
        500
    );
}

#[test]
fn merge_settings_sync_snapshot_keeps_cached_ui_only_fields() {
    let db_snapshot = json!({
        "system": { "executionMode": "agent-dev" },
        "automationCron": { "revision": 3, "tasks": [{ "id": "cron-a" }] },
        "theme": "light",
        "locale": "zh-CN",
        "skills": {},
        "chatRuntimeControls": {
            "thinkingEnabled": true,
            "nativeWebSearchEnabled": true,
            "reasoning": "high"
        },
        "customSettings": {},
        "selectedModel": null,
    });
    let cached_snapshot = json!({
        "theme": "dark",
        "locale": "en-US",
        "skills": { "enabled": true },
        "chatRuntimeControls": {
            "thinkingEnabled": false,
            "nativeWebSearchEnabled": false,
            "reasoning": "xhigh"
        },
        "customSettings": {
            "conversationTitleModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5-mini"
            }
        },
        "selectedModel": {
            "customProviderId": "provider-a",
            "model": "gpt-5.4"
        },
    });

    let merged = merge_settings_sync_snapshot(db_snapshot, Some(&cached_snapshot))
        .expect("merge settings sync snapshot");

    assert_eq!(
        merged["automationCron"],
        json!({ "revision": 3, "tasks": [{ "id": "cron-a" }] })
    );
    assert_eq!(merged["theme"], json!("dark"));
    assert_eq!(merged["locale"], json!("en-US"));
    assert_eq!(merged["skills"], json!({ "enabled": true }));
    assert_eq!(
        merged["chatRuntimeControls"],
        json!({
            "thinkingEnabled": false,
            "nativeWebSearchEnabled": false,
            "reasoning": "xhigh"
        })
    );
    assert_eq!(
        merged["customSettings"],
        json!({
            "conversationTitleModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5-mini"
            }
        })
    );
    assert_eq!(
        merged["selectedModel"],
        json!({
            "customProviderId": "provider-a",
            "model": "gpt-5.4"
        })
    );
}

#[test]
fn merge_settings_sync_snapshot_without_cache_leaves_ui_only_fields_absent() {
    let db_snapshot = json!({
        "system": { "executionMode": "agent-dev" },
        "automationCron": { "revision": 3, "tasks": [{ "id": "cron-a" }] },
    });

    let merged =
        merge_settings_sync_snapshot(db_snapshot, None).expect("merge settings sync snapshot");

    let merged_map = merged.as_object().expect("merged snapshot object");
    assert!(!merged_map.contains_key("theme"));
    assert!(!merged_map.contains_key("locale"));
    assert!(!merged_map.contains_key("selectedModel"));
    assert_eq!(merged["system"], json!({ "executionMode": "agent-dev" }));
}

#[test]
fn merge_settings_update_into_snapshot_keeps_unrelated_fields() {
    let full_snapshot = json!({
        "system": { "executionMode": "agent-dev" },
        "theme": "dark",
        "locale": "en-US",
        "selectedModel": {
            "customProviderId": "provider-a",
            "model": "gpt-5.4"
        },
        "remote": { "enableWebTerminal": true },
    });
    let partial_update = json!({
        "theme": "system",
        "remote": { "enableWebTerminal": false },
    });

    let merged = merge_settings_update_into_snapshot(full_snapshot, partial_update)
        .expect("merge settings update into snapshot");

    assert_eq!(merged["theme"], json!("system"));
    assert_eq!(merged["locale"], json!("en-US"));
    assert_eq!(
        merged["selectedModel"],
        json!({
            "customProviderId": "provider-a",
            "model": "gpt-5.4"
        })
    );
    assert_eq!(merged["system"], json!({ "executionMode": "agent-dev" }));
    // Remote settings are desktop-owned and must not be overwritten by clients.
    assert_eq!(merged["remote"], json!({ "enableWebTerminal": true }));
}

#[test]
fn local_settings_update_event_keeps_private_api_key_updates_only_at_root() {
    let payload = json!({
        "customProviders": [
            {
                "id": "provider-a",
                "name": "A",
                "apiKey": "leaked-key"
            }
        ],
        "remote": {
            "enableWebTerminal": true
        },
        "providerApiKeyUpdates": {
            "provider-a": "new-key"
        }
    });

    let event_payload =
        build_local_settings_update_event_payload(payload).expect("build event payload");
    assert_eq!(event_payload.get("remote"), None);
    assert_eq!(event_payload["customProviders"][0]["apiKey"], Value::Null);
    assert_eq!(
        event_payload["customProviders"][0]["apiKeyConfigured"],
        true
    );
    assert_eq!(
        event_payload["providerApiKeyUpdates"]["provider-a"],
        "new-key"
    );
}

#[test]
fn terminal_project_path_key_is_required_for_gateway_requests() {
    assert_eq!(
        required_terminal_project_path_key(" /workspace/project ").as_deref(),
        Ok("/workspace/project")
    );
    assert_eq!(
        required_terminal_project_path_key(r" C:\Repo\ ").as_deref(),
        Ok("c:/repo")
    );
    assert!(required_terminal_project_path_key(" ").is_err());
}

#[test]
fn set_disconnected_status_resets_runtime_fields_for_new_config() {
    let config = RemoteSettingsPayload {
        enabled: true,
        gateway_url: "https://gateway.example.com".to_string(),
        grpc_port: 50051,
        grpc_endpoint: String::new(),
        token: "dev-token".to_string(),
        agent_id: "agent-new".to_string(),
        auto_reconnect: true,
        heartbeat_interval: 30,
        enable_web_terminal: false,
        enable_web_ssh_terminal: false,
        enable_web_git: false,
        enable_web_tunnels: false,
    };
    let mut status = GatewayStatusSnapshot {
        online: true,
        enabled: true,
        configured: true,
        gateway_url: "https://old-gateway.example.com".to_string(),
        agent_id: "agent-old".to_string(),
        session_id: Some("session-123".to_string()),
        connected_since: Some(123),
        last_heartbeat: Some(456),
        last_error: Some("previous error".to_string()),
        protocol: Some("v2".to_string()),
    };

    set_disconnected_status(
        &mut status,
        &config,
        Some("connect gateway failed".to_string()),
    );

    assert!(!status.online);
    assert!(status.enabled);
    assert!(status.configured);
    assert_eq!(status.gateway_url, "https://gateway.example.com");
    assert_eq!(status.agent_id, "agent-new");
    assert_eq!(status.session_id, None);
    assert_eq!(status.connected_since, None);
    assert_eq!(status.last_heartbeat, None);
    assert_eq!(status.last_error.as_deref(), Some("connect gateway failed"));
}

#[test]
fn chat_runtime_wake_ping_uses_dedicated_request_prefix() {
    assert!(is_chat_runtime_wake_request_id(
        "chat-runtime-wake-request-1"
    ));
    assert!(is_chat_runtime_wake_request_id(
        "  chat-runtime-wake-request-2  "
    ));
    assert!(!is_chat_runtime_wake_request_id("ping-request-1"));
}

#[test]
fn gateway_connection_nudge_detects_offline_and_stale_sessions() {
    let config = RemoteSettingsPayload {
        enabled: true,
        gateway_url: "https://gateway.example.com".to_string(),
        grpc_port: 50051,
        grpc_endpoint: String::new(),
        token: "dev-token".to_string(),
        agent_id: "agent".to_string(),
        auto_reconnect: true,
        heartbeat_interval: 30,
        enable_web_terminal: false,
        enable_web_ssh_terminal: false,
        enable_web_git: false,
        enable_web_tunnels: false,
    };
    assert_eq!(
        gateway_connection_stale_after(&config),
        Duration::from_secs(50)
    );

    let mut status = GatewayStatusSnapshot {
        online: false,
        enabled: true,
        configured: true,
        gateway_url: config.gateway_url.clone(),
        agent_id: config.agent_id.clone(),
        session_id: None,
        connected_since: None,
        last_heartbeat: None,
        last_error: None,
        protocol: None,
    };
    assert!(gateway_connection_needs_restart(&status, &config, 1_000));

    status.online = true;
    status.last_heartbeat = Some(960);
    assert!(!gateway_connection_needs_restart(&status, &config, 1_000));
    status.last_heartbeat = Some(940);
    assert!(gateway_connection_needs_restart(&status, &config, 1_000));

    let mut disabled = config.clone();
    disabled.enabled = false;
    assert!(!gateway_connection_needs_restart(&status, &disabled, 1_000));
}

#[test]
fn gateway_reconnect_backoff_is_fast_after_a_stable_session_and_bounded_on_failures() {
    let (first_delay, next_delay) =
        gateway_reconnect_backoff(GATEWAY_RECONNECT_MIN, Duration::from_secs(1));
    assert_eq!(first_delay, GATEWAY_RECONNECT_MIN);
    assert_eq!(next_delay, GATEWAY_RECONNECT_MIN * 2);

    let (capped_delay, capped_next) =
        gateway_reconnect_backoff(GATEWAY_RECONNECT_MAX, Duration::from_secs(1));
    assert_eq!(capped_delay, GATEWAY_RECONNECT_MAX);
    assert_eq!(capped_next, GATEWAY_RECONNECT_MAX);

    let (stable_delay, stable_next) =
        gateway_reconnect_backoff(GATEWAY_RECONNECT_MAX, GATEWAY_RECONNECT_STABLE_AFTER);
    assert_eq!(stable_delay, GATEWAY_RECONNECT_MIN);
    assert_eq!(stable_next, GATEWAY_RECONNECT_MIN * 2);
}

#[test]
fn build_chat_event_envelope_preserves_tool_result_arguments() {
    let envelope = build_chat_event_envelope(
        "request-1".to_string(),
        json!({
            "type": "tool_result",
            "conversation_id": "conversation-1",
            "id": "bash-call",
            "name": "Bash",
            "arguments": {
                "command": "printf live",
                "cwd": "crates/agent-gateway"
            },
            "content": [{ "type": "text", "text": "live" }],
            "isError": false,
            "round": 1
        }),
    )
    .expect("build chat event envelope");

    let chat_event = match envelope.payload.expect("payload") {
        super::proto::agent_envelope::Payload::ChatEvent(event) => event,
        _ => panic!("expected chat event payload"),
    };
    assert_eq!(chat_event.conversation_id, "conversation-1");
    assert_eq!(
        chat_event.r#type,
        super::proto::chat_event::ChatEventType::ToolResult as i32
    );

    let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
    assert_eq!(data["arguments"]["command"], "printf live");
    assert_eq!(data["arguments"]["cwd"], "crates/agent-gateway");
}

#[test]
fn build_chat_event_envelope_preserves_tool_status_retry_attempts() {
    let envelope = build_chat_event_envelope(
        "request-1".to_string(),
        json!({
            "type": "tool_status",
            "conversation_id": "conversation-1",
            "status": "第 1 轮：模型生成中...",
            "isCompaction": false,
            "retryAttempts": [
                { "attempt": 1, "maxAttempts": 5, "errorMessage": "503 service unavailable" }
            ]
        }),
    )
    .expect("build chat tool_status event envelope");

    let chat_event = match envelope.payload.expect("payload") {
        super::proto::agent_envelope::Payload::ChatEvent(event) => event,
        _ => panic!("expected chat event payload"),
    };
    assert_eq!(
        chat_event.r#type,
        super::proto::chat_event::ChatEventType::ToolStatus as i32
    );

    let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
    assert_eq!(data["status"], "第 1 轮：模型生成中...");
    assert_eq!(data["retryAttempts"][0]["attempt"], 1);
    assert_eq!(data["retryAttempts"][0]["maxAttempts"], 5);
    assert_eq!(
        data["retryAttempts"][0]["errorMessage"],
        "503 service unavailable"
    );

    // Status-only events keep the key as an explicit null (WebUI treats
    // null/absent as "leave the current list untouched").
    let plain = build_chat_event_envelope(
        "request-1".to_string(),
        json!({
            "type": "tool_status",
            "conversation_id": "conversation-1",
            "status": "Running",
            "isCompaction": false
        }),
    )
    .expect("build plain tool_status event envelope");
    let plain_event = match plain.payload.expect("payload") {
        super::proto::agent_envelope::Payload::ChatEvent(event) => event,
        _ => panic!("expected chat event payload"),
    };
    let plain_data: Value = serde_json::from_str(&plain_event.data).expect("chat event data");
    assert!(plain_data["retryAttempts"].is_null());
}

#[test]
fn build_chat_event_envelope_preserves_title_final_flag() {
    let envelope = build_chat_event_envelope(
        "request-1".to_string(),
        json!({
            "type": "token",
            "conversation_id": "conversation-1",
            "text": "",
            "title": "Final title",
            "titleFinal": true
        }),
    )
    .expect("build chat title event envelope");

    let chat_event = match envelope.payload.expect("payload") {
        super::proto::agent_envelope::Payload::ChatEvent(event) => event,
        _ => panic!("expected chat event payload"),
    };
    assert_eq!(chat_event.conversation_id, "conversation-1");
    assert_eq!(
        chat_event.r#type,
        super::proto::chat_event::ChatEventType::Token as i32
    );

    let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
    assert_eq!(data["title"], "Final title");
    assert_eq!(data["titleFinal"], true);
}

#[test]
fn build_chat_event_envelope_preserves_hosted_search_payload() {
    let envelope = build_chat_event_envelope(
        "request-1".to_string(),
        json!({
            "type": "hosted_search",
            "conversation_id": "conversation-1",
            "id": "search-1",
            "provider": "codex",
            "status": "completed",
            "queries": ["设计模式定义"],
            "sources": [
                {
                    "url": "https://example.com/pattern",
                    "title": "设计模式",
                    "sourceType": "citation"
                }
            ],
            "updatedAt": 1234,
            "round": 2
        }),
    )
    .expect("build hosted search event envelope");

    let chat_event = match envelope.payload.expect("payload") {
        super::proto::agent_envelope::Payload::ChatEvent(event) => event,
        _ => panic!("expected chat event payload"),
    };
    assert_eq!(chat_event.conversation_id, "conversation-1");
    assert_eq!(
        chat_event.r#type,
        super::proto::chat_event::ChatEventType::HostedSearch as i32
    );

    let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
    assert_eq!(data["id"], "search-1");
    assert_eq!(data["provider"], "codex");
    assert_eq!(data["status"], "completed");
    assert_eq!(data["queries"][0], "设计模式定义");
    assert_eq!(data["sources"][0]["url"], "https://example.com/pattern");
    assert_eq!(data["updatedAt"], 1234);
    assert_eq!(data["round"], 2);
}

#[test]
fn build_chat_event_envelope_preserves_user_message_payload() {
    let envelope = build_chat_event_envelope(
        "request-1".to_string(),
        json!({
            "type": "user_message",
            "conversation_id": "conversation-1",
            "message": "queued prompt",
            "uploaded_files": [
                {
                    "relativePath": "notes.md",
                    "absolutePath": "/workspace/notes.md",
                    "fileName": "notes.md",
                    "kind": "text",
                    "sizeBytes": 12
                }
            ],
            "execution_mode": "agent"
        }),
    )
    .expect("build user message event envelope");

    let chat_event = match envelope.payload.expect("payload") {
        super::proto::agent_envelope::Payload::ChatEvent(event) => event,
        _ => panic!("expected chat event payload"),
    };
    assert_eq!(chat_event.conversation_id, "conversation-1");
    assert_eq!(
        chat_event.r#type,
        super::proto::chat_event::ChatEventType::UserMessage as i32
    );

    let data: Value = serde_json::from_str(&chat_event.data).expect("chat event data");
    assert_eq!(data["message"], "queued prompt");
    assert_eq!(data["uploaded_files"][0]["relativePath"], "notes.md");
    assert_eq!(data["uploaded_files"][0]["kind"], "text");
    assert_eq!(data["execution_mode"], "agent");
}

#[test]
fn chat_event_terminal_detection_covers_done_and_error_only() {
    assert!(chat_event_is_terminal(&json!({ "type": "done" })));
    assert!(chat_event_is_terminal(
        &json!({ "type": "error", "message": "boom" })
    ));
    assert!(chat_event_is_terminal(&json!({ "type": " done " })));
    assert!(!chat_event_is_terminal(
        &json!({ "type": "token", "text": "hi" })
    ));
    assert!(!chat_event_is_terminal(&json!({ "type": "tool_call" })));
    assert!(!chat_event_is_terminal(&json!({ "kind": "done" })));
    assert!(!chat_event_is_terminal(&json!("done")));
}

#[test]
fn runtime_status_envelope_carries_run_reports() {
    let active_run = proto::ChatRunReport {
        run_id: "run-1".to_string(),
        conversation_id: "conversation-1".to_string(),
        state: "running".to_string(),
        error_code: String::new(),
        message: String::new(),
        updated_at: 1_772_000_000_000,
    };
    let finished_run = proto::ChatRunReport {
        run_id: "run-2".to_string(),
        conversation_id: "conversation-2".to_string(),
        state: "failed".to_string(),
        error_code: "desktop_run_lost".to_string(),
        message: "The desktop runtime stopped reporting this run.".to_string(),
        updated_at: 1_772_000_000_500,
    };

    let envelope = build_gateway_runtime_status_envelope(
        "worker-1".to_string(),
        "busy".to_string(),
        true,
        2,
        vec![active_run],
        vec![finished_run],
    );

    let status = match envelope.payload.expect("payload") {
        super::proto::agent_envelope::Payload::RuntimeStatus(status) => status,
        _ => panic!("expected runtime status payload"),
    };
    assert_eq!(status.worker_id, "worker-1");
    assert_eq!(status.state, "busy");
    assert!(status.visible);
    assert_eq!(status.active_run_count, 2);
    assert_eq!(status.active_runs.len(), 1);
    assert_eq!(status.active_runs[0].run_id, "run-1");
    assert_eq!(status.active_runs[0].state, "running");
    assert_eq!(status.active_runs[0].updated_at, 1_772_000_000_000);
    assert_eq!(status.finished_runs.len(), 1);
    assert_eq!(status.finished_runs[0].run_id, "run-2");
    assert_eq!(status.finished_runs[0].state, "failed");
    assert_eq!(status.finished_runs[0].error_code, "desktop_run_lost");
    assert_eq!(
        status.finished_runs[0].message,
        "The desktop runtime stopped reporting this run."
    );
}

#[test]
fn runtime_status_republish_record_tracks_last_webview_report() {
    let now = Instant::now();
    let record =
        GatewayController::next_runtime_status_republish_record("worker-1", "busy", true, 2, now)
            .expect("busy state must be recorded for republish");
    assert_eq!(record.worker_id, "worker-1");
    assert_eq!(record.state, "busy");
    assert!(record.visible);
    assert_eq!(record.active_run_count, 2);

    // "suspended" is the webview's goodbye: stop echoing on its behalf.
    assert!(GatewayController::next_runtime_status_republish_record(
        "worker-1",
        "suspended",
        false,
        0,
        now,
    )
    .is_none());
}

#[test]
fn runtime_status_republish_payload_expires_after_max_age() {
    let now = Instant::now();
    let record =
        GatewayController::next_runtime_status_republish_record("worker-1", "ready", true, 0, now)
            .expect("record");

    let fresh = GatewayController::runtime_status_republish_payload(
        Some(&record),
        now + GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE - Duration::from_secs(1),
    );
    assert_eq!(
        fresh,
        Some(("worker-1".to_string(), "ready".to_string(), true, 0))
    );

    // A webview that has been silent past the max age (it refreshes the
    // record at least once a minute even when throttled) is gone; the echo
    // must stop instead of impersonating it.
    let stale = GatewayController::runtime_status_republish_payload(
        Some(&record),
        now + GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE + Duration::from_secs(1),
    );
    assert_eq!(stale, None);

    assert_eq!(
        GatewayController::runtime_status_republish_payload(None, now),
        None
    );
}
