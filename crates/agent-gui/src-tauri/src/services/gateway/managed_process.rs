//! ManagedProcess snapshot publication (agent -> gateway) and
//! webui-originated panel request handling (gateway -> agent).

use std::sync::Arc;

use agent_core::runtime::managed_process::{
    ManagedProcessRecord, ManagedProcessRegistry, ManagedProcessSnapshot,
};

use super::*;

fn to_proto_record(record: &ManagedProcessRecord) -> proto::ManagedProcessRecord {
    proto::ManagedProcessRecord {
        id: record.id.clone(),
        label: record.label.clone().unwrap_or_default(),
        command: record.command.clone(),
        cwd: record.cwd.clone(),
        shell: record.shell.clone(),
        pid: record.pid,
        log_path: record.log_path.clone(),
        started_at: record.started_at as i64,
        finished_at: record.finished_at.map(|value| value as i64),
        exit_code: record.exit_code,
        running: record.running,
        isolated: record.isolated,
        restored: record.restored,
    }
}

pub(crate) fn build_managed_process_snapshot_proto(
    snapshot: &ManagedProcessSnapshot,
) -> proto::ManagedProcessSnapshot {
    proto::ManagedProcessSnapshot {
        processes: snapshot.processes.iter().map(to_proto_record).collect(),
        revision: snapshot.revision,
    }
}

/// Registry calls block on process polling/signalling; keep them off the
/// async runtime.
async fn run_registry_task<T: Send + 'static>(
    registry: Arc<ManagedProcessRegistry>,
    task: impl FnOnce(&ManagedProcessRegistry) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(move || task(&registry))
        .await
        .map_err(|error| format!("managed process task failed: {error}"))?
}

impl GatewayController {
    pub async fn publish_managed_process_snapshot(
        &self,
        snapshot: ManagedProcessSnapshot,
    ) -> Result<(), String> {
        if !self.status().online {
            return Ok(());
        }
        let envelope = proto::AgentEnvelope {
            request_id: format!("managed-process-{}", uuid::Uuid::new_v4()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::ManagedProcessSnapshot(
                build_managed_process_snapshot_proto(&snapshot),
            )),
        };
        self.send_agent_envelope(envelope).await
    }

    pub(crate) async fn publish_current_managed_processes(&self) -> Result<(), String> {
        let registry = Arc::clone(&self.managed_process_registry);
        let snapshot = run_registry_task(registry, |registry| registry.snapshot()).await?;
        self.publish_managed_process_snapshot(snapshot).await
    }

    pub(crate) async fn handle_managed_process_request(
        &self,
        request: proto::ManagedProcessRequest,
    ) -> Result<proto::ManagedProcessResponse, String> {
        let registry = Arc::clone(&self.managed_process_registry);
        let action = request.action.trim().to_lowercase();
        match action.as_str() {
            "snapshot" => {
                let snapshot = run_registry_task(registry, |registry| registry.snapshot()).await?;
                Ok(proto::ManagedProcessResponse {
                    action,
                    snapshot: Some(build_managed_process_snapshot_proto(&snapshot)),
                    ..Default::default()
                })
            }
            "stop" => {
                let process_id = request.process_id.clone();
                let (stopped, snapshot) = run_registry_task(registry, move |registry| {
                    let response = registry.stop(process_id)?;
                    Ok((response.stopped, registry.snapshot()?))
                })
                .await?;
                Ok(proto::ManagedProcessResponse {
                    action,
                    stopped,
                    snapshot: Some(build_managed_process_snapshot_proto(&snapshot)),
                    ..Default::default()
                })
            }
            "read_log" => {
                let process_id = request.process_id.clone();
                let max_bytes = (request.max_bytes > 0).then_some(request.max_bytes as u64);
                let log = run_registry_task(registry, move |registry| {
                    registry.read_log(process_id, max_bytes)
                })
                .await?;
                Ok(proto::ManagedProcessResponse {
                    action,
                    log_content: log.content,
                    log_path: log.log_path,
                    log_truncated: log.truncated,
                    ..Default::default()
                })
            }
            "clear" => {
                let process_id = request.process_id.trim().to_string();
                let process_id = (!process_id.is_empty()).then_some(process_id);
                let snapshot =
                    run_registry_task(registry, move |registry| registry.clear(process_id)).await?;
                Ok(proto::ManagedProcessResponse {
                    action,
                    snapshot: Some(build_managed_process_snapshot_proto(&snapshot)),
                    ..Default::default()
                })
            }
            other => Err(format!("unsupported managed process action: {other}")),
        }
    }
}
