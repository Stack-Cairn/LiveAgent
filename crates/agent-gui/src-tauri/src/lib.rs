mod commands;
mod runtime;
mod services;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;
use tauri::WindowEvent;

const MAIN_WINDOW_LABEL: &str = "main";
// Only size + maximized are persisted: POSITION would fight multi-monitor
// layouts we don't manage, VISIBLE would re-show a tray-hidden window on
// startup, and DECORATIONS would override the per-platform window chrome
// (Windows runs undecorated with custom chrome).
pub(crate) const WINDOW_STATE_FLAGS: tauri_plugin_window_state::StateFlags =
    tauri_plugin_window_state::StateFlags::SIZE
        .union(tauri_plugin_window_state::StateFlags::MAXIMIZED);
const TRAY_SHOW_MENU_ON_LEFT_CLICK: bool = !cfg!(target_os = "windows");
const TERMINAL_EXIT_REQUESTED_EVENT: &str = "terminal:exit-requested";
/// 统一的「前端动作」事件：托盘菜单与全局快捷键中需要前端语义的动作
/// （开会话/新建对话/切工作空间/改主题/停止运行等）都经此事件转发，
/// 两端各自监听并只处理自己拥有的 action（App.tsx / ChatPage.tsx）。
const APP_ACTION_EVENT: &str = "app:action";
/// Rust 直连动作的结果反馈（如托盘触发 cron）：前端收到后 toast 呈现。
const APP_ACTION_FEEDBACK_EVENT: &str = "app:action-feedback";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitRequestedEvent {
    running_count: usize,
}

pub fn app_version() -> &'static str {
    env!("LIVEAGENT_APP_VERSION")
}

