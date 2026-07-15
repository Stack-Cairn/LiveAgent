use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock},
};

use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::commands::{
    chat_history,
    fs::{
        fs_create_dir_sync, fs_delete_sync, fs_list_dirs_sync, fs_list_sync, fs_mention_list_sync,
        fs_read_editable_text_sync, fs_read_workspace_image_sync, fs_rename_sync, fs_roots_sync,
        fs_write_text_sync,
    },
    git::git_gateway_action_sync,
    settings::{load_providers, open_db},
    system::{
        system_create_project_folder_sync, system_import_uploaded_readable_files_sync,
        system_list_skill_files_sync, system_read_skill_metadata_sync,
        system_read_skill_text_sync, system_read_uploaded_image_preview_sync,
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
    MemoryOrganizeRunReadArgs, MemoryOrganizeRunUpdateArgs, MemoryQuotaSummaryArgs,
    MemoryReadArgs, MemoryRecentRejectionsArgs, MemorySearchArgs, MemoryStore, MemoryUpdateArgs,
    MemoryWriteArgs,
};
use crate::services::skills::system_manage_skill_sync;

const DEFAULT_HISTORY_LIST_PAGE: i32 = 1;
const DEFAULT_HISTORY_LIST_PAGE_SIZE: i32 = 80;

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
            let snapshot =
                tauri::async_runtime::spawn_blocking(move || store.snapshot())
                    .await
                    .map_err(|e| format!("gateway automation snapshot join failed: {e}"))??;
            serialize_cron_manage_result(&snapshot)?
        }
        "cron_apply" => {
            let input = parse_apply_input(&request.task_json)?;
            let store = Arc::clone(&store);
            let response =
                tauri::async_runtime::spawn_blocking(move || store.cron_apply(input))
                    .await
                    .map_err(|e| format!("gateway cron apply join failed: {e}"))??;
            serialize_cron_manage_result(&response)?
        }
        "hooks_apply" => {
            let input = parse_apply_input(&request.task_json)?;
            let store = Arc::clone(&store);
            let response =
                tauri::async_runtime::spawn_blocking(move || store.hooks_apply(input))
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
            let cleared =
                tauri::async_runtime::spawn_blocking(move || store.clear_runs(&task_id))
                    .await
                    .map_err(|e| format!("gateway clear_runs join failed: {e}"))??;
            serialize_cron_manage_result(&json!({ "clearedCount": cleared }))?
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
    validate_stable_chat_message_ref(base_message_ref)?;

    let record = chat_history::chat_history_get(request.conversation_id.clone()).await?;
    let (prefix_segments, prefix_message_count) =
        build_history_prefix_segments(&record.segments, base_message_ref)?;
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
        fs_mention_list_sync(request.workdir, max_results, Some(request.query))
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
        fs_list_sync(request.workdir, path, depth, offset, max_results)
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
    tauri::async_runtime::spawn_blocking(move || fs_delete_sync(request.workdir, request.path))
        .await
        .map_err(|e| format!("gateway fs delete join failed: {e}"))?
        .map_err(|e| e.message)
        .map(|response| proto::FsDeleteResponse {
            path: response.path,
            kind: response.kind,
        })
}

pub async fn handle_git_request(request: proto::GitRequest) -> Result<proto::GitResponse, String> {
    let action = request.action.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let result = git_gateway_action_sync(action.clone(), request.workdir, request.args_json)?;
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
    let payload = serde_json::from_str::<Value>(trimmed)
        .map_err(|e| format!("invalid runs query: {e}"))?;
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

const BUILTIN_SHARE_TOOL_NAMES: &[&str] = &[
    "Agent",
    "Bash",
    "CronTaskManager",
    "Delete",
    "Edit",
    "Glob",
    "Grep",
    "HttpGetTest",
    "Image",
    "List",
    "ManagedProcess",
    "McpManager",
    "MemoryManager",
    "Read",
    "ReadTerminal",
    "SendMessage",
    "SkillsManager",
    "SSHManager",
    "SshManager",
    "TodoWrite",
    "TunnelManager",
    "Write",
];

fn is_builtin_share_tool_name(name: &str) -> bool {
    let trimmed = name.trim();
    let normalized = trimmed.to_ascii_lowercase();
    normalized.starts_with("mcp_")
        || matches!(
            normalized.as_str(),
            "websearch"
                | "web_search"
                | "builtin_web_search"
                | "web_search_20250305"
                | "web_search_20260209"
                | "web_search_20260318"
                | "web_search_2025_08_26"
                | "web_search_preview"
                | "web_search_preview_2025_03_11"
        )
        || normalized.starts_with("web_search_call")
        || BUILTIN_SHARE_TOOL_NAMES
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(trimmed))
}

fn collect_json_string_fields(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
    values: &mut Vec<String>,
) {
    for key in keys {
        let Some(value) = object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !values.iter().any(|candidate| candidate == value) {
            values.push(value.to_string());
        }
    }
}

fn json_string_fields(
    object: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Vec<String> {
    let mut values = Vec::new();
    collect_json_string_fields(object, keys, &mut values);
    values
}

fn non_empty_json_object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object().filter(|object| !object.is_empty())
}

#[derive(Debug)]
struct NormalizedToolCall {
    id: Option<String>,
    associated_ids: Vec<String>,
    name: Option<String>,
    is_call_like: bool,
}

fn normalize_tool_call_like(block: &Value) -> Option<NormalizedToolCall> {
    let record = block.as_object()?;
    let payload_record = record.get("payload").and_then(non_empty_json_object);
    let parsed_data = record
        .get("data")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let data_record = record
        .get("data")
        .and_then(non_empty_json_object)
        .or_else(|| parsed_data.as_ref().and_then(non_empty_json_object));

    let direct_nested_tool_call = record
        .get("toolCall")
        .filter(|value| !value.is_null())
        .and_then(non_empty_json_object);
    let payload_nested_tool_call = payload_record
        .and_then(|payload| payload.get("toolCall"))
        .filter(|value| !value.is_null())
        .and_then(non_empty_json_object);
    let data_nested_tool_call = data_record
        .and_then(|data| data.get("toolCall"))
        .filter(|value| !value.is_null())
        .and_then(non_empty_json_object);
    // Preserve WebUI field precedence, but inspect every wrapper as a security
    // boundary: a custom name in one layer must not mask a builtin name in another.
    let sources = [
        direct_nested_tool_call,
        payload_nested_tool_call,
        data_nested_tool_call,
        payload_record,
        data_record,
        Some(record),
    ];
    let mut associated_ids = Vec::new();
    let mut candidate_names = Vec::new();
    for source in sources.into_iter().flatten() {
        collect_json_string_fields(
            source,
            &["id", "toolCallId", "toolCallID", "tool_call_id", "call_id"],
            &mut associated_ids,
        );
        collect_json_string_fields(
            source,
            &["name", "toolName", "tool_name"],
            &mut candidate_names,
        );
    }
    let id = associated_ids.first().cloned();
    let name = candidate_names
        .iter()
        .find(|name| is_builtin_share_tool_name(name))
        .cloned()
        .or_else(|| candidate_names.first().cloned());
    let block_type = record.get("type").and_then(Value::as_str).map(str::trim);
    let is_call_like = matches!(block_type, Some("toolCall") | Some("tool_use"))
        || direct_nested_tool_call.is_some()
        || payload_nested_tool_call.is_some()
        || data_nested_tool_call.is_some()
        || ((payload_record.is_some() || data_record.is_some())
            && (id.is_some() || name.is_some()));

    Some(NormalizedToolCall {
        id,
        associated_ids,
        name,
        is_call_like,
    })
}

#[derive(Clone, Debug)]
struct RedactedToolIdentity {
    public_id: String,
    tool_name: String,
}

