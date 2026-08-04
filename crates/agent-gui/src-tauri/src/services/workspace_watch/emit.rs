//! 工作区活动事件的出口。
//!
//! 只负责组装 payload 并投给事件总线。谁想要这些事件——桌面 webview、Gateway、
//! 将来的 HTTP 后端——各自注册 sink，与本文件无关。
//!
//! best-effort：丢一条事件由下一次变更自愈，绝不阻塞 watcher 线程。

use serde::Serialize;

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

        self.events.emit(WORKSPACE_ACTIVITY_EVENT, payload);
    }
}
