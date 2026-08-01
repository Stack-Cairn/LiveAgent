//! 应用级业务状态装配。
//!
//! `AppContext` 集中管理所有共享状态（store/registry/controller）的创建、
//! 依赖注入与后台任务启动，**不依赖 tauri** —— desktop（经 tauri `State`
//! 注册）与 headless（axum `AppState`）两个构建共用同一装配逻辑。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::commands::app::{CloseWindowBehaviorState, CLOSE_WINDOW_BEHAVIOR_MINIMIZE};
use crate::commands::git::GitCloneTaskRegistry;
use crate::events::EventEmitter;
use crate::runtime::managed_process::{ManagedProcessNotifier, ManagedProcessRegistry};
use crate::runtime::sftp::SftpSessionRegistry;
use crate::runtime::terminal::TerminalSessionRegistry;
use crate::services::automation::{AutomationNotifier, AutomationScheduler, AutomationStore};
use crate::services::gateway::GatewayController;
use crate::services::memory::MemoryStore;
use crate::services::power_activity::PowerActivityManager;
use crate::services::provider_usage::ProviderUsageService;

/// 应用级共享状态集合。
///
/// 字段全部为 `Arc<T>`：desktop 侧每个字段经 `app.manage(Arc::clone(...))`
/// 注册为 tauri `State`；headless 侧整体作为 axum `AppState` 持有。
pub struct AppContext {
    pub automation_store: Arc<AutomationStore>,
    pub automation_scheduler: Arc<AutomationScheduler>,
    pub memory_store: Arc<MemoryStore>,
    pub provider_usage_service: Arc<ProviderUsageService>,
    pub power_activity: Arc<PowerActivityManager>,
    pub managed_process_registry: Arc<ManagedProcessRegistry>,
    pub terminal_registry: Arc<TerminalSessionRegistry>,
    pub git_clone_task_registry: Arc<GitCloneTaskRegistry>,
    pub sftp_registry: Arc<SftpSessionRegistry>,
    pub allow_exit: Arc<AtomicBool>,
    pub close_window_behavior: Arc<CloseWindowBehaviorState>,
    pub gateway_controller: Arc<GatewayController>,
}

impl AppContext {
    /// 装配全部业务状态并启动后台任务。
    ///
    /// `event_emitter` 由调用方注入：desktop 经 `shared_emitter(app.handle())`，
    /// headless 经 WebSocket 事件广播实现。
    pub fn new(event_emitter: Arc<dyn EventEmitter>) -> Arc<Self> {
        let automation_store = Arc::new(
            AutomationStore::open().expect("failed to initialize LiveAgent automation store"),
        );
        let automation_scheduler = Arc::new(AutomationScheduler::new(Arc::clone(
            &automation_store,
        )));
        let memory_store = Arc::new(
            MemoryStore::open().expect("failed to initialize LiveAgent memory store"),
        );
        let provider_usage_service = Arc::new(ProviderUsageService::default());
        let power_activity = Arc::new(PowerActivityManager::default());
        let managed_process_registry = Arc::new(ManagedProcessRegistry::open());
        let terminal_registry = Arc::new(TerminalSessionRegistry::default());
        let git_clone_task_registry = Arc::new(GitCloneTaskRegistry::default());
        let sftp_registry = Arc::new(SftpSessionRegistry::new(Arc::clone(&terminal_registry)));
        let allow_exit = Arc::new(AtomicBool::new(false));
        let close_window_behavior = Arc::new(CloseWindowBehaviorState::new(
            CLOSE_WINDOW_BEHAVIOR_MINIMIZE,
        ));

        // 事件出口：terminal/sftp 会话把内部事件经 emitter 广播给前端。
        terminal_registry.attach_event_emitter(Arc::clone(&event_emitter));
        sftp_registry.attach_event_emitter(Arc::clone(&event_emitter));

        let gateway_controller = Arc::new(GatewayController::new(
            Arc::clone(&event_emitter),
            Arc::clone(&automation_store),
            Arc::clone(&memory_store),
            Arc::clone(&provider_usage_service),
            Arc::clone(&terminal_registry),
            Arc::clone(&sftp_registry),
            Arc::clone(&managed_process_registry),
            Arc::clone(&git_clone_task_registry),
        ));

        // 进程注册表：自动回收孤儿进程 + 结果回写 gateway。
        managed_process_registry.set_notifier(ManagedProcessNotifier {
            event_emitter: Arc::clone(&event_emitter),
            gateway: Arc::downgrade(&gateway_controller),
        });
        managed_process_registry.spawn_startup_reconcile();
        managed_process_registry.spawn_monitor();

        // 自动化 store：cron 任务变更经 notifier 转发 gateway/事件。
        automation_store.set_notifier(AutomationNotifier {
            event_emitter: Arc::clone(&event_emitter),
            gateway: Arc::downgrade(&gateway_controller),
            scheduler: Arc::downgrade(&automation_scheduler),
        });
        Arc::clone(&automation_scheduler).start();

        if let Err(error) = gateway_controller.start() {
            eprintln!("failed to start remote gateway controller: {error}");
        }
        crate::compat::async_runtime::spawn({
            let gateway_controller = Arc::clone(&gateway_controller);
            async move {
                if let Err(error) = gateway_controller.reload_from_db().await {
                    eprintln!("failed to load remote gateway settings: {error}");
                }
            }
        });

        Arc::new(Self {
            automation_store,
            automation_scheduler,
            memory_store,
            provider_usage_service,
            power_activity,
            managed_process_registry,
            terminal_registry,
            git_clone_task_registry,
            sftp_registry,
            allow_exit,
            close_window_behavior,
            gateway_controller,
        })
    }
}
