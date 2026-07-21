mod commands;
mod runtime;
mod services;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;
use tauri::Manager;
use tauri::WindowEvent;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_DOUBLE_CLICK_INTERVAL_MS: u64 = 500;
const TRAY_SHOW_MENU_ON_LEFT_CLICK: bool = !cfg!(target_os = "windows");
const TERMINAL_EXIT_REQUESTED_EVENT: &str = "terminal:exit-requested";

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
            commands::chat_history::chat_history_get,
            commands::chat_history::chat_history_get_active_segment,
            commands::chat_history::chat_history_upsert,
            commands::chat_history::chat_history_upsert_active_segment,
            commands::chat_history::chat_history_append_segment,
            commands::chat_history::chat_history_rename,
            commands::chat_history::chat_history_branch,
            commands::chat_history::chat_history_set_pinned,
            commands::chat_history::chat_history_set_model,
            commands::chat_history::chat_history_share_get,
            commands::chat_history::chat_history_share_set,
            commands::chat_history::chat_history_delete,
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
            commands::update::app_update_check,
            commands::update::app_update_install,
            commands::update::app_restart,
            commands::app::app_runtime_platform,
            commands::app::app_set_close_window_behavior,
            commands::app::app_confirmed_exit,
            commands::app::app_macos_traffic_light_metrics,
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
            commands::shell::shell_cancel,
            commands::process::managed_process_start,
            commands::process::managed_process_status,
            commands::process::managed_process_stop,
            commands::process::managed_process_read_log,
            commands::process::managed_process_snapshot,
            commands::process::managed_process_clear,
            commands::terminal::terminal_shell_options,
            commands::terminal::terminal_list,
            commands::terminal::terminal_create,
            commands::terminal::terminal_create_ssh,
            commands::terminal::terminal_answer_ssh_prompt,
            commands::terminal::terminal_cancel_ssh_prompt,
            commands::terminal::terminal_ssh_latency,
            commands::terminal::terminal_ssh_exec,
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
            commands::git::git_switch_branch,
            commands::git::git_create_branch,
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
            commands::custom_tools::system_http_get_test,
            commands::gateway::gateway_connect,
            commands::gateway::gateway_disconnect,
            commands::gateway::gateway_status,
            commands::gateway::gateway_nudge_connection,
            commands::gateway::gateway_send_chat_event,
            commands::gateway::gateway_chat_claim_next,
            commands::gateway::gateway_chat_mark_started,
            commands::gateway::gateway_chat_mark_local_started,
            commands::gateway::gateway_chat_mark_queued_in_gui,
            commands::gateway::gateway_chat_complete,
            commands::gateway::gateway_chat_fail,
            commands::gateway::gateway_chat_cancel_request,
            commands::gateway::gateway_chat_heartbeat,
            commands::gateway::gateway_chat_runtime_heartbeat,
            commands::gateway::gateway_chat_release_lease,
            commands::gateway::gateway_chat_queue_respond,
            commands::gateway::gateway_publish_chat_queue_event,
            commands::gateway::gateway_publish_chat_runtime_snapshot,
            commands::gateway::gateway_publish_settings_sync,
            commands::gateway::gateway_tunnel_state,
            commands::gateway::gateway_tunnel_create,
            commands::gateway::gateway_tunnel_update,
            commands::gateway::gateway_tunnel_close,
            commands::gateway::gateway_tunnel_check,
            commands::gateway::workspace_watch_set,
            services::proxy::proxy_get_server_info,
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

fn record_tray_left_click(last_click_at: &Mutex<Option<Instant>>) -> bool {
    let now = Instant::now();
    let mut last_click_at = last_click_at.lock().unwrap();
    let is_double_click = last_click_at
        .map(|previous| now.duration_since(previous))
        .is_some_and(|elapsed| elapsed <= Duration::from_millis(TRAY_DOUBLE_CLICK_INTERVAL_MS));

    *last_click_at = if is_double_click { None } else { Some(now) };

    is_double_click
}

fn configure_system_tray(
    app: &tauri::App,
    allow_exit: Arc<AtomicBool>,
    terminal_registry: Arc<runtime::terminal::TerminalSessionRegistry>,
) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW_ID, "显示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let last_left_click_at = Arc::new(Mutex::new(None));

    let mut tray_builder = TrayIconBuilder::new()
        .tooltip("LiveAgent")
        .menu(&menu)
        .show_menu_on_left_click(TRAY_SHOW_MENU_ON_LEFT_CLICK)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => {
                if let Err(error) = show_main_window(app) {
                    eprintln!("failed to show LiveAgent window from tray: {error}");
                }
            }
            TRAY_QUIT_ID => {
                request_app_exit(app, &allow_exit, &terminal_registry);
            }
            _ => {}
        })
        .on_tray_icon_event({
            let last_left_click_at = Arc::clone(&last_left_click_at);
            move |tray, event| match event {
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
                    if record_tray_left_click(&last_left_click_at) {
                        if let Err(error) = show_main_window(tray.app_handle()) {
                            eprintln!(
                                "failed to show LiveAgent window from tray left double-click: {error}"
                            );
                        }
                    }
                }
                _ => {}
            }
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
    app.manage(tray);

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
    let power_activity = Arc::new(services::power_activity::PowerActivityManager::default());
    let managed_process_registry =
        Arc::new(runtime::managed_process::ManagedProcessRegistry::open());
    let terminal_registry = Arc::new(runtime::terminal::TerminalSessionRegistry::default());
    let sftp_registry = Arc::new(runtime::sftp::SftpSessionRegistry::new(Arc::clone(
        &terminal_registry,
    )));
    let allow_exit = Arc::new(AtomicBool::new(false));
    let close_window_behavior = Arc::new(commands::app::CloseWindowBehaviorState::new(
        commands::app::CLOSE_WINDOW_BEHAVIOR_MINIMIZE,
    ));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_mcp_bridge::init())
        .manage(Arc::new(commands::mcp::McpRuntimeManager::default()))
        .manage(Arc::clone(&memory_store))
        .manage(Arc::clone(&power_activity))
        .manage(Arc::new(runtime::shell_runner::ShellRunRegistry::default()))
        .manage(Arc::clone(&managed_process_registry))
        .manage(Arc::clone(&terminal_registry))
        .manage(Arc::clone(&sftp_registry))
        .manage(Arc::clone(&allow_exit))
        .manage(Arc::clone(&close_window_behavior))
        .manage(Arc::clone(&automation_store))
        .manage(Arc::clone(&automation_scheduler))
        .manage(Arc::new(commands::hook::HookScopeRegistry::default()))
        .setup({
            let allow_exit = Arc::clone(&allow_exit);
            let terminal_registry = Arc::clone(&terminal_registry);
            let sftp_registry = Arc::clone(&sftp_registry);
            let managed_process_registry = Arc::clone(&managed_process_registry);
            move |app| {
                commands::history_db::initialize_history_db()?;
                configure_system_tray(
                    app,
                    Arc::clone(&allow_exit),
                    Arc::clone(&terminal_registry),
                )?;
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
                terminal_registry.attach_app_handle(app.handle().clone());
                sftp_registry.attach_app_handle(app.handle().clone());
                let gateway_controller = Arc::new(services::gateway::GatewayController::new(
                    app.handle().clone(),
                    Arc::clone(&automation_store),
                    Arc::clone(&memory_store),
                    Arc::clone(&terminal_registry),
                    Arc::clone(&sftp_registry),
                    Arc::clone(&managed_process_registry),
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
                managed_process_registry.shutdown_cleanup();
                power_activity.clear_all();
            }
        }
        _ => {}
    });
}
