use std::{collections::HashSet, sync::Arc};

use serde::Deserialize;
use serde_json::{json, Value};

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
use crate::services::memory::{
    MemoryAcceptArgs, MemoryBatchArgs, MemoryDeleteArgs, MemoryDeleteProjectArgs, MemoryListArgs,
    MemoryOrganizeDueClaimArgs, MemoryOrganizeRunCreateArgs, MemoryOrganizeRunListArgs,
    MemoryOrganizeRunReadArgs, MemoryOrganizeRunUpdateArgs, MemoryQuotaSummaryArgs, MemoryReadArgs,
    MemoryRecentRejectionsArgs, MemorySearchArgs, MemoryStore, MemoryUpdateArgs, MemoryWriteArgs,
};
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

pub async fn handle_provider_list() -> Result<proto::ProviderListResponse, String> {
    let providers = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        load_providers(&conn)
    })
    .await
    .map_err(|e| format!("gateway provider list join failed: {e}"))??;

    let providers_json = serde_json::to_string(&sanitize_provider_summaries(providers)?)
        .map_err(|e| format!("serialize gateway provider list failed: {e}"))?;

    Ok(proto::ProviderListResponse { providers_json })
}

pub async fn handle_provider_models(
    request: proto::ProviderModelsRequest,
) -> Result<proto::ProviderModelsResponse, String> {
    let provider_type = request.provider_type.trim().to_string();
    let request_api_key = request.api_key.trim().to_string();
    let config = if request_api_key.is_empty() {
        let provider_id = request.provider_id.trim().to_string();
        let expected_provider_type = provider_type.clone();
        let is_full_url = request.is_full_url;
        tauri::async_runtime::spawn_blocking(move || {
            let conn = open_db()?;
            resolve_stored_provider_models_config(
                &provider_id,
                &expected_provider_type,
                is_full_url,
                load_providers(&conn)?,
            )
        })
        .await
        .map_err(|error| format!("读取供应商 API Key 任务失败：{error}"))??
    } else {
        ProviderModelsRequestConfig {
            provider_type,
            base_url: request.base_url.trim().to_string(),
            api_key: request_api_key,
            use_system_proxy: request.use_system_proxy,
            models_url: Some(request.models_url.trim().to_string())
                .filter(|value| !value.is_empty()),
            is_full_url: request.is_full_url.unwrap_or(false),
        }
    };
    let models_json = crate::services::provider_models::fetch_provider_models(
        &config.provider_type,
        &config.base_url,
        &config.api_key,
        config.use_system_proxy,
        config.models_url.as_deref(),
        config.is_full_url,
    )
    .await?;
    Ok(proto::ProviderModelsResponse { models_json })
}

#[derive(Debug, PartialEq)]
struct ProviderModelsRequestConfig {
    provider_type: String,
    base_url: String,
    api_key: String,
    use_system_proxy: bool,
    models_url: Option<String>,
    is_full_url: bool,
}

fn resolve_stored_provider_models_config(
    provider_id: &str,
    expected_provider_type: &str,
    is_full_url: Option<bool>,
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
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
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
    })
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

pub async fn handle_memory_manage(
    memory_store: Arc<MemoryStore>,
    request: proto::MemoryManageRequest,
) -> Result<proto::MemoryManageResponse, String> {
    tauri::async_runtime::spawn_blocking(move || handle_memory_manage_sync(memory_store, request))
        .await
        .map_err(|e| format!("gateway memory manage join failed: {e}"))?
}

