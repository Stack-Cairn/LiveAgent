//! Dual emit sinks for workspace activity: the local webview event is
//! unconditional; the gateway envelope goes out only for workdirs the gateway
//! declared interest in, and only best-effort (never blocking a watcher
//! thread — a dropped event is healed by the next change).

use serde::Serialize;
use tauri::Emitter;

use crate::services::gateway::{now_unix_seconds, proto};

use super::{WorkspaceWatchService, WORKSPACE_ACTIVITY_EVENT};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActivityPayload {
    pub workdir: String,
    pub revision: u64,
    pub fs: bool,
    pub git: bool,
    pub changed_paths: Vec<String>,
    pub truncated: bool,
}

impl WorkspaceWatchService {
    pub(crate) fn emit_activity(
        &self,
        workdir: &str,
        fs: bool,
        git: bool,
        changed_paths: Vec<String>,
        truncated: bool,
    ) {
        if !fs && !git {
            return;
        }
        let payload = WorkspaceActivityPayload {
            workdir: workdir.to_string(),
            revision: self.next_revision(workdir),
            fs,
            git,
            changed_paths,
            truncated,
        };

        // 代码索引失效 sink：内部只入队（绝不阻塞 watcher 线程），未启用索引
        // 的 workdir 一次 stat 即返回。git-only 事件不触发（索引只关心工作树）。
        if fs {
            crate::services::code_index::global_code_index_service().notify_workspace_activity(
                workdir,
                &payload.changed_paths,
                payload.truncated,
            );
        }

        if let Err(error) = self
            .app_handle
            .emit(WORKSPACE_ACTIVITY_EVENT, payload.clone())
        {
            eprintln!("emit workspace activity failed: {error}");
        }

        if !self.workdir_in_gateway_set(workdir) {
            return;
        }
        let Some(controller) = self.current_gateway() else {
            return;
        };
        let Ok(sender) = controller.current_outbound_sender() else {
            return;
        };
        let _ = sender.try_send(proto::AgentEnvelope {
            request_id: format!("workspace-activity-{}", uuid::Uuid::new_v4()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::WorkspaceActivity(
                proto::WorkspaceActivityEvent {
                    workdir: payload.workdir,
                    revision: payload.revision,
                    fs: payload.fs,
                    git: payload.git,
                    changed_paths: payload.changed_paths,
                    truncated: payload.truncated,
                },
            )),
        });
    }
}
