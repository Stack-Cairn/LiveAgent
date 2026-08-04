//! 把 `EventSink` 接到 Gateway 上。
//!
//! 这是**过渡设施**：Gateway 在阶段 4 整体删除时，本文件一并消失。
//!
//! 它存在的意义是把「Gateway 想听哪些事件」这件事从后端代码里挪出来。此前
//! `runtime/`、`services/`、`commands/` 里散落着 65 处 `GatewayController` 引用，
//! 全都是为了推事件——那让后端在编译期依赖 Gateway，无法迁入 agent-core。
//! 现在后端只管往 `EventBus` 发，Gateway 的知识全部收敛在这里。
//!
//! 注意：本 sink 拿到事件后多半是**重读当前状态再发布**，而不是把 payload 反序列化回来。
//! 这些事件推的都是全量快照，重读是幂等的；这样就不必给每个 payload 类型追加
//! `Deserialize`（共 11 个事件，那是纯粹的噪音）。

use std::sync::{Arc, Weak};

use crate::commands::chat_history::{
    ChatHistorySummary, HISTORY_DELETE_EVENT, HISTORY_UPSERT_EVENT,
};
use agent_core::events::EventSink;
use crate::runtime::managed_process::MANAGED_PROCESS_CHANGED_EVENT;
use crate::services::automation::types::{CRON_CHANGED_EVENT, HOOKS_CHANGED_EVENT};
use crate::services::gateway::{
    build_history_sync_delete, build_history_sync_upsert, now_unix_seconds, proto,
    GatewayController,
};
use crate::services::workspace_watch::{WorkspaceWatchService, WORKSPACE_ACTIVITY_EVENT};

pub struct GatewayEventSink {
    controller: Weak<GatewayController>,
    workspace_watch: Weak<WorkspaceWatchService>,
}

impl GatewayEventSink {
    pub fn new(
        controller: &Arc<GatewayController>,
        workspace_watch: &Arc<WorkspaceWatchService>,
    ) -> Self {
        Self {
            controller: Arc::downgrade(controller),
            workspace_watch: Arc::downgrade(workspace_watch),
        }
    }

    /// 工作区活动只转发 Gateway 声明过兴趣的 workdir，且是 best-effort：
    /// 丢一条由下一次变更自愈，绝不阻塞 watcher 线程。
    fn forward_workspace_activity(
        &self,
        controller: &Arc<GatewayController>,
        payload: &serde_json::Value,
    ) {
        let Some(workdir) = payload.get("workdir").and_then(|v| v.as_str()) else {
            return;
        };
        let Some(watch) = self.workspace_watch.upgrade() else {
            return;
        };
        if !watch.workdir_in_gateway_set(workdir) {
            return;
        }
        let Ok(sender) = controller.current_outbound_sender() else {
            return;
        };

        let changed_paths = payload
            .get("changedPaths")
            .and_then(|v| v.as_array())
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(|p| p.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        let _ = sender.try_send(proto::AgentEnvelope {
            request_id: format!("workspace-activity-{}", uuid::Uuid::new_v4()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::WorkspaceActivity(
                proto::WorkspaceActivityEvent {
                    workdir: workdir.to_string(),
                    revision: payload.get("revision").and_then(|v| v.as_u64()).unwrap_or(0),
                    fs: payload.get("fs").and_then(|v| v.as_bool()).unwrap_or(false),
                    git: payload.get("git").and_then(|v| v.as_bool()).unwrap_or(false),
                    changed_paths,
                    truncated: payload
                        .get("truncated")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                },
            )),
        });
    }
}

impl EventSink for GatewayEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let Some(controller) = self.controller.upgrade() else {
            return;
        };

        match event {
            MANAGED_PROCESS_CHANGED_EVENT => {
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = controller.publish_current_managed_processes().await {
                        eprintln!("publish managed process snapshot failed: {error}");
                    }
                });
            }
            // cron / hooks 变更都会改变 settings 快照，Gateway 需要重新同步。
            CRON_CHANGED_EVENT | HOOKS_CHANGED_EVENT => {
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = controller.refresh_settings_sync_from_db().await {
                        eprintln!(
                            "refresh gateway settings sync after automation change failed: {error}"
                        );
                    }
                });
            }
            WORKSPACE_ACTIVITY_EVENT => {
                self.forward_workspace_activity(&controller, &payload);
            }
            // history 是少数几个必须把 payload 读回来的事件：Gateway 要把整个
            // summary 转成 sync 事件发给远端，重读数据库拿不到「刚才改的是哪一条」。
            HISTORY_UPSERT_EVENT => {
                match serde_json::from_value::<ChatHistorySummary>(payload) {
                    Ok(summary) => {
                        tauri::async_runtime::spawn(async move {
                            controller
                                .publish_history_sync(build_history_sync_upsert(&summary))
                                .await;
                        });
                    }
                    Err(error) => eprintln!("history upsert 事件反序列化失败: {error}"),
                }
            }
            HISTORY_DELETE_EVENT => {
                let Some(conversation_id) = payload.as_str().map(str::to_string) else {
                    eprintln!("history delete 事件 payload 不是字符串");
                    return;
                };
                tauri::async_runtime::spawn(async move {
                    controller
                        .publish_history_sync(build_history_sync_delete(conversation_id))
                        .await;
                });
            }
            // 其余事件 Gateway 通过各 registry 自带的 subscriber 通道拿，
            // 或者根本不关心。不认识的事件静默丢弃是正确行为：
            // 加一个新事件不应该逼着这里跟着改。
            _ => {}
        }
    }
}