fn next_redacted_tool_identity(
    tool_name: String,
    next_ordinal: &mut usize,
    reserved_tool_ids: &mut HashSet<String>,
) -> RedactedToolIdentity {
    loop {
        let public_id = format!("share-redacted-tool-call-{}", *next_ordinal);
        *next_ordinal = (*next_ordinal).saturating_add(1);
        if reserved_tool_ids.insert(public_id.clone()) {
            return RedactedToolIdentity {
                public_id,
                tool_name,
            };
        }
    }
}

fn collect_reserved_tool_ids(messages: &[Value]) -> HashSet<String> {
    let mut reserved_tool_ids = HashSet::new();
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
                    let Some(normalized) = normalize_tool_call_like(block) else {
                        continue;
                    };
                    if normalized.is_call_like {
                        for id in normalized.associated_ids {
                            reserved_tool_ids.insert(id);
                        }
                    }
                }
            }
            Some("toolResult") => {
                for id in json_string_fields(
                    object,
                    &["toolCallId", "toolCallID", "tool_call_id", "call_id"],
                ) {
                    reserved_tool_ids.insert(id);
                }
            }
            _ => {}
        }
    }
    reserved_tool_ids
}

fn collect_redacted_original_tool_ids(messages: &[Value]) -> HashMap<String, String> {
    let mut tool_names_by_id = HashMap::new();
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
                    let Some(normalized) = normalize_tool_call_like(block) else {
                        continue;
                    };
                    if !normalized.is_call_like {
                        continue;
                    }
                    let Some(tool_name) = normalized
                        .name
                        .filter(|name| is_builtin_share_tool_name(name))
                    else {
                        continue;
                    };
                    for id in normalized.associated_ids {
                        tool_names_by_id.entry(id).or_insert(tool_name.clone());
                    }
                }
            }
            Some("toolResult") => {
                let Some(tool_name) = json_string_fields(
                    object,
                    &["toolName", "tool_name", "name"],
                )
                .into_iter()
                .find(|name| is_builtin_share_tool_name(name))
                else {
                    continue;
                };
                for id in json_string_fields(
                    object,
                    &["toolCallId", "toolCallID", "tool_call_id", "call_id"],
                ) {
                    tool_names_by_id.entry(id).or_insert(tool_name.clone());
                }
            }
            _ => {}
        }
    }
    tool_names_by_id
}

struct RedactedToolPlan {
    call_identities_by_location: HashMap<(usize, usize), RedactedToolIdentity>,
    call_identities_by_original_id: HashMap<String, Vec<RedactedToolIdentity>>,
    tool_names_by_original_id: HashMap<String, String>,
    next_ordinal: usize,
    reserved_tool_ids: HashSet<String>,
}

fn build_redacted_tool_plan(messages: &[Value]) -> RedactedToolPlan {
    let tool_names_by_original_id = collect_redacted_original_tool_ids(messages);
    let mut reserved_tool_ids = collect_reserved_tool_ids(messages);
    let mut call_identities_by_location = HashMap::new();
    let mut call_identities_by_original_id: HashMap<String, Vec<RedactedToolIdentity>> =
        HashMap::new();
    let mut next_ordinal = 1;

    for (message_index, message) in messages.iter().enumerate() {
        let Some(object) = message.as_object() else {
            continue;
        };
        if object.get("role").and_then(Value::as_str).map(str::trim) != Some("assistant") {
            continue;
        }
        let Some(blocks) = object.get("content").and_then(Value::as_array) else {
            continue;
        };
        for (block_index, block) in blocks.iter().enumerate() {
            let Some(normalized) = normalize_tool_call_like(block) else {
                continue;
            };
            if !normalized.is_call_like {
                continue;
            }
            let original_name = normalized.name;
            let original_id = normalized.id;
            let associated_ids = normalized.associated_ids;
            let tool_name = original_name
                .as_ref()
                .filter(|name| is_builtin_share_tool_name(name))
                .cloned()
                .or_else(|| {
                    original_id
                        .as_ref()
                        .and_then(|id| tool_names_by_original_id.get(id))
                        .cloned()
                });
            let Some(tool_name) = tool_name else {
                continue;
            };

            let identity =
                next_redacted_tool_identity(tool_name, &mut next_ordinal, &mut reserved_tool_ids);
            call_identities_by_location.insert((message_index, block_index), identity.clone());
            for original_id in associated_ids {
                call_identities_by_original_id
                    .entry(original_id)
                    .or_default()
                    .push(identity.clone());
            }
        }
    }

    RedactedToolPlan {
        call_identities_by_location,
        call_identities_by_original_id,
        tool_names_by_original_id,
        next_ordinal,
        reserved_tool_ids,
    }
}

static SEED_TOOL_CALL_MARKUP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<\s*seed:tool_call\s*>.*?(?:</\s*seed:tool_call\s*>|\z)")
        .expect("valid seed tool-call markup regex")
});

static DSML_TOOL_CALL_MARKUP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)<\s*(?:\|{2}|｜{2})\s*DSML\s*(?:\|{2}|｜{2})\s*tool_calls\s*>.*?(?:</\s*(?:\|{2}|｜{2})\s*DSML\s*(?:\|{2}|｜{2})\s*tool_calls\s*>|\z)",
    )
    .expect("valid DSML tool-call markup regex")
});

static FLATTENED_TOOL_REQUEST_HEADER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?im)(?:(?:Previous assistant tool request:|Historical assistant tool request \(read-only context; do not repeat\):|Historical tool call \(read-only, not repeating\):)\s*|^[ \t]*)(?:tool_call_id:[^\r\n]*\s*)?tool_name:\s*(?P<tool_name>[^\r\n]+?)\s*arguments:\s*",
    )
    .expect("valid flattened tool-request header regex")
});

fn find_json_container_end(value: &str, start: usize) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut index = start;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if !matches!(bytes.get(index), Some(b'{') | Some(b'[')) {
        return None;
    }

    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[index..].iter().copied().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => stack.push(b'}'),
            b'[' => stack.push(b']'),
            b'}' | b']' if stack.pop() != Some(byte) => return None,
            b'}' | b']' if stack.is_empty() => return Some(index + offset + 1),
            _ => {}
        }
    }
    None
}

fn strip_flattened_builtin_tool_requests(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut copied_through = 0;
    let mut search_from = 0;

    while search_from < value.len() {
        let Some(captures) = FLATTENED_TOOL_REQUEST_HEADER_RE.captures(&value[search_from..])
        else {
            break;
        };
        let header = captures.get(0).expect("flattened header match");
        let absolute_start = search_from + header.start();
        let absolute_end = search_from + header.end();
        let is_builtin = captures
            .name("tool_name")
            .map(|capture| is_builtin_share_tool_name(capture.as_str()))
            .unwrap_or(false);
        if !is_builtin {
            search_from = absolute_end;
            continue;
        }

        output.push_str(&value[copied_through..absolute_start]);
        // A malformed or truncated recovered request is removed through EOF. This
        // deliberately fails closed because its argument boundary is unknowable.
        let removal_end = find_json_container_end(value, absolute_end).unwrap_or(value.len());
        copied_through = removal_end;
        search_from = removal_end;
    }
    output.push_str(&value[copied_through..]);
    output
}

fn strip_recovered_tool_call_markup(value: &str) -> String {
    let without_seed = SEED_TOOL_CALL_MARKUP_RE.replace_all(value, "");
    let without_dsml = DSML_TOOL_CALL_MARKUP_RE
        .replace_all(&without_seed, "")
        .into_owned();
    strip_flattened_builtin_tool_requests(&without_dsml)
}

fn redact_assistant_text_markup(message: &mut Value) {
    let Some(content) = message
        .as_object_mut()
        .and_then(|object| object.get_mut("content"))
    else {
        return;
    };
    if let Some(text) = content.as_str() {
        *content = Value::String(strip_recovered_tool_call_markup(text));
        return;
    }
    let Some(blocks) = content.as_array_mut() else {
        return;
    };
    for block in blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        match object.get("type").and_then(Value::as_str).map(str::trim) {
            Some("text") => {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    let stripped = strip_recovered_tool_call_markup(text);
                    object.insert("text".to_string(), Value::String(stripped));
                }
            }
            Some("thinking") => {
                for key in ["thinking", "text"] {
                    if let Some(text) = object.get(key).and_then(Value::as_str) {
                        let stripped = strip_recovered_tool_call_markup(text);
                        object.insert(key.to_string(), Value::String(stripped));
                    }
                }
            }
            _ => {}
        }
    }
}

