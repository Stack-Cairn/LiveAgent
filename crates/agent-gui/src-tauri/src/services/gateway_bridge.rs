use std::{collections::HashSet, sync::Arc};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::{
    chat_file_links::open_chat_file_link_for_conversation,
    chat_history,
    chat_history::ChatHistoryMessageRef,
    checkpoint,
    fs::{
        fs_create_dir_sync, fs_delete_sync, fs_list_dirs_sync, fs_list_sync, fs_mention_list_sync,
        fs_read_editable_text_sync, fs_read_workspace_image_sync, fs_rename_sync, fs_roots_sync,
        fs_write_text_sync,
    },
    git::{git_gateway_clone_task_action_sync, GitCloneTaskRegistry},
    root_grants::{
        workspace_root_grants_apply, workspace_root_grants_list, workspace_root_grants_revoke,
        WorkspaceRootAccess, WorkspaceRootGrant, WorkspaceRootGrantDraft,
    },
    settings::{load_providers, open_db},
    system::{
        system_create_project_folder_sync, system_import_directory_abort_sync,
        system_import_directory_chunk_sync, system_import_directory_commit_sync,
        system_import_directory_start_sync, system_import_directory_sync,
        system_import_uploaded_readable_files_sync, system_list_skill_files_sync,
        system_read_skill_metadata_sync, system_read_skill_text_sync,
        system_read_uploaded_image_preview_sync, SystemImportDirectoryInputFile,
        SystemReadableFileUploadInput,
    },
};
use crate::services::automation::{
    validate_cron_expression, AutomationApplyInput, AutomationStore,
};
use crate::services::gateway::proto;
use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};
use crate::services::provider_usage::{ProviderUsageResult, ProviderUsageService};
use crate::services::skills::system_manage_skill_sync;

const DEFAULT_HISTORY_LIST_PAGE: i32 = 1;
const DEFAULT_HISTORY_LIST_PAGE_SIZE: i32 = 80;

pub fn provider_usage_response(
    result: ProviderUsageResult,
) -> Result<proto::ProviderUsageResponse, String> {
    let result_json = serde_json::to_string(&result)
        .map_err(|error| format!("serialize provider usage result failed: {error}"))?;
    Ok(proto::ProviderUsageResponse { result_json })
}

pub async fn handle_provider_usage(
    service: Arc<ProviderUsageService>,
    request: proto::ProviderUsageRequest,
) -> Result<proto::ProviderUsageResponse, String> {
    // config_json 非空 = 按草稿测试(忽略启用开关、不读写缓存);空 = 常规查询。
    let result = if request.config_json.is_empty() {
        service.query(&request.provider_id, request.refresh).await
    } else {
        service
            .test(&request.provider_id, &request.config_json)
            .await
    };
    provider_usage_response(result)
}

pub async fn handle_checkpoint(
    request: proto::CheckpointRequest,
) -> Result<proto::CheckpointResponse, String> {
    let action = request.action.trim().to_string();
    let result_json = match action.as_str() {
        "list" => {
            serde_json::to_string(&checkpoint::checkpoint_list(request.conversation_id).await?)
                .map_err(|error| format!("serialize checkpoint list failed: {error}"))?
        }
        "diff" => serde_json::to_string(
            &checkpoint::checkpoint_diff_stats(
                request.conversation_id,
                request.turn_seq,
                request.authorized_roots,
            )
            .await?,
        )
        .map_err(|error| format!("serialize checkpoint diff failed: {error}"))?,
        "rewind" => {
            let expected = request
                .expected
                .into_iter()
                .map(|entry| checkpoint::CheckpointExpectedEntry {
                    key: entry.key,
                    current_hash: entry.current_hash,
                })
                .collect();
            serde_json::to_string(
                &checkpoint::checkpoint_rewind_code(
                    request.conversation_id,
                    request.turn_seq,
                    request.authorized_roots,
                    expected,
                )
                .await?,
            )
            .map_err(|error| format!("serialize checkpoint rewind failed: {error}"))?
        }
        _ => return Err(format!("unsupported checkpoint action: {action}")),
    };
    Ok(proto::CheckpointResponse {
        action,
        result_json,
    })
}

#[derive(Debug, Deserialize)]
struct HistorySharedListArgs {
    page: i64,
    #[serde(alias = "pageSize")]
    page_size: i64,
}

/// Gateway relay for the automation domain. Web clients speak the same
/// versioned apply protocol as the desktop webview and the LLM tool; the
/// legacy per-task create/update/delete actions no longer exist.
pub async fn handle_cron_manage(
    app: AppHandle,
    store: Arc<AutomationStore>,
    request: proto::CronManageRequest,
) -> Result<proto::CronManageResponse, String> {
    let action = request.action.trim().to_string();
    let result_json = match action.as_str() {
        "snapshot" => {
            let store = Arc::clone(&store);
            let snapshot = tauri::async_runtime::spawn_blocking(move || store.snapshot())
                .await
                .map_err(|e| format!("gateway automation snapshot join failed: {e}"))??;
            serialize_cron_manage_result(&snapshot)?
        }
        "cron_apply" => {
            let input = parse_apply_input(&request.task_json)?;
            let store = Arc::clone(&store);
            let response = tauri::async_runtime::spawn_blocking(move || store.cron_apply(input))
                .await
                .map_err(|e| format!("gateway cron apply join failed: {e}"))??;
            serialize_cron_manage_result(&response)?
        }
        "hooks_apply" => {
            let input = parse_apply_input(&request.task_json)?;
            let store = Arc::clone(&store);
            let response = tauri::async_runtime::spawn_blocking(move || store.hooks_apply(input))
                .await
                .map_err(|e| format!("gateway hooks apply join failed: {e}"))??;
            serialize_cron_manage_result(&response)?
        }
        "list_runs" => {
            let task_id = parse_required_cron_task_id(&request, "list_runs")?;
            let limit = parse_runs_limit(&request.task_json)?;
            let store = Arc::clone(&store);
            let runs =
                tauri::async_runtime::spawn_blocking(move || store.list_runs(&task_id, limit))
                    .await
                    .map_err(|e| format!("gateway list_runs join failed: {e}"))??;
            serialize_cron_manage_result(&json!({ "runs": runs }))?
        }
        "clear_runs" => {
            let task_id = parse_required_cron_task_id(&request, "clear_runs")?;
            let store = Arc::clone(&store);
            let cleared = tauri::async_runtime::spawn_blocking(move || store.clear_runs(&task_id))
                .await
                .map_err(|e| format!("gateway clear_runs join failed: {e}"))??;
            serialize_cron_manage_result(&json!({ "clearedCount": cleared }))?
        }
        "run_now" => {
            let task_id = parse_required_cron_task_id(&request, "run_now")?;
            let store = Arc::clone(&store);
            let response =
                tauri::async_runtime::spawn_blocking(move || store.run_cron_task_now(&task_id))
                    .await
                    .map_err(|e| format!("gateway run_now join failed: {e}"))??;
            serialize_cron_manage_result(&response)?
        }
        "occurrences" => {
            let query = parse_occurrence_query(&request.task_json)?;
            let response =
                crate::services::automation::kbrain_occurrences::query(app, query).await?;
            serialize_cron_manage_result(&response)?
        }
        "validate" => {
            let expression = parse_validate_expression(&request.task_json)?;
            tauri::async_runtime::spawn_blocking(move || validate_cron_expression(&expression))
                .await
                .map_err(|e| format!("gateway cron validate join failed: {e}"))??;
            serialize_cron_manage_result(&json!({ "valid": true }))?
        }
        other => return Err(format!("unsupported cron action: {other}")),
    };

    Ok(proto::CronManageResponse {
        action,
        result_json,
    })
}

pub async fn handle_history_list(
    request: proto::HistoryListRequest,
) -> Result<proto::HistoryListResponse, String> {
    let page_number = if request.page > 0 {
        request.page
    } else {
        DEFAULT_HISTORY_LIST_PAGE
    };
    let page_size = if request.page_size > 0 {
        request.page_size
    } else {
        DEFAULT_HISTORY_LIST_PAGE_SIZE
    };
    let cwd = request.cwd.trim().to_string();
    let cwd = if cwd.is_empty() { None } else { Some(cwd) };
    let page = chat_history::chat_history_list(
        i64::from(page_number),
        i64::from(page_size),
        cwd,
        Some(request.cwd_empty),
    )
    .await?;
    Ok(build_proto_history_list_response(page))
}

fn build_proto_history_list_response(
    page: chat_history::ChatHistoryListResponse,
) -> proto::HistoryListResponse {
    let total_count = i32::try_from(page.total_count).unwrap_or(i32::MAX);
    let conversations = page
        .items
        .into_iter()
        .map(|item| proto::ConversationSummary {
            id: item.id,
            title: item.title,
            created_at: item.created_at,
            updated_at: item.updated_at,
            message_count: i32::try_from(item.message_count).unwrap_or(i32::MAX),
            provider_id: item.provider_id,
            model: item.model,
            session_id: item.session_id.unwrap_or_default(),
            cwd: item.cwd.unwrap_or_default(),
            selected_model_json: item.selected_model_json.unwrap_or_default(),
            is_pinned: item.is_pinned,
            pinned_at: item.pinned_at.unwrap_or_default(),
            is_shared: item.is_shared,
        })
        .collect();

    proto::HistoryListResponse {
        conversations,
        total_count,
    }
}

pub async fn handle_history_workdirs() -> Result<proto::HistoryWorkdirsResponse, String> {
    let response = chat_history::chat_history_workdirs().await?;
    Ok(proto::HistoryWorkdirsResponse {
        workdirs: response
            .workdirs
            .into_iter()
            .map(|item| proto::HistoryWorkdirSummary {
                path: item.path,
                conversation_count: i32::try_from(item.conversation_count).unwrap_or(i32::MAX),
                updated_at: item.updated_at,
            })
            .collect(),
    })
}

/// 轨迹按需拉取：事件窗口、Prompt 分段和子代理运行各用独立字段。
///
/// 三种只读诊断查询合并在一个信封臂里，因为调用方与生命周期完全一致（都只在
/// WebUI 打开轨迹页后发生），同时保持 section id 与 subagent run id 的协议语义分离。
pub async fn handle_trajectory_fetch(
    request: proto::TrajectoryFetchRequest,
) -> Result<proto::TrajectoryFetchResponse, String> {
    let conversation_id = request.conversation_id.clone();
    if request.include_subagent_runs {
        let runs = chat_history::trajectory_get_subagent_runs_inner(
            conversation_id.clone(),
            request.subagent_run_ids,
        )
        .await?;
        return Ok(proto::TrajectoryFetchResponse {
            conversation_id,
            events_json: String::new(),
            truncated: false,
            sections: Vec::new(),
            oldest_segment_index: 0,
            returned_segment_count: 0,
            total_segment_count: 0,
            has_more_before: false,
            subagent_runs_json: runs.runs_json,
        });
    }
    if !request.section_ids.is_empty() {
        let sections =
            chat_history::trajectory_get_sections(conversation_id.clone(), request.section_ids)
                .await?;
        return Ok(proto::TrajectoryFetchResponse {
            conversation_id,
            events_json: String::new(),
            truncated: false,
            sections: sections
                .into_iter()
                .map(|section| proto::TrajectorySectionPayload {
                    section_id: section.section_id,
                    slot: section.slot,
                    content: section.content,
                    bytes: section.bytes,
                })
                .collect(),
            oldest_segment_index: 0,
            returned_segment_count: 0,
            total_segment_count: 0,
            has_more_before: false,
            subagent_runs_json: String::new(),
        });
    }

    let events = chat_history::trajectory_get_window_inner(
        conversation_id.clone(),
        i64::from(request.max_segments),
        request.before_segment_index.map(i64::from),
    )
    .await?;
    Ok(proto::TrajectoryFetchResponse {
        conversation_id,
        events_json: events.events_json,
        truncated: events.truncated,
        sections: Vec::new(),
        oldest_segment_index: i32::try_from(events.oldest_segment_index).unwrap_or(i32::MAX),
        returned_segment_count: i32::try_from(events.returned_segment_count).unwrap_or(i32::MAX),
        total_segment_count: i32::try_from(events.total_segment_count).unwrap_or(i32::MAX),
        has_more_before: events.has_more_before,
        subagent_runs_json: String::new(),
    })
}

