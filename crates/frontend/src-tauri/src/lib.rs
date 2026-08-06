mod backend_server;
mod commands;
mod services;
mod tauri_commands;
mod tauri_sink;

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
            tauri_commands::chat_history::chat_history_list,
            tauri_commands::chat_history::chat_history_workdirs,
            tauri_commands::chat_history::chat_history_shared_list,
            tauri_commands::chat_history::chat_history_search,
            tauri_commands::chat_history::chat_history_get_window,
            tauri_commands::chat_history::chat_history_upsert,
            tauri_commands::chat_history::chat_history_upsert_active_segment,
            tauri_commands::chat_history::chat_history_append_segment,
            tauri_commands::chat_history::chat_history_rename,
            tauri_commands::chat_history::chat_history_branch,
            tauri_commands::chat_history::chat_history_replace_from_message,
            tauri_commands::chat_history::chat_history_set_pinned,
            tauri_commands::chat_history::chat_history_set_model,
            tauri_commands::chat_history::chat_history_share_get,
            tauri_commands::chat_history::chat_history_share_set,
            tauri_commands::chat_history::chat_history_delete,
            // Subagent store
            tauri_commands::subagent_store::subagent_identity_upsert,
            tauri_commands::subagent_store::subagent_identity_list,
            tauri_commands::subagent_store::subagent_run_save,
            tauri_commands::subagent_store::subagent_run_list,
            tauri_commands::subagent_store::subagent_run_load,
            tauri_commands::subagent_store::subagent_run_prune,
            tauri_commands::subagent_store::subagent_message_append,
            tauri_commands::subagent_store::subagent_message_list,
            // File system
            tauri_commands::fs::fs_read_text,
            tauri_commands::fs::fs_read_editable_text,
            tauri_commands::fs::fs_path_status,
            tauri_commands::fs::fs_read_image_source,
            tauri_commands::fs::fs_read_workspace_image,
            tauri_commands::fs::fs_write_text,
            tauri_commands::fs::fs_edit_text,
            tauri_commands::fs::fs_delete,
            tauri_commands::fs::fs_open_workspace_path,
            tauri_commands::fs::fs_create_dir,
            tauri_commands::fs::fs_rename,
            tauri_commands::fs::fs_roots,
            tauri_commands::fs::fs_list_dirs,
            tauri_commands::fs::fs_list,
            tauri_commands::fs::fs_glob,
            tauri_commands::fs::fs_grep,
            tauri_commands::fs::fs_mention_list,
            tauri_commands::chat_file_links::open_chat_file_link,
            // Subagent worktrees
            tauri_commands::subagent_worktree::subagent_worktree_create,
            tauri_commands::subagent_worktree::subagent_worktree_status,
            tauri_commands::subagent_worktree::subagent_worktree_apply,
            tauri_commands::subagent_worktree::subagent_worktree_cleanup,
            // MCP
            tauri_commands::mcp::mcp_list_tools,
            tauri_commands::mcp::mcp_call_tool,
            tauri_commands::mcp::mcp_runtime_status,
            tauri_commands::mcp::mcp_stop_server,
            tauri_commands::mcp::mcp_test_server,
            tauri_commands::mcp::mcp_restart_server,
            // Memory
            tauri_commands::memory::memory_list,
            tauri_commands::memory::memory_read,
            tauri_commands::memory::memory_search,
            tauri_commands::memory::memory_write,
            tauri_commands::memory::memory_update,
            tauri_commands::memory::memory_delete,
            tauri_commands::memory::memory_delete_project,
            tauri_commands::memory::memory_accept,
            tauri_commands::memory::memory_apply_batch,
            tauri_commands::memory::memory_organize_run_create,
            tauri_commands::memory::memory_organize_run_update,
            tauri_commands::memory::memory_organize_run_list,
            tauri_commands::memory::memory_organize_run_read,
            tauri_commands::memory::memory_organize_run_clear_history,
            tauri_commands::memory::memory_organize_due_claim,
            tauri_commands::memory::memory_organize_due_complete,
            tauri_commands::memory::memory_index_overview,
            tauri_commands::memory::memory_paths_info,
            tauri_commands::memory::memory_recent_rejections,
            tauri_commands::memory::memory_today_local_date,
            tauri_commands::memory::memory_today_daily,
            tauri_commands::memory::memory_quota_summary,
            tauri_commands::memory::memory_wipe_all,
            // Settings
            tauri_commands::settings::settings_load_all,
            tauri_commands::settings::settings_save_providers,
            tauri_commands::settings::settings_list_ccswitch_providers,
            tauri_commands::settings::settings_list_cherry_studio_providers,
            tauri_commands::settings::settings_list_cherry_studio_providers_from_path,
            tauri_commands::settings::settings_save_system,
            tauri_commands::settings::settings_save_mcp,
            tauri_commands::settings::settings_save_agents,
            tauri_commands::settings::settings_save_ssh,
            tauri_commands::settings::settings_apply_ssh_patch,
            tauri_commands::settings::settings_reset_ssh_known_host,
            tauri_commands::settings::settings_save_remote,
            tauri_commands::settings::settings_save_memory,
            commands::update::app_update_check,
            commands::update::app_update_install,
            commands::update::app_restart,
            commands::app::app_runtime_platform,
            commands::app::app_set_close_window_behavior,
            commands::app::app_set_global_shortcuts,
            commands::app::app_window_pinned,
            commands::app::app_toggle_window_pin,
            commands::app::app_confirmed_exit,
            commands::app::app_macos_traffic_light_metrics,
            commands::backend::get_backend_endpoint,
            commands::tray::app_tray_menu_sync,
            // Hooks
            tauri_commands::hook::hook_run_script,
            tauri_commands::hook::hook_run_http_requests,
            tauri_commands::hook::hook_cancel_scope,
            // Automation (cron tasks + hooks store)
            tauri_commands::cron::cron_validate_expression,
            tauri_commands::cron::automation_snapshot,
            tauri_commands::cron::automation_cron_apply,
            tauri_commands::cron::automation_hooks_apply,
            tauri_commands::cron::automation_list_runs,
            tauri_commands::cron::automation_clear_runs,
            tauri_commands::cron::automation_run_cron_now,
            tauri_commands::cron::automation_claim_prompt_runs,
            tauri_commands::cron::automation_release_prompt_run,
            tauri_commands::cron::automation_complete_prompt_run,
            // Local command execution
            tauri_commands::shell::shell_run,
            tauri_commands::shell::runtime_cancel,
            tauri_commands::process::managed_process_start,
            tauri_commands::process::managed_process_status,
            tauri_commands::process::managed_process_stop,
            tauri_commands::process::managed_process_read_log,
            tauri_commands::process::managed_process_snapshot,
            tauri_commands::process::managed_process_clear,
            tauri_commands::terminal::terminal_shell_options,
            tauri_commands::terminal::terminal_list,
            tauri_commands::terminal::terminal_create,
            tauri_commands::terminal::terminal_create_ssh,
            tauri_commands::terminal::terminal_answer_ssh_prompt,
            tauri_commands::terminal::terminal_cancel_ssh_prompt,
            tauri_commands::terminal::terminal_ssh_reconnect,
            tauri_commands::terminal::terminal_ssh_latency,
            tauri_commands::terminal::terminal_ssh_exec,
            tauri_commands::terminal::terminal_ssh_local_forward_start,
            tauri_commands::terminal::terminal_ssh_local_forward_list,
            tauri_commands::terminal::terminal_ssh_local_forward_stop,
            tauri_commands::terminal::terminal_ssh_local_forward_check_port,
            tauri_commands::terminal::ssh_terminal_tabs_list,
            tauri_commands::terminal::ssh_terminal_tab_open,
            tauri_commands::terminal::ssh_terminal_tab_close,
            tauri_commands::terminal::terminal_stream_attach,
            tauri_commands::terminal::terminal_stream_input,
            tauri_commands::terminal::terminal_stream_resize,
            tauri_commands::terminal::terminal_rename,
            tauri_commands::terminal::terminal_close,
            tauri_commands::terminal::terminal_close_project,
            tauri_commands::terminal::terminal_read_tail,
            tauri_commands::sftp::sftp_list,
            tauri_commands::sftp::sftp_stat,
            tauri_commands::sftp::sftp_read_text,
            tauri_commands::sftp::sftp_write_text,
            tauri_commands::sftp::sftp_mkdir,
            tauri_commands::sftp::sftp_rename,
            tauri_commands::sftp::sftp_delete,
            tauri_commands::sftp::sftp_transfer,
            tauri_commands::sftp::sftp_cancel_transfer,
            tauri_commands::sftp::sftp_transfer_status,
            tauri_commands::git::git_status,
            tauri_commands::git::git_discover_repositories,
            tauri_commands::git::git_branches,
            tauri_commands::git::git_init,
            tauri_commands::git::git_clone_repository,
            tauri_commands::git::git_clone_repository_start,
            tauri_commands::git::git_clone_repository_tasks,
            tauri_commands::git::git_clone_repository_cancel,
            tauri_commands::git::git_clone_repository_dismiss,
            tauri_commands::git::git_list_remote_branches,
            tauri_commands::git::git_switch_branch,
            tauri_commands::git::git_create_branch,
            tauri_commands::git::git_diff,
            tauri_commands::git::git_log,
            tauri_commands::git::git_commit_details,
            tauri_commands::git::git_compare_commit_with_remote,
            tauri_commands::git::git_commit_diff,
            tauri_commands::git::git_stage,
            tauri_commands::git::git_stage_all,
            tauri_commands::git::git_unstage,
            tauri_commands::git::git_unstage_all,
            tauri_commands::git::git_discard,
            tauri_commands::git::git_discard_all,
            tauri_commands::git::git_add_to_gitignore,
            tauri_commands::git::git_open_system_file_location,
            tauri_commands::git::git_commit,
            tauri_commands::git::git_fetch,
            tauri_commands::git::git_pull,
            tauri_commands::git::git_set_remote,
            tauri_commands::git::git_push,
            tauri_commands::git::git_delete_branch,
            tauri_commands::git::git_rename_branch,
            tauri_commands::git::git_stash_push,
            tauri_commands::git::git_stash_pop,
            commands::system::system_pick_folder,
            commands::system::system_pick_file,
            commands::system::system_create_project_folder,
            commands::system::system_import_pasted_texts,
            commands::system::system_import_readable_file_paths,
            commands::system::system_import_uploaded_readable_files,
            commands::system::system_pick_readable_files,
            commands::system::system_read_uploaded_image_preview,
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
            tauri_commands::tunnel::tunnel_state,
            tauri_commands::tunnel::tunnel_create,
            tauri_commands::tunnel::tunnel_update,
            tauri_commands::tunnel::tunnel_close,
            tauri_commands::tunnel::tunnel_check,
            commands::workspace::workspace_watch_set,
            commands::provider_usage::provider_usage_query,
            commands::provider_usage::provider_usage_test,
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
/// （开会话/新建对话/打开设置等）；后台型动作（停止运行/改主题）
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
            let Some(store) =
                app.try_state::<Arc<backend::services::automation::AutomationStore>>()
            else {
                return;
            };
            let store = Arc::clone(store.inner());
            let app_handle = app.clone();
            tokio::task::spawn_blocking(move || {
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
            match backend::commands::settings::config_dir() {
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
            let terminal_registry =
                app.state::<Arc<backend::runtime::terminal::TerminalSessionRegistry>>();
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
    terminal_registry: &backend::runtime::terminal::TerminalSessionRegistry,
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
    // 进入 tokio runtime 上下文，并**必须**在此之前把同一个 handle 交给 tauri。
    //
    // 为什么需要这一步：P2-15 把 225 处 `tauri::async_runtime::spawn` 换成了
    // `tokio::spawn`。两者有一处实质差异（P2-12 已记录）——tauri 版会
    // `RUNTIME.get_or_init(default_runtime)` 自建 runtime，所以在任何上下文都能调；
    // 裸 `tokio::spawn` 在 runtime 之外**直接 panic**。
    //
    // P2-12 的逐站点核查结论是「所有 spawn 都只从 async 上下文可达」，但漏了
    // `.setup()` 这条路径：它由 tauri 在**主线程同步**调用，不在任何 runtime 里。
    // 于是 `gc_upload_staging_on_startup()`（system.rs 的 spawn_blocking）一进
    // setup 就 panic，而且它发生在 objc 的 `did_finish_launching` 回调里——
    // 那是个 `extern "C"` 边界，panic 不能跨越，直接变成 abort。
    //
    // 与其逐个给 setup 里的 spawn 加保护（那是把特殊情况数量从 1 变成 N），
    // 不如在入口建好 runtime 并让 tauri 复用它：此后**任何**代码路径都在 runtime
    // 上下文里，`tokio::spawn` 与 `tauri::async_runtime::spawn` 行为一致。
    let runtime = tokio::runtime::Runtime::new().expect("failed to build tokio runtime");
    // 让 tauri 用同一个 runtime，而不是让它自己再建一个：两个 runtime 意味着
    // 两个线程池，且 `async_runtime::block_on` 与 `tokio::spawn` 会落在不同的
    // 执行器上。必须在 tauri 首次碰 RUNTIME 之前调用，否则 `set` 会 panic。
    tauri::async_runtime::set(runtime.handle().clone());
    let _guard = runtime.enter();

    // 必须在任何后端逻辑之前：backend 编译时不知道自己会被装进哪个产物，
    // 版本号只能由宿主注入（MCP 的 clientInfo 会读它）。
    backend::set_app_version(app_version());

    let automation_store = Arc::new(
        backend::services::automation::AutomationStore::open()
            .expect("failed to initialize LiveAgent automation store"),
    );
    let automation_scheduler = Arc::new(
        backend::services::automation::AutomationScheduler::new(Arc::clone(&automation_store)),
    );
    let memory_store = Arc::new(
        backend::services::memory::MemoryStore::open()
            .expect("failed to initialize LiveAgent memory store"),
    );
    let provider_usage_service =
        Arc::new(backend::services::provider_usage::ProviderUsageService::default());
    let power_activity =
        Arc::new(backend::services::power_activity::PowerActivityManager::default());
    let managed_process_registry =
        Arc::new(backend::runtime::managed_process::ManagedProcessRegistry::open());
    let terminal_registry =
        Arc::new(backend::runtime::terminal::TerminalSessionRegistry::default());
    let git_clone_task_registry =
        Arc::new(backend::commands::git::GitCloneTaskRegistry::default());
    let sftp_registry = Arc::new(backend::runtime::sftp::SftpSessionRegistry::new(
        Arc::clone(&terminal_registry),
    ));
    let allow_exit = Arc::new(AtomicBool::new(false));
    // 持有内嵌后端服务（含 Node 引擎进程句柄），直到真正退出时关闭。
    let backend_server_slot: Arc<std::sync::Mutex<Option<backend_server::BackendServer>>> =
        Arc::new(std::sync::Mutex::new(None));
    let close_window_behavior = Arc::new(commands::app::CloseWindowBehaviorState::new(
        commands::app::CLOSE_WINDOW_BEHAVIOR_MINIMIZE,
    ));

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
        .manage(Arc::new(commands::app::WindowPinState::default()))
        .manage(Arc::new(
            backend::commands::mcp::McpRuntimeManager::default(),
        ))
        .manage(Arc::clone(&memory_store))
        .manage(Arc::clone(&provider_usage_service))
        .manage(Arc::clone(&power_activity))
        .manage(Arc::new(
            backend::runtime::shell_runner::ShellRunRegistry::default(),
        ))
        .manage(Arc::clone(&managed_process_registry))
        .manage(Arc::clone(&terminal_registry))
        .manage(Arc::clone(&sftp_registry))
        .manage(Arc::clone(&git_clone_task_registry))
        .manage(Arc::clone(&allow_exit))
        .manage(Arc::clone(&close_window_behavior))
        .manage(Arc::clone(&automation_store))
        .manage(Arc::clone(&automation_scheduler))
        .manage(Arc::new(
            backend::commands::hook::HookScopeRegistry::default(),
        ))
        .setup({
            let terminal_registry = Arc::clone(&terminal_registry);
            let sftp_registry = Arc::clone(&sftp_registry);
            let managed_process_registry = Arc::clone(&managed_process_registry);
            let backend_server_slot = Arc::clone(&backend_server_slot);
            move |app| {
                backend::commands::history_db::initialize_history_db()?;
                configure_system_tray(app)?;
                #[cfg(target_os = "windows")]
                configure_windows_window_chrome(app)?;
                if let Err(error) =
                    backend::commands::settings::initialize_system_proxy_from_db()
                {
                    eprintln!("failed to initialize system proxy state: {error}");
                }
                commands::system::gc_upload_staging_on_startup();
                if let Err(error) = backend::services::skills::ensure_builtin_agent_skills_sync()
                {
                    eprintln!("failed to seed builtin skills: {error}");
                }
                // 事件总线：后端只管往这里发，谁听由这里决定。
                // 桌面 webview 只是普通订阅者，没有谁被硬编码进后端。
                // 先建空总线，sink 稍后注册——总线用内部可变性，允许后置。
                let events = Arc::new(backend::events::EventBus::new());
                let workspace_watch = Arc::new(
                    backend::services::workspace_watch::WorkspaceWatchService::new(Arc::clone(
                        &events,
                    )),
                );
                events.register(Arc::new(tauri_sink::TauriEventSink::new(
                    app.handle().clone(),
                )));
                app.manage(Arc::clone(&events));
                app.manage(Arc::clone(&workspace_watch));
                managed_process_registry.set_event_bus(Arc::clone(&events));
                terminal_registry.set_event_bus(Arc::clone(&events));
                sftp_registry.set_event_bus(Arc::clone(&events));
                managed_process_registry.spawn_startup_reconcile();
                managed_process_registry.spawn_monitor();
                automation_store.set_notifier(
                    backend::services::automation::AutomationNotifier {
                        events: Arc::clone(&events),
                        scheduler: Arc::downgrade(&automation_scheduler),
                    },
                );
                Arc::clone(&automation_scheduler).start();

                // 隧道（P2-30）：桌面壳复用后端那套「一隧道一端口」实现，
                // 与 backend 走的是同一个 TunnelStore + 同一个数据面。
                let tunnels = Arc::new(backend::services::tunnel::TunnelStore::new(
                    Arc::clone(&events),
                    Arc::new(backend::services::tunnel::data_plane::TunnelDataPlane::new()),
                ));
                app.manage(Arc::clone(&tunnels));
                tokio::spawn({
                    let tunnels = Arc::clone(&tunnels);
                    async move {
                        // 恢复上次留下的隧道：端口和 token 是新的，链接会变。
                        if let Err(error) = tunnels.initialize().await {
                            eprintln!("failed to restore tunnels: {error}");
                        }
                        // 周期清扫过期隧道：TTL 的强制执行就在这里。
                        tunnels.spawn_sweeper();
                    }
                });

                // 启动内嵌后端服务（HTTP）。chat 引擎不在这里起——
                // pi 进程由后端在首次 chat_send 时按会话惰性拉起。
                // 这必须在 tokio runtime 上下文里运行（setup 被 runtime.enter() 保护了）。
                let backend_endpoint = Arc::new(tokio::sync::RwLock::new(None));
                let backend_endpoint_clone = Arc::clone(&backend_endpoint);

                tokio::spawn(async move {
                    match backend_server::start_backend_server().await {
                        Ok(server) => {
                            eprintln!("内嵌后端服务启动成功：端口 {}", server.port);
                            *backend_endpoint_clone.write().await = Some(
                                commands::backend::BackendEndpoint {
                                    host: "127.0.0.1".to_string(),
                                    port: server.port,
                                    password: server.password.clone(),
                                },
                            );
                            // 持有 server 直到退出：它握着 pi 会话表，退出时据此收子进程。
                            *backend_server_slot.lock().expect("backend server slot poisoned") =
                                Some(server);
                        }
                        Err(e) => {
                            eprintln!("启动内嵌后端服务失败：{e}");
                        }
                    }
                });
                app.manage(backend_endpoint);

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
                managed_process_registry.shutdown_cleanup();
                git_clone_task_registry.shutdown_cleanup();
                if let Some(server) = backend_server_slot
                    .lock()
                    .ok()
                    .and_then(|mut slot| slot.take())
                {
                    server.shutdown_sessions();
                }
                power_activity.clear_all();
            }
        }
        _ => {}
    });
}