fn redacted_tool_call_block(identity: &RedactedToolIdentity) -> Value {
    json!({
        "type": "toolCall",
        "id": identity.public_id,
        "name": identity.tool_name,
        "redacted": true,
    })
}

fn redacted_hosted_search_block(source: &Value, public_id: String) -> Value {
    let status = source
        .as_object()
        .and_then(|object| object.get("status"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| matches!(*status, "searching" | "completed" | "failed"))
        .unwrap_or("searching");
    json!({
        "type": "hostedSearch",
        "id": public_id,
        "status": status,
        "queries": [],
        "sources": [],
        "redacted": true,
    })
}

fn redacted_tool_result_message(source: &Value, identity: &RedactedToolIdentity) -> Value {
    let source = source.as_object();
    let mut redacted = serde_json::Map::new();
    redacted.insert("role".to_string(), Value::String("toolResult".to_string()));
    redacted.insert(
        "toolCallId".to_string(),
        Value::String(identity.public_id.clone()),
    );
    redacted.insert(
        "toolName".to_string(),
        Value::String(identity.tool_name.clone()),
    );
    redacted.insert(
        "content".to_string(),
        json!([{ "type": "text", "text": "工具调用内容已脱敏" }]),
    );
    redacted.insert(
        "details".to_string(),
        json!({ "kind": "redacted_tool_content" }),
    );
    redacted.insert(
        "isError".to_string(),
        Value::Bool(
            source
                .and_then(|object| object.get("isError"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    if let Some(timestamp) = source
        .and_then(|object| object.get("timestamp"))
        .filter(|value| value.is_number())
    {
        redacted.insert("timestamp".to_string(), timestamp.clone());
    }
    redacted.insert("redacted".to_string(), Value::Bool(true));
    Value::Object(redacted)
}

fn redact_summary_message(message: &Value) -> Value {
    let source = message.as_object();
    let mut redacted = serde_json::Map::new();
    redacted.insert("role".to_string(), Value::String("summary".to_string()));
    if let Some(id) = source
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
    {
        redacted.insert("id".to_string(), Value::String(id.to_string()));
    }
    if let Some(timestamp) = source
        .and_then(|object| object.get("timestamp"))
        .filter(|value| value.is_number())
    {
        redacted.insert("timestamp".to_string(), timestamp.clone());
    }
    redacted.insert(
        "content".to_string(),
        Value::String("摘要内容已脱敏".to_string()),
    );
    redacted.insert("redacted".to_string(), Value::Bool(true));
    Value::Object(redacted)
}

fn refresh_redacted_history_ref_content_hash(message: &mut Value) {
    let has_history_ref = message
        .as_object()
        .and_then(|object| object.get("liveAgentHistoryRef"))
        .and_then(Value::as_object)
        .is_some();
    if !has_history_ref {
        return;
    }

    let content_hash = history_message_content_hash(message);
    if let Some(history_ref) = message
        .as_object_mut()
        .and_then(|object| object.get_mut("liveAgentHistoryRef"))
        .and_then(Value::as_object_mut)
    {
        history_ref.insert("contentHash".to_string(), Value::String(content_hash));
    }
}

fn redact_builtin_tool_content_json(raw: &str) -> Result<String, String> {
    let mut parsed = serde_json::from_str::<Value>(raw)
        .map_err(|e| format!("parse share history failed: {e}"))?;
    let items = parsed
        .as_array_mut()
        .ok_or_else(|| "share history messages payload is not an array".to_string())?;
    let redacted_tool_plan = build_redacted_tool_plan(items);
    let mut next_redacted_ordinal = redacted_tool_plan.next_ordinal;
    let mut next_redacted_hosted_search_ordinal = 1usize;
    let mut reserved_tool_ids = redacted_tool_plan.reserved_tool_ids.clone();
    let mut result_identity_cursors: HashMap<String, usize> = HashMap::new();
    let mut consumed_result_identity_ids = HashSet::new();

    for (message_index, message) in items.iter_mut().enumerate() {
        if message
            .as_object()
            .and_then(|object| object.get("role"))
            .and_then(Value::as_str)
            .map(str::trim)
            == Some("summary")
        {
            *message = redact_summary_message(message);
            continue;
        }
        let role = message
            .as_object()
            .and_then(|object| object.get("role"))
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string());
        match role.as_deref() {
            Some("assistant") => {
                redact_assistant_text_markup(message);
                if let Some(blocks) = message
                    .as_object_mut()
                    .and_then(|object| object.get_mut("content"))
                    .and_then(Value::as_array_mut)
                {
                    for (block_index, block) in blocks.iter_mut().enumerate() {
                        if let Some(identity) = redacted_tool_plan
                            .call_identities_by_location
                            .get(&(message_index, block_index))
                        {
                            *block = redacted_tool_call_block(identity);
                        } else if block
                            .as_object()
                            .and_then(|object| object.get("type"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            == Some("hostedSearch")
                        {
                            let public_id = loop {
                                let candidate = format!(
                                    "share-redacted-hosted-search-{}",
                                    next_redacted_hosted_search_ordinal
                                );
                                next_redacted_hosted_search_ordinal =
                                    next_redacted_hosted_search_ordinal.saturating_add(1);
                                if reserved_tool_ids.insert(candidate.clone()) {
                                    break candidate;
                                }
                            };
                            *block = redacted_hosted_search_block(block, public_id);
                        }
                    }
                }
            }
            Some("toolResult") => {
                let object = message.as_object().expect("toolResult message object");
                let original_names =
                    json_string_fields(object, &["toolName", "tool_name", "name"]);
                let original_ids = json_string_fields(
                    object,
                    &["toolCallId", "toolCallID", "tool_call_id", "call_id"],
                );
                let builtin_name = original_names
                    .iter()
                    .find(|name| is_builtin_share_tool_name(name))
                    .cloned();
                let mut planned_identity = None;
                for id in &original_ids {
                    let Some(identities) = redacted_tool_plan.call_identities_by_original_id.get(id)
                    else {
                        continue;
                    };
                    let cursor = result_identity_cursors.entry(id.clone()).or_default();
                    while identities.get(*cursor).is_some_and(|identity| {
                        consumed_result_identity_ids.contains(&identity.public_id)
                    }) {
                        *cursor = (*cursor).saturating_add(1);
                    }
                    if let Some(identity) = identities.get(*cursor).cloned() {
                        *cursor = (*cursor).saturating_add(1);
                        consumed_result_identity_ids.insert(identity.public_id.clone());
                        planned_identity = Some(identity);
                        break;
                    }
                }
                let planned_tool_name = original_ids.iter().find_map(|id| {
                    redacted_tool_plan
                        .tool_names_by_original_id
                        .get(id)
                        .cloned()
                });
                if builtin_name.is_some()
                    || planned_identity.is_some()
                    || planned_tool_name.is_some()
                {
                    let identity = planned_identity.unwrap_or_else(|| {
                        next_redacted_tool_identity(
                            builtin_name
                                .or(planned_tool_name)
                                .unwrap_or_else(|| "Tool".to_string()),
                            &mut next_redacted_ordinal,
                            &mut reserved_tool_ids,
                        )
                    });
                    *message = redacted_tool_result_message(message, &identity);
                }
            }
            _ => {}
        }
        refresh_redacted_history_ref_content_hash(message);
    }

    serde_json::to_string(items)
        .map_err(|e| format!("serialize redacted share history failed: {e}"))
}

fn flatten_history_messages_json(
    segments: &[chat_history::ChatHistorySegmentRecord],
) -> Result<String, String> {
    flatten_history_messages_json_window(segments, 0).map(|(messages_json, _)| messages_json)
}

fn validate_stable_chat_message_ref(ref_value: &proto::ChatMessageRef) -> Result<(), String> {
    if ref_value.segment_index < 0 || ref_value.message_index < 0 {
        return Err("base_message_ref indexes must be non-negative".to_string());
    }
    if ref_value.segment_id.trim().is_empty()
        || ref_value.message_id.trim().is_empty()
        || ref_value.role.trim().is_empty()
        || ref_value.content_hash.trim().is_empty()
    {
        return Err(
            "base_message_ref requires segment_id, message_id, role, and content_hash".to_string(),
        );
    }
    if ref_value.role.trim() != "user" {
        return Err("base_message_ref role must be user".to_string());
    }
    Ok(())
}

fn read_json_trimmed_string(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn flatten_user_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                block.as_object().and_then(|object| {
                    match object.get("type").and_then(Value::as_str) {
                        Some("text") => object.get("text").and_then(Value::as_str),
                        _ => None,
                    }
                })
            })
            .collect::<String>(),
        _ => String::new(),
    }
}

fn append_hash_part(parts: &mut Vec<String>, value: impl AsRef<str>) {
    let value = value.as_ref();
    parts.push(format!("{}:{value}", value.len()));
}

fn fnv1a32(input: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for byte in input.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("fnv1a32:{hash:08x}")
}

fn history_message_content_hash(message: &Value) -> String {
    let object = message.as_object();
    let role = object
        .and_then(|object| object.get("role"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut parts = vec!["liveagent-history-ref-v1".to_string()];
    append_hash_part(&mut parts, role);

    if role == "user" {
        let display_text = object
            .and_then(|object| object.get("liveAgentDisplayContent"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                flatten_user_content(object.and_then(|object| object.get("content")))
            });
        append_hash_part(&mut parts, display_text);

        let attachments = object
            .and_then(|object| object.get("liveAgentAttachments"))
            .and_then(Value::as_array);
        let valid_attachments = attachments
            .map(|attachments| {
                attachments
                    .iter()
                    .filter_map(Value::as_object)
                    .filter(|attachment| {
                        attachment
                            .get("relativePath")
                            .and_then(Value::as_str)
                            .is_some()
                            && attachment.get("fileName").and_then(Value::as_str).is_some()
                            && attachment.get("kind").and_then(Value::as_str).is_some()
                            && attachment
                                .get("sizeBytes")
                                .and_then(Value::as_f64)
                                .is_some()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        append_hash_part(&mut parts, valid_attachments.len().to_string());
        for attachment_object in valid_attachments {
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("fileName")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            append_hash_part(
                &mut parts,
                attachment_object
                    .get("sizeBytes")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "0".to_string()),
            );
        }
    } else {
        append_hash_part(
            &mut parts,
            object
                .and_then(|object| object.get("content"))
                .map(Value::to_string)
                .unwrap_or_else(|| "null".to_string()),
        );
    }

    fnv1a32(&parts.join("|"))
}

fn history_message_id_for_ref(message: &Value) -> Option<String> {
    let object = message.as_object()?;
    read_json_trimmed_string(object, "id").or_else(|| {
        if object.get("role").and_then(Value::as_str) == Some("assistant") {
            read_json_trimmed_string(object, "responseId")
        } else {
            None
        }
    })
}

fn build_history_message_ref_json(
    segment: &chat_history::ChatHistorySegmentRecord,
    message_index: usize,
    message: &Value,
) -> Option<Value> {
    let object = message.as_object()?;
    let segment_id = segment.segment_id.trim();
    let message_id = history_message_id_for_ref(message)?;
    let role = object.get("role").and_then(Value::as_str)?.trim();
    if segment_id.is_empty() || message_id.is_empty() || role.is_empty() {
        return None;
    }
    Some(json!({
        "segmentIndex": segment.segment_index,
        "messageIndex": message_index,
        "segmentId": segment_id,
        "messageId": message_id,
        "role": role,
        "contentHash": history_message_content_hash(message),
    }))
}

fn message_matches_stable_ref(message: &Value, ref_value: &proto::ChatMessageRef) -> bool {
    let Some(object) = message.as_object() else {
        return false;
    };
    let Some(message_id) = history_message_id_for_ref(message) else {
        return false;
    };
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    message_id == ref_value.message_id.trim()
        && role == ref_value.role.trim()
        && history_message_content_hash(message) == ref_value.content_hash.trim()
}

fn build_history_prefix_segments(
    segments: &[chat_history::ChatHistorySegmentRecord],
    ref_value: &proto::ChatMessageRef,
) -> Result<(Vec<chat_history::ChatHistorySegmentRecord>, i64), String> {
    let mut prefix_segments = Vec::new();
    let mut prefix_message_count = 0_i64;
    let target_segment_id = ref_value.segment_id.trim();

    for segment in segments {
        let parsed = serde_json::from_str::<Value>(&segment.messages_json)
            .map_err(|e| format!("parse history segment {} failed: {e}", segment.segment_id))?;
        let messages = parsed
            .as_array()
            .ok_or_else(|| format!("history segment {} is not an array", segment.segment_id))?;

        if segment.segment_id.trim() != target_segment_id {
            let message_count = i64::try_from(messages.len()).unwrap_or(i64::MAX);
            prefix_message_count = prefix_message_count.saturating_add(message_count);
            prefix_segments.push(segment.clone());
            continue;
        }

        let hinted_index = usize::try_from(ref_value.message_index).ok();
        let target_index = hinted_index
            .filter(|index| {
                messages
                    .get(*index)
                    .map(|message| message_matches_stable_ref(message, ref_value))
                    .unwrap_or(false)
            })
            .or_else(|| {
                messages
                    .iter()
                    .position(|message| message_matches_stable_ref(message, ref_value))
            })
            .ok_or_else(|| {
                "base_message_ref did not match a stable user message in history".to_string()
            })?;

        let prefix_messages = messages[..target_index].to_vec();
        let mut prefix_segment = segment.clone();
        prefix_segment.messages_json = serde_json::to_string(&prefix_messages)
            .map_err(|e| format!("serialize history prefix segment failed: {e}"))?;
        prefix_segment.message_count = i64::try_from(prefix_messages.len()).unwrap_or(i64::MAX);
        prefix_segment.end_message_id = prefix_messages
            .last()
            .and_then(history_message_id_for_ref)
            .or_else(|| segment.start_message_id.clone());
        prefix_message_count = prefix_message_count.saturating_add(prefix_segment.message_count);
        prefix_segments.push(prefix_segment);
        return Ok((prefix_segments, prefix_message_count));
    }

    Err("base_message_ref segment was not found in history".to_string())
}

fn flatten_history_messages_json_window(
    segments: &[chat_history::ChatHistorySegmentRecord],
    max_messages: i64,
) -> Result<(String, i32), String> {
    struct ParsedSegment<'a> {
        segment: &'a chat_history::ChatHistorySegmentRecord,
        summary: Option<Value>,
        messages: Vec<Value>,
    }

    let mut parsed_segments = Vec::new();
    let mut selected_message_count = 0_usize;
    for segment in segments {
        let summary = match segment.summary_json.as_deref().map(str::trim) {
            Some(trimmed) if !trimmed.is_empty() => match serde_json::from_str::<Value>(trimmed) {
                Ok(summary) => Some(summary),
                Err(error) => {
                    eprintln!(
                        "skip invalid history segment summary {}: {error}",
                        segment.segment_id
                    );
                    None
                }
            },
            _ => None,
        };

        let parsed = serde_json::from_str::<Value>(&segment.messages_json)
            .map_err(|e| format!("parse history segment {} failed: {e}", segment.segment_id))?;
        let items = parsed
            .as_array()
            .ok_or_else(|| format!("history segment {} is not an array", segment.segment_id))?
            .to_vec();
        selected_message_count = selected_message_count.saturating_add(items.len());
        parsed_segments.push(ParsedSegment {
            segment,
            summary,
            messages: items,
        });
    }

    let max_messages = usize::try_from(max_messages.max(0)).unwrap_or(0);
    let mut messages_to_skip = if max_messages > 0 && selected_message_count > max_messages {
        selected_message_count - max_messages
    } else {
        0
    };
    let mut merged = Vec::new();
    let mut returned_message_count = 0_usize;

    for parsed in parsed_segments {
        if messages_to_skip >= parsed.messages.len() {
            messages_to_skip -= parsed.messages.len();
            continue;
        }

        if let Some(summary) = parsed.summary {
            merged.push(summary);
        }

        let start_index = messages_to_skip;
        messages_to_skip = 0;
        for (message_index, item) in parsed.messages.iter().enumerate().skip(start_index) {
            let mut cloned = item.clone();
            if let Some(object) = cloned.as_object_mut() {
                if let Some(history_ref) =
                    build_history_message_ref_json(parsed.segment, message_index, item)
                {
                    object.insert("liveAgentHistoryRef".to_string(), history_ref);
                }
            }
            merged.push(cloned);
            returned_message_count = returned_message_count.saturating_add(1);
        }
    }

    let messages_json = serde_json::to_string(&merged)
        .map_err(|e| format!("serialize flattened history messages failed: {e}"))?;
    Ok((
        messages_json,
        i32::try_from(returned_message_count).unwrap_or(i32::MAX),
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
        build_history_prefix_segments, flatten_history_messages_json,
        flatten_history_messages_json_window, history_message_content_hash,
        is_builtin_share_tool_name, parse_runs_limit, redact_builtin_tool_content_json,
        sanitize_provider_summaries,
    };
    use crate::commands::chat_history::ChatHistorySegmentRecord;

    fn make_segment(
        segment_index: i64,
        segment_id: &str,
        summary_json: Option<&str>,
        messages_json: &str,
    ) -> ChatHistorySegmentRecord {
        ChatHistorySegmentRecord {
            segment_index,
            segment_id: segment_id.to_string(),
            summary_json: summary_json.map(str::to_string),
            messages_json: messages_json.to_string(),
            message_count: 0,
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
                "nativeWebSearchEnabled": false
            }
        ])))
        .expect("sanitize provider summaries");

        assert_eq!(result[0]["id"], "provider-a");
        assert_eq!(result[0]["nativeWebSearchEnabled"], false);
        assert_eq!(result[0]["apiKey"], Value::Null);
        assert_eq!(result[0]["baseUrl"], Value::Null);
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
        assert_eq!(
            parsed,
            json!([
                {
                    "role":"user",
                    "content":"hello"
                },
                {"role":"summary","id":"summary-1","content":"compressed"},
                {
                    "role":"assistant",
                    "content":"world"
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
                    "content":"new-0"
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

        let (prefix, count) = build_history_prefix_segments(
            &segments,
            &crate::services::gateway::proto::ChatMessageRef {
                segment_index: 1,
                message_index: 1,
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
                        "arguments": { "command": "cat secret.txt" },
                        "thoughtSignature": "secret thought signature",
                        "reasoning_details": { "encrypted": "secret reasoning" },
                        "unknownProviderField": "secret provider field"
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
                "details": { "stdout": "secret output" },
                "unknownProviderField": "secret result field"
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

        assert_eq!(
            blocks[0],
            json!({
                "type": "toolCall",
                "id": "share-redacted-tool-call-1",
                "name": "Bash",
                "redacted": true
            })
        );
        assert_eq!(blocks[1]["arguments"]["query"], "keep me");
        assert_eq!(
            items[1],
            json!({
                "role": "toolResult",
                "toolCallId": "share-redacted-tool-call-1",
                "toolName": "Bash",
                "content": [{ "type": "text", "text": "工具调用内容已脱敏" }],
                "details": { "kind": "redacted_tool_content" },
                "isError": false,
                "redacted": true
            })
        );
        assert_eq!(items[2]["content"][0]["text"], "visible output");
        assert_eq!(items[2]["details"]["data"], "keep me");
        assert_eq!(blocks[2]["name"], "mcp_docs_search");
        assert_eq!(blocks[2]["id"], "share-redacted-tool-call-2");
        assert_eq!(blocks[2]["arguments"], Value::Null);
        assert_eq!(blocks[2]["redacted"], true);
        assert_eq!(items[3]["toolCallId"], blocks[2]["id"]);
        assert_eq!(items[3]["content"][0]["text"], "工具调用内容已脱敏");
        assert_eq!(items[3]["details"]["kind"], "redacted_tool_content");
        for secret in [
            "secret thought signature",
            "secret reasoning",
            "secret provider field",
            "secret result field",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn redact_builtin_tool_content_covers_current_chat_tools() {
        for tool_name in ["ReadTerminal", "SendMessage", "TodoWrite", "TunnelManager"] {
            let tool_call_id = format!("call-{tool_name}");
            let raw = serde_json::to_string(&json!([
                {
                    "role": "assistant",
                    "content": [{
                        "type": "toolCall",
                        "id": tool_call_id,
                        "name": tool_name,
                        "arguments": { "secretArgument": format!("secret-{tool_name}") }
                    }]
                },
                {
                    "role": "toolResult",
                    "toolCallId": tool_call_id,
                    "toolName": tool_name,
                    "content": [{ "type": "text", "text": format!("secret output from {tool_name}") }],
                    "details": { "secretDetail": format!("secret detail from {tool_name}") }
                }
            ]))
            .expect("serialize input");

            let redacted = redact_builtin_tool_content_json(&raw)
                .unwrap_or_else(|error| panic!("redact {tool_name}: {error}"));
            let parsed = serde_json::from_str::<Value>(&redacted)
                .unwrap_or_else(|error| panic!("parse redacted {tool_name}: {error}"));
            let items = parsed.as_array().expect("redacted history array");
            let block = &items[0]["content"][0];

            assert_eq!(block["name"], tool_name);
            assert_eq!(block["id"], "share-redacted-tool-call-1", "{tool_name}");
            assert_eq!(block["arguments"], Value::Null, "{tool_name}");
            assert_eq!(block["redacted"], true, "{tool_name}");
            assert_eq!(items[1]["toolCallId"], block["id"], "{tool_name}");
            assert_eq!(
                items[1]["content"][0]["text"], "工具调用内容已脱敏",
                "{tool_name}"
            );
            assert_eq!(
                items[1]["details"]["kind"], "redacted_tool_content",
                "{tool_name}"
            );
            assert!(
                !redacted.contains(&format!("secret-{tool_name}")),
                "{tool_name}"
            );
            assert!(
                !redacted.contains(&format!("secret output from {tool_name}")),
                "{tool_name}"
            );
            assert!(
                !redacted.contains(&format!("secret detail from {tool_name}")),
                "{tool_name}"
            );
        }
    }

    #[test]
    fn redaction_strips_recovered_tool_markup_from_all_assistant_text_shapes() {
        let raw = serde_json::to_string(&json!([
            {
                "role": "assistant",
                "content": "before <seed:tool_call>string-secret</seed:tool_call> after"
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": "text-before <SEED:TOOL_CALL>text-secret</SEED:TOOL_CALL> text-after"
                    },
                    {
                        "type": "thinking",
                        "thinking": "think-before <｜｜DSML｜｜ tool_calls>thinking-secret</｜｜DSML｜｜ tool_calls> think-after"
                    },
                    {
                        "type": "thinking",
                        "text": "fallback-before <||DSML|| tool_calls>unterminated-dsml-secret"
                    },
                    {
                        "type": "text",
                        "text": "tail-before <seed:tool_call>unterminated-seed-secret"
                    }
                ]
            }
        ]))
        .expect("serialize recovered markup history");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact recovered markup");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse redacted history");

        assert_eq!(parsed[0]["content"], "before  after");
        assert_eq!(parsed[1]["content"][0]["text"], "text-before  text-after");
        assert_eq!(
            parsed[1]["content"][1]["thinking"],
            "think-before  think-after"
        );
        assert_eq!(parsed[1]["content"][2]["text"], "fallback-before ");
        assert_eq!(parsed[1]["content"][3]["text"], "tail-before ");
        for secret_or_markup in [
            "string-secret",
            "text-secret",
            "thinking-secret",
            "unterminated-dsml-secret",
            "unterminated-seed-secret",
            "<seed:tool_call>",
            "DSML",
        ] {
            assert!(
                !redacted.contains(secret_or_markup),
                "leaked {secret_or_markup}"
            );
        }
    }

    #[test]
    fn redaction_strips_flattened_builtin_requests_but_preserves_surrounding_and_custom_text() {
        let raw = serde_json::to_string(&json!([{
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "before\nPrevious assistant tool request:\n\ntool_call_id: c1\n\ntool_name: bash\n\narguments:\n{\"command\":\"cat /home/me/.ssh/id_rsa\",\"nested\":{\"close\":\"} still secret\"}}\nafter"
                },
                {
                    "type": "thinking",
                    "thinking": "Historical tool call (read-only, not repeating):\ntool_name: MCP_docs_search\narguments: [\"thinking-secret\"]\nthinking-after"
                },
                {
                    "type": "text",
                    "text": "Previous assistant tool request:\ntool_name: CustomTool\narguments:\n{\"query\":\"custom-visible\"}"
                },
                {
                    "type": "text",
                    "text": "prefix\ntool_name: BASH\narguments:\n{\"command\":\"unterminated-secret\""
                }
            ]
        }]))
        .expect("serialize flattened tool requests");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact flattened requests");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse redacted history");

        assert_eq!(parsed[0]["content"][0]["text"], "before\n\nafter");
        assert_eq!(parsed[0]["content"][1]["thinking"], "\nthinking-after");
        assert!(parsed[0]["content"][2]["text"]
            .as_str()
            .expect("custom flattened text")
            .contains("custom-visible"));
        assert_eq!(parsed[0]["content"][3]["text"], "prefix\n");
        for secret in [
            "/home/me/.ssh/id_rsa",
            "thinking-secret",
            "unterminated-secret",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn redaction_is_case_insensitive_and_covers_provider_native_search() {
        let raw = serde_json::to_string(&json!([
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "lower-bash",
                        "name": " bash ",
                        "arguments": { "command": "lowercase-secret" }
                    },
                    {
                        "type": "toolCall",
                        "id": "native-search",
                        "name": "WebSearch",
                        "arguments": { "query": "native-query-secret" }
                    },
                    {
                        "type": "toolCall",
                        "id": "preview-search",
                        "name": "WEB_SEARCH_PREVIEW",
                        "arguments": { "query": "preview-query-secret" }
                    },
                    {
                        "type": "hostedSearch",
                        "id": "provider-secret-id",
                        "provider": "provider-secret",
                        "status": "completed",
                        "queries": ["hosted-query-secret"],
                        "sources": [{
                            "url": "https://secret.example/private",
                            "title": "source-title-secret",
                            "citedText": "cited-text-secret"
                        }],
                        "unknown": "hosted-unknown-secret"
                    },
                    {
                        "type": "toolCall",
                        "id": "share-redacted-hosted-search-1",
                        "name": "CustomTool",
                        "arguments": { "query": "custom-visible" }
                    }
                ]
            },
            {
                "role": "toolResult",
                "toolCallId": "lower-bash",
                "toolName": "BASH",
                "content": [{ "type": "text", "text": "lower-result-secret" }]
            },
            {
                "role": "toolResult",
                "toolCallId": "native-search",
                "toolName": "web_search",
                "content": [{ "type": "text", "text": "native-result-secret" }],
                "details": { "sources": ["native-source-secret"] }
            },
            {
                "role": "toolResult",
                "toolCallId": "preview-search",
                "toolName": "web_search_preview",
                "content": [{ "type": "text", "text": "preview-result-secret" }]
            }
        ]))
        .expect("serialize case and native search history");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact search history");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse redacted history");
        let blocks = parsed[0]["content"].as_array().expect("assistant blocks");

        for block in &blocks[..3] {
            assert_eq!(block["redacted"], true);
            assert_eq!(block["arguments"], Value::Null);
        }
        assert_eq!(
            blocks[3],
            json!({
                "type": "hostedSearch",
                "id": "share-redacted-hosted-search-2",
                "status": "completed",
                "queries": [],
                "sources": [],
                "redacted": true
            })
        );
        assert_eq!(blocks[4]["id"], "share-redacted-hosted-search-1");
        assert_eq!(blocks[4]["arguments"]["query"], "custom-visible");
        for result in parsed.as_array().expect("history items").iter().skip(1) {
            assert_eq!(result["redacted"], true);
            assert_eq!(result["details"]["kind"], "redacted_tool_content");
        }
        for secret in [
            "lowercase-secret",
            "native-query-secret",
            "preview-query-secret",
            "provider-secret-id",
            "provider-secret",
            "hosted-query-secret",
            "https://secret.example/private",
            "source-title-secret",
            "cited-text-secret",
            "hosted-unknown-secret",
            "lower-result-secret",
            "native-result-secret",
            "native-source-secret",
            "preview-result-secret",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn redaction_normalizes_nested_payload_and_data_tool_call_shapes() {
        let data_tool_call_json = serde_json::to_string(&json!({
            "toolCall": {
                "id": "inner-data-json",
                "name": "TodoWrite",
                "arguments": { "todos": ["secret-data-json"] }
            }
        }))
        .expect("serialize data toolCall wrapper");
        let raw = serde_json::to_string(&json!([
            {
                "role": "assistant",
                "content": [
                {
                    "type": "toolCall",
                    "id": "misleading-direct-id",
                    "name": "CustomTool",
                    "toolCall": {
                        "id": "inner-direct",
                        "name": "Bash",
                        "arguments": { "command": "secret-direct" }
                    }
                },
                {
                    "type": "toolCall",
                    "id": "misleading-payload-id",
                    "name": "CustomTool",
                    "payload": {
                        "toolCall": {
                            "id": "inner-payload",
                            "name": "Read",
                            "input": { "path": "secret-payload" }
                        }
                    }
                },
                {
                    "type": "toolCall",
                    "name": "CustomTool",
                    "data": {
                        "toolCall": {
                            "id": "inner-data-object",
                            "name": "mcp_private_lookup",
                            "parameters": { "query": "secret-data-object" }
                        }
                    }
                },
                {
                    "type": "toolCall",
                    "name": "CustomTool",
                    "data": data_tool_call_json
                },
                {
                    "type": "toolCall",
                    "name": "CustomTool",
                    "payload": {
                        "id": "payload-source",
                        "name": "Write",
                        "args": { "content": "secret-payload-source" }
                    }
                },
                {
                    "type": "toolCall",
                    "name": "CustomTool",
                    "data": {
                        "id": "data-source",
                        "name": "Grep",
                        "arguments": { "pattern": "secret-data-source" }
                    }
                },
                {
                    "type": "toolCall",
                    "id": "outer-builtin-id",
                    "name": "Bash",
                    "arguments": { "command": "secret-outer-builtin" },
                    "payload": {
                        "id": "inner-custom-id",
                        "name": "CustomTool",
                        "marker": "secret-inner-custom"
                    }
                }
                ]
            },
            {
                "role": "toolResult",
                "toolCallId": "outer-builtin-id",
                "content": [{ "type": "text", "text": "secret-outer-result" }]
            }
        ]))
        .expect("serialize normalized tool-call shapes");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact normalized shapes");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse normalized shapes");
        let blocks = parsed[0]["content"].as_array().expect("assistant blocks");
        for (index, expected_name) in [
            "Bash",
            "Read",
            "mcp_private_lookup",
            "TodoWrite",
            "Write",
            "Grep",
            "Bash",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(
                blocks[index],
                json!({
                    "type": "toolCall",
                    "id": format!("share-redacted-tool-call-{}", index + 1),
                    "name": expected_name,
                    "redacted": true
                })
            );
        }
        assert_eq!(parsed[1]["redacted"], true);
        assert_eq!(parsed[1]["toolCallId"], "share-redacted-tool-call-7");
        for secret in [
            "secret-direct",
            "secret-payload",
            "secret-data-object",
            "secret-data-json",
            "secret-payload-source",
            "secret-data-source",
            "misleading-direct-id",
            "misleading-payload-id",
            "outer-builtin-id",
            "inner-custom-id",
            "secret-outer-builtin",
            "secret-inner-custom",
            "secret-outer-result",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn redacted_hosted_search_preserves_only_valid_status() {
        let raw = serde_json::to_string(&json!([{
            "role": "assistant",
            "content": [
                {
                    "type": "hostedSearch",
                    "id": "failed-secret-id",
                    "status": "failed",
                    "queries": ["failed-query-secret"]
                },
                {
                    "type": "hostedSearch",
                    "id": "searching-secret-id",
                    "status": "searching",
                    "sources": [{ "url": "https://searching-secret.example" }]
                },
                {
                    "type": "hostedSearch",
                    "id": "invalid-secret-id",
                    "status": "provider-private-status",
                    "queries": ["invalid-query-secret"]
                }
            ]
        }]))
        .expect("serialize hosted search statuses");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact hosted searches");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse redacted history");
        let blocks = parsed[0]["content"].as_array().expect("hosted search blocks");

        assert_eq!(blocks[0]["status"], "failed");
        assert_eq!(blocks[1]["status"], "searching");
        assert_eq!(blocks[2]["status"], "searching");
        for (index, block) in blocks.iter().enumerate() {
            assert_eq!(
                block["id"],
                format!("share-redacted-hosted-search-{}", index + 1)
            );
            assert_eq!(block["queries"], json!([]));
            assert_eq!(block["sources"], json!([]));
            assert_eq!(block["redacted"], true);
        }
        for secret in [
            "failed-secret-id",
            "failed-query-secret",
            "searching-secret-id",
            "https://searching-secret.example",
            "invalid-secret-id",
            "provider-private-status",
            "invalid-query-secret",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn generated_redacted_ids_avoid_all_input_tool_ids_and_keep_result_pairing() {
        let raw = serde_json::to_string(&json!([
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "share-redacted-tool-call-1",
                        "name": "CustomTool",
                        "arguments": { "keep": true }
                    },
                    {
                        "type": "toolCall",
                        "id": "share-redacted-tool-call-2",
                        "name": "Bash",
                        "arguments": { "command": "secret-first" }
                    },
                    {
                        "type": "toolCall",
                        "id": "share-redacted-tool-call-3",
                        "name": "CustomTool",
                        "arguments": { "keep": true }
                    },
                    {
                        "type": "toolCall",
                        "id": "builtin-second",
                        "name": "Read",
                        "arguments": { "path": "secret-second" }
                    }
                ]
            },
            {
                "role": "toolResult",
                "toolCallId": "share-redacted-tool-call-4",
                "toolName": "CustomTool",
                "content": "keep custom result"
            },
            {
                "role": "toolResult",
                "toolCallId": "share-redacted-tool-call-2",
                "toolName": "Bash",
                "content": "secret first result"
            },
            {
                "role": "toolResult",
                "toolCallId": "builtin-second",
                "toolName": "Read",
                "content": "secret second result"
            }
        ]))
        .expect("serialize colliding tool IDs");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact colliding IDs");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse colliding IDs");
        let blocks = parsed[0]["content"].as_array().expect("assistant blocks");

        assert_eq!(blocks[0]["id"], "share-redacted-tool-call-1");
        assert_eq!(blocks[1]["id"], "share-redacted-tool-call-5");
        assert_eq!(blocks[2]["id"], "share-redacted-tool-call-3");
        assert_eq!(blocks[3]["id"], "share-redacted-tool-call-6");
        assert_eq!(parsed[1]["toolCallId"], "share-redacted-tool-call-4");
        assert_eq!(parsed[2]["toolCallId"], blocks[1]["id"]);
        assert_eq!(parsed[3]["toolCallId"], blocks[3]["id"]);
        for secret in [
            "secret-first",
            "secret-second",
            "secret first result",
            "secret second result",
            "builtin-second",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn redaction_checks_every_name_and_id_alias_in_the_same_object() {
        let raw = serde_json::to_string(&json!([
            {
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": "misleading-call-id",
                    "toolCallId": "actual-builtin-id",
                    "name": "CustomTool",
                    "toolName": "Bash",
                    "arguments": { "command": "same-object-call-secret" }
                }]
            },
            {
                "role": "toolResult",
                "toolCallId": "misleading-result-id",
                "call_id": "actual-builtin-id",
                "name": "CustomTool",
                "toolName": "Bash",
                "content": "same-object-result-secret"
            },
            {
                "role": "toolResult",
                "toolCallId": "result-only-secret-id",
                "name": "CustomTool",
                "tool_name": "Read",
                "content": "result-only-alias-secret"
            }
        ]))
        .expect("serialize aliased tool messages");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact aliased tools");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse aliased tools");
        let call = &parsed[0]["content"][0];

        assert_eq!(call["name"], "Bash");
        assert_eq!(call["redacted"], true);
        assert_eq!(parsed[1]["toolCallId"], call["id"]);
        assert_eq!(parsed[1]["toolName"], "Bash");
        assert_eq!(parsed[1]["redacted"], true);
        assert_eq!(parsed[2]["toolName"], "Read");
        assert_eq!(parsed[2]["redacted"], true);
        for secret in [
            "misleading-call-id",
            "actual-builtin-id",
            "same-object-call-secret",
            "misleading-result-id",
            "same-object-result-secret",
            "result-only-secret-id",
            "result-only-alias-secret",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn string_assistant_redaction_refreshes_the_public_history_hash() {
        let redact = |secret: &str| {
            let mut message = json!({
                "role": "assistant",
                "id": "assistant-string-content",
                "content": format!(
                    "before<seed:tool_call>{{\"name\":\"Bash\",\"pin\":\"{secret}\"}}</seed:tool_call>after"
                )
            });
            let original_hash = history_message_content_hash(&message);
            message.as_object_mut().expect("assistant object").insert(
                "liveAgentHistoryRef".to_string(),
                json!({
                    "segmentIndex": 0,
                    "messageIndex": 0,
                    "segmentId": "segment-string-content",
                    "messageId": "assistant-string-content",
                    "role": "assistant",
                    "contentHash": original_hash,
                }),
            );
            let raw = serde_json::to_string(&json!([message])).expect("serialize history ref");
            let redacted = redact_builtin_tool_content_json(&raw).expect("redact string content");
            let parsed = serde_json::from_str::<Value>(&redacted).expect("parse redacted history");
            (parsed[0].clone(), redacted)
        };

        let (first, first_json) = redact("pin-1111");
        let (second, second_json) = redact("pin-2222");

        assert_eq!(first, second);
        assert_eq!(first["content"], "beforeafter");
        assert_eq!(
            first["liveAgentHistoryRef"]["contentHash"],
            history_message_content_hash(&first)
        );
        assert!(!first_json.contains("pin-1111"));
        assert!(!second_json.contains("pin-2222"));
    }

    #[test]
    fn builtin_share_policy_covers_the_mirrored_tool_catalog() {
        let catalog = include_str!("../../../src/lib/tools/builtinToolCatalog.ts");
        let catalog_names = catalog
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("toolName: \"")
                    .and_then(|value| value.strip_suffix("\","))
            })
            .collect::<Vec<_>>();

        assert!(
            !catalog_names.is_empty(),
            "catalog parser found no tool names"
        );
        for tool_name in &catalog_names {
            assert!(
                is_builtin_share_tool_name(tool_name),
                "{tool_name} is missing from the server share-redaction policy"
            );
        }
        let mut unique_names = catalog_names.clone();
        unique_names.sort_unstable();
        unique_names.dedup();
        assert_eq!(
            unique_names.len(),
            catalog_names.len(),
            "builtin catalog tool names must be unique"
        );
    }

    #[test]
    fn redacted_tool_ids_are_public_placeholders_even_for_out_of_order_or_missing_ids() {
        let raw = serde_json::to_string(&json!([
            {
                "role": "toolResult",
                "toolCallId": "dsml-tool-call-secret-hash",
                "toolName": "Bash",
                "content": "secret result"
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "dsml-tool-call-secret-hash",
                        "name": "RecoveredAlias",
                        "arguments": { "command": "secret command" }
                    },
                    {
                        "type": "toolCall",
                        "name": "TodoWrite",
                        "arguments": { "todos": ["secret todo"] }
                    },
                    {
                        "type": "toolCall",
                        "id": "duplicate-secret-id",
                        "name": "Read",
                        "arguments": { "path": "/secret/one" }
                    },
                    {
                        "type": "toolCall",
                        "id": "duplicate-secret-id",
                        "name": "Bash",
                        "arguments": { "command": "secret two" }
                    }
                ]
            },
            {
                "role": "toolResult",
                "toolName": "TodoWrite",
                "content": "secret id-less result"
            }
        ]))
        .expect("serialize edge-case history");

        let redacted = redact_builtin_tool_content_json(&raw).expect("redact edge-case history");
        let parsed = serde_json::from_str::<Value>(&redacted).expect("parse edge-case history");
        let blocks = parsed[1]["content"].as_array().expect("assistant blocks");

        assert_eq!(parsed[0]["toolCallId"], "share-redacted-tool-call-1");
        assert_eq!(blocks[0]["id"], parsed[0]["toolCallId"]);
        assert_eq!(blocks[0]["name"], "Bash");
        assert_eq!(blocks[1]["id"], "share-redacted-tool-call-2");
        assert_eq!(blocks[2]["id"], "share-redacted-tool-call-3");
        assert_eq!(blocks[3]["id"], "share-redacted-tool-call-4");
        assert_ne!(blocks[3]["id"], blocks[2]["id"]);
        assert_eq!(parsed[2]["toolCallId"], "share-redacted-tool-call-5");
        for secret in [
            "dsml-tool-call-secret-hash",
            "duplicate-secret-id",
            "secret command",
            "secret todo",
            "secret two",
            "secret result",
            "secret id-less result",
        ] {
            assert!(!redacted.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn flattened_shared_history_redacts_summaries_and_refreshes_tool_hashes() {
        let flatten_and_redact = |secret: &str| {
            let derived_tool_call_id = format!("dsml-tool-call-{secret}");
            let summary_json = serde_json::to_string(&json!({
                "role": "summary",
                "id": "summary-1",
                "timestamp": 42,
                "content": format!("ran command with {secret} in /private/{secret}"),
                "summaryMeta": {
                    "fileLedger": [{ "path": format!("/private/{secret}") }],
                    "unknownMetadata": { "error": format!("failure: {secret}") }
                },
                "provider": format!("provider-{secret}")
            }))
            .expect("serialize summary");
            let messages_json = serde_json::to_string(&json!([
                {
                    "role": "user",
                    "id": "user-1",
                    "content": "ordinary user text"
                },
                {
                    "role": "assistant",
                    "responseId": "response-builtin",
                    "content": [
                        { "type": "text", "text": "ordinary assistant text" },
                        {
                            "type": "toolCall",
                            "id": derived_tool_call_id,
                            "name": "ReadTerminal",
                            "arguments": { "sessionId": secret },
                            "thoughtSignature": format!("signature-{secret}"),
                            "reasoning_details": { "encrypted": format!("reasoning-{secret}") },
                            "unknownProviderField": format!("provider-{secret}")
                        }
                    ]
                },
                {
                    "role": "toolResult",
                    "id": format!("result-{secret}"),
                    "toolCallId": derived_tool_call_id,
                    "toolName": "ReadTerminal",
                    "content": [{ "type": "text", "text": format!("terminal output {secret}") }],
                    "details": { "error": format!("terminal error {secret}") },
                    "isError": true,
                    "timestamp": 77,
                    "unknownProviderField": format!("result-provider-{secret}")
                },
                {
                    "role": "assistant",
                    "responseId": "response-custom",
                    "content": [{
                        "type": "toolCall",
                        "id": "call-custom",
                        "name": "CustomTool",
                        "arguments": { "query": "keep custom arguments" }
                    }]
                },
                {
                    "role": "toolResult",
                    "id": "result-custom",
                    "toolCallId": "call-custom",
                    "toolName": "CustomTool",
                    "content": [{ "type": "text", "text": "keep custom output" }],
                    "details": { "data": "keep custom details" }
                }
            ]))
            .expect("serialize messages");
            let flattened = flatten_history_messages_json(&[make_segment(
                0,
                "segment-a",
                Some(&summary_json),
                &messages_json,
            )])
            .expect("flatten history");
            let flattened_value = serde_json::from_str::<Value>(&flattened)
                .expect("parse flattened history before redaction");
            let redacted = redact_builtin_tool_content_json(&flattened)
                .expect("redact flattened shared history");
            let redacted_value =
                serde_json::from_str::<Value>(&redacted).expect("parse redacted shared history");
            (flattened_value, redacted_value, redacted)
        };

        let (flattened_a, redacted_a, redacted_json_a) = flatten_and_redact("pin-1111");
        let (flattened_b, redacted_b, redacted_json_b) = flatten_and_redact("pin-2222");

        assert_ne!(
            flattened_a[2]["liveAgentHistoryRef"]["contentHash"],
            flattened_b[2]["liveAgentHistoryRef"]["contentHash"]
        );
        assert_eq!(
            redacted_a[2]["liveAgentHistoryRef"]["contentHash"],
            redacted_b[2]["liveAgentHistoryRef"]["contentHash"]
        );
        assert_eq!(
            redacted_a[2]["liveAgentHistoryRef"]["contentHash"],
            history_message_content_hash(&redacted_a[2])
        );
        assert_eq!(redacted_a, redacted_b);

        for (public_json, secret) in [
            (&redacted_json_a, "pin-1111"),
            (&redacted_json_b, "pin-2222"),
        ] {
            assert!(!public_json.contains(secret), "leaked {secret}");
        }

        assert_eq!(redacted_a[0]["role"], "summary");
        assert_eq!(redacted_a[0]["id"], "summary-1");
        assert_eq!(redacted_a[0]["timestamp"], 42);
        assert_eq!(redacted_a[0]["content"], "摘要内容已脱敏");
        assert_eq!(redacted_a[0]["redacted"], true);
        assert_eq!(redacted_a[0]["summaryMeta"], Value::Null);
        assert_eq!(redacted_a[0]["provider"], Value::Null);

        assert_eq!(redacted_a[1], flattened_a[1]);
        assert_eq!(
            redacted_a[2]["content"][0]["text"],
            "ordinary assistant text"
        );
        assert_eq!(
            redacted_a[2]["content"][1],
            json!({
                "type": "toolCall",
                "id": "share-redacted-tool-call-1",
                "name": "ReadTerminal",
                "redacted": true
            })
        );
        assert_eq!(
            redacted_a[3],
            json!({
                "role": "toolResult",
                "toolCallId": "share-redacted-tool-call-1",
                "toolName": "ReadTerminal",
                "content": [{ "type": "text", "text": "工具调用内容已脱敏" }],
                "details": { "kind": "redacted_tool_content" },
                "isError": true,
                "timestamp": 77,
                "redacted": true
            })
        );
        assert_eq!(redacted_a[4], flattened_a[4]);
        assert_eq!(redacted_a[5], flattened_a[5]);
    }
}