macro_rules! app_invoke_handler {
    () => {
        tauri::generate_handler![
            // Chat history
            commands::chat_history::chat_history_list,
            commands::chat_history::chat_history_workdirs,
            commands::chat_history::chat_history_shared_list,
            commands::chat_history::chat_history_search,
            commands::chat_history::chat_history_get_window,
            commands::chat_history::chat_history_upsert,
            commands::chat_history::chat_history_upsert_active_segment,
            commands::chat_history::chat_history_append_segment,
            commands::chat_history::chat_history_rename,
            commands::chat_history::chat_history_branch,
            commands::chat_history::chat_history_replace_from_message,
            commands::chat_history::chat_history_set_pinned,
            commands::chat_history::chat_history_set_model,
            commands::chat_history::chat_history_set_cwd,
            commands::chat_history::chat_history_share_get,
            commands::chat_history::chat_history_share_set,
            commands::chat_history::chat_history_delete,
            // Trajectory (events ride the owning history segment)
            commands::chat_history::trajectory_append_events,
            commands::chat_history::trajectory_get_events,
            commands::chat_history::trajectory_get_window,
            commands::chat_history::trajectory_resolve_turn_number,
            commands::chat_history::trajectory_get_subagent_runs,
            commands::chat_history::trajectory_put_sections,
            commands::chat_history::trajectory_get_sections,
            // Subagent store
            commands::subagent_store::subagent_identity_upsert,
            commands::subagent_store::subagent_identity_list,
            commands::subagent_store::subagent_run_save,
            commands::subagent_store::subagent_run_list,
            commands::subagent_store::subagent_run_load,
            commands::subagent_store::subagent_run_prune,
            commands::subagent_store::subagent_message_append,
            commands::subagent_store::subagent_message_list,
            // File system
            commands::fs::fs_read_text,
            commands::fs::fs_read_editable_text,
            commands::fs::fs_path_status,
            commands::fs::fs_read_image_source,
            commands::fs::fs_read_workspace_image,
            commands::fs::fs_write_text,
            commands::fs::fs_edit_text,
            commands::fs::fs_delete,
            commands::fs::fs_open_workspace_path,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_roots,
            commands::fs::fs_list_dirs,
            commands::fs::fs_list,
            commands::fs::fs_glob,
            commands::fs::fs_grep,
            commands::fs::fs_mention_list,
            // 会话检查点(rewind)
            commands::checkpoint::checkpoint_begin_turn,
            commands::checkpoint::checkpoint_list,
            commands::checkpoint::checkpoint_diff_stats,
            commands::checkpoint::checkpoint_rewind_code,
            commands::checkpoint::checkpoint_clear,
            commands::chat_file_links::open_chat_file_link,
            commands::root_grants::workspace_root_grants_list,
            commands::root_grants::workspace_root_grants_apply,
            commands::root_grants::workspace_root_grants_revoke,
            // Subagent worktrees
            commands::subagent_worktree::subagent_worktree_create,
            commands::subagent_worktree::subagent_worktree_status,
            commands::subagent_worktree::subagent_worktree_apply,
            commands::subagent_worktree::subagent_worktree_cleanup,
            // MCP
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_runtime_status,
            commands::mcp::mcp_stop_server,
            commands::mcp::mcp_test_server,
            commands::mcp::mcp_restart_server,
            // Memory
            commands::memory::memory_list,
            commands::memory::memory_read,
            commands::memory::memory_search,
            commands::memory::memory_write,
            commands::memory::memory_update,
            commands::memory::memory_delete,
            commands::memory::memory_delete_project,
            commands::memory::memory_accept,
            commands::memory::memory_apply_batch,
            commands::memory::memory_organize_run_create,
            commands::memory::memory_organize_run_update,
            commands::memory::memory_organize_run_list,
            commands::memory::memory_organize_run_read,
            commands::memory::memory_organize_run_clear_history,
            commands::memory::memory_organize_due_claim,
            commands::memory::memory_organize_due_complete,
            commands::memory::memory_index_overview,
            commands::memory::memory_paths_info,
            commands::memory::memory_recent_rejections,
            commands::memory::memory_today_local_date,
            commands::memory::memory_today_daily,
            commands::memory::memory_quota_summary,
            commands::memory::memory_wipe_all,
            // Settings
            commands::settings::settings_load_all,
            commands::settings::settings_save_providers,
            commands::settings::settings_list_ccswitch_providers,
            commands::settings::settings_list_cherry_studio_providers,
            commands::settings::settings_list_cherry_studio_providers_from_path,
            commands::settings::settings_save_system,
            commands::settings::settings_save_mcp,
            commands::settings::settings_save_agents,
            commands::settings::settings_save_ssh,
            commands::settings::settings_apply_ssh_patch,
            commands::settings::settings_reset_ssh_known_host,
            commands::settings::settings_save_remote,
            commands::settings::settings_save_memory,
            commands::settings::settings_save_model_failover,
            commands::settings::settings_save_stt,
            commands::settings::settings_reveal_stt_secret,
            services::stt::settings_test_stt,
            services::stt::stt_request_microphone_permission,
            services::stt::stt_start,
            services::stt::stt_send_audio,
            services::stt::stt_stop,
            services::stt::stt_cancel,
            commands::settings::settings_backup_export,
            commands::settings::settings_backup_peek_import,
            commands::settings::settings_backup_apply_import,
            commands::settings::settings_backup_load_sync_config,
            commands::settings::settings_backup_save_sync_config,
            commands::settings::settings_backup_test_sync_connection,
            commands::settings::settings_backup_fetch_remote_info,
            commands::settings::settings_backup_upload,
            commands::settings::settings_backup_download,
            commands::settings::settings_backup_mark_dirty,
            commands::update::app_update_check,
            commands::update::app_update_install,
            commands::update::app_restart,
            commands::app::app_runtime_platform,
            commands::app::app_frontend_ready,
            commands::app::app_set_close_window_behavior,
            commands::app::app_set_global_shortcuts,
            commands::app::app_window_pinned,
            commands::app::app_toggle_window_pin,
            commands::app::app_confirmed_exit,
            commands::app::app_macos_traffic_light_metrics,
            commands::tray::app_tray_menu_sync,
            // Hooks
            commands::hook::hook_run_script,
            commands::hook::hook_run_http_requests,
            commands::hook::hook_cancel_scope,
            // Automation (cron tasks + hooks store)
            commands::cron::cron_validate_expression,
            commands::cron::automation_snapshot,
            commands::cron::automation_cron_apply,
            commands::cron::automation_hooks_apply,
            commands::cron::automation_list_runs,
            commands::cron::automation_clear_runs,
            commands::cron::automation_run_cron_now,
            commands::cron::automation_claim_prompt_runs,
            commands::cron::automation_release_prompt_run,
            commands::cron::automation_complete_prompt_run,
            // Local command execution
            commands::shell::shell_run,
            commands::shell::shell_session_start,
            commands::shell::shell_session_wait,
            commands::shell::shell_session_stop,
            commands::shell::runtime_cancel,
            commands::process::managed_process_start,
            commands::process::managed_process_status,
            commands::process::managed_process_stop,
            commands::process::managed_process_read_log,
            commands::process::managed_process_wait,
            commands::process::managed_process_snapshot,
            commands::process::managed_process_clear,
            commands::terminal::terminal_shell_options,
            commands::terminal::terminal_list,
            commands::terminal::terminal_create,
            commands::terminal::terminal_create_ssh,
            commands::terminal::terminal_answer_ssh_prompt,
            commands::terminal::terminal_cancel_ssh_prompt,
            commands::terminal::terminal_ssh_reconnect,
            commands::terminal::terminal_ssh_latency,
            commands::terminal::terminal_ssh_exec,
            commands::terminal::terminal_ssh_local_forward_start,
            commands::terminal::terminal_ssh_local_forward_list,
            commands::terminal::terminal_ssh_local_forward_stop,
            commands::terminal::terminal_ssh_local_forward_check_port,
            commands::terminal::ssh_terminal_tabs_list,
            commands::terminal::ssh_terminal_tab_open,
            commands::terminal::ssh_terminal_tab_close,
            commands::terminal::terminal_stream_attach,
            commands::terminal::terminal_stream_input,
            commands::terminal::terminal_stream_resize,
            commands::terminal::terminal_rename,
            commands::terminal::terminal_close,
            commands::terminal::terminal_close_project,
            commands::terminal::terminal_read_tail,
            commands::sftp::sftp_list,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_transfer,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_transfer_status,
            commands::git::git_status,
            commands::git::git_discover_repositories,
            commands::git::git_branches,
            commands::git::git_init,
            commands::git::git_clone_repository,
            commands::git::git_clone_repository_start,
            commands::git::git_clone_repository_tasks,
            commands::git::git_clone_repository_cancel,
            commands::git::git_clone_repository_dismiss,
            commands::git::git_list_remote_branches,
            commands::git::git_switch_branch,
            commands::git::git_create_branch,
            commands::git::git_create_worktree,
            commands::git::git_remove_worktree,
            commands::git::git_diff,
            commands::git::git_log,
            commands::git::git_commit_details,
            commands::git::git_compare_commit_with_remote,
            commands::git::git_commit_diff,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_unstage_all,
            commands::git::git_discard,
            commands::git::git_discard_all,
            commands::git::git_add_to_gitignore,
            commands::git::git_open_system_file_location,
            commands::git::git_commit,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_set_remote,
            commands::git::git_push,
            commands::git::git_delete_branch,
            commands::git::git_rename_branch,
            commands::git::git_stash_push,
            commands::git::git_stash_pop,
            commands::system::system_pick_folder,
            commands::system::system_resolve_dropped_workspace_folders,
            commands::system::system_classify_dropped_paths,
            commands::system::system_pick_file,
            commands::system::system_sandbox_capability,
            commands::system::system_save_preview_file,
            commands::system::system_create_project_folder,
            commands::system::system_import_pasted_texts,
            commands::system::system_import_readable_file_paths,
            commands::system::system_import_uploaded_readable_files,
            commands::system::system_pick_readable_files,
            commands::system::system_read_uploaded_image_preview,
            commands::system::system_open_uploaded_image,
            commands::system::system_prepare_preview_file_save,
            commands::system::system_write_preview_file,
            commands::system::system_clipboard_write_image,
            commands::system::system_prepare_uploaded_image_clipboard,
            commands::system::system_clipboard_write_uploaded_image,
            commands::system::system_read_uploaded_native_attachment,
            commands::system::system_list_skill_files,
            commands::system::system_ensure_builtin_skills,
            commands::system::system_read_skill_metadata,
            commands::system::system_read_skill_text,
            commands::system::system_manage_skill,
            commands::system::system_append_debug_jsonl,
            commands::system::system_begin_power_activity,
            commands::system::system_end_power_activity,
            commands::system::system_clipboard_read_text,
            commands::gateway::gateway_connect,
            commands::gateway::gateway_disconnect,
            commands::gateway::gateway_status,
            commands::gateway::gateway_nudge_connection,
            commands::gateway::gateway_send_chat_ingress_batch,
            commands::gateway::gateway_commit_chat_checkpoint,
            commands::gateway::gateway_chat_claim_next,
            commands::gateway::gateway_chat_mark_started,
            commands::gateway::gateway_chat_mark_local_started,
            commands::gateway::gateway_chat_mark_local_cancelled,
            commands::gateway::gateway_chat_mark_queued_in_gui,
            commands::gateway::gateway_chat_complete,
            commands::gateway::gateway_chat_fail,
            commands::gateway::gateway_chat_cancel_request,
            commands::gateway::gateway_chat_heartbeat,
            commands::gateway::gateway_chat_runtime_heartbeat,
            commands::gateway::gateway_chat_release_lease,
            commands::gateway::gateway_chat_queue_respond,
            commands::gateway::gateway_publish_chat_queue_event,
            commands::gateway::gateway_publish_settings_sync,
            commands::gateway::gateway_tunnel_state,
            commands::gateway::gateway_tunnel_create,
            commands::gateway::gateway_tunnel_update,
            commands::gateway::gateway_tunnel_close,
            commands::gateway::gateway_tunnel_check,
            commands::gateway::workspace_watch_set,
            commands::gateway::provider_usage_query,
            commands::gateway::provider_usage_test,
            services::proxy::proxy_get_server_info,
        ]
    };
}

fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(ready_state) = app.try_state::<Arc<commands::app::FrontendReadyState>>() {
        if !ready_state.0.load(Ordering::SeqCst) {
            return Ok(());
        }
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
    }

    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else if let Err(error) = show_main_window(app) {
            eprintln!("failed to show LiveAgent window from global shortcut: {error}");
        }
    }
}

fn toggle_main_window_pin(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let pin_state = app.state::<Arc<commands::app::WindowPinState>>();
        let next = !pin_state.0.load(Ordering::SeqCst);
        match window.set_always_on_top(next) {
            Ok(()) => {
                pin_state.0.store(next, Ordering::SeqCst);
                if next {
                    if let Err(error) = show_main_window(app) {
                        eprintln!("failed to show LiveAgent window when pinning: {error}");
                    }
                }
                let _ = app.emit("global-shortcut:pin-changed", next);
                // 托盘勾选与置顶真源（WindowPinState）同步；托盘可能尚未建好。
                if let Some(handles) = app.try_state::<Arc<services::tray::TrayMenuHandles>>() {
                    handles.set_pin_checked(next);
                }
            }
            Err(error) => eprintln!("failed to toggle LiveAgent window pin: {error}"),
        }
    }
}

/// 应用级动作总线：全局快捷键与托盘菜单的动作都收敛到这里执行。
/// Rust 能独立完成的直接做（webview 卡死时托盘仍可用）；需要前端语义的
/// 经 [`APP_ACTION_EVENT`] 转发（部分动作先呼出主窗口）。
#[derive(Debug, Clone)]
enum AppAction {
    Summon,
    ToggleWindow,
    TogglePin,
    NewChat,
    OpenConversation(String),
    ViewAllConversations,
    SwitchWorkspace(String),
    StopRun(String),
    StopAllRuns,
    ToggleCronTask(String),
    GatewayToggle,
    SetTheme(&'static str),
    OpenSettings,
    CheckUpdates,
    OpenDataDir,
    Quit,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppActionEvent {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppActionFeedbackEvent {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 结果附加值（如 cron 开关后的 "enabled"/"disabled"）。
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

/// 托盘菜单项 ID → 动作。静态 ID 与动态前缀都定义在 `services::tray`。
fn tray_menu_action(id: &str) -> Option<AppAction> {
    use services::tray as tray_ids;
    match id {
        tray_ids::TRAY_SHOW_ID => Some(AppAction::Summon),
        tray_ids::TRAY_NEW_CHAT_ID => Some(AppAction::NewChat),
        tray_ids::TRAY_PIN_ID => Some(AppAction::TogglePin),
        tray_ids::TRAY_RECENT_VIEW_ALL_ID => Some(AppAction::ViewAllConversations),
        tray_ids::TRAY_RUN_STOP_ALL_ID => Some(AppAction::StopAllRuns),
        tray_ids::TRAY_GATEWAY_ID => Some(AppAction::GatewayToggle),
        tray_ids::TRAY_THEME_LIGHT_ID => Some(AppAction::SetTheme("light")),
        tray_ids::TRAY_THEME_DARK_ID => Some(AppAction::SetTheme("dark")),
        tray_ids::TRAY_THEME_SYSTEM_ID => Some(AppAction::SetTheme("system")),
        tray_ids::TRAY_SETTINGS_ID => Some(AppAction::OpenSettings),
        tray_ids::TRAY_CHECK_UPDATES_ID => Some(AppAction::CheckUpdates),
        tray_ids::TRAY_OPEN_DATA_DIR_ID => Some(AppAction::OpenDataDir),
        tray_ids::TRAY_QUIT_ID => Some(AppAction::Quit),
        _ => {
            if let Some(rest) = id.strip_prefix(tray_ids::TRAY_RECENT_PREFIX) {
                Some(AppAction::OpenConversation(rest.to_string()))
            } else if let Some(rest) = id.strip_prefix(tray_ids::TRAY_WORKSPACE_PREFIX) {
                Some(AppAction::SwitchWorkspace(rest.to_string()))
            } else if let Some(rest) = id.strip_prefix(tray_ids::TRAY_RUN_PREFIX) {
                Some(AppAction::StopRun(rest.to_string()))
            } else {
                id.strip_prefix(tray_ids::TRAY_CRON_PREFIX)
                    .map(|rest| AppAction::ToggleCronTask(rest.to_string()))
            }
        }
    }
}

/// 转发前端动作。`show_window` 用于用户预期看到界面反馈的动作
/// （开会话/新建对话/打开设置等）；后台型动作（停止运行/改主题/网关开关）
/// 不抢焦点。
fn forward_app_action(
    app: &tauri::AppHandle,
    action: &'static str,
    id: Option<String>,
    value: Option<String>,
    show_window: bool,
) {
    if show_window {
        if let Err(error) = show_main_window(app) {
            eprintln!("failed to show LiveAgent window for action {action}: {error}");
        }
    }
    if let Err(error) = app.emit(APP_ACTION_EVENT, AppActionEvent { action, id, value }) {
        eprintln!("failed to emit app action {action}: {error}");
    }
}

fn dispatch_app_action(app: &tauri::AppHandle, action: AppAction) {
    match action {
        AppAction::Summon => {
            if let Err(error) = show_main_window(app) {
                eprintln!("failed to show LiveAgent window: {error}");
            }
        }
        AppAction::ToggleWindow => toggle_main_window(app),
        AppAction::TogglePin => toggle_main_window_pin(app),
        AppAction::NewChat => forward_app_action(app, "new-chat", None, None, true),
        AppAction::OpenConversation(id) => {
            forward_app_action(app, "open-conversation", Some(id), None, true);
        }
        AppAction::ViewAllConversations => {
            forward_app_action(app, "view-all-conversations", None, None, true);
        }
        AppAction::SwitchWorkspace(id) => {
            forward_app_action(app, "switch-workspace", Some(id), None, true);
        }
        AppAction::StopRun(id) => forward_app_action(app, "stop-run", Some(id), None, false),
        AppAction::StopAllRuns => forward_app_action(app, "stop-all-runs", None, None, false),
        AppAction::GatewayToggle => forward_app_action(app, "gateway-toggle", None, None, false),
        AppAction::SetTheme(theme) => {
            forward_app_action(app, "set-theme", None, Some(theme.to_string()), false);
        }
        AppAction::OpenSettings => forward_app_action(app, "open-settings", None, None, true),
        AppAction::CheckUpdates => forward_app_action(app, "check-updates", None, None, true),
        AppAction::ToggleCronTask(task_id) => {
            // 托盘的定时任务子项是启用开关：翻转走 AutomationStore 唯一的
            // cron_apply 写路径（CAS），成功后 automation:cron-changed 会驱动
            // 前端 store 与托盘勾选自然刷新。开关是后台动作，不呼出主窗口；
            // 结果经 feedback 事件给前端 toast（窗口可见时提示文案）。
            let Some(store) = app.try_state::<Arc<services::automation::AutomationStore>>() else {
                return;
            };
            let store = Arc::clone(store.inner());
            let app_handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let (value, error) = match store.toggle_cron_task_enabled(&task_id) {
                    Ok(enabled) => (
                        Some(if enabled { "enabled" } else { "disabled" }.to_string()),
                        None,
                    ),
                    Err(error) => {
                        eprintln!("failed to toggle cron task from tray: {error}");
                        (None, Some(error))
                    }
                };
                if let Err(emit_error) = app_handle.emit(
                    APP_ACTION_FEEDBACK_EVENT,
                    AppActionFeedbackEvent {
                        action: "toggle-cron-task",
                        id: Some(task_id),
                        ok: error.is_none(),
                        error,
                        value,
                    },
                ) {
                    eprintln!("failed to emit cron toggle feedback: {emit_error}");
                }
            });
        }
        AppAction::OpenDataDir => {
            use tauri_plugin_opener::OpenerExt;
            match commands::settings::config_dir() {
                Ok(dir) => {
                    if let Err(error) = app
                        .opener()
                        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
                    {
                        eprintln!("failed to open LiveAgent data directory: {error}");
                    }
                }
                Err(error) => eprintln!("failed to resolve LiveAgent data directory: {error}"),
            }
        }
        AppAction::Quit => {
            let allow_exit = app.state::<Arc<AtomicBool>>();
            let terminal_registry = app.state::<Arc<runtime::terminal::TerminalSessionRegistry>>();
            request_app_exit(app, allow_exit.inner(), terminal_registry.inner());
        }
    }
}

fn handle_global_shortcut(
    app: &tauri::AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
) {
    let action = app
        .state::<Arc<commands::app::GlobalShortcutRegistry>>()
        .lookup_action(shortcut);
    let Some(action) = action else {
        return;
    };
    let action = match action.as_str() {
        "summon" => AppAction::Summon,
        "toggle" => AppAction::ToggleWindow,
        "newChat" => AppAction::NewChat,
        "pin" => AppAction::TogglePin,
        _ => return,
    };
    dispatch_app_action(app, action);
}

fn request_app_exit(
    app: &tauri::AppHandle,
    allow_exit: &AtomicBool,
    terminal_registry: &runtime::terminal::TerminalSessionRegistry,
) {
    let running_count = terminal_registry.running_session_count();
    if running_count > 0 {
        if let Err(error) = show_main_window(app) {
            eprintln!("failed to show LiveAgent window before terminal exit confirm: {error}");
        }
        if let Err(error) = app.emit(
            TERMINAL_EXIT_REQUESTED_EVENT,
            TerminalExitRequestedEvent { running_count },
        ) {
            eprintln!("failed to request terminal exit confirmation: {error}");
        }
        return;
    }

    allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn configure_system_tray(app: &tauri::App) -> tauri::Result<()> {
    let skeleton = services::tray::build_tray_menu_skeleton(app, app_version())?;
    let menu = skeleton.menu.clone();

    let mut tray_builder = TrayIconBuilder::new()
        .tooltip("LiveAgent")
        .menu(&menu)
        .show_menu_on_left_click(TRAY_SHOW_MENU_ON_LEFT_CLICK)
        .on_menu_event(|app, event| {
            if let Some(action) = tray_menu_action(event.id().as_ref()) {
                dispatch_app_action(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                if let Err(error) = show_main_window(tray.app_handle()) {
                    eprintln!("failed to show LiveAgent window from tray double-click: {error}");
                }
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } => {
                // Windows 惯例：左键单击即激活主窗口（菜单在右键）。
                // 其他平台左键弹菜单（TRAY_SHOW_MENU_ON_LEFT_CLICK）。
                if cfg!(target_os = "windows") {
                    if let Err(error) = show_main_window(tray.app_handle()) {
                        eprintln!("failed to show LiveAgent window from tray click: {error}");
                    }
                }
            }
            _ => {}
        });

    #[cfg(target_os = "macos")]
    {
        match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon-macos.png")) {
            Ok(icon) => {
                tray_builder = tray_builder.icon(icon).icon_as_template(true);
            }
            Err(error) => {
                eprintln!("failed to load macOS tray icon: {error}");
                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            tray_builder = tray_builder.icon(icon.clone());
        }
    }

    let tray = tray_builder.build(app)?;
    let handles = Arc::new(services::tray::TrayMenuHandles::new(
        skeleton,
        tray.clone(),
        app_version(),
    ));
    app.manage(tray);
    app.manage(handles);

    Ok(())
}

#[cfg(target_os = "windows")]
fn configure_windows_window_chrome(app: &tauri::App) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.set_decorations(false)?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 最早期钩子:若本进程是 Windows 沙箱的自我再执行启动器(__sandbox_exec),
    // 就在此建立受限令牌并运行真实命令,以其退出码退出——绝不继续初始化 Tauri。
    // 非 Windows 平台为空操作。
    runtime::windows_sandbox::run_sandbox_launcher_if_requested();

    let automation_store = Arc::new(
        services::automation::AutomationStore::open()
            .expect("failed to initialize LiveAgent automation store"),
    );
    let automation_scheduler = Arc::new(services::automation::AutomationScheduler::new(
        Arc::clone(&automation_store),
    ));
    let memory_store = Arc::new(
        services::memory::MemoryStore::open().expect("failed to initialize LiveAgent memory store"),
    );
    let provider_usage_service =
        Arc::new(services::provider_usage::ProviderUsageService::default());
    let power_activity = Arc::new(services::power_activity::PowerActivityManager::default());
    let managed_process_registry =
        Arc::new(runtime::managed_process::ManagedProcessRegistry::open());
    let shell_session_manager = Arc::new(runtime::shell_session::ShellSessionManager::default());
    runtime::shell_session::ShellSessionManager::start_cleaner(&shell_session_manager);
    let terminal_registry = Arc::new(runtime::terminal::TerminalSessionRegistry::default());
    let git_clone_task_registry = Arc::new(commands::git::GitCloneTaskRegistry::default());
    let sftp_registry = Arc::new(runtime::sftp::SftpSessionRegistry::new(Arc::clone(
        &terminal_registry,
    )));
    let allow_exit = Arc::new(AtomicBool::new(false));
    let close_window_behavior = Arc::new(commands::app::CloseWindowBehaviorState::new(
        commands::app::CLOSE_WINDOW_BEHAVIOR_MINIMIZE,
    ));
    let stt_manager = Arc::new(services::stt::SttManager::default());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_mcp_bridge::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        handle_global_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .manage(Arc::new(commands::app::GlobalShortcutRegistry::default()))
        .manage(Arc::new(commands::app::FrontendReadyState::default()))
        .manage(Arc::new(commands::app::WindowPinState::default()))
        .manage(Arc::new(commands::mcp::McpRuntimeManager::default()))
        .manage(Arc::clone(&memory_store))
        .manage(Arc::clone(&provider_usage_service))
        .manage(Arc::clone(&power_activity))
        .manage(Arc::new(runtime::shell_runner::ShellRunRegistry::default()))
        .manage(Arc::clone(&shell_session_manager))
        .manage(Arc::clone(&managed_process_registry))
        .manage(Arc::clone(&terminal_registry))
        .manage(Arc::clone(&sftp_registry))
        .manage(Arc::clone(&git_clone_task_registry))
        .manage(Arc::clone(&allow_exit))
        .manage(Arc::clone(&close_window_behavior))
        .manage(Arc::clone(&automation_store))
        .manage(Arc::clone(&automation_scheduler))
        .manage(Arc::new(commands::hook::HookScopeRegistry::default()))
        .manage(stt_manager)
        .on_page_load(|webview, payload| {
            if webview.label() != MAIN_WINDOW_LABEL
                || !matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                return;
            }
            let app = webview.app_handle();
            if let Some(ready_state) =
                app.try_state::<Arc<commands::app::FrontendReadyState>>()
            {
                ready_state.0.store(false, Ordering::SeqCst);
            }
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.hide();
                }
            }
        })
        .setup({
            let terminal_registry = Arc::clone(&terminal_registry);
            let sftp_registry = Arc::clone(&sftp_registry);
            let managed_process_registry = Arc::clone(&managed_process_registry);
            let git_clone_task_registry = Arc::clone(&git_clone_task_registry);
            let provider_usage_service = Arc::clone(&provider_usage_service);
            move |app| {
                commands::history_db::initialize_history_db()?;
                configure_system_tray(app)?;
                #[cfg(target_os = "windows")]
                configure_windows_window_chrome(app)?;
                if let Err(error) = commands::settings::initialize_system_proxy_from_db() {
                    eprintln!("failed to initialize system proxy state: {error}");
                }
                commands::system::gc_upload_staging_on_startup();
                commands::system::start_directory_import_staging_gc();
                app.manage(services::proxy::start_proxy_server()?);
                if let Err(error) = services::skills::ensure_builtin_agent_skills_sync() {
                    eprintln!("failed to seed builtin skills: {error}");
                }
                terminal_registry.attach_app_handle(app.handle().clone());
                sftp_registry.attach_app_handle(app.handle().clone());
                // 配置自动同步的后台任务：只消费脏信号并做防抖上传，
                // 未开启自动同步时它会在每次唤醒后静默跳过。
                services::webdav_auto_sync::start(app.handle().clone());
                let gateway_controller = Arc::new(services::gateway::GatewayController::new(
                    app.handle().clone(),
                    Arc::clone(&automation_store),
                    Arc::clone(&memory_store),
                    Arc::clone(&provider_usage_service),
                    Arc::clone(&terminal_registry),
                    Arc::clone(&sftp_registry),
                    Arc::clone(&managed_process_registry),
                    Arc::clone(&git_clone_task_registry),
                ));
                managed_process_registry.set_notifier(
                    runtime::managed_process::ManagedProcessNotifier {
                        app_handle: app.handle().clone(),
                        gateway: Arc::downgrade(&gateway_controller),
                    },
                );
                managed_process_registry.spawn_startup_reconcile();
                managed_process_registry.spawn_monitor();
                automation_store.set_notifier(services::automation::AutomationNotifier {
                    app_handle: app.handle().clone(),
                    gateway: Arc::downgrade(&gateway_controller),
                    scheduler: Arc::downgrade(&automation_scheduler),
                });
                Arc::clone(&automation_scheduler).start();
                app.manage(Arc::clone(&gateway_controller));
                if let Err(error) = gateway_controller.start() {
                    eprintln!("failed to start remote gateway controller: {error}");
                }
                tauri::async_runtime::spawn({
                    let gateway_controller = Arc::clone(&gateway_controller);
                    async move {
                        if let Err(error) = gateway_controller.reload_from_db().await {
                            eprintln!("failed to load remote gateway settings: {error}");
                        }
                    }
                });
                Ok(())
            }
        })
        .on_window_event({
            let allow_exit = Arc::clone(&allow_exit);
            let close_window_behavior = Arc::clone(&close_window_behavior);
            let terminal_registry = Arc::clone(&terminal_registry);
            move |window, event| {
                if window.label() != MAIN_WINDOW_LABEL {
                    return;
                }

                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if commands::app::is_close_window_exit(&close_window_behavior) {
                        request_app_exit(window.app_handle(), &allow_exit, &terminal_registry);
                    } else if let Err(error) = window.hide() {
                        eprintln!("failed to hide LiveAgent window on close: {error}");
                    }
                }
            }
        })
        .invoke_handler(app_invoke_handler!())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app, event| match event {
        tauri::RunEvent::Resumed => {
            if let Some(gateway_controller) =
                _app.try_state::<Arc<services::gateway::GatewayController>>()
            {
                if let Err(error) = gateway_controller.nudge_connection("app_resumed", true) {
                    eprintln!("failed to nudge gateway connection after app resume: {error}");
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_main_window(_app) {
                eprintln!("failed to show LiveAgent window from dock reopen: {error}");
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !allow_exit.load(Ordering::SeqCst) {
                let running_count = terminal_registry.running_session_count();
                if running_count > 0 {
                    if let Err(error) = show_main_window(_app) {
                        eprintln!(
                            "failed to show LiveAgent window before terminal exit confirm: {error}"
                        );
                    }
                    if let Err(error) = _app.emit(
                        TERMINAL_EXIT_REQUESTED_EVENT,
                        TerminalExitRequestedEvent { running_count },
                    ) {
                        eprintln!("failed to request terminal exit confirmation: {error}");
                    }
                }
                api.prevent_exit();
            } else {
                // Real exit: reclaim every non-isolated managed process
                // before the OS tears us down (Drop is not guaranteed).
                terminal_registry.shutdown_cleanup();
                shell_session_manager.shutdown_cleanup();
                managed_process_registry.shutdown_cleanup();
                git_clone_task_registry.shutdown_cleanup();
                power_activity.clear_all();
            }
        }
        _ => {}
    });
}