pub async fn handle_history_get(
    request: proto::HistoryGetRequest,
) -> Result<proto::HistoryGetResponse, String> {
    let max_messages = i64::from(request.max_messages).max(0);
    let record = if max_messages > 0 {
        chat_history::chat_history_get_tail(request.conversation_id.clone(), max_messages).await?
    } else {
        chat_history::chat_history_get(request.conversation_id.clone()).await?
    };
    let (messages_json, returned_message_count) =
        flatten_history_messages_json_window(&record.segments, max_messages)?;
    let total_message_count = i32::try_from(record.total_message_count).unwrap_or(i32::MAX);

    Ok(proto::HistoryGetResponse {
        conversation_id: record.id.clone(),
        messages_json,
        total_message_count,
        returned_message_count,
        has_more: max_messages > 0
            && i64::from(returned_message_count) < record.total_message_count,
        conversation: Some(build_proto_conversation_summary_from_record(&record)),
    })
}

pub async fn handle_history_prefix(
    request: proto::HistoryPrefixRequest,
) -> Result<proto::HistoryPrefixResponse, String> {
    let max_messages = i64::from(request.max_messages).max(0);
    let base_message_ref = request
        .base_message_ref
        .as_ref()
        .ok_or_else(|| "history.prefix requires base_message_ref".to_string())?;
    let base_message_ref = history_message_ref_from_proto(base_message_ref);
    chat_history::validate_user_history_message_ref(&base_message_ref)?;

    let record = chat_history::chat_history_get(request.conversation_id.clone()).await?;
    let (prefix_segments, prefix_message_count) =
        chat_history::build_history_prefix_segments(&record.segments, &base_message_ref)?;
    let (messages_json, returned_message_count) =
        flatten_history_messages_json_window(&prefix_segments, max_messages)?;

    Ok(proto::HistoryPrefixResponse {
        conversation_id: record.id.clone(),
        messages_json,
        total_message_count: i32::try_from(prefix_message_count).unwrap_or(i32::MAX),
        returned_message_count,
        has_more: max_messages > 0 && i64::from(returned_message_count) < prefix_message_count,
        conversation: Some(build_proto_conversation_summary_from_record(&record)),
    })
}

pub async fn handle_history_rename(
    request: proto::HistoryRenameRequest,
) -> Result<proto::HistoryRenameResponse, String> {
    let summary =
        chat_history::chat_history_rename_inner(request.conversation_id.clone(), request.title)
            .await?;

    Ok(proto::HistoryRenameResponse {
        conversation: Some(build_proto_conversation_summary(summary)),
    })
}

pub async fn handle_history_branch(
    request: proto::HistoryBranchRequest,
) -> Result<proto::HistoryBranchResponse, String> {
    let base_message_ref = request
        .base_message_ref
        .as_ref()
        .ok_or_else(|| "history.branch requires base_message_ref".to_string())?;
    let anchor = history_message_ref_from_proto(base_message_ref);
    chat_history::validate_user_history_message_ref(&anchor)?;
    let summary =
        chat_history::chat_history_branch_inner(request.conversation_id.clone(), anchor).await?;

    Ok(proto::HistoryBranchResponse {
        conversation: Some(build_proto_conversation_summary(summary)),
    })
}

pub async fn handle_history_pin(
    request: proto::HistoryPinRequest,
) -> Result<proto::HistoryPinResponse, String> {
    let summary =
        chat_history::chat_history_set_pinned_inner(request.conversation_id, request.is_pinned)
            .await?;

    Ok(proto::HistoryPinResponse {
        conversation: Some(build_proto_conversation_summary(summary)),
    })
}

pub async fn handle_history_set_cwd(
    request: proto::HistorySetCwdRequest,
) -> Result<proto::HistorySetCwdResponse, String> {
    let summary =
        chat_history::chat_history_set_cwd_inner(request.conversation_id, request.cwd).await?;

    Ok(proto::HistorySetCwdResponse {
        conversation: Some(build_proto_conversation_summary(summary)),
    })
}

pub async fn handle_history_share_get(
    request: proto::HistoryShareGetRequest,
) -> Result<proto::HistoryShareGetResponse, String> {
    let status = chat_history::chat_history_share_get_inner(request.conversation_id).await?;

    Ok(proto::HistoryShareGetResponse {
        share: Some(build_proto_history_share_status(status)),
    })
}

pub async fn handle_history_share_set(
    request: proto::HistoryShareSetRequest,
) -> Result<proto::HistoryShareSetResponse, String> {
    let status = chat_history::chat_history_share_set_inner(
        request.conversation_id,
        request.enabled,
        request.redact_tool_content,
    )
    .await?;

    Ok(proto::HistoryShareSetResponse {
        share: Some(build_proto_history_share_status(status)),
    })
}

pub async fn handle_history_share_resolve(
    request: proto::HistoryShareResolveRequest,
) -> Result<proto::HistoryShareResolveResponse, String> {
    let record = chat_history::chat_history_share_resolve_inner(request.token).await?;
    let messages_json = flatten_history_messages_json(&record.segments)?;
    let messages_json = if record.redact_tool_content {
        redact_builtin_tool_content_json(&messages_json)?
    } else {
        messages_json
    };
    let total_message_count = i32::try_from(record.total_message_count).unwrap_or(i32::MAX);

    Ok(proto::HistoryShareResolveResponse {
        conversation_id: record.id.clone(),
        messages_json,
        total_message_count,
        conversation: Some(build_proto_conversation_summary_from_record(&record)),
        redact_tool_content: record.redact_tool_content,
    })
}

pub async fn handle_history_delete(
    request: proto::HistoryDeleteRequest,
) -> Result<proto::HistoryDeleteResponse, String> {
    chat_history::chat_history_delete_inner(request.conversation_id).await?;
    Ok(proto::HistoryDeleteResponse {})
}

pub(crate) async fn kbrain_gateway_settings(app: AppHandle) -> Result<Value, String> {
    kbrain_gateway_resource(app, "/v1/settings").await
}

pub(crate) async fn kbrain_gateway_mcp_settings(app: AppHandle) -> Result<Value, String> {
    kbrain_gateway_resource(app, "/v1/mcp").await
}

async fn kbrain_gateway_resource(app: AppHandle, path: &str) -> Result<Value, String> {
    let backend = app
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or_else(|| "K-brain backend state is unavailable".to_string())?;
    let connection = tauri::async_runtime::spawn_blocking({
        let backend = Arc::clone(backend.inner());
        let app = app.clone();
        move || backend.ensure_started(&app)
    })
    .await
    .map_err(|error| format!("K-brain backend startup task failed: {error}"))??;
    kbrain_prompt_request(&connection, reqwest::Method::GET, path, None).await
}

pub async fn handle_provider_list(app: AppHandle) -> Result<proto::ProviderListResponse, String> {
    let settings = kbrain_gateway_settings(app).await?;
    let providers = settings.get("providers").cloned();

    let providers_json = serde_json::to_string(&sanitize_provider_summaries(providers)?)
        .map_err(|e| format!("serialize gateway provider list failed: {e}"))?;

    Ok(proto::ProviderListResponse { providers_json })
}

pub async fn handle_provider_models(
    app: AppHandle,
    request: proto::ProviderModelsRequest,
) -> Result<proto::ProviderModelsResponse, String> {
    let backend = app
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or_else(|| "K-brain backend state is unavailable".to_string())?;
    let connection = tauri::async_runtime::spawn_blocking({
        let backend = Arc::clone(backend.inner());
        let app = app.clone();
        move || backend.ensure_started(&app)
    })
    .await
    .map_err(|error| format!("K-brain backend startup task failed: {error}"))??;
    let provider_id = request.provider_id.trim().to_string();
    let provider_type = request.provider_type.trim().to_string();
    let request_headers = request.custom_headers.as_ref().map(|headers| {
        headers
            .headers
            .iter()
            .map(|header| (header.name.clone(), header.value.clone()))
            .collect::<Vec<_>>()
    });
    let config = if request.api_key.trim().is_empty() {
        let provider_id_for_lookup = provider_id.clone();
        let provider_type_for_lookup = provider_type.clone();
        let request_headers_for_lookup = request_headers.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            resolve_stored_provider_models_config(
                &provider_id_for_lookup,
                &provider_type_for_lookup,
                request.is_full_url,
                request_headers_for_lookup,
                load_providers(&conn)?,
            )
        })
        .await
        .map_err(|error| format!("读取供应商 API Key 任务失败：{error}"))??
    } else {
        ProviderModelsRequestConfig {
            provider_type: provider_type.clone(),
            base_url: request.base_url.trim().to_string(),
            api_key: request.api_key.trim().to_string(),
            use_system_proxy: request.use_system_proxy,
            models_url: request.models_url.trim().to_string(),
            is_full_url: request.is_full_url.unwrap_or(false),
            custom_headers: request_headers.unwrap_or_default(),
        }
    };
    let api = match config.provider_type.as_str() {
        "gemini" => "google-generative-ai",
        "claude_code" => "anthropic-messages",
        "codex" => match request.request_format.trim() {
            "openai-completions" => "openai-completions",
            _ => "openai-responses",
        },
        "xai" => "openai-responses",
        "deepseek" => "openai-completions",
        other => return Err(format!("unsupported provider type: {other}")),
    };
    let mut body = serde_json::json!({
        "type": config.provider_type,
        "api": api,
        "baseUrl": config.base_url,
        "apiKey": config.api_key,
        "isFullUrl": config.is_full_url,
        "modelsUrl": config.models_url,
        "useSystemProxy": config.use_system_proxy,
        "requestFormat": request.request_format.trim(),
    });
    if !provider_id.is_empty() {
        body["providerId"] = Value::String(provider_id);
    }
    body["customHeaders"] = serde_json::to_value(
        config
            .custom_headers
            .iter()
            .map(|(key, value)| json!({ "key": key, "value": value }))
            .collect::<Vec<_>>(),
    )
    .map_err(|error| format!("serialize provider headers failed: {error}"))?;
    let models = kbrain_provider_models(&connection, body).await?;
    Ok(proto::ProviderModelsResponse {
        models_json: serde_json::to_string(&models)
            .map_err(|error| format!("serialize K-brain model response failed: {error}"))?,
    })
}

#[derive(Debug, PartialEq)]
struct ProviderModelsRequestConfig {
    provider_type: String,
    base_url: String,
    api_key: String,
    use_system_proxy: bool,
    models_url: String,
    is_full_url: bool,
    custom_headers: Vec<(String, String)>,
}

fn resolve_stored_provider_models_config(
    provider_id: &str,
    expected_provider_type: &str,
    is_full_url: Option<bool>,
    custom_headers: Option<Vec<(String, String)>>,
    providers: Option<Value>,
) -> Result<ProviderModelsRequestConfig, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("请先填写 API Key".to_string());
    }
    let providers = providers
        .and_then(|value| value.as_array().cloned())
        .ok_or_else(|| "未找到已保存的供应商".to_string())?;
    let provider = providers
        .into_iter()
        .find(|provider| provider.get("id").and_then(Value::as_str) == Some(provider_id))
        .ok_or_else(|| "未找到已保存的供应商".to_string())?;
    let stored_provider_type = provider
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if stored_provider_type != expected_provider_type.trim() {
        return Err("供应商类型与已保存配置不匹配".to_string());
    }
    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "已保存的供应商未配置 API Key".to_string())?;
    let base_url = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let models_url = provider
        .get("modelsUrl")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let stored_headers = provider
        .get("customHeaders")
        .and_then(Value::as_array)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|header| {
                    let key = header.get("key").and_then(Value::as_str)?.trim();
                    let value = header.get("value").and_then(Value::as_str)?;
                    (!key.is_empty()).then(|| (key.to_string(), value.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ProviderModelsRequestConfig {
        provider_type: stored_provider_type.to_string(),
        base_url,
        api_key,
        use_system_proxy: provider
            .get("useSystemProxy")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        models_url,
        is_full_url: is_full_url.unwrap_or_else(|| {
            provider
                .get("isFullUrl")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        }),
        custom_headers: custom_headers.unwrap_or(stored_headers),
    })
}

pub async fn handle_kbrain_terminal_request(
    app: AppHandle,
    request: proto::TerminalRequest,
) -> Result<proto::TerminalResponse, String> {
    let backend = app
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or_else(|| "K-brain backend state is unavailable".to_string())?;
    let connection = tauri::async_runtime::spawn_blocking({
        let backend = Arc::clone(backend.inner());
        let app = app.clone();
        move || backend.ensure_started(&app)
    })
    .await
    .map_err(|error| format!("K-brain backend startup task failed: {error}"))??;
    kbrain_terminal_request(&connection, &request).await
}

async fn kbrain_terminal_request(
    connection: &KBrainBackendConnection,
    request: &proto::TerminalRequest,
) -> Result<proto::TerminalResponse, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("create K-brain HTTP client failed: {error}"))?;
    let action = request.action.trim().to_ascii_lowercase();
    if request.conversation_id.trim().is_empty() || request.run_id.trim().is_empty() {
        return Err("canonical terminal request requires conversation_id and run_id".to_string());
    }
    let path = "/v1/terminal";
    let body = json!({
        "action": action,
        "conversation_id": request.conversation_id.trim(),
        "run_id": request.run_id.trim(),
        "data": request.data,
        "cwd": request.cwd,
        "session_id": request.session_id,
        "max_bytes": request.max_bytes,
        "project_path_key": request.project_path_key,
        "shell": request.shell,
        "title": request.title,
        "cols": request.cols,
        "rows": request.rows,
    });
    let response = client
        .post(format!(
            "{}{}",
            connection.base_url.trim_end_matches('/'),
            path
        ))
        .bearer_auth(&connection.token)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("K-brain terminal request failed: {error}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("K-brain terminal response was invalid JSON: {error}"))?;
    if !status.is_success() {
        return Err(format!("K-brain terminal request failed (HTTP {status})"));
    }
    if payload.get("conversation_id").and_then(Value::as_str)
        != Some(request.conversation_id.trim())
        || payload.get("run_id").and_then(Value::as_str) != Some(request.run_id.trim())
    {
        return Err("K-brain terminal response identity mismatch".to_string());
    }
    decode_kbrain_terminal_response(payload)
}

