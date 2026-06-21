use std::{collections::HashSet, sync::Arc};

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
        system_list_skill_files_sync, system_manage_cron_task_sync,
        system_read_skill_metadata_sync, system_read_skill_text_sync,
        system_read_uploaded_image_preview_sync, SystemReadableFileUploadInput,
    },
};
use crate::services::cron::{clear_logs_sync, list_logs_sync, CronManager};
use crate::services::gateway::proto;
use crate::services::memory::{
    MemoryAcceptArgs, MemoryBatchArgs, MemoryDeleteArgs, MemoryDeleteProjectArgs, MemoryListArgs,
    MemoryOrganizeDueClaimArgs, MemoryOrganizeRunCreateArgs, MemoryOrganizeRunListArgs,
    MemoryOrganizeRunReadArgs, MemoryOrganizeRunUpdateArgs, MemoryReadArgs,
    MemoryRecentRejectionsArgs, MemorySearchArgs, MemoryStore, MemoryUpdateArgs, MemoryWriteArgs,
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

pub async fn handle_cron_manage(
    cron_manager: Arc<CronManager>,
    request: proto::CronManageRequest,
) -> Result<proto::CronManageResponse, String> {
    let action = request.action.trim().to_string();
    match action.as_str() {
        "list_logs" => {
            let task_id = parse_required_cron_task_id(&request, "list_logs")?;
            let limit = parse_cron_logs_limit(&request.task_json)?;
            let logs = tauri::async_runtime::spawn_blocking(move || list_logs_sync(task_id, limit))
                .await
                .map_err(|e| format!("gateway cron list_logs join failed: {e}"))??;
            return Ok(proto::CronManageResponse {
                action,
                result_json: serialize_cron_manage_result(&json!({
                    "action": "list_logs",
                    "logs": logs,
                }))?,
            });
        }
        "clear_logs" => {
            let task_id = parse_required_cron_task_id(&request, "clear_logs")?;
            let cleared_count =
                tauri::async_runtime::spawn_blocking(move || clear_logs_sync(task_id))
                    .await
                    .map_err(|e| format!("gateway cron clear_logs join failed: {e}"))??;
            return Ok(proto::CronManageResponse {
                action,
                result_json: serialize_cron_manage_result(&json!({
                    "action": "clear_logs",
                    "clearedCount": cleared_count,
                }))?,
            });
        }
        _ => {}
    }

    let payload = build_cron_manage_payload(&request)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = open_db()?;
        system_manage_cron_task_sync(&mut conn, payload)
    })
    .await
    .map_err(|e| format!("gateway cron manage join failed: {e}"))??;

    if result.should_reload {
        cron_manager.request_reload();
    }

    Ok(proto::CronManageResponse {
        action: result.response.action.clone(),
        result_json: serialize_cron_manage_result(&result.response)?,
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

fn build_cron_manage_payload(request: &proto::CronManageRequest) -> Result<Value, String> {
    let action = request.action.trim();
    match action {
        "create" => Ok(json!({
            "action": "create",
            "task": parse_task_json(&request.task_json)?,
        })),
        "read" => {
            if request.task_id.trim().is_empty() {
                Ok(json!({ "action": "read" }))
            } else {
                Ok(json!({
                    "action": "read",
                    "task_id": request.task_id.trim(),
                }))
            }
        }
        "update" => Ok(json!({
            "action": "update",
            "task_id": request.task_id.trim(),
            "task": parse_task_json(&request.task_json)?,
        })),
        "delete" => Ok(json!({
            "action": "delete",
            "task_id": request.task_id.trim(),
        })),
        _ => Err(format!("unsupported cron action: {action}")),
    }
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

fn parse_cron_logs_limit(raw: &str) -> Result<usize, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(100);
    }

    let payload = serde_json::from_str::<Value>(trimmed)
        .map_err(|e| format!("invalid cron logs query: {e}"))?;
    let limit = payload
        .as_object()
        .and_then(|obj| obj.get("limit"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(100);
    Ok(limit)
}

fn serialize_cron_manage_result(payload: &impl serde::Serialize) -> Result<String, String> {
    serde_json::to_string(payload)
        .map_err(|e| format!("serialize cron manage response failed: {e}"))
}

fn parse_task_json(raw: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(raw).map_err(|e| format!("invalid task_json: {e}"))
}

fn is_builtin_share_tool_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.starts_with("mcp_") {
        return true;
    }
    matches!(
        trimmed,
        "Agent"
            | "Bash"
            | "CronTaskManager"
            | "Delete"
            | "Edit"
            | "Glob"
            | "Grep"
            | "HttpGetTest"
            | "Image"
            | "List"
            | "ManagedProcess"
            | "McpManager"
            | "MemoryManager"
            | "Read"
            | "SkillsManager"
            | "SSHManager"
            | "SshManager"
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
                object.insert(
                    "liveAgentHistoryRef".to_string(),
                    json!({
                        "segmentIndex": parsed.segment.segment_index,
                        "messageIndex": message_index,
                    }),
                );
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
        flatten_history_messages_json, flatten_history_messages_json_window, parse_cron_logs_limit,
        redact_builtin_tool_content_json, sanitize_provider_summaries,
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
    fn parse_cron_logs_limit_defaults_to_100() {
        assert_eq!(parse_cron_logs_limit("").expect("default limit"), 100);
        assert_eq!(parse_cron_logs_limit("{}").expect("object default"), 100);
        assert_eq!(
            parse_cron_logs_limit(r#"{"limit":0}"#).expect("zero fallback"),
            100
        );
    }

    #[test]
    fn parse_cron_logs_limit_accepts_positive_limit() {
        assert_eq!(
            parse_cron_logs_limit(r#"{"limit":25}"#).expect("parse explicit limit"),
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
                    "content":"hello",
                    "liveAgentHistoryRef":{"segmentIndex":0,"messageIndex":0}
                },
                {"role":"summary","id":"summary-1","content":"compressed"},
                {
                    "role":"assistant",
                    "content":"world",
                    "liveAgentHistoryRef":{"segmentIndex":1,"messageIndex":0}
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
                        {"role":"user","content":"old-0"},
                        {"role":"assistant","content":"old-1"},
                        {"role":"user","content":"old-2"}
                    ]"#,
                ),
                make_segment(
                    5,
                    "segment-b",
                    Some(r#"{"role":"summary","id":"summary-b","content":"newer"}"#),
                    r#"[
                        {"role":"assistant","content":"new-0"},
                        {"role":"user","content":"new-1"}
                    ]"#,
                ),
            ],
            3,
        )
        .expect("flatten tail history window");

        let parsed = serde_json::from_str::<Value>(&flattened).expect("parse flattened history");
        assert_eq!(returned_message_count, 3);
        assert_eq!(
            parsed,
            json!([
                {"role":"summary","id":"summary-a","content":"older"},
                {
                    "role":"user",
                    "content":"old-2",
                    "liveAgentHistoryRef":{"segmentIndex":4,"messageIndex":2}
                },
                {"role":"summary","id":"summary-b","content":"newer"},
                {
                    "role":"assistant",
                    "content":"new-0",
                    "liveAgentHistoryRef":{"segmentIndex":5,"messageIndex":0}
                },
                {
                    "role":"user",
                    "content":"new-1",
                    "liveAgentHistoryRef":{"segmentIndex":5,"messageIndex":1}
                }
            ])
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
}
