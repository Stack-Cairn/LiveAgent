mod app_context;
mod commands;
mod compat;
mod events;
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
            commands::adapters::chat_history_list,
            commands::adapters::chat_history_workdirs,
            commands::adapters::chat_history_shared_list,
            commands::adapters::chat_history_search,
            commands::adapters::chat_history_get_window,
            commands::adapters::chat_history_upsert,
            commands::adapters::chat_history_upsert_active_segment,
            commands::adapters::chat_history_append_segment,
            commands::adapters::chat_history_rename,
            commands::adapters::chat_history_branch,
            commands::adapters::chat_history_replace_from_message,
            commands::adapters::chat_history_set_pinned,
            commands::adapters::chat_history_set_model,
            commands::adapters::chat_history_share_get,
            commands::adapters::chat_history_share_set,
            commands::adapters::chat_history_delete,
            // Subagent store
            commands::adapters::subagent_identity_upsert,
            commands::adapters::subagent_identity_list,
            commands::adapters::subagent_run_save,
            commands::adapters::subagent_run_list,
            commands::adapters::subagent_run_load,
            commands::adapters::subagent_run_prune,
            commands::adapters::subagent_message_append,
            commands::adapters::subagent_message_list,
            // File system
            commands::adapters::fs_read_text,
            commands::adapters::fs_read_editable_text,
            commands::adapters::fs_path_status,
            commands::adapters::fs_read_image_source,
            commands::adapters::fs_read_workspace_image,
            commands::adapters::fs_write_text,
            commands::adapters::fs_edit_text,
            commands::adapters::fs_delete,
            commands::adapters::fs_open_workspace_path,
            commands::adapters::fs_create_dir,
            commands::adapters::fs_rename,
            commands::adapters::fs_roots,
            commands::adapters::fs_list_dirs,
            commands::adapters::fs_list,
            commands::adapters::fs_glob,
            commands::adapters::fs_grep,
            commands::adapters::fs_mention_list,
            commands::adapters::open_chat_file_link,
            // Subagent worktrees
            commands::adapters::subagent_worktree_create,
            commands::adapters::subagent_worktree_status,
            commands::adapters::subagent_worktree_apply,
            commands::adapters::subagent_worktree_cleanup,
            // MCP
            commands::adapters::mcp_list_tools,
            commands::adapters::mcp_call_tool,
            commands::adapters::mcp_runtime_status,
            commands::adapters::mcp_stop_server,
            commands::adapters::mcp_test_server,
            commands::adapters::mcp_restart_server,
            // Memory
            commands::adapters::memory_list,
            commands::adapters::memory_read,
            commands::adapters::memory_search,
            commands::adapters::memory_write,
            commands::adapters::memory_update,
            commands::adapters::memory_delete,
            commands::adapters::memory_delete_project,
            commands::adapters::memory_accept,
            commands::adapters::memory_apply_batch,
            commands::adapters::memory_organize_run_create,
            commands::adapters::memory_organize_run_update,
            commands::adapters::memory_organize_run_list,
            commands::adapters::memory_organize_run_read,
            commands::adapters::memory_organize_run_clear_history,
            commands::adapters::memory_organize_due_claim,
            commands::adapters::memory_organize_due_complete,
            commands::adapters::memory_index_overview,
            commands::adapters::memory_paths_info,
            commands::adapters::memory_recent_rejections,
            commands::adapters::memory_today_local_date,
            commands::adapters::memory_today_daily,
            commands::adapters::memory_quota_summary,
            commands::adapters::memory_wipe_all,
            // Settings
            commands::adapters::settings_load_all,
            commands::adapters::settings_save_providers,
            commands::adapters::settings_list_ccswitch_providers,
            commands::adapters::settings_list_cherry_studio_providers,
            commands::adapters::settings_list_cherry_studio_providers_from_path,
            commands::adapters::settings_save_system,
            commands::adapters::settings_save_mcp,
            commands::adapters::settings_save_agents,
            commands::adapters::settings_save_ssh,
            commands::adapters::settings_apply_ssh_patch,
            commands::adapters::settings_reset_ssh_known_host,
            commands::adapters::settings_save_remote,
            commands::adapters::settings_save_memory,
            commands::adapters::app_update_check,
            commands::adapters::app_update_install,
            commands::adapters::app_restart,
            commands::adapters::app_runtime_platform,
            commands::adapters::app_set_close_window_behavior,
            commands::adapters::app_set_global_shortcuts,
            commands::adapters::app_window_pinned,
            commands::adapters::app_toggle_window_pin,
            commands::adapters::app_confirmed_exit,
            commands::adapters::app_macos_traffic_light_metrics,
            commands::adapters::app_tray_menu_sync,
            // Hooks
            commands::adapters::hook_run_script,
            commands::adapters::hook_run_http_requests,
            commands::adapters::hook_cancel_scope,
            // Automation (cron tasks + hooks store)
            commands::adapters::cron_validate_expression,
            commands::adapters::automation_snapshot,
            commands::adapters::automation_cron_apply,
            commands::adapters::automation_hooks_apply,
            commands::adapters::automation_list_runs,
            commands::adapters::automation_clear_runs,
            commands::adapters::automation_run_cron_now,
            commands::adapters::automation_claim_prompt_runs,
            commands::adapters::automation_release_prompt_run,
            commands::adapters::automation_complete_prompt_run,
            // Local command execution
            commands::adapters::shell_run,
            commands::adapters::runtime_cancel,
            commands::adapters::managed_process_start,
            commands::adapters::managed_process_status,
            commands::adapters::managed_process_stop,
            commands::adapters::managed_process_read_log,
            commands::adapters::managed_process_snapshot,
            commands::adapters::managed_process_clear,
            commands::adapters::terminal_shell_options,
            commands::adapters::terminal_list,
            commands::adapters::terminal_create,
            commands::adapters::terminal_create_ssh,
            commands::adapters::terminal_answer_ssh_prompt,
            commands::adapters::terminal_cancel_ssh_prompt,
            commands::adapters::terminal_ssh_reconnect,
            commands::adapters::terminal_ssh_latency,
            commands::adapters::terminal_ssh_exec,
            commands::adapters::terminal_ssh_local_forward_start,
            commands::adapters::terminal_ssh_local_forward_list,
            commands::adapters::terminal_ssh_local_forward_stop,
            commands::adapters::terminal_ssh_local_forward_check_port,
            commands::adapters::ssh_terminal_tabs_list,
            commands::adapters::ssh_terminal_tab_open,
            commands::adapters::ssh_terminal_tab_close,
            commands::adapters::terminal_stream_attach,
            commands::adapters::terminal_stream_input,
            commands::adapters::terminal_stream_resize,
            commands::adapters::terminal_rename,
            commands::adapters::terminal_close,
            commands::adapters::terminal_close_project,
            commands::adapters::terminal_read_tail,
            commands::adapters::sftp_list,
            commands::adapters::sftp_stat,
            commands::adapters::sftp_read_text,
            commands::adapters::sftp_write_text,
            commands::adapters::sftp_mkdir,
            commands::adapters::sftp_rename,
            commands::adapters::sftp_delete,
            commands::adapters::sftp_transfer,
            commands::adapters::sftp_cancel_transfer,
            commands::adapters::sftp_transfer_status,
            commands::adapters::git_status,
            commands::adapters::git_discover_repositories,
            commands::adapters::git_branches,
            commands::adapters::git_init,
            commands::adapters::git_clone_repository,
            commands::adapters::git_clone_repository_start,
            commands::adapters::git_clone_repository_tasks,
            commands::adapters::git_clone_repository_cancel,
            commands::adapters::git_clone_repository_dismiss,
            commands::adapters::git_list_remote_branches,
            commands::adapters::git_switch_branch,
            commands::adapters::git_create_branch,
            commands::adapters::git_diff,
            commands::adapters::git_log,
            commands::adapters::git_commit_details,
            commands::adapters::git_compare_commit_with_remote,
            commands::adapters::git_commit_diff,
            commands::adapters::git_stage,
            commands::adapters::git_stage_all,
            commands::adapters::git_unstage,
            commands::adapters::git_unstage_all,
            commands::adapters::git_discard,
            commands::adapters::git_discard_all,
            commands::adapters::git_add_to_gitignore,
            commands::adapters::git_open_system_file_location,
            commands::adapters::git_commit,
            commands::adapters::git_fetch,
            commands::adapters::git_pull,
            commands::adapters::git_set_remote,
            commands::adapters::git_push,
            commands::adapters::git_delete_branch,
            commands::adapters::git_rename_branch,
            commands::adapters::git_stash_push,
            commands::adapters::git_stash_pop,
            commands::adapters::system_pick_folder,
            commands::adapters::system_pick_file,
            commands::adapters::system_create_project_folder,
            commands::adapters::system_import_pasted_texts,
            commands::adapters::system_import_readable_file_paths,
            commands::adapters::system_import_uploaded_readable_files,
            commands::adapters::system_pick_readable_files,
            commands::adapters::system_read_uploaded_image_preview,
            commands::adapters::system_read_uploaded_native_attachment,
            commands::adapters::system_list_skill_files,
            commands::adapters::system_ensure_builtin_skills,
            commands::adapters::system_read_skill_metadata,
            commands::adapters::system_read_skill_text,
            commands::adapters::system_manage_skill,
            commands::adapters::system_append_debug_jsonl,
            commands::adapters::system_begin_power_activity,
            commands::adapters::system_end_power_activity,
            commands::adapters::system_clipboard_read_text,
            commands::adapters::gateway_connect,
            commands::adapters::gateway_disconnect,
            commands::adapters::gateway_status,
            commands::adapters::gateway_nudge_connection,
            commands::adapters::gateway_send_chat_ingress_batch,
            commands::adapters::gateway_commit_chat_checkpoint,
            commands::adapters::gateway_chat_claim_next,
            commands::adapters::gateway_chat_mark_started,
            commands::adapters::gateway_chat_mark_local_started,
            commands::adapters::gateway_chat_mark_local_cancelled,
            commands::adapters::gateway_chat_mark_queued_in_gui,
            commands::adapters::gateway_chat_complete,
            commands::adapters::gateway_chat_fail,
            commands::adapters::gateway_chat_cancel_request,
            commands::adapters::gateway_chat_heartbeat,
            commands::adapters::gateway_chat_runtime_heartbeat,
            commands::adapters::gateway_chat_release_lease,
            commands::adapters::gateway_chat_queue_respond,
            commands::adapters::gateway_publish_chat_queue_event,
            commands::adapters::gateway_publish_settings_sync,
            commands::adapters::gateway_tunnel_state,
            commands::adapters::gateway_tunnel_create,
            commands::adapters::gateway_tunnel_update,
            commands::adapters::gateway_tunnel_close,
            commands::adapters::gateway_tunnel_check,
            commands::adapters::workspace_watch_set,
            commands::adapters::provider_usage_query,
            commands::adapters::provider_usage_test,
            commands::adapters::proxy_get_server_info,
        ]
    };
}

fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
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
            crate::compat::async_runtime::spawn_blocking(move || {
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
        // 纯桌面态：与 AppContext 无关的静态状态（headless 无窗口/托盘/快捷键）。
        .manage(Arc::new(commands::app::GlobalShortcutRegistry::default()))
        .manage(Arc::new(commands::app::WindowPinState::default()))
        .manage(Arc::new(commands::mcp::McpRuntimeManager::default()))
        .manage(Arc::new(runtime::shell_runner::ShellRunRegistry::default()))
        .manage(Arc::new(commands::hook::HookScopeRegistry::default()))
        .setup({
            move |app| {
                commands::history_db::initialize_history_db()?;
                configure_system_tray(app)?;
                #[cfg(target_os = "windows")]
                configure_windows_window_chrome(app)?;
                if let Err(error) = commands::settings::initialize_system_proxy_from_db() {
                    eprintln!("failed to initialize system proxy state: {error}");
                }
                commands::system::gc_upload_staging_on_startup();
                app.manage(services::proxy::start_proxy_server()?);
                if let Err(error) = services::skills::ensure_builtin_agent_skills_sync() {
                    eprintln!("failed to seed builtin skills: {error}");
                }
                // 业务装配（headless 与 desktop 共用）：状态创建 + 依赖注入 + 后台任务。
                let event_emitter: Arc<dyn crate::events::EventEmitter> =
                    crate::events::shared_emitter(app.handle().clone());
                let ctx = app_context::AppContext::new(event_emitter);
                manage_app_context_states(app, &ctx);
                Ok(())
            }
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                let Some(ctx) = window.try_state::<Arc<app_context::AppContext>>() else {
                    return;
                };
                api.prevent_close();
                if commands::app::is_close_window_exit(&ctx.close_window_behavior) {
                    request_app_exit(window.app_handle(), &ctx.allow_exit, &ctx.terminal_registry);
                } else if let Err(error) = window.hide() {
                    eprintln!("failed to hide LiveAgent window on close: {error}");
                }
            }
        })
        .invoke_handler(app_invoke_handler!())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app, event| match event {
        tauri::RunEvent::Resumed => {
            if let Some(ctx) = app.try_state::<Arc<app_context::AppContext>>() {
                if let Err(error) = ctx.gateway_controller.nudge_connection("app_resumed", true) {
                    eprintln!("failed to nudge gateway connection after app resume: {error}");
                }
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_main_window(app) {
                eprintln!("failed to show LiveAgent window from dock reopen: {error}");
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            let Some(ctx) = app.try_state::<Arc<app_context::AppContext>>() else {
                api.prevent_exit();
                return;
            };
            if !ctx.allow_exit.load(Ordering::SeqCst) {
                let running_count = ctx.terminal_registry.running_session_count();
                if running_count > 0 {
                    if let Err(error) = show_main_window(app) {
                        eprintln!(
                            "failed to show LiveAgent window before terminal exit confirm: {error}"
                        );
                    }
                    if let Err(error) = app.emit(
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
                ctx.terminal_registry.shutdown_cleanup();
                ctx.managed_process_registry.shutdown_cleanup();
                ctx.git_clone_task_registry.shutdown_cleanup();
                ctx.power_activity.clear_all();
            }
        }
        _ => {}
    });
}

/// 将 `AppContext` 的各字段注册为 tauri `State`，供命令适配层按需解包。
/// 注意：`State` 以类型区分，字段本身必须各自 `manage`（不能只 manage 整个 ctx）。
fn manage_app_context_states(app: &tauri::App, ctx: &Arc<app_context::AppContext>) {
    app.manage(Arc::clone(&ctx.automation_store));
    app.manage(Arc::clone(&ctx.automation_scheduler));
    app.manage(Arc::clone(&ctx.memory_store));
    app.manage(Arc::clone(&ctx.provider_usage_service));
    app.manage(Arc::clone(&ctx.power_activity));
    app.manage(Arc::clone(&ctx.managed_process_registry));
    app.manage(Arc::clone(&ctx.terminal_registry));
    app.manage(Arc::clone(&ctx.sftp_registry));
    app.manage(Arc::clone(&ctx.git_clone_task_registry));
    app.manage(Arc::clone(&ctx.allow_exit));
    app.manage(Arc::clone(&ctx.close_window_behavior));
    app.manage(Arc::clone(&ctx.gateway_controller));
}