fn decode_kbrain_terminal_response(payload: Value) -> Result<proto::TerminalResponse, String> {
    use base64::Engine;
    fn record(value: &Value) -> Result<proto::TerminalSession, String> {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("terminal response has no session id")?;
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let number = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or_default();
        Ok(proto::TerminalSession {
            id: id.to_string(),
            project_path_key: text("project_path_key"),
            cwd: text("cwd"),
            shell: text("shell"),
            title: text("title"),
            pid: number("pid") as u32,
            cols: number("cols") as u32,
            rows: number("rows") as u32,
            created_at: number("created_at"),
            updated_at: number("updated_at"),
            finished_at: number("finished_at"),
            exit_code: value
                .get("exit_code")
                .and_then(Value::as_i64)
                .unwrap_or_default() as i32,
            running: value
                .get("running")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            kind: text("kind"),
            ..Default::default()
        })
    }
    let output = base64::engine::general_purpose::STANDARD
        .decode(
            payload
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| format!("invalid terminal output encoding: {error}"))?;
    let sessions = payload
        .get("sessions")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(record).collect::<Result<Vec<_>, _>>())
        .transpose()?
        .unwrap_or_default();
    let shell_options = payload
        .get("shell_options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| proto::TerminalShellOption {
                    id: item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    label: item
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    command: item
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(proto::TerminalResponse {
        action: payload
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        session: payload.get("session").map(record).transpose()?,
        sessions,
        output,
        truncated: payload
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        output_start_offset: payload
            .get("output_start_offset")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        output_end_offset: payload
            .get("output_end_offset")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        default_shell: payload
            .get("default_shell")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        shell_options,
        ..Default::default()
    })
}

async fn kbrain_provider_models(
    connection: &KBrainBackendConnection,
    body: Value,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("create K-brain HTTP client failed: {error}"))?;
    let provider_id = body
        .get("providerId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("draft");
    let response = client
        .post(format!(
            "{}/v1/settings/providers/{}/models",
            connection.base_url.trim_end_matches('/'),
            urlencoding::encode(provider_id),
        ))
        .bearer_auth(&connection.token)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("K-brain provider discovery request failed: {error}"))?;
    let status = response.status();
    let payload = response.json::<Value>().await.map_err(|error| {
        format!("K-brain provider discovery response was invalid JSON: {error}")
    })?;
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("K-brain provider discovery failed");
        return Err(format!("{message} (HTTP {status})"));
    }
    Ok(payload
        .get("models")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new())))
}

async fn ensure_kbrain_connection(app: &AppHandle) -> Result<KBrainBackendConnection, String> {
    let backend = app
        .try_state::<Arc<KBrainBackendState>>()
        .ok_or_else(|| "K-brain backend state is unavailable".to_string())?;
    tauri::async_runtime::spawn_blocking({
        let backend = Arc::clone(backend.inner());
        let app = app.clone();
        move || backend.ensure_started(&app)
    })
    .await
    .map_err(|error| format!("K-brain backend startup task failed: {error}"))?
}

fn prompt_workdir_query(workdir: &str) -> String {
    let workdir = workdir.trim();
    if workdir.is_empty() {
        String::new()
    } else {
        format!("?workdir={}", urlencoding::encode(workdir))
    }
}

/// 指令目录请求的上限：WebUI 打开“/”弹层时同步等待，K-brain 卡住时要尽快失败。
const KBRAIN_COMMANDS_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 记忆命令的上限，与 Gateway 直连 K-brain 时的请求超时（2 分钟）一致：
/// 手动整理在 K-brain 里同步执行，提前断开会把整理一起取消。
const KBRAIN_MEMORY_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// 调 K-brain 的指令接口并解析 JSON；非 2xx 时取 error/message 字段作为错误。
async fn kbrain_prompt_request(
    connection: &KBrainBackendConnection,
    method: reqwest::Method,
    path_and_query: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    kbrain_json_request(
        connection,
        method,
        path_and_query,
        body,
        KBRAIN_COMMANDS_REQUEST_TIMEOUT,
    )
    .await
}

async fn kbrain_json_request(
    connection: &KBrainBackendConnection,
    method: reqwest::Method,
    path_and_query: &str,
    body: Option<Value>,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("create K-brain HTTP client failed: {error}"))?;
    let mut request = client
        .request(
            method,
            format!(
                "{}{}",
                connection.base_url.trim_end_matches('/'),
                path_and_query
            ),
        )
        .bearer_auth(&connection.token);
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("K-brain prompt request failed: {error}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("K-brain prompt response was invalid JSON: {error}"))?;
    if !status.is_success() {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("K-brain prompt request failed");
        return Err(format!("{message} (HTTP {status})"));
    }
    Ok(payload)
}

async fn kbrain_slash_commands(
    connection: &KBrainBackendConnection,
    workdir: &str,
) -> Result<proto::SlashCommandListResponse, String> {
    let payload = kbrain_prompt_request(
        connection,
        reqwest::Method::GET,
        &format!("/v1/commands{}", prompt_workdir_query(workdir)),
        None,
    )
    .await?;
    let commands = payload
        .get("commands")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    let text = |key: &str| {
                        item.get(key)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    };
                    Some(proto::SlashCommandSummary {
                        name,
                        description: text("description"),
                        argument_hint: text("argument_hint"),
                        kind: text("kind"),
                        source: text("source"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(proto::SlashCommandListResponse { commands })
}

/// WebUI 输入框“/”指令目录：桌面端内置动作 + K-brain 的提示词模板。
pub async fn handle_slash_command_list(
    app: AppHandle,
    request: proto::SlashCommandListRequest,
) -> Result<proto::SlashCommandListResponse, String> {
    let connection = ensure_kbrain_connection(&app).await?;
    kbrain_slash_commands(&connection, &request.workdir).await
}

pub async fn handle_skill_files_list() -> Result<proto::SkillFilesListResponse, String> {
    tauri::async_runtime::spawn_blocking(system_list_skill_files_sync)
        .await
        .map_err(|e| format!("gateway skill files list join failed: {e}"))?
        .map(|response| proto::SkillFilesListResponse {
            root_dir: response.root_dir,
            paths: response.paths,
            truncated: response.truncated,
        })
}

pub async fn handle_file_mention_list(
    request: proto::FileMentionListRequest,
) -> Result<proto::FileMentionListResponse, String> {
    let max_results = usize::try_from(request.max_results)
        .ok()
        .filter(|value| *value > 0);

    tauri::async_runtime::spawn_blocking(move || {
        fs_mention_list_sync(
            request.workdir,
            max_results,
            Some(request.query),
            request.show_hidden,
        )
    })
    .await
    .map_err(|e| format!("gateway file mention list join failed: {e}"))?
    .map(|response| proto::FileMentionListResponse {
        entries: response
            .entries
            .into_iter()
            .map(|entry| proto::FileMentionEntry {
                path: entry.path,
                kind: entry.kind,
                hidden: entry.hidden,
            })
            .collect(),
        truncated: response.truncated,
    })
}

/// 已安装应用清单（WebUI @ 应用提及）：复用桌面 @ 弹层同一份枚举，
/// WebUI 拿到的与 GUI 完全一致（含 32px PNG 图标 data URL）。宿主自身
/// 的剔除也走同一份裁决（macOS 按 bundle id，Windows 按当前 exe）。
pub async fn handle_installed_apps_list(
    host_identifier: String,
) -> Result<proto::InstalledAppsListResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::cua_driver::installed_apps::list_installed_apps(&host_identifier)
    })
    .await
    .map_err(|e| format!("gateway installed apps list join failed: {e}"))
    .map(|apps| proto::InstalledAppsListResponse {
        apps: apps
            .into_iter()
            .map(|app| proto::InstalledAppEntry {
                name: app.name,
                bundle_id: app.bundle_id,
                path: app.path,
                icon_data_url: app.icon_data_url.unwrap_or_default(),
            })
            .collect(),
    })
}

/// Computer Use 设置页的只读引导状态（WebUI）。两个 action 与桌面端的
/// `cua_driver_probe` / `cua_driver_permissions_status` 两条命令一一对应，
/// 返回的 JSON 就是那两条命令的返回值本身——设置页在两端读到的是同一个对象。
///
/// 只接只读 action：安装（联网执行安装脚本）与授权（在宿主屏幕上弹 TCC
/// 对话框）是桌面本机动作，浏览器那端既确认不了命令全文也点不到弹窗，
/// 网关侧同样按白名单拒绝，这里再兜一次底。
pub async fn handle_cua_driver(
    request: proto::CuaDriverRequest,
) -> Result<proto::CuaDriverResponse, String> {
    let action = request.action.trim().to_string();
    let result = match action.as_str() {
        "probe" => tauri::async_runtime::spawn_blocking(crate::services::cua_driver::probe)
            .await
            .map_err(|e| format!("gateway cua driver probe join failed: {e}"))
            .and_then(|probe| {
                serde_json::to_string(&probe).map_err(|e| format!("cua driver probe encode: {e}"))
            })?,
        "permissions_status" => {
            tauri::async_runtime::spawn_blocking(crate::services::cua_driver::permissions_status)
                .await
                .map_err(|e| format!("gateway cua driver permissions join failed: {e}"))
                .and_then(|permissions| {
                    serde_json::to_string(&permissions)
                        .map_err(|e| format!("cua driver permissions encode: {e}"))
                })?
        }
        other => return Err(format!("unsupported cua driver action: {other}")),
    };
    Ok(proto::CuaDriverResponse {
        action,
        result_json: result,
    })
}

/// 应用代理设置的代理服务检测：与桌面 `system_proxy_detect` / `system_proxy_test`
/// 同一实现，结果按同一份 camelCase JSON 回给 WebUI。
pub async fn handle_proxy_detect(
    request: proto::ProxyDetectRequest,
) -> Result<proto::ProxyDetectResponse, String> {
    let action = request.action.trim().to_string();
    let result_json = match action.as_str() {
        "detect" => serde_json::to_string(&crate::services::proxy_detect::detect().await)
            .map_err(|e| format!("proxy detect encode: {e}"))?,
        "test" => {
            let input: crate::services::proxy_detect::ProxyTestInput =
                serde_json::from_str(&request.input_json)
                    .map_err(|e| format!("proxy test input invalid: {e}"))?;
            let result = crate::services::proxy_detect::test(input).await?;
            serde_json::to_string(&result).map_err(|e| format!("proxy test encode: {e}"))?
        }
        other => return Err(format!("unsupported proxy detect action: {other}")),
    };
    Ok(proto::ProxyDetectResponse {
        action,
        result_json,
    })
}