fn handle_memory_manage_sync(
    memory_store: Arc<MemoryStore>,
    request: proto::MemoryManageRequest,
) -> Result<proto::MemoryManageResponse, String> {
    let command = request.command.trim();
    let result = match command {
        "memory_list" => {
            let args = parse_memory_args::<MemoryListArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.list(args)?)
        }
        "history_shared_list" => {
            let args = parse_memory_args::<HistorySharedListArgs>(&request.args_json, command)?;
            let page = chat_history::list_shared_chat_history_page_sync(args.page, args.page_size)?;
            serde_json::to_value(history_list_json(page))
        }
        "memory_read" => {
            let args = parse_memory_args::<MemoryReadArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.read(args)?)
        }
        "memory_search" => {
            let args = parse_memory_args::<MemorySearchArgs>(&request.args_json, command)?;
            let history_args = args.clone();
            let mut response = memory_store.search(args)?;
            response.history_matches =
                chat_history::search_chat_history_for_memory_sync(&history_args)?;
            serde_json::to_value(response)
        }
        "memory_write" => {
            let args = parse_memory_args::<MemoryWriteArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.write(args)?)
        }
        "memory_update" => {
            let args = parse_memory_args::<MemoryUpdateArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.update(args)?)
        }
        "memory_delete" => {
            let args = parse_memory_args::<MemoryDeleteArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.delete(args)?)
        }
        "memory_delete_project" => {
            let args = parse_memory_args::<MemoryDeleteProjectArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.delete_project(args)?)
        }
        "memory_accept" => {
            let args = parse_memory_args::<MemoryAcceptArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.accept(args)?)
        }
        "memory_apply_batch" => {
            let args = parse_memory_args::<MemoryBatchArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.apply_batch(args)?)
        }
        "memory_organize_run_create" => {
            let args =
                parse_memory_args::<MemoryOrganizeRunCreateArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.organize_run_create(args)?)
        }
        "memory_organize_run_update" => {
            let args =
                parse_memory_args::<MemoryOrganizeRunUpdateArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.organize_run_update(args)?)
        }
        "memory_organize_run_list" => {
            let args = if request.args_json.trim().is_empty() {
                MemoryOrganizeRunListArgs::default()
            } else {
                parse_memory_args::<MemoryOrganizeRunListArgs>(&request.args_json, command)?
            };
            serde_json::to_value(memory_store.organize_run_list(args)?)
        }
        "memory_organize_run_read" => {
            let args = parse_memory_args::<MemoryOrganizeRunReadArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.organize_run_read(args)?)
        }
        "memory_organize_run_clear_history" => {
            serde_json::to_value(memory_store.organize_run_clear_history()?)
        }
        "memory_organize_due_claim" => {
            let args =
                parse_memory_args::<MemoryOrganizeDueClaimArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.organize_due_claim(args)?)
        }
        "memory_organize_due_complete" => {
            let args =
                parse_memory_args::<MemoryOrganizeRunUpdateArgs>(&request.args_json, command)?;
            serde_json::to_value(memory_store.organize_due_complete(args)?)
        }
        "memory_index_overview" => {
            let args = parse_memory_value(&request.args_json, command)?;
            let workdir = args
                .get("workdir")
                .and_then(Value::as_str)
                .map(str::to_string);
            serde_json::to_value(memory_store.overview(workdir)?)
        }
        "memory_paths_info" => serde_json::to_value(memory_store.paths_info()?),
        "memory_recent_rejections" => {
            let args = if request.args_json.trim().is_empty() {
                MemoryRecentRejectionsArgs::default()
            } else {
                parse_memory_args::<MemoryRecentRejectionsArgs>(&request.args_json, command)?
            };
            serde_json::to_value(memory_store.recent_rejections(args)?)
        }
        "memory_today_local_date" => {
            let args = parse_memory_value(&request.args_json, command)?;
            let rollover_hour = args
                .get("rolloverHour")
                .or_else(|| args.get("rollover_hour"))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok());
            serde_json::to_value(memory_store.today_local_date(rollover_hour))
        }
        "memory_today_daily" => {
            let args = parse_memory_value(&request.args_json, command)?;
            let rollover_hour = args
                .get("rolloverHour")
                .or_else(|| args.get("rollover_hour"))
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok());
            serde_json::to_value(memory_store.today_daily(rollover_hour)?)
        }
        "memory_quota_summary" => {
            let args = if request.args_json.trim().is_empty() {
                MemoryQuotaSummaryArgs::default()
            } else {
                parse_memory_args::<MemoryQuotaSummaryArgs>(&request.args_json, command)?
            };
            serde_json::to_value(memory_store.quota_summary(args)?)
        }
        "memory_wipe_all" => serde_json::to_value(memory_store.wipe_all()?),
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

    use super::{
        flatten_history_messages_json, flatten_history_messages_json_window,
        is_builtin_share_tool_name, parse_runs_limit, redact_builtin_tool_content_json,
        resolve_stored_provider_models_config, sanitize_provider_summaries,
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
    fn provider_models_resolves_redacted_webui_config_from_matching_provider() {
        let providers = json!([{
            "id": "provider-a",
            "type": "codex",
            "baseUrl": "https://stored.example.com/v1/responses",
            "apiKey": "stored-secret",
            "isFullUrl": true,
            "modelsUrl": "https://stored.example.com/models",
            "useSystemProxy": true
        }]);
        assert_eq!(
            resolve_stored_provider_models_config("provider-a", "codex", None, Some(providers))
                .expect("stored provider config"),
            super::ProviderModelsRequestConfig {
                provider_type: "codex".to_string(),
                base_url: "https://stored.example.com/v1/responses".to_string(),
                api_key: "stored-secret".to_string(),
                use_system_proxy: true,
                models_url: Some("https://stored.example.com/models".to_string()),
                is_full_url: true,
            }
        );
    }

    #[test]
    fn provider_models_applies_webui_full_url_mode_to_stored_endpoint() {
        let providers = json!([{
            "id": "provider-a",
            "type": "codex",
            "baseUrl": "https://stored.example.com/v1/responses",
            "apiKey": "stored-secret",
            "isFullUrl": false
        }]);
        let config = resolve_stored_provider_models_config(
            "provider-a",
            "codex",
            Some(true),
            Some(providers),
        )
        .expect("stored provider config with draft full URL mode");

        assert_eq!(config.base_url, "https://stored.example.com/v1/responses");
        assert_eq!(config.api_key, "stored-secret");
        assert!(config.is_full_url);
    }

    #[test]
    fn provider_models_rejects_mismatched_stored_provider_type() {
        let providers = json!([{
            "id": "provider-a",
            "type": "claude_code",
            "apiKey": "stored-secret"
        }]);
        assert_eq!(
            resolve_stored_provider_models_config("provider-a", "codex", None, Some(providers))
                .expect_err("provider type mismatch"),
            "供应商类型与已保存配置不匹配"
        );
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
}
