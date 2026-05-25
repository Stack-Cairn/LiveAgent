mod commands;
mod runtime;
mod services;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::WindowEvent;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";
const TRAY_DOUBLE_CLICK_INTERVAL_MS: u64 = 500;
const TRAY_SHOW_MENU_ON_LEFT_CLICK: bool = !cfg!(target_os = "windows");

macro_rules! app_invoke_handler {
    () => {
        tauri::generate_handler![
            // Chat history
            commands::chat_history::chat_history_list,
            commands::chat_history::chat_history_search,
            commands::chat_history::chat_history_get,
            commands::chat_history::chat_history_get_active_segment,
            commands::chat_history::chat_history_upsert,
            commands::chat_history::chat_history_upsert_active_segment,
            commands::chat_history::chat_history_append_segment,
            commands::chat_history::chat_history_rename,
            commands::chat_history::chat_history_set_pinned,
            commands::chat_history::chat_history_share_get,
            commands::chat_history::chat_history_share_set,
            commands::chat_history::chat_history_delete,
            // Subagent history
            commands::subagent_history::subagent_identity_upsert,
            commands::subagent_history::subagent_identity_list,
            commands::subagent_history::subagent_run_upsert,
            commands::subagent_history::subagent_run_append_event,
            commands::subagent_history::subagent_message_append,
            commands::subagent_history::subagent_message_list,
            commands::subagent_history::subagent_run_list,
            commands::subagent_history::subagent_run_get,
            commands::subagent_history::subagent_run_get_state,
            commands::subagent_history::subagent_run_prune,
            // File system
            commands::fs::fs_read_text,
            commands::fs::fs_read_image_source,
            commands::fs::fs_write_text,
            commands::fs::fs_edit_text,
            commands::fs::fs_delete,
            commands::fs::fs_list,
            commands::fs::fs_glob,
            commands::fs::fs_grep,
            commands::fs::fs_mention_list,
            // Delegated subagent worktrees
            commands::delegate::delegate_create_worktree,
            commands::delegate::delegate_worktree_status,
            commands::delegate::delegate_apply_worktree_changes,
            commands::delegate::delegate_cleanup_worktree,
            commands::delegate::delegate_cleanup_worktrees,
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
            commands::memory::memory_wipe_all,
            // Settings
            commands::settings::settings_load_all,
            commands::settings::settings_save_providers,
            commands::settings::settings_save_system,
            commands::settings::settings_save_mcp,
            commands::settings::settings_save_agents,
            commands::settings::settings_save_hooks,
            commands::settings::settings_save_cron,
            commands::settings::settings_save_remote,
            commands::settings::settings_save_memory,
            commands::update::app_update_check,
            commands::update::app_update_install,
            // Hooks
            commands::hook::hook_run_script,
            commands::hook::hook_run_http_requests,
            // Cron
            commands::cron::cron_validate_expression,
            commands::cron::cron_list_logs,
            commands::cron::cron_clear_logs,
            commands::cron::cron_take_pending_prompt_runs,
            commands::cron::cron_complete_prompt_run,
            // Local command execution
            commands::shell::shell_run,
            commands::shell::shell_cancel,
            commands::process::managed_process_start,
            commands::process::managed_process_status,
            commands::process::managed_process_stop,
            commands::process::managed_process_read_log,
            commands::system::system_pick_folder,
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
            commands::system::system_add_cron_task,
            commands::system::system_manage_cron_task,
            commands::system_tools::system_http_get_test,
            commands::gateway::gateway_connect,
            commands::gateway::gateway_disconnect,
            commands::gateway::gateway_status,
            commands::gateway::gateway_send_chat_event,
            commands::gateway::gateway_publish_conversation_activity,
            commands::gateway::gateway_publish_settings_sync,
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

fn record_tray_left_click(last_click_at: &Mutex<Option<Instant>>) -> bool {
    let now = Instant::now();
    let mut last_click_at = last_click_at.lock().unwrap();
    let is_double_click = last_click_at
        .map(|previous| now.duration_since(previous))
        .is_some_and(|elapsed| elapsed <= Duration::from_millis(TRAY_DOUBLE_CLICK_INTERVAL_MS));

    *last_click_at = if is_double_click { None } else { Some(now) };

    is_double_click
}

fn configure_system_tray(app: &tauri::App, allow_exit: Arc<AtomicBool>) -> tauri::Result<()> {
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
                allow_exit.store(true, Ordering::SeqCst);
                app.exit(0);
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
    let cron_manager = Arc::new(services::cron::CronManager::new());
    let memory_store = Arc::new(
        services::memory::MemoryStore::open().expect("failed to initialize LiveAgent memory store"),
    );
    let allow_exit = Arc::new(AtomicBool::new(false));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_mcp_bridge::init())
        .manage(Arc::new(commands::mcp::McpRuntimeManager::default()))
        .manage(Arc::clone(&memory_store))
        .manage(Arc::new(
            services::power_activity::PowerActivityManager::default(),
        ))
        .manage(Arc::new(runtime::shell_runner::ShellRunRegistry::default()))
        .manage(Arc::new(
            runtime::managed_process::ManagedProcessRegistry::default(),
        ))
        .manage(Arc::clone(&cron_manager))
        .setup({
            let allow_exit = Arc::clone(&allow_exit);
            move |app| {
                configure_system_tray(app, Arc::clone(&allow_exit))?;
                #[cfg(target_os = "windows")]
                configure_windows_window_chrome(app)?;
                app.manage(services::proxy::start_proxy_server()?);
                if let Err(error) = services::skills::ensure_builtin_agent_skills_sync() {
                    eprintln!("failed to seed builtin skills: {error}");
                }
                cron_manager.attach_app_handle(app.handle().clone())?;
                Arc::clone(&cron_manager).start();
                cron_manager.request_reload();
                let gateway_controller = Arc::new(services::gateway::GatewayController::new(
                    app.handle().clone(),
                    Arc::clone(&cron_manager),
                    Arc::clone(&memory_store),
                ));
                cron_manager
                    .attach_settings_sync_controller(Arc::downgrade(&gateway_controller))?;
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
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("failed to hide LiveAgent window on close: {error}");
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
                api.prevent_exit();
            }
        }
        _ => {}
    });
}
