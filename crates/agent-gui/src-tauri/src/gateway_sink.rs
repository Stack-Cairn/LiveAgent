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

use crate::services::gateway::{
    build_history_sync_delete, build_history_sync_upsert, now_unix_seconds, proto,
    GatewayController,
};
use agent_core::commands::chat_history::{
    ChatHistorySummary, HISTORY_DELETE_EVENT, HISTORY_UPSERT_EVENT,
};
use agent_core::commands::settings::SETTINGS_REMOTE_SAVED_EVENT;
use agent_core::events::EventSink;
use agent_core::runtime::managed_process::MANAGED_PROCESS_CHANGED_EVENT;
use agent_core::services::automation::types::{CRON_CHANGED_EVENT, HOOKS_CHANGED_EVENT};
use agent_core::services::workspace_watch::{WorkspaceWatchService, WORKSPACE_ACTIVITY_EVENT};

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
                    revision: payload
                        .get("revision")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    fs: payload.get("fs").and_then(|v| v.as_bool()).unwrap_or(false),
                    git: payload
                        .get("git")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
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

/// 一条事件对应的 Gateway 动作。
///
/// 拆出这个 enum 的唯一目的是**能测**。`GatewayController` 持有 `tauri::AppHandle`，
/// 单测里造不出来，所以「收到事件后做了什么」验不了。但 P2-07 真实踩过的那次回归
/// （移除 gateway 发布调用后忘了在 sink 里接上，编译全绿而 history 同步已断）
/// 是一个**路由错误**——事件名没落到任何分支上。路由是纯函数，可以单独测。
///
/// 于是：决策在这里（可测），执行留在 `emit_json`（造不出 controller，但只剩转发）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayAction {
    PublishManagedProcesses,
    RefreshSettingsSync,
    ApplyRemoteSettings,
    ForwardWorkspaceActivity,
    PublishHistoryUpsert,
    PublishHistoryDelete,
    /// 其余事件 Gateway 通过各 registry 自带的 subscriber 通道拿，或者根本不关心。
    /// 静默忽略是正确行为：加一个新事件不该逼着这里跟着改。
    Ignore,
}

fn action_for(event: &str) -> GatewayAction {
    match event {
        MANAGED_PROCESS_CHANGED_EVENT => GatewayAction::PublishManagedProcesses,
        // cron / hooks 变更都会改变 settings 快照，Gateway 需要重新同步。
        CRON_CHANGED_EVENT | HOOKS_CHANGED_EVENT => GatewayAction::RefreshSettingsSync,
        SETTINGS_REMOTE_SAVED_EVENT => GatewayAction::ApplyRemoteSettings,
        WORKSPACE_ACTIVITY_EVENT => GatewayAction::ForwardWorkspaceActivity,
        HISTORY_UPSERT_EVENT => GatewayAction::PublishHistoryUpsert,
        HISTORY_DELETE_EVENT => GatewayAction::PublishHistoryDelete,
        _ => GatewayAction::Ignore,
    }
}

impl EventSink for GatewayEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let Some(controller) = self.controller.upgrade() else {
            return;
        };

        match action_for(event) {
            GatewayAction::PublishManagedProcesses => {
                tokio::spawn(async move {
                    if let Err(error) = controller.publish_current_managed_processes().await {
                        eprintln!("publish managed process snapshot failed: {error}");
                    }
                });
            }
            GatewayAction::RefreshSettingsSync => {
                tokio::spawn(async move {
                    if let Err(error) = controller.refresh_settings_sync_from_db().await {
                        eprintln!(
                            "refresh gateway settings sync after automation change failed: {error}"
                        );
                    }
                });
            }
            // settings_save_remote 迁入 agent-core 后不再直接持有 controller，
            // 改成发事件；apply_config 这一步搬到这里，Gateway 的知识仍然只在本文件。
            GatewayAction::ApplyRemoteSettings => match serde_json::from_value(payload) {
                Ok(config) => {
                    if let Err(error) = controller.apply_config(config) {
                        eprintln!("apply remote settings to gateway failed: {error}");
                    }
                }
                Err(error) => eprintln!("settings:remote-saved 事件反序列化失败: {error}"),
            },
            GatewayAction::ForwardWorkspaceActivity => {
                self.forward_workspace_activity(&controller, &payload);
            }
            // history 是少数几个必须把 payload 读回来的事件：Gateway 要把整个
            // summary 转成 sync 事件发给远端，重读数据库拿不到「刚才改的是哪一条」。
            GatewayAction::PublishHistoryUpsert => {
                match serde_json::from_value::<ChatHistorySummary>(payload) {
                    Ok(summary) => {
                        tokio::spawn(async move {
                            controller
                                .publish_history_sync(build_history_sync_upsert(&summary))
                                .await;
                        });
                    }
                    Err(error) => eprintln!("history upsert 事件反序列化失败: {error}"),
                }
            }
            GatewayAction::PublishHistoryDelete => {
                let Some(conversation_id) = payload.as_str().map(str::to_string) else {
                    eprintln!("history delete 事件 payload 不是字符串");
                    return;
                };
                tokio::spawn(async move {
                    controller
                        .publish_history_sync(build_history_sync_delete(conversation_id))
                        .await;
                });
            }
            GatewayAction::Ignore => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每条事件都必须落到一个非 Ignore 的分支上。
    ///
    /// 断言用的是 agent-core 导出的**常量本身**，不是字面量字符串——这样后端改了
    /// 事件名，这里跟着变，测试不会假绿。而如果后端**新增**一条 Gateway 该关心的
    /// 事件却忘了在 `action_for` 里接上，就会掉进 Ignore，被下面的断言抓住。
    #[test]
    fn every_event_gateway_cares_about_is_routed() {
        let expected = [
            (MANAGED_PROCESS_CHANGED_EVENT, GatewayAction::PublishManagedProcesses),
            (CRON_CHANGED_EVENT, GatewayAction::RefreshSettingsSync),
            (HOOKS_CHANGED_EVENT, GatewayAction::RefreshSettingsSync),
            (SETTINGS_REMOTE_SAVED_EVENT, GatewayAction::ApplyRemoteSettings),
            (WORKSPACE_ACTIVITY_EVENT, GatewayAction::ForwardWorkspaceActivity),
            (HISTORY_UPSERT_EVENT, GatewayAction::PublishHistoryUpsert),
            (HISTORY_DELETE_EVENT, GatewayAction::PublishHistoryDelete),
        ];

        for (event, action) in expected {
            assert_eq!(
                action_for(event),
                action,
                "事件 {event} 没有路由到预期动作——Gateway 会静默地收不到它"
            );
        }
    }

    /// 事件名之间不能互相碰撞：两条不同的事件落到同一个动作上（除了 cron/hooks
    /// 这对故意共享的）说明常量写重了。
    #[test]
    fn event_names_are_distinct() {
        let names = [
            MANAGED_PROCESS_CHANGED_EVENT,
            CRON_CHANGED_EVENT,
            HOOKS_CHANGED_EVENT,
            SETTINGS_REMOTE_SAVED_EVENT,
            WORKSPACE_ACTIVITY_EVENT,
            HISTORY_UPSERT_EVENT,
            HISTORY_DELETE_EVENT,
        ];
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "存在重复的事件名常量");
    }

    #[test]
    fn unknown_events_are_ignored_rather_than_panicking() {
        assert_eq!(action_for("terminal:output"), GatewayAction::Ignore);
        assert_eq!(action_for(""), GatewayAction::Ignore);
    }
}
