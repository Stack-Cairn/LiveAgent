use std::collections::HashMap;
use std::sync::MutexGuard;

use crate::runtime::project_path::project_path_keys_equal;

use super::*;

impl TerminalSessionRegistry {
    pub fn ssh_terminal_tabs_list(
        &self,
        project_path_key: String,
    ) -> Result<SshTerminalTabsSnapshot, String> {
        let project_key = required_project_key(project_path_key)?;
        let (snapshot, should_broadcast) = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            if let Some(snapshot) = self.prune_invalid_ssh_terminal_tabs_for_project(&project_key) {
                (snapshot, true)
            } else {
                (self.ssh_terminal_tabs_snapshot(&project_key), false)
            }
        };
        if should_broadcast {
            self.broadcast_ssh_tabs_snapshot(snapshot.clone());
        }
        Ok(snapshot)
    }

    pub fn ssh_terminal_tab_open(
        &self,
        session_id: String,
        kind: String,
    ) -> Result<SshTerminalTabsSnapshot, String> {
        let kind = normalize_ssh_terminal_tab_kind(&kind)?;
        let (snapshot, should_broadcast) = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            let session = self.valid_ssh_terminal_tab_session(&session_id, &kind)?;
            let tab_id = ssh_terminal_tab_id(&session.id, &kind);
            let now = now_ms();
            let mut tabs_by_project = self
                .ssh_terminal_tabs
                .lock()
                .map_err(|_| "ssh terminal tabs registry poisoned".to_string())?;
            let state = tabs_by_project
                .entry(session.project_path_key.clone())
                .or_default();
            if state.tabs.iter().any(|tab| tab.id == tab_id) {
                return Ok(ssh_terminal_tabs_snapshot_from_state(
                    &session.project_path_key,
                    state,
                ));
            } else {
                state.tabs.push(SshTerminalTabRecord {
                    id: tab_id.clone(),
                    session_id: session.id.clone(),
                    project_path_key: session.project_path_key.clone(),
                    kind,
                    created_at: now,
                    updated_at: now,
                });
            }
            state.revision = state.revision.saturating_add(1);
            (
                ssh_terminal_tabs_snapshot_from_state(&session.project_path_key, state),
                true,
            )
        };
        if should_broadcast {
            self.broadcast_ssh_tabs_snapshot(snapshot.clone());
        }
        Ok(snapshot)
    }

    pub fn ssh_terminal_tab_close(
        &self,
        tab_id: String,
    ) -> Result<SshTerminalTabsSnapshot, String> {
        let tab_id = tab_id.trim();
        if tab_id.is_empty() {
            return Err("tab_id is required".to_string());
        }
        let snapshot = {
            let _tabs_tx = self.lock_ssh_terminal_tabs_tx()?;
            let mut tabs_by_project = self
                .ssh_terminal_tabs
                .lock()
                .map_err(|_| "ssh terminal tabs registry poisoned".to_string())?;
            let Some(project_key) = tabs_by_project.iter().find_map(|(project_key, state)| {
                state
                    .tabs
                    .iter()
                    .any(|tab| tab.id == tab_id)
                    .then(|| project_key.clone())
            }) else {
                return Err(format!("ssh terminal tab not found: {tab_id}"));
            };
            let state = tabs_by_project
                .get_mut(&project_key)
                .ok_or_else(|| format!("ssh terminal tab not found: {tab_id}"))?;
            let Some(index) = state.tabs.iter().position(|tab| tab.id == tab_id) else {
                return Err(format!("ssh terminal tab not found: {tab_id}"));
            };
            state.tabs.remove(index);
            state.revision = state.revision.saturating_add(1);
            ssh_terminal_tabs_snapshot_from_state(&project_key, state)
        };
        self.broadcast_ssh_tabs_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    pub(crate) fn lock_ssh_terminal_tabs_tx(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.ssh_terminal_tabs_tx
            .lock()
            .map_err(|_| "ssh terminal tabs transaction lock poisoned".to_string())
    }

    pub(crate) fn valid_ssh_terminal_tab_session(
        &self,
        session_id: &str,
        kind: &str,
    ) -> Result<TerminalSessionRecord, String> {
        let session = self.record(session_id.trim().to_string())?;
        if session.kind.trim() != "ssh" {
            return Err("terminal session is not an SSH connection".to_string());
        }
        let ssh = session
            .ssh
            .as_ref()
            .ok_or_else(|| "SSH session metadata is missing".to_string())?;
        if ssh.status == SSH_STATUS_DISCONNECTED {
            return Err("SSH connection is disconnected".to_string());
        }
        if kind == "sftp" && !ssh.sftp_enabled {
            return Err("SFTP is not enabled for this SSH session".to_string());
        }
        Ok(session)
    }

    pub(crate) fn ssh_terminal_tabs_snapshot(
        &self,
        project_path_key: &str,
    ) -> SshTerminalTabsSnapshot {
        self.ssh_terminal_tabs
            .lock()
            .ok()
            .and_then(|tabs_by_project| {
                tabs_by_project
                    .get(project_path_key)
                    .map(|state| ssh_terminal_tabs_snapshot_from_state(project_path_key, state))
            })
            .unwrap_or_else(|| SshTerminalTabsSnapshot {
                project_path_key: project_path_key.to_string(),
                tabs: Vec::new(),
                revision: 0,
            })
    }

    pub(crate) fn prune_invalid_ssh_terminal_tabs_for_project(
        &self,
        project_path_key: &str,
    ) -> Option<SshTerminalTabsSnapshot> {
        let valid_sessions = self
            .sessions
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|entry| entry.record.lock().ok().map(|record| record.clone()))
                    .filter(|record| {
                        project_path_keys_equal(&record.project_path_key, project_path_key)
                            && record.kind.trim() == "ssh"
                            && record
                                .ssh
                                .as_ref()
                                .map(|ssh| ssh.status != SSH_STATUS_DISCONNECTED)
                                .unwrap_or(false)
                    })
                    .map(|record| {
                        (
                            record.id,
                            record.ssh.map(|ssh| ssh.sftp_enabled).unwrap_or(false),
                        )
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        let mut tabs_by_project = self.ssh_terminal_tabs.lock().ok()?;
        let state = tabs_by_project.get_mut(project_path_key)?;
        let before_len = state.tabs.len();
        state.tabs.retain(|tab| {
            valid_sessions
                .get(&tab.session_id)
                .map(|sftp_enabled| tab.kind != "sftp" || *sftp_enabled)
                .unwrap_or(false)
        });
        if state.tabs.len() == before_len {
            return None;
        }
        state.revision = state.revision.saturating_add(1);
        Some(ssh_terminal_tabs_snapshot_from_state(
            project_path_key,
            state,
        ))
    }

    pub(crate) fn prune_ssh_terminal_tabs_for_session_locked(
        &self,
        session_id: &str,
    ) -> Vec<SshTerminalTabsSnapshot> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Vec::new();
        }
        let mut tabs_by_project = match self.ssh_terminal_tabs.lock() {
            Ok(tabs_by_project) => tabs_by_project,
            Err(_) => return Vec::new(),
        };
        let mut snapshots = Vec::new();
        for (project_key, state) in tabs_by_project.iter_mut() {
            let before_len = state.tabs.len();
            state.tabs.retain(|tab| tab.session_id != session_id);
            if state.tabs.len() == before_len {
                continue;
            }
            state.revision = state.revision.saturating_add(1);
            snapshots.push(ssh_terminal_tabs_snapshot_from_state(project_key, state));
        }
        snapshots
    }
}