pub async fn handle_fs_roots() -> Result<proto::FsRootsResponse, String> {
    tauri::async_runtime::spawn_blocking(fs_roots_sync)
        .await
        .map_err(|e| format!("gateway fs roots join failed: {e}"))?
        .map(|response| proto::FsRootsResponse {
            roots: response
                .roots
                .into_iter()
                .map(|root| proto::FsRoot {
                    id: root.id,
                    path: root.path,
                    kind: root.kind,
                    label: root.label,
                })
                .collect(),
        })
}

fn workspace_root_grant_to_proto(grant: WorkspaceRootGrant) -> proto::WorkspaceRootGrant {
    proto::WorkspaceRootGrant {
        id: grant.id,
        project_id: grant.project_id,
        project_path_key: grant.project_path_key,
        alias: grant.alias,
        display_path: grant.display_path,
        canonical_path: grant.canonical_path,
        access: grant.access.as_str().to_string(),
        state: grant.state.as_str().to_string(),
        created_at: grant.created_at,
        updated_at: grant.updated_at,
    }
}

pub async fn handle_workspace_root_grants(
    request: proto::WorkspaceRootGrantsRequest,
) -> Result<proto::WorkspaceRootGrantsResponse, String> {
    let action = request.action.trim();
    let grants = match action {
        "list" => {
            if !request.grants.is_empty() {
                return Err("列出目录授权时不能携带授权草稿".to_string());
            }
            workspace_root_grants_list(request.project_id, request.project_path).await?
        }
        "apply" => {
            let drafts = request
                .grants
                .into_iter()
                .map(|grant| {
                    Ok(WorkspaceRootGrantDraft {
                        id: grant.id,
                        alias: grant.alias,
                        display_path: grant.display_path,
                        access: WorkspaceRootAccess::parse(grant.access.trim())?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            workspace_root_grants_apply(request.project_id, request.project_path, drafts).await?
        }
        "revoke" => {
            if !request.project_path.trim().is_empty() || !request.grants.is_empty() {
                return Err("撤销目录授权时只能提供项目 id".to_string());
            }
            workspace_root_grants_revoke(request.project_id).await?;
            Vec::new()
        }
        _ => return Err(format!("不支持的目录授权操作：{action}")),
    };

    Ok(proto::WorkspaceRootGrantsResponse {
        grants: grants
            .into_iter()
            .map(workspace_root_grant_to_proto)
            .collect(),
    })
}

pub async fn handle_fs_list_dirs(
    request: proto::FsListDirsRequest,
) -> Result<proto::FsListDirsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let max_results = usize::try_from(request.max_results)
            .ok()
            .filter(|value| *value > 0);
        fs_list_dirs_sync(request.path, max_results)
    })
    .await
    .map_err(|e| format!("gateway fs list dirs join failed: {e}"))?
    .map(|response| proto::FsListDirsResponse {
        path: response.path,
        entries: response
            .entries
            .into_iter()
            .map(|entry| proto::FsDirEntry {
                path: entry.path,
                name: entry.name,
            })
            .collect(),
        truncated: response.truncated,
    })
}

pub async fn handle_fs_create_project_folder(
    request: proto::FsCreateProjectFolderRequest,
) -> Result<proto::FsCreateProjectFolderResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_create_project_folder_sync(request.parent, request.name)
    })
    .await
    .map_err(|e| format!("gateway fs create project folder join failed: {e}"))?
    .map(|response| proto::FsCreateProjectFolderResponse {
        path: response.path,
    })
}

pub async fn handle_fs_list(
    request: proto::FsListRequest,
) -> Result<proto::FsListResponse, String> {
    let path = if request.path.trim().is_empty() {
        None
    } else {
        Some(request.path)
    };
    let depth = usize::try_from(request.depth)
        .ok()
        .filter(|value| *value > 0);
    let offset = usize::try_from(request.offset).ok();
    let max_results = usize::try_from(request.max_results)
        .ok()
        .filter(|value| *value > 0);

    tauri::async_runtime::spawn_blocking(move || {
        fs_list_sync(
            request.workdir,
            path,
            depth,
            offset,
            max_results,
            request.show_hidden,
        )
    })
    .await
    .map_err(|e| format!("gateway fs list join failed: {e}"))?
    .map_err(|e| e.message)
    .map(|response| {
        let has_path = response.path.is_some();
        proto::FsListResponse {
            path: response.path.unwrap_or_default(),
            has_path,
            depth: u32::try_from(response.depth).unwrap_or(u32::MAX),
            offset: u32::try_from(response.offset).unwrap_or(u32::MAX),
            max_results: u32::try_from(response.max_results).unwrap_or(u32::MAX),
            total: u32::try_from(response.total).unwrap_or(u32::MAX),
            has_more: response.has_more,
            entries: response
                .entries
                .into_iter()
                .map(|entry| proto::FsListEntry {
                    path: entry.path,
                    kind: entry.kind,
                    hidden: entry.hidden,
                })
                .collect(),
        }
    })
}

pub async fn handle_fs_read_editable_text(
    request: proto::FsReadEditableTextRequest,
) -> Result<proto::FsReadEditableTextResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_read_editable_text_sync(request.workdir, request.path)
    })
    .await
    .map_err(|e| format!("gateway fs read editable text join failed: {e}"))?
    .map_err(|e| e.message)
    .map(|response| proto::FsReadEditableTextResponse {
        path: response.path,
        content: response.content,
        mtime_ms: response.mtime_ms,
        content_hash: response.content_hash,
        size_bytes: u64::try_from(response.size_bytes).unwrap_or(u64::MAX),
        total_lines: u64::try_from(response.total_lines).unwrap_or(u64::MAX),
    })
}

pub async fn handle_fs_read_workspace_image(
    request: proto::FsReadWorkspaceImageRequest,
) -> Result<proto::FsReadWorkspaceImageResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_read_workspace_image_sync(request.workdir, request.path)
    })
    .await
    .map_err(|e| format!("gateway fs read workspace preview join failed: {e}"))?
    .map_err(|e| e.message)
    .and_then(|response| {
        Ok(proto::FsReadWorkspaceImageResponse {
            path: response.path,
            mime_type: response
                .mime_type
                .ok_or_else(|| "workspace preview response is missing mime type".to_string())?,
            data: response
                .data
                .ok_or_else(|| "workspace preview response is missing data".to_string())?,
            size_bytes: u64::try_from(response.size_bytes.unwrap_or_default()).unwrap_or(u64::MAX),
            mtime_ms: response.mtime_ms,
            content_hash: response.content_hash,
        })
    })
}

pub async fn handle_chat_file_open(
    request: proto::ChatFileOpenRequest,
) -> Result<proto::ChatFileOpenResponse, String> {
    open_chat_file_link_for_conversation(
        request.conversation_id,
        request.workdir,
        request.path,
        request.source,
        request.line,
        request.end_line,
        request.column,
        request.open_in_file_manager,
    )
    .await
    .map_err(|error| error.message)
    .map(|response| proto::ChatFileOpenResponse {
        action: response.action,
        kind: response.kind,
        workdir: response.workdir.unwrap_or_default(),
        path: response.path.unwrap_or_default(),
        line: response.line,
        end_line: response.end_line,
        column: response.column,
        outside_workspace: response.outside_workspace,
    })
}

pub async fn handle_fs_write_text(
    request: proto::FsWriteTextRequest,
) -> Result<proto::FsWriteTextResponse, String> {
    let expected_mtime_ms = if request.has_expected_mtime_ms {
        Some(request.expected_mtime_ms)
    } else {
        None
    };
    let expected_content_hash = if request.has_expected_content_hash {
        Some(request.expected_content_hash)
    } else {
        None
    };

    tauri::async_runtime::spawn_blocking(move || {
        fs_write_text_sync(
            request.workdir,
            request.path,
            request.content,
            request.mode,
            expected_mtime_ms,
            expected_content_hash,
            // WebUI 文件管理器的直接写入,不属于对话轮,不做检查点捕获。
            None,
        )
    })
    .await
    .map_err(|e| format!("gateway fs write text join failed: {e}"))?
    .map_err(|e| e.message)
    .map(|response| proto::FsWriteTextResponse {
        path: response.path,
        mode: response.mode,
        existed_before: response.existed_before,
        bytes_written: u64::try_from(response.bytes_written).unwrap_or(u64::MAX),
        mtime_ms: response.mtime_ms,
        content_hash: response.content_hash,
        total_lines: u64::try_from(response.total_lines).unwrap_or(u64::MAX),
    })
}

pub async fn handle_fs_create_dir(
    request: proto::FsCreateDirRequest,
) -> Result<proto::FsCreateDirResponse, String> {
    tauri::async_runtime::spawn_blocking(move || fs_create_dir_sync(request.workdir, request.path))
        .await
        .map_err(|e| format!("gateway fs create dir join failed: {e}"))?
        .map_err(|e| e.message)
        .map(|response| proto::FsCreateDirResponse {
            path: response.path,
            kind: response.kind,
        })
}

pub async fn handle_fs_rename(
    request: proto::FsRenameRequest,
) -> Result<proto::FsRenameResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_rename_sync(request.workdir, request.from_path, request.to_path)
    })
    .await
    .map_err(|e| format!("gateway fs rename join failed: {e}"))?
    .map_err(|e| e.message)
    .map(|response| proto::FsRenameResponse {
        from_path: response.from_path,
        path: response.path,
        kind: response.kind,
    })
}

pub async fn handle_fs_delete(
    request: proto::FsDeleteRequest,
) -> Result<proto::FsDeleteResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs_delete_sync(request.workdir, request.path, None)
    })
    .await
    .map_err(|e| format!("gateway fs delete join failed: {e}"))?
    .map_err(|e| e.message)
    .map(|response| proto::FsDeleteResponse {
        path: response.path,
        kind: response.kind,
    })
}

pub async fn handle_git_request(
    request: proto::GitRequest,
    clone_task_registry: Arc<GitCloneTaskRegistry>,
) -> Result<proto::GitResponse, String> {
    let action = request.action.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let result = git_gateway_clone_task_action_sync(
            action.clone(),
            request.workdir,
            request.args_json,
            &clone_task_registry,
        )?;
        Ok(proto::GitResponse {
            action,
            result_json: result.to_string(),
        })
    })
    .await
    .map_err(|e| format!("gateway git request join failed: {e}"))?
}

pub async fn handle_upload_readable_files(
    request: proto::UploadReadableFilesRequest,
) -> Result<proto::UploadReadableFilesResponse, String> {
    let workdir = request.workdir;
    let uploads = request
        .files
        .into_iter()
        .map(|file| SystemReadableFileUploadInput {
            file_name: file.file_name,
            mime_type: if file.mime_type.trim().is_empty() {
                None
            } else {
                Some(file.mime_type)
            },
            content: file.content,
        })
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        system_import_uploaded_readable_files_sync(workdir, uploads)
    })
    .await
    .map_err(|e| format!("gateway upload readable files join failed: {e}"))?
    .map(|response| proto::UploadReadableFilesResponse {
        files: response
            .files
            .into_iter()
            .map(|file| proto::ChatUploadedFile {
                relative_path: file.relative_path,
                absolute_path: file.absolute_path,
                dedupe_key: file.dedupe_key.unwrap_or_default(),
                file_name: file.file_name,
                kind: file.kind,
                size_bytes: i64::try_from(file.size_bytes).unwrap_or(i64::MAX),
            })
            .collect(),
        skipped: response.skipped,
    })
}

pub async fn handle_import_directory(
    request: proto::ImportDirectoryRequest,
) -> Result<proto::ImportDirectoryResponse, String> {
    let transfer_id = request.transfer_id.clone();
    let operation = proto::ImportDirectoryOperation::try_from(request.operation)
        .map_err(|_| format!("不支持的目录导入操作：{}", request.operation))?;
    let outcome = tauri::async_runtime::spawn_blocking(move || match operation {
        proto::ImportDirectoryOperation::Start => system_import_directory_start_sync(
            request.transfer_id,
            request.name,
            request.target,
            request.total_files,
            request.total_bytes,
        ),
        proto::ImportDirectoryOperation::WriteChunk => system_import_directory_chunk_sync(
            request.transfer_id,
            request.relative_path,
            request.offset,
            request.chunk,
            request.file_complete,
        ),
        proto::ImportDirectoryOperation::Commit => {
            system_import_directory_commit_sync(request.transfer_id)
        }
        proto::ImportDirectoryOperation::Abort => {
            system_import_directory_abort_sync(request.transfer_id)?;
            Ok(crate::commands::system::SystemImportDirectoryOutcome {
                root_path: String::new(),
                file_count: 0,
                skipped: Vec::new(),
                received_bytes: 0,
            })
        }
        proto::ImportDirectoryOperation::Unspecified => {
            #[allow(deprecated)]
            let files = request
                .files
                .into_iter()
                .map(|file| SystemImportDirectoryInputFile {
                    relative_path: file.relative_path,
                    content: file.content,
                })
                .collect();
            system_import_directory_sync(request.name, request.target, files)
        }
    })
    .await
    .map_err(|e| format!("gateway import directory join failed: {e}"))??;

    Ok(proto::ImportDirectoryResponse {
        root_path: outcome.root_path,
        file_count: i32::try_from(outcome.file_count).unwrap_or(i32::MAX),
        skipped: outcome.skipped,
        transfer_id,
        received_bytes: outcome.received_bytes,
    })
}

pub async fn handle_uploaded_image_preview(
    request: proto::UploadedImagePreviewRequest,
) -> Result<proto::UploadedImagePreviewResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        system_read_uploaded_image_preview_sync(request.workdir, request.absolute_path)
    })
    .await
    .map_err(|e| format!("gateway uploaded image preview join failed: {e}"))?
    .map(|response| proto::UploadedImagePreviewResponse {
        mime_type: response.mime_type,
        data: response.data,
    })
}

/// 桌面端在 K-brain 模式下把这些记忆命令交给 K-brain（`agent-gui/src/lib/kbrain/memory.ts`）。
/// WebUI 经网关转来的同名命令必须走同一条路，否则读写的是不再更新的本地记忆索引。
const KBRAIN_MEMORY_COMMANDS: &[&str] = &[
    "memory_organizer",
    "memory_list",
    "memory_read",
    "memory_search",
    "memory_write",
    "memory_update",
    "memory_delete",
    "memory_delete_project",
    "memory_accept",
    "memory_apply_batch",
    "memory_overview",
    "memory_quota_summary",
    "memory_recent_rejections",
    "memory_organize_run_create",
    "memory_organize_run_update",
    "memory_organize_run_list",
    "memory_organize_run_read",
    "memory_organize_run_clear_history",
    "memory_organize_due_claim",
    "memory_organize_due_complete",
    "memory_index_overview",
    "memory_paths_info",
    "memory_today_local_date",
    "memory_today_daily",
    "memory_wipe_all",
];

fn is_kbrain_memory_command(command: &str) -> bool {
    KBRAIN_MEMORY_COMMANDS.contains(&command.trim())
}

pub async fn handle_memory_manage(
    app: AppHandle,
    request: proto::MemoryManageRequest,
) -> Result<proto::MemoryManageResponse, String> {
    let command = request.command.trim().to_string();
    if is_kbrain_memory_command(&command) {
        let connection = ensure_kbrain_connection(&app).await?;
        return kbrain_memory_manage(&connection, &command, &request.args_json).await;
    }
    tauri::async_runtime::spawn_blocking(move || handle_history_manage_sync(request))
        .await
        .map_err(|e| format!("gateway memory manage join failed: {e}"))?
}

/// 把一条记忆命令原样交给 K-brain 的 `/v1/memory/manage`，结果 JSON 原样返回。
async fn kbrain_memory_manage(
    connection: &KBrainBackendConnection,
    command: &str,
    args_json: &str,
) -> Result<proto::MemoryManageResponse, String> {
    let args = parse_memory_value(args_json, command)?;
    let result = kbrain_json_request(
        connection,
        reqwest::Method::POST,
        "/v1/memory/manage",
        Some(json!({ "command": command, "args": args })),
        KBRAIN_MEMORY_REQUEST_TIMEOUT,
    )
    .await?;
    let result_json = serde_json::to_string(&result)
        .map_err(|e| format!("serialize {command} result JSON failed: {e}"))?;
    Ok(proto::MemoryManageResponse { result_json })
}

/// `memory.manage` 里与记忆库无关的会话历史命令，仍由桌面端本地处理。
fn handle_history_manage_sync(
    request: proto::MemoryManageRequest,
) -> Result<proto::MemoryManageResponse, String> {
    let command = request.command.trim();
    let result = match command {
        "history_shared_list" => {
            let args = parse_memory_args::<HistorySharedListArgs>(&request.args_json, command)?;
            let page = chat_history::list_shared_chat_history_page_sync(args.page, args.page_size)?;
            serde_json::to_value(history_list_json(page))
        }
        "chat_history_search" => {
            let args = parse_memory_args::<chat_history::ChatHistorySearchArgs>(
                &request.args_json,
                command,
            )?;
            serde_json::to_value(chat_history::search_chat_history_sync(args)?)
        }
        _ => return Err(format!("unsupported memory command: {command}")),
    }
    .map_err(|e| format!("serialize {command} result failed: {e}"))?;

    let result_json = serde_json::to_string(&result)
        .map_err(|e| format!("serialize {command} result JSON failed: {e}"))?;
    Ok(proto::MemoryManageResponse { result_json })
}

fn parse_memory_args<T>(raw: &str, command: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
{
    let value = parse_memory_value(raw, command)?;
    serde_json::from_value(value).map_err(|e| format!("invalid {command} args: {e}"))
}

fn parse_memory_value(raw: &str, command: &str) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str::<Value>(trimmed).map_err(|e| format!("invalid {command} args JSON: {e}"))
}

pub async fn handle_skill_metadata_read(
    request: proto::SkillMetadataReadRequest,
) -> Result<proto::SkillMetadataReadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || system_read_skill_metadata_sync(request.path))
        .await
        .map_err(|e| format!("gateway skill metadata read join failed: {e}"))?
        .map(|response| proto::SkillMetadataReadResponse {
            name: response.name.unwrap_or_default(),
            description: response.description.unwrap_or_default(),
        })
}

pub async fn handle_skill_text_read(
    request: proto::SkillTextReadRequest,
) -> Result<proto::SkillTextReadResponse, String> {
    let offset = usize::try_from(request.offset)
        .ok()
        .filter(|value| *value > 0);
    let length = usize::try_from(request.length)
        .ok()
        .filter(|value| *value > 0);

    tauri::async_runtime::spawn_blocking(move || {
        system_read_skill_text_sync(request.path, offset, length)
    })
    .await
    .map_err(|e| format!("gateway skill text read join failed: {e}"))?
    .map(|response| proto::SkillTextReadResponse {
        content: response.content,
        truncated: response.truncated,
    })
}

pub async fn handle_skill_manage(
    request: proto::SkillManageRequest,
) -> Result<proto::SkillManageResponse, String> {
    let payload = if request.payload_json.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_str::<Value>(&request.payload_json)
            .map_err(|e| format!("invalid skill manage payload JSON: {e}"))?
    };

    tauri::async_runtime::spawn_blocking(move || system_manage_skill_sync(payload))
        .await
        .map_err(|e| format!("gateway skill manage join failed: {e}"))?
        .and_then(|response| {
            serde_json::to_string(&response)
                .map(|result_json| proto::SkillManageResponse { result_json })
                .map_err(|e| format!("serialize skill manage response failed: {e}"))
        })
}

fn parse_apply_input(raw: &str) -> Result<AutomationApplyInput, String> {
    serde_json::from_str::<AutomationApplyInput>(raw.trim())
        .map_err(|e| format!("invalid automation apply payload: {e}"))
}

fn parse_required_cron_task_id(
    request: &proto::CronManageRequest,
    action: &str,
) -> Result<String, String> {
    let task_id = request.task_id.trim();
    if task_id.is_empty() {
        return Err(format!("cron {action} requires task_id"));
    }
    Ok(task_id.to_string())
}

fn parse_runs_limit(raw: &str) -> Result<usize, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(100);
    }
    let payload =
        serde_json::from_str::<Value>(trimmed).map_err(|e| format!("invalid runs query: {e}"))?;
    Ok(payload
        .as_object()
        .and_then(|obj| obj.get("limit"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .map(|value| value.clamp(1, 500))
        .unwrap_or(100))
}

fn parse_occurrence_query(
    raw: &str,
) -> Result<crate::services::automation::CronOccurrenceQuery, String> {
    serde_json::from_str(raw.trim()).map_err(|e| format!("invalid occurrences payload: {e}"))
}

fn parse_validate_expression(raw: &str) -> Result<String, String> {
    let payload = serde_json::from_str::<Value>(raw.trim())
        .map_err(|e| format!("invalid validate payload: {e}"))?;
    payload
        .as_object()
        .and_then(|obj| obj.get("expression"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "validate requires expression".to_string())
}

fn serialize_cron_manage_result(payload: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(payload)
        .map_err(|e| format!("serialize cron manage response failed: {e}"))
}

fn is_builtin_share_tool_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.starts_with("mcp_") {
        return true;
    }
    matches!(
        trimmed,
        "Agent"
            | "AskUserQuestion"
            | "Bash"
            | "Browser"
            | "CronTaskManager"
            | "Delete"
            | "Edit"
            | "ExitPlanMode"
            | "Glob"
            | "Grep"
            | "Image"
            | "List"
            | "ManagedProcess"
            | "ProcessStop"
            | "ProcessWait"
            | "McpManager"
            | "MemoryManager"
            | "PlanningMutate"
            | "PlanningQuery"
            | "Read"
            | "ReadConversation"
            | "ReadTerminal"
            | "SendMessage"
            | "SkillsManager"
            | "ToolSearch"
            | "SSHManager"
            | "SshManager"
            | "TaskCreate"
            | "TaskUpdate"
            | "TaskList"
            | "TunnelManager"
            | "Write"
    )
}

fn read_json_string_field(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn read_tool_block_name(block: &Value) -> Option<String> {
    let object = block.as_object()?;
    read_json_string_field(object, &["name", "toolName", "tool_name"]).or_else(|| {
        object
            .get("toolCall")
            .and_then(Value::as_object)
            .and_then(|nested| read_json_string_field(nested, &["name", "toolName", "tool_name"]))
    })
}

fn read_tool_block_id(block: &Value) -> Option<String> {
    let object = block.as_object()?;
    read_json_string_field(
        object,
        &["id", "toolCallId", "toolCallID", "tool_call_id", "call_id"],
    )
    .or_else(|| {
        object
            .get("toolCall")
            .and_then(Value::as_object)
            .and_then(|nested| {
                read_json_string_field(
                    nested,
                    &["id", "toolCallId", "toolCallID", "tool_call_id", "call_id"],
                )
            })
    })
}

fn collect_redacted_tool_call_ids(messages: &[Value]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for message in messages {
        let Some(object) = message.as_object() else {
            continue;
        };
        match object.get("role").and_then(Value::as_str).map(str::trim) {
            Some("assistant") => {
                let Some(blocks) = object.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for block in blocks {
                    let block_type = block
                        .as_object()
                        .and_then(|record| record.get("type"))
                        .and_then(Value::as_str)
                        .map(str::trim);
                    if !matches!(block_type, Some("toolCall") | Some("tool_use")) {
                        continue;
                    }
                    if read_tool_block_name(block)
                        .as_deref()
                        .map(is_builtin_share_tool_name)
                        .unwrap_or(false)
                    {
                        if let Some(id) = read_tool_block_id(block) {
                            ids.insert(id);
                        }
                    }
                }
            }
            Some("toolResult") => {
                let is_builtin = read_json_string_field(object, &["toolName", "tool_name", "name"])
                    .as_deref()
                    .map(is_builtin_share_tool_name)
                    .unwrap_or(false);
                if is_builtin {
                    if let Some(id) = read_json_string_field(
                        object,
                        &["toolCallId", "toolCallID", "tool_call_id", "call_id"],
                    ) {
                        ids.insert(id);
                    }
                }
            }
            _ => {}
        }
    }
    ids
}

fn redact_tool_call_block(block: &mut Value) {
    let Some(object) = block.as_object_mut() else {
        return;
    };
    for key in [
        "arguments",
        "args",
        "input",
        "parameters",
        "payload",
        "data",
    ] {
        object.remove(key);
    }
    if let Some(nested) = object.get_mut("toolCall").and_then(Value::as_object_mut) {
        for key in [
            "arguments",
            "args",
            "input",
            "parameters",
            "payload",
            "data",
        ] {
            nested.remove(key);
        }
    }
    object.insert("redacted".to_string(), Value::Bool(true));
}

fn redact_builtin_tool_content_json(raw: &str) -> Result<String, String> {
    let mut parsed = serde_json::from_str::<Value>(raw)
        .map_err(|e| format!("parse share history failed: {e}"))?;
    let items = parsed
        .as_array_mut()
        .ok_or_else(|| "share history messages payload is not an array".to_string())?;
    let redacted_tool_call_ids = collect_redacted_tool_call_ids(items);

    for message in items.iter_mut() {
        let Some(object) = message.as_object_mut() else {
            continue;
        };
        match object.get("role").and_then(Value::as_str).map(str::trim) {
            Some("assistant") => {
                let Some(blocks) = object.get_mut("content").and_then(Value::as_array_mut) else {
                    continue;
                };
                for block in blocks {
                    let block_type = block
                        .as_object()
                        .and_then(|record| record.get("type"))
                        .and_then(Value::as_str)
                        .map(str::trim);
                    if !matches!(block_type, Some("toolCall") | Some("tool_use")) {
                        continue;
                    }
                    let is_builtin = read_tool_block_name(block)
                        .as_deref()
                        .map(is_builtin_share_tool_name)
                        .unwrap_or(false);
                    let is_redacted_id = read_tool_block_id(block)
                        .as_ref()
                        .map(|id| redacted_tool_call_ids.contains(id))
                        .unwrap_or(false);
                    if is_builtin || is_redacted_id {
                        redact_tool_call_block(block);
                    }
                }
            }
            Some("toolResult") => {
                let is_builtin = read_json_string_field(object, &["toolName", "tool_name", "name"])
                    .as_deref()
                    .map(is_builtin_share_tool_name)
                    .unwrap_or(false);
                let is_redacted_id = read_json_string_field(
                    object,
                    &["toolCallId", "toolCallID", "tool_call_id", "call_id"],
                )
                .as_ref()
                .map(|id| redacted_tool_call_ids.contains(id))
                .unwrap_or(false);
                if is_builtin || is_redacted_id {
                    object.insert(
                        "content".to_string(),
                        json!([{ "type": "text", "text": "工具调用内容已脱敏" }]),
                    );
                    object.insert(
                        "details".to_string(),
                        json!({ "kind": "redacted_tool_content" }),
                    );
                }
            }
            _ => {}
        }
    }

    serde_json::to_string(items)
        .map_err(|e| format!("serialize redacted share history failed: {e}"))
}

fn flatten_history_messages_json(
    segments: &[chat_history::ChatHistorySegmentRecord],
) -> Result<String, String> {
    flatten_history_messages_json_window(segments, 0).map(|(messages_json, _)| messages_json)
}

fn history_message_ref_from_proto(ref_value: &proto::ChatMessageRef) -> ChatHistoryMessageRef {
    ChatHistoryMessageRef {
        segment_index: i64::from(ref_value.segment_index),
        message_index: i64::from(ref_value.message_index),
        segment_id: ref_value.segment_id.clone(),
        message_id: ref_value.message_id.clone(),
        role: ref_value.role.clone(),
        content_hash: ref_value.content_hash.clone(),
    }
}

fn flatten_history_messages_json_window(
    segments: &[chat_history::ChatHistorySegmentRecord],
    max_messages: i64,
) -> Result<(String, i32), String> {
    let window = chat_history::build_history_message_window(segments, max_messages, None, false)?;
    let messages_json = chat_history::flatten_history_message_window(&window)?;
    Ok((
        messages_json,
        i32::try_from(window.returned_message_count).unwrap_or(i32::MAX),
    ))
}

fn build_proto_conversation_summary_from_record(
    record: &chat_history::ChatHistoryRecord,
) -> proto::ConversationSummary {
    proto::ConversationSummary {
        id: record.id.clone(),
        title: record.title.clone(),
        created_at: record.created_at,
        updated_at: record.updated_at,
        message_count: i32::try_from(record.total_message_count).unwrap_or(i32::MAX),
        provider_id: record.provider_id.clone(),
        model: record.model.clone(),
        session_id: record.session_id.clone().unwrap_or_default(),
        cwd: record.cwd.clone().unwrap_or_default(),
        selected_model_json: record.selected_model_json.clone().unwrap_or_default(),
        is_pinned: record.is_pinned,
        pinned_at: record.pinned_at.unwrap_or_default(),
        is_shared: record.is_shared,
    }
}

fn build_proto_conversation_summary(
    summary: chat_history::ChatHistorySummary,
) -> proto::ConversationSummary {
    proto::ConversationSummary {
        id: summary.id,
        title: summary.title,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        message_count: i32::try_from(summary.message_count).unwrap_or(i32::MAX),
        provider_id: summary.provider_id,
        model: summary.model,
        session_id: summary.session_id.unwrap_or_default(),
        cwd: summary.cwd.unwrap_or_default(),
        selected_model_json: summary.selected_model_json.unwrap_or_default(),
        is_pinned: summary.is_pinned,
        pinned_at: summary.pinned_at.unwrap_or_default(),
        is_shared: summary.is_shared,
    }
}

fn build_proto_history_share_status(
    status: chat_history::ChatHistoryShareStatus,
) -> proto::HistoryShareStatus {
    proto::HistoryShareStatus {
        conversation_id: status.conversation_id,
        enabled: status.enabled,
        token: status.token.unwrap_or_default(),
        created_at: status.created_at.unwrap_or_default(),
        updated_at: status.updated_at.unwrap_or_default(),
        redact_tool_content: status.redact_tool_content,
    }
}

fn history_list_json(page: chat_history::ChatHistoryListResponse) -> Value {
    json!({
        "conversations": page.items.into_iter().map(|item| {
            json!({
                "id": item.id,
                "title": item.title,
                "created_at": item.created_at,
                "updated_at": item.updated_at,
                "message_count": item.message_count,
                "provider_id": item.provider_id,
                "model": item.model,
                "session_id": item.session_id.unwrap_or_default(),
                "cwd": item.cwd.unwrap_or_default(),
                "selected_model_json": item.selected_model_json.unwrap_or_default(),
                "is_pinned": item.is_pinned,
                "pinned_at": item.pinned_at.unwrap_or_default(),
                "is_shared": item.is_shared,
            })
        }).collect::<Vec<_>>(),
        "total_count": page.total_count,
    })
}

fn sanitize_provider_summaries(providers: Option<Value>) -> Result<Value, String> {
    let Some(providers) = providers else {
        return Ok(Value::Array(Vec::new()));
    };

    let items = providers
        .as_array()
        .ok_or_else(|| "provider settings payload is not an array".to_string())?;
    let sanitized = items
        .iter()
        .map(sanitize_provider_summary)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Value::Array(sanitized))
}

fn sanitize_provider_summary(provider: &Value) -> Result<Value, String> {
    let source = provider
        .as_object()
        .ok_or_else(|| "provider settings item is not an object".to_string())?;

    let mut payload = serde_json::Map::new();
    for key in [
        "id",
        "name",
        "type",
        "models",
        "activeModels",
        "requestFormat",
        "reasoning",
        "promptCachingEnabled",
        "promptCacheHintMode",
        "nativeWebSearchEnabled",
    ] {
        if let Some(value) = source.get(key) {
            payload.insert(key.to_string(), value.clone());
        }
    }

    Ok(Value::Object(payload))
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        decode_kbrain_terminal_response, flatten_history_messages_json,
        flatten_history_messages_json_window, is_builtin_share_tool_name, is_kbrain_memory_command,
        kbrain_memory_manage, kbrain_provider_models, kbrain_slash_commands,
        kbrain_terminal_request, parse_occurrence_query, parse_runs_limit, prompt_workdir_query,
        proto, redact_builtin_tool_content_json, resolve_stored_provider_models_config,
        sanitize_provider_summaries, KBrainBackendConnection, KBRAIN_MEMORY_COMMANDS,
    };
    use crate::commands::chat_history::{
        self, history_message_content_hash, ChatHistoryMessageRef, ChatHistorySegmentRecord,
    };

    fn make_segment(
        segment_index: i64,
        segment_id: &str,
        summary_json: Option<&str>,
        messages_json: &str,
    ) -> ChatHistorySegmentRecord {
        let message_count = serde_json::from_str::<Value>(messages_json)
            .ok()
            .and_then(|value| value.as_array().map(|messages| messages.len() as i64))
            .unwrap_or(1);
        ChatHistorySegmentRecord {
            segment_index,
            segment_id: segment_id.to_string(),
            summary_json: summary_json.map(str::to_string),
            messages_json: messages_json.to_string(),
            message_count,
            start_message_id: None,
            end_message_id: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn gateway_memory_routing_matches_desktop_kbrain_commands() {
        // 桌面端 K-brain 模式下交给 K-brain 的记忆命令清单；网关转来的同名命令必须走同一条路。
        let source = include_str!("../../../src/lib/kbrain/memory.ts");
        let start = source.find("new Set([").expect("memoryCommands set");
        let end = start + source[start..].find("]);").expect("memoryCommands end");
        let mut desktop: Vec<&str> = source[start..end].split('"').skip(1).step_by(2).collect();
        desktop.sort_unstable();
        let mut gateway = KBRAIN_MEMORY_COMMANDS.to_vec();
        gateway.sort_unstable();
        assert_eq!(gateway, desktop);
        for command in &desktop {
            assert!(is_kbrain_memory_command(command), "{command}");
        }
        assert!(is_kbrain_memory_command("  memory_list  "));
        for command in [
            "history_shared_list",
            "chat_history_search",
            "",
            "memory_unknown",
        ] {
            assert!(!is_kbrain_memory_command(command), "{command}");
        }
    }

    #[tokio::test]
    async fn kbrain_memory_manage_forwards_command_and_surfaces_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(serve_one_prompt_request(
            listener,
            "200 OK",
            r#"{"entries":[{"slug":"fresh","scope":"global","unreviewed":true}],"truncated":false}"#,
        ));
        let response = kbrain_memory_manage(
            &prompt_fixture_connection(address),
            "memory_list",
            r#"{"includeAllProjects":true,"includeDaily":true,"limit":1000}"#,
        )
        .await
        .expect("memory list");
        let (headers, body) = server.await.expect("fixture task");
        assert!(headers.starts_with("POST /v1/memory/manage "));
        assert!(
            headers.contains("authorization: Bearer fixture-token")
                || headers.contains("Authorization: Bearer fixture-token")
        );
        assert_eq!(
            body,
            Some(json!({
                "command": "memory_list",
                "args": {"includeAllProjects": true, "includeDaily": true, "limit": 1000}
            }))
        );
        assert_eq!(
            serde_json::from_str::<Value>(&response.result_json).expect("result JSON"),
            json!({"entries":[{"slug":"fresh","scope":"global","unreviewed":true}],"truncated":false})
        );

        // 空参数按空对象发送；K-brain 的 null 结果（今天没有日记）原样回给 WebUI。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(serve_one_prompt_request(listener, "200 OK", "null"));
        let response = kbrain_memory_manage(
            &prompt_fixture_connection(address),
            "memory_today_daily",
            "  ",
        )
        .await
        .expect("today daily");
        let (_, body) = server.await.expect("fixture task");
        assert_eq!(
            body,
            Some(json!({"command": "memory_today_daily", "args": {}}))
        );
        assert_eq!(response.result_json, "null");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(serve_one_prompt_request(
            listener,
            "404 Not Found",
            r#"{"version":"v1","error":"memory entry not found"}"#,
        ));
        let error = kbrain_memory_manage(
            &prompt_fixture_connection(address),
            "memory_read",
            r#"{"slug":"missing","scope":"global"}"#,
        )
        .await
        .expect_err("missing entry");
        server.await.expect("fixture task");
        assert!(error.contains("memory entry not found"), "{error}");

        let error = kbrain_memory_manage(
            &prompt_fixture_connection(address),
            "memory_read",
            "{not json",
        )
        .await
        .expect_err("invalid args");
        assert!(error.contains("invalid memory_read args JSON"), "{error}");
    }

    fn prompt_fixture_connection(address: std::net::SocketAddr) -> KBrainBackendConnection {
        KBrainBackendConnection {
            base_url: format!("http://{address}"),
            token: "fixture-token".to_string(),
            protocol_version: "kbrain.agent.v1".to_string(),
            storage_id: "test-storage".into(),
        }
    }

    /// 单次请求的本地 K-brain 替身：返回请求头与 JSON 正文，并回写给定响应。
    async fn serve_one_prompt_request(
        listener: tokio::net::TcpListener,
        status: &'static str,
        payload: &'static str,
    ) -> (String, Option<Value>) {
        let (mut socket, _) = listener.accept().await.expect("accept prompt request");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        let header_end = loop {
            let count = socket.read(&mut buffer).await.expect("read request");
            assert!(count > 0, "fixture request ended before headers");
            request.extend_from_slice(&buffer[..count]);
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
        let content_length = headers
            .lines()
            .find_map(|line| {
                line.strip_prefix("Content-Length:")
                    .or_else(|| line.strip_prefix("content-length:"))
            })
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while request.len() < header_end + content_length {
            let count = socket.read(&mut buffer).await.expect("read request body");
            assert!(count > 0, "fixture request ended before body");
            request.extend_from_slice(&buffer[..count]);
        }
        let body = (content_length > 0).then(|| {
            serde_json::from_slice(&request[header_end..header_end + content_length])
                .expect("prompt request JSON")
        });
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write fixture response");
        (headers, body)
    }

    #[test]
    fn prompt_workdir_query_is_omitted_when_blank_and_encoded_otherwise() {
        assert_eq!(prompt_workdir_query("   "), "");
        assert_eq!(
            prompt_workdir_query(" C:\\work dir "),
            "?workdir=C%3A%5Cwork%20dir"
        );
    }

    #[tokio::test]
    async fn slash_command_list_maps_catalog_and_surfaces_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(serve_one_prompt_request(
            listener,
            "200 OK",
            r#"{"version":"v1","commands":[{"name":"goal","description":"Keep working","argument_hint":"<goal>","kind":"action","source":"builtin"},{"name":"  "},{"name":"fix","kind":"prompt","source":"project"}]}"#,
        ));
        let response = kbrain_slash_commands(&prompt_fixture_connection(address), "/repo")
            .await
            .expect("slash commands");
        let (headers, body) = server.await.expect("fixture task");
        assert!(headers.starts_with("GET /v1/commands?workdir=%2Frepo "));
        assert!(
            headers.contains("authorization: Bearer fixture-token")
                || headers.contains("Authorization: Bearer fixture-token")
        );
        assert!(body.is_none());
        let names: Vec<_> = response
            .commands
            .iter()
            .map(|command| {
                (
                    command.name.as_str(),
                    command.argument_hint.as_str(),
                    command.kind.as_str(),
                    command.source.as_str(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                ("goal", "<goal>", "action", "builtin"),
                ("fix", "", "prompt", "project")
            ]
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(serve_one_prompt_request(
            listener,
            "400 Bad Request",
            r#"{"error":"workdir is invalid"}"#,
        ));
        let error = kbrain_slash_commands(&prompt_fixture_connection(address), "")
            .await
            .expect_err("bad workdir");
        let (headers, _) = server.await.expect("fixture task");
        assert!(headers.starts_with("GET /v1/commands "));
        assert!(error.starts_with("workdir is invalid (HTTP 400"));
    }

    #[test]
    fn parse_occurrence_query_requires_exact_range_fields() {
        let query = parse_occurrence_query(r#"{"from":1,"to":2}"#).expect("parse query");
        assert_eq!((query.from, query.to), (1, 2));
        assert!(parse_occurrence_query(r#"{"from":1}"#).is_err());
        assert!(parse_occurrence_query(r#"{"from":1,"to":2,"extra":true}"#).is_err());
        assert!(parse_occurrence_query("").is_err());
    }

    #[test]
    fn parse_runs_limit_defaults_to_100() {
        assert_eq!(parse_runs_limit("").expect("default limit"), 100);
        assert_eq!(parse_runs_limit("{}").expect("object default"), 100);
        assert_eq!(
            parse_runs_limit(r#"{"limit":0}"#).expect("zero fallback"),
            100
        );
    }

    #[test]
    fn parse_runs_limit_accepts_positive_limit() {
        assert_eq!(
            parse_runs_limit(r#"{"limit":25}"#).expect("parse explicit limit"),
            25
        );
    }

    #[test]
    fn provider_summaries_do_not_include_api_keys() {
        let result = sanitize_provider_summaries(Some(json!([
            {
                "id": "provider-a",
                "name": "A",
                "type": "codex",
                "baseUrl": "https://api.example.com",
                "apiKey": "secret-key",
                "models": [],
                "activeModels": [],
                "promptCacheHintMode": "openrouter-session",
                "nativeWebSearchEnabled": false
            }
        ])))
        .expect("sanitize provider summaries");

        assert_eq!(result[0]["id"], "provider-a");
        assert_eq!(result[0]["promptCacheHintMode"], "openrouter-session");
        assert_eq!(result[0]["nativeWebSearchEnabled"], false);
        assert_eq!(result[0]["apiKey"], Value::Null);
        assert_eq!(result[0]["baseUrl"], Value::Null);
    }

    #[test]
    fn stored_provider_model_config_preserves_redacted_settings_and_draft_overrides() {
        let stored = json!([
            {
                "id": "saved/provider",
                "type": "codex",
                "apiKey": "saved-secret",
                "baseUrl": "https://relay.example.test/v1",
                "modelsUrl": "https://catalog.example.test/models",
                "useSystemProxy": true,
                "isFullUrl": true,
                "customHeaders": [{ "key": "X-Saved", "value": "yes" }]
            }
        ]);
        let config = resolve_stored_provider_models_config(
            "saved/provider",
            "codex",
            Some(false),
            Some(vec![("X-Draft".to_string(), "yes".to_string())]),
            Some(stored),
        )
        .expect("resolve saved provider config");

        assert_eq!(config.provider_type, "codex");
        assert_eq!(config.api_key, "saved-secret");
        assert_eq!(config.base_url, "https://relay.example.test/v1");
        assert_eq!(config.models_url, "https://catalog.example.test/models");
        assert!(config.use_system_proxy);
        assert!(!config.is_full_url);
        assert_eq!(
            config.custom_headers,
            vec![("X-Draft".to_string(), "yes".to_string())]
        );
    }

    #[test]
    fn stored_provider_model_config_rejects_missing_or_mismatched_credentials() {
        let missing =
            resolve_stored_provider_models_config("missing", "codex", None, None, Some(json!([])))
                .expect_err("missing provider must fail");
        assert!(missing.contains("未找到已保存的供应商"));

        let mismatch = resolve_stored_provider_models_config(
            "saved",
            "gemini",
            None,
            None,
            Some(json!([{ "id": "saved", "type": "codex", "apiKey": "secret" }])),
        )
        .expect_err("provider type mismatch must fail");
        assert!(mismatch.contains("类型"));

        let no_key = resolve_stored_provider_models_config(
            "saved",
            "codex",
            None,
            None,
            Some(json!([{ "id": "saved", "type": "codex", "apiKey": "" }])),
        )
        .expect_err("missing API key must fail");
        assert!(no_key.contains("API Key"));
    }

    #[tokio::test]
    async fn kbrain_mcp_snapshot_reads_authenticated_backend() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8_lossy(&request).to_lowercase();
            assert!(headers.starts_with("get /v1/mcp "));
            assert!(headers.contains("authorization: bearer fixture-token"));
            let payload = r#"{"settings":{"servers":[{"id":"backend-docs","enabled":true,"transport":"stdio","command":"server"}]},"statuses":[]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(), payload
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let connection = KBrainBackendConnection {
            base_url: format!("http://{address}"),
            token: "fixture-token".into(),
            protocol_version: "kbrain.agent.v1".into(),
            storage_id: "test-storage".into(),
        };
        let result =
            super::kbrain_prompt_request(&connection, reqwest::Method::GET, "/v1/mcp", None)
                .await
                .unwrap();
        let mut snapshot = json!({"mcp": {"servers": [], "selected": ["stale"]}});
        crate::services::gateway::apply_kbrain_mcp_settings(&mut snapshot, &result).unwrap();
        assert_eq!(snapshot["mcp"]["servers"][0]["id"], "backend-docs");
        assert_eq!(snapshot["mcp"]["selected"], json!([]));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn kbrain_terminal_posts_identity_and_decodes_binary_snapshot() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept discovery request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let count = socket.read(&mut buffer).await.expect("read request");
                assert!(count > 0, "fixture request ended before headers");
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .and_then(|value| value.trim().parse::<usize>().ok())
                .expect("content length");
            while request.len() < header_end + content_length {
                let count = socket.read(&mut buffer).await.expect("read request body");
                assert!(count > 0, "fixture request ended before body");
                request.extend_from_slice(&buffer[..count]);
            }
            let body: Value =
                serde_json::from_slice(&request[header_end..header_end + content_length])
                    .expect("discovery request JSON");
            assert!(
                headers.contains("authorization: Bearer fixture-token")
                    || headers.contains("Authorization: Bearer fixture-token")
            );
            assert!(headers.starts_with("POST /v1/terminal "));
            assert_eq!(body["conversation_id"], "conversation");
            assert_eq!(body["run_id"], "run");
            assert_eq!(body["session_id"], "term-1");
            assert_eq!(body["action"], "read");
            assert!(body.get("command").is_none());
            let payload = r#"{"conversation_id":"conversation","run_id":"run","action":"read","session":{"id":"term-1","pid":42,"running":true,"kind":"local"},"output":"AP9B","output_start_offset":7,"output_end_offset":10,"truncated":true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write fixture response");
        });

        let result = kbrain_terminal_request(
            &KBrainBackendConnection {
                base_url: format!("http://{address}"),
                token: "fixture-token".to_string(),
                protocol_version: "kbrain.agent.v1".to_string(),
                storage_id: "test-storage".into(),
            },
            &proto::TerminalRequest {
                action: "read".to_string(),
                conversation_id: "conversation".to_string(),
                run_id: "run".to_string(),
                session_id: "term-1".to_string(),
                ..Default::default()
            },
        )
        .await
        .expect("terminal snapshot");
        assert_eq!(result.output, vec![0, 255, 65]);
        assert_eq!(result.output_start_offset, 7);
        assert_eq!(result.output_end_offset, 10);
        assert!(result.truncated);
        assert_eq!(result.session.unwrap().pid, 42);
        server.await.expect("fixture server");
    }

    #[tokio::test]
    async fn kbrain_terminal_requires_complete_identity() {
        let error = kbrain_terminal_request(
            &KBrainBackendConnection {
                base_url: "http://127.0.0.1:1".to_string(),
                token: "token".to_string(),
                protocol_version: "kbrain.agent.v1".to_string(),
                storage_id: "test-storage".into(),
            },
            &proto::TerminalRequest {
                action: "read".to_string(),
                run_id: "run".to_string(),
                ..Default::default()
            },
        )
        .await
        .expect_err("missing identity");
        assert!(error.contains("conversation_id and run_id"));
    }

    #[test]
    fn kbrain_terminal_rejects_invalid_buffer_and_missing_session_id() {
        assert!(decode_kbrain_terminal_response(json!({"output":"%%%"})).is_err());
        assert!(decode_kbrain_terminal_response(json!({"session":{}})).is_err());
    }

    #[tokio::test]
    async fn kbrain_provider_models_posts_normalized_discovery_request_and_reads_models() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local K-brain fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept discovery request");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let count = socket.read(&mut buffer).await.expect("read request");
                assert!(count > 0, "fixture request ended before headers");
                request.extend_from_slice(&buffer[..count]);
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).into_owned();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .and_then(|value| value.trim().parse::<usize>().ok())
                .expect("content length");
            while request.len() < header_end + content_length {
                let count = socket.read(&mut buffer).await.expect("read request body");
                assert!(count > 0, "fixture request ended before body");
                request.extend_from_slice(&buffer[..count]);
            }
            let body: Value =
                serde_json::from_slice(&request[header_end..header_end + content_length])
                    .expect("discovery request JSON");
            assert!(
                headers.contains("authorization: Bearer fixture-token")
                    || headers.contains("Authorization: Bearer fixture-token")
            );
            assert!(headers.contains("/saved%2Fprovider/models"));
            assert_eq!(body["providerId"], "saved/provider");
            assert_eq!(body["api"], "openai-completions");
            assert_eq!(body["requestFormat"], "openai-completions");
            assert_eq!(body["apiKey"], "saved-secret");
            assert_eq!(body["customHeaders"][0]["key"], "X-Client");
            let payload = r#"{"models":[{"id":"fixture-model","displayName":"Fixture Model"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write fixture response");
        });

        let result = kbrain_provider_models(
            &KBrainBackendConnection {
                base_url: format!("http://{address}"),
                token: "fixture-token".to_string(),
                protocol_version: "kbrain.agent.v1".to_string(),
                storage_id: "test-storage".into(),
            },
            json!({
                "providerId": "saved/provider",
                "type": "codex",
                "api": "openai-completions",
                "requestFormat": "openai-completions",
                "apiKey": "saved-secret",
                "baseUrl": "https://relay.example.test/v1",
                "modelsUrl": "https://catalog.example.test/models",
                "isFullUrl": true,
                "useSystemProxy": true,
                "customHeaders": [{ "key": "X-Client", "value": "fixture" }]
            }),
        )
        .await
        .expect("K-brain discovery response");
        assert_eq!(result[0]["id"], "fixture-model");
        server.await.expect("fixture server");
    }

    #[test]
    fn flatten_history_messages_json_skips_invalid_summary_json() {
        let flattened = flatten_history_messages_json(&[
            make_segment(
                0,
                "segment-a",
                Some("{not-json"),
                r#"[{"role":"user","content":"hello"}]"#,
            ),
            make_segment(
                1,
                "segment-b",
                Some(r#"{"role":"summary","id":"summary-1","content":"compressed"}"#),
                r#"[{"role":"assistant","content":"world"}]"#,
            ),
        ])
        .expect("flatten history");

        let parsed = serde_json::from_str::<Value>(&flattened).expect("parse flattened history");
        let hello_hash = history_message_content_hash(&json!({
            "role":"user",
            "content":"hello"
        }));
        let world_hash = history_message_content_hash(&json!({
            "role":"assistant",
            "content":"world"
        }));
        assert_eq!(
            parsed,
            json!([
                {
                    "role":"user",
                    "content":"hello",
                    "liveAgentHistoryRef":{
                        "segmentIndex":0,
                        "messageIndex":0,
                        "segmentId":"segment-a",
                        "messageId":"segment-0-message-0-0",
                        "role":"user",
                        "contentHash":hello_hash
                    }
                },
                {"role":"summary","id":"summary-1","content":"compressed"},
                {
                    "role":"assistant",
                    "content":"world",
                    "liveAgentHistoryRef":{
                        "segmentIndex":1,
                        "messageIndex":0,
                        "segmentId":"segment-b",
                        "messageId":"segment-1-message-0-0",
                        "role":"assistant",
                        "contentHash":world_hash
                    }
                }
            ])
        );
    }

    #[test]
    fn flatten_history_messages_json_window_keeps_tail_refs() {
        let (flattened, returned_message_count) = flatten_history_messages_json_window(
            &[
                make_segment(
                    4,
                    "segment-a",
                    Some(r#"{"role":"summary","id":"summary-a","content":"older"}"#),
                    r#"[
                        {"role":"user","id":"user-old-0","content":"old-0"},
                        {"role":"assistant","content":"old-1"},
                        {"role":"user","id":"user-old-2","content":"old-2"}
                    ]"#,
                ),
                make_segment(
                    5,
                    "segment-b",
                    Some(r#"{"role":"summary","id":"summary-b","content":"newer"}"#),
                    r#"[
                        {"role":"assistant","content":"new-0"},
                        {"role":"user","id":"user-new-1","content":"new-1"}
                    ]"#,
                ),
            ],
            3,
        )
        .expect("flatten tail history window");

        let parsed = serde_json::from_str::<Value>(&flattened).expect("parse flattened history");
        let old_2_hash = history_message_content_hash(
            &json!({"role":"user","id":"user-old-2","content":"old-2"}),
        );
        let new_1_hash = history_message_content_hash(
            &json!({"role":"user","id":"user-new-1","content":"new-1"}),
        );
        let new_0_hash =
            history_message_content_hash(&json!({"role":"assistant","content":"new-0"}));
        assert_eq!(returned_message_count, 3);
        assert_eq!(
            parsed,
            json!([
                {"role":"summary","id":"summary-a","content":"older"},
                {
                    "role":"user",
                    "id":"user-old-2",
                    "content":"old-2",
                    "liveAgentHistoryRef":{
                        "segmentIndex":4,
                        "messageIndex":2,
                        "segmentId":"segment-a",
                        "messageId":"user-old-2",
                        "role":"user",
                        "contentHash":old_2_hash
                    }
                },
                {"role":"summary","id":"summary-b","content":"newer"},
                {
                    "role":"assistant",
                    "content":"new-0",
                    "liveAgentHistoryRef":{
                        "segmentIndex":5,
                        "messageIndex":0,
                        "segmentId":"segment-b",
                        "messageId":"segment-5-message-0-0",
                        "role":"assistant",
                        "contentHash":new_0_hash
                    }
                },
                {
                    "role":"user",
                    "id":"user-new-1",
                    "content":"new-1",
                    "liveAgentHistoryRef":{
                        "segmentIndex":5,
                        "messageIndex":1,
                        "segmentId":"segment-b",
                        "messageId":"user-new-1",
                        "role":"user",
                        "contentHash":new_1_hash
                    }
                }
            ])
        );
    }

    #[test]
    fn build_history_prefix_segments_excludes_target_and_tail() {
        let target = json!({"role":"user","id":"user-target","content":"target"});
        let target_hash = history_message_content_hash(&target);
        let segments = vec![
            make_segment(
                0,
                "segment-a",
                None,
                r#"[
                    {"role":"user","id":"user-a","content":"a"},
                    {"role":"assistant","content":"answer-a"}
                ]"#,
            ),
            make_segment(
                1,
                "segment-b",
                Some(r#"{"role":"summary","id":"summary-b","content":"older"}"#),
                r#"[
                    {"role":"assistant","content":"before"},
                    {"role":"user","id":"user-target","content":"target"},
                    {"role":"assistant","content":"after"}
                ]"#,
            ),
        ];

        let (prefix, count) = chat_history::build_history_prefix_segments(
            &segments,
            &ChatHistoryMessageRef {
                segment_index: 1_i64,
                message_index: 1_i64,
                segment_id: "segment-b".to_string(),
                message_id: "user-target".to_string(),
                role: "user".to_string(),
                content_hash: target_hash,
            },
        )
        .expect("prefix");

        assert_eq!(count, 3);
        assert_eq!(prefix.len(), 2);
        let target_segment_messages =
            serde_json::from_str::<Value>(&prefix[1].messages_json).expect("target segment JSON");
        assert_eq!(
            target_segment_messages,
            json!([{"role":"assistant","content":"before"}])
        );
    }

    #[test]
    fn flatten_history_messages_json_still_rejects_invalid_messages_json() {
        let error = flatten_history_messages_json(&[make_segment(
            0,
            "segment-a",
            Some(r#"{"role":"summary","id":"summary-1","content":"compressed"}"#),
            "{not-an-array",
        )])
        .expect_err("invalid messages_json should fail");

        assert!(error.contains("parse history segment segment-a failed"));
    }

    #[test]
    fn redact_builtin_tool_content_removes_arguments_and_results() {
        let raw = serde_json::to_string(&json!([
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "call-bash",
                        "name": "Bash",
                        "arguments": { "command": "cat secret.txt" }
                    },
                    {
                        "type": "toolCall",
                        "id": "call-custom",
                        "name": "CustomTool",
                        "arguments": { "query": "keep me" }
                    },
                    {
                        "type": "toolCall",
                        "id": "call-mcp",
                        "name": "mcp_docs_search",
                        "arguments": { "query": "secret mcp query" }
                    }
                ]
            },
            {
                "role": "toolResult",
                "toolCallId": "call-bash",
                "toolName": "Bash",
                "content": [{ "type": "text", "text": "secret output" }],
                "details": { "stdout": "secret output" }
            },
            {
                "role": "toolResult",
                "toolCallId": "call-custom",
                "toolName": "CustomTool",
                "content": [{ "type": "text", "text": "visible output" }],
                "details": { "data": "keep me" }
            },
            {
                "role": "toolResult",
                "toolCallId": "call-mcp",
                "toolName": "mcp_docs_search",
                "content": [{ "type": "text", "text": "secret mcp output" }],
                "details": { "serverId": "docs", "tool": "search", "mcp": { "content": "secret" } }
            }
        ]))
        .expect("serialize input");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact builtin tool content");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse redacted output");
        let items = parsed.as_array().expect("redacted history array");
        let blocks = items[0]["content"].as_array().expect("assistant content");

        assert_eq!(blocks[0]["name"], "Bash");
        assert_eq!(blocks[0]["arguments"], Value::Null);
        assert_eq!(blocks[0]["redacted"], true);
        assert_eq!(blocks[1]["arguments"]["query"], "keep me");
        assert_eq!(items[1]["content"][0]["text"], "工具调用内容已脱敏");
        assert_eq!(items[1]["details"]["kind"], "redacted_tool_content");
        assert_eq!(items[2]["content"][0]["text"], "visible output");
        assert_eq!(items[2]["details"]["data"], "keep me");
        assert_eq!(blocks[2]["name"], "mcp_docs_search");
        assert_eq!(blocks[2]["arguments"], Value::Null);
        assert_eq!(blocks[2]["redacted"], true);
        assert_eq!(items[3]["content"][0]["text"], "工具调用内容已脱敏");
        assert_eq!(items[3]["details"]["kind"], "redacted_tool_content");
    }

    #[test]
    fn shared_chat_history_builtin_policy_covers_the_tool_catalog() {
        let catalog = include_str!("../../../../agent-ui/src/lib/tools/builtinToolCatalog.ts");
        let tool_names = catalog.lines().filter_map(|line| {
            line.trim()
                .strip_prefix("toolName: \"")
                .and_then(|value| value.strip_suffix("\","))
        });
        let mut count = 0;
        for tool_name in tool_names {
            count += 1;
            assert!(
                is_builtin_share_tool_name(tool_name),
                "{tool_name} is missing from share redaction"
            );
        }
        assert!(count > 0, "catalog parser found no tools");
    }

    #[tokio::test]
    async fn proxy_detect_rejects_unknown_actions_and_bad_test_input() {
        use crate::services::gateway::proto;

        let unknown = super::handle_proxy_detect(proto::ProxyDetectRequest {
            action: "apply".to_string(),
            input_json: String::new(),
        })
        .await
        .unwrap_err();
        assert!(unknown.contains("unsupported"), "{unknown}");

        let malformed = super::handle_proxy_detect(proto::ProxyDetectRequest {
            action: "test".to_string(),
            input_json: r#"{"type":"ftp","host":"127.0.0.1","port":21}"#.to_string(),
        })
        .await
        .unwrap_err();
        assert!(malformed.contains("input invalid"), "{malformed}");

        // 没被检测到过的地址：桥接层原样带回服务层的拒绝。
        let undetected = super::handle_proxy_detect(proto::ProxyDetectRequest {
            action: " test ".to_string(),
            input_json: r#"{"type":"http","host":"203.0.113.7","port":3128}"#.to_string(),
        })
        .await
        .unwrap_err();
        assert!(undetected.contains("检测到"), "{undetected}");
    }
    /// 分发循环是单任务串行的（connection.rs 的 dispatcher_task）。MemoryManage 要等
    /// K-brain（手动整理可达 2 分钟），在循环里直接 await 会让同一连接的 Ping、chat、
    /// 审批全部排队。桌面 Wry AppHandle 无法在单测里构造，这里核对分发臂已 spawn。
    #[test]
    fn memory_manage_envelope_is_spawned_off_the_dispatch_loop() {
        let source = include_str!("gateway/envelope_handler.rs");
        let start = source
            .find("Payload::MemoryManage(request)) =>")
            .expect("MemoryManage arm");
        let rest = &source[start + 1..];
        let end = rest
            .find("Some(proto::gateway_envelope::Payload::")
            .expect("next arm");
        let arm = &rest[..end];
        assert!(
            arm.contains("async_runtime::spawn("),
            "MemoryManage arm awaits K-brain inline on the dispatch loop:\n{arm}"
        );
        // 对照：同样等 K-brain 的 SlashCommandList 已经 spawn。
        let slash = source
            .find("Payload::SlashCommandList(request)) =>")
            .expect("SlashCommandList arm");
        assert!(source[slash..slash + 200].contains("async_runtime::spawn("));
    }
}
