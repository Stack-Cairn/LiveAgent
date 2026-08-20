use std::time::{Duration, Instant};

use serde_json::json;
use tauri::Emitter;

use crate::services::chat_run_ledger::{ChatRunLedger, ChatRunLedgerState};

use super::*;

#[derive(Debug, Clone)]
pub(crate) struct RemoteChatInboxRecord {
    pub(crate) request: GatewayChatRequestEvent,
    pub(crate) state: String,
    pub(crate) lease_owner: Option<String>,
    pub(crate) lease_expires_at: Option<Instant>,
    pub(crate) attempt: u32,
    pub(crate) started: bool,
    pub(crate) last_error: Option<String>,
    pub(crate) created_at: Instant,
    pub(crate) updated_at: Instant,
}

// Last runtime status the webview reported, echoed to the gateway by a Rust
// timer while the webview's own heartbeat interval is throttled (hidden or
// occluded window).
#[derive(Debug, Clone)]
pub(crate) struct RuntimeStatusRepublishRecord {
    pub(crate) worker_id: String,
    pub(crate) state: String,
    pub(crate) visible: bool,
    pub(crate) active_run_count: u32,
    pub(crate) updated_at: Instant,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteChatEnqueueOutcome {
    pub(crate) request_id: String,
    pub(crate) conversation_id: String,
    pub(crate) control_type: &'static str,
    pub(crate) should_wake_runtime: bool,
    pub(crate) inserted: bool,
}

impl GatewayController {
    pub(crate) fn enqueue_remote_chat_request(
        &self,
        request: GatewayChatRequestEvent,
    ) -> Result<RemoteChatEnqueueOutcome, String> {
        let request_id = request.request_id.trim();
        if request_id.is_empty() {
            return Ok(RemoteChatEnqueueOutcome {
                request_id: String::new(),
                conversation_id: String::new(),
                control_type: "delivered",
                should_wake_runtime: false,
                inserted: false,
            });
        }
        let request_id = request_id.to_string();
        let client_request_id = request.client_request_id.trim().to_string();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;

        let existing_request_id = if inbox.contains_key(&request_id) {
            Some(request_id.clone())
        } else if client_request_id.is_empty() {
            None
        } else {
            inbox.iter().find_map(|(candidate_request_id, record)| {
                if record.request.client_request_id.trim() == client_request_id {
                    Some(candidate_request_id.clone())
                } else {
                    None
                }
            })
        };

        if let Some(existing_request_id) = existing_request_id {
            let now = Instant::now();
            let record = inbox
                .get_mut(&existing_request_id)
                .ok_or_else(|| "remote chat request disappeared while enqueueing".to_string())?;
            Self::merge_duplicate_remote_chat_request(record, request, now);
            return Ok(RemoteChatEnqueueOutcome {
                request_id: existing_request_id,
                conversation_id: record.request.conversation_id.clone(),
                control_type: Self::remote_chat_record_control_type(record),
                should_wake_runtime: Self::remote_chat_record_should_wake_runtime(record, now),
                inserted: false,
            });
        }

        let now = Instant::now();
        inbox.insert(
            request_id.clone(),
            RemoteChatInboxRecord {
                request,
                state: "queued".to_string(),
                lease_owner: None,
                lease_expires_at: None,
                attempt: 0,
                started: false,
                last_error: None,
                created_at: now,
                updated_at: now,
            },
        );
        let conversation_id = inbox
            .get(request_id.as_str())
            .map(|record| record.request.conversation_id.clone())
            .unwrap_or_default();
        Ok(RemoteChatEnqueueOutcome {
            request_id,
            conversation_id,
            control_type: "delivered",
            should_wake_runtime: true,
            inserted: true,
        })
    }

    pub(crate) fn remove_remote_chat_request(&self, request_id: &str) -> Result<(), String> {
        let request_id = request_id.trim();
        if request_id.is_empty() {
            return Ok(());
        }
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        inbox.remove(request_id);
        Ok(())
    }

    pub(crate) fn cancel_remote_chat_request(
        &self,
        request_id: &str,
        conversation_id: &str,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let conversation_id = conversation_id.trim();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        if !request_id.is_empty() {
            inbox.remove(request_id);
        }
        if !conversation_id.is_empty() {
            inbox.retain(|_, record| {
                record.request.conversation_id.trim() != conversation_id
                    || !Self::remote_chat_record_should_cancel_for_conversation(record)
            });
        }
        Ok(())
    }

    pub(crate) fn merge_duplicate_remote_chat_request(
        record: &mut RemoteChatInboxRecord,
        request: GatewayChatRequestEvent,
        now: Instant,
    ) {
        // A reconnect can replay the same gateway request while the JS runner is
        // already processing it. Preserve local lease/owner/started state and
        // only fill metadata that may have been absent in the original payload.
        if !record.started && record.state.trim() == "queued" {
            let canonical_request_id = record.request.request_id.clone();
            record.request = request;
            record.request.request_id = canonical_request_id;
            record.updated_at = now;
            return;
        }
        if record.request.client_request_id.trim().is_empty()
            && !request.client_request_id.trim().is_empty()
        {
            record.request.client_request_id = request.client_request_id.clone();
        }
        if record.request.conversation_id.trim().is_empty()
            && !request.conversation_id.trim().is_empty()
        {
            record.request.conversation_id = request.conversation_id.clone();
        }
        record.updated_at = now;
    }

    pub(crate) fn remote_chat_record_control_type(record: &RemoteChatInboxRecord) -> &'static str {
        if record.started {
            return "started";
        }
        match record.state.trim() {
            "claimed" => "claimed",
            "starting" => "starting",
            "queued_in_gui" => "queued_in_gui",
            "running" => "started",
            "failed" => "failed",
            "cancelled" => "cancelled",
            "completed" => "completed",
            _ => "delivered",
        }
    }

    pub(crate) fn remote_chat_record_should_wake_runtime(
        record: &RemoteChatInboxRecord,
        now: Instant,
    ) -> bool {
        if record.started {
            return false;
        }
        match record.state.trim() {
            "queued" | "delivered" => true,
            "claimed" | "starting" => record
                .lease_expires_at
                .map(|expires_at| now >= expires_at)
                .unwrap_or(true),
            _ => false,
        }
    }

    pub(crate) fn remote_chat_record_should_cancel_for_conversation(
        record: &RemoteChatInboxRecord,
    ) -> bool {
        if record.started {
            return true;
        }
        matches!(record.state.trim(), "claimed" | "starting" | "running")
    }

    pub(crate) fn remote_chat_record_has_current_lease(
        record: &RemoteChatInboxRecord,
        worker_id: &str,
        now: Instant,
    ) -> bool {
        if worker_id.trim().is_empty() {
            return false;
        }
        if record.lease_owner.as_deref() != Some(worker_id) {
            return false;
        }
        record
            .lease_expires_at
            .map(|expires_at| now < expires_at)
            .unwrap_or(false)
    }

    pub(crate) fn remote_chat_record_is_owned_by_worker(
        record: &RemoteChatInboxRecord,
        worker_id: &str,
    ) -> bool {
        !worker_id.trim().is_empty() && record.lease_owner.as_deref() == Some(worker_id)
    }

    pub(crate) fn remote_chat_record_lease_ms(record: &RemoteChatInboxRecord) -> u64 {
        if record.started {
            GATEWAY_CHAT_RUNNING_LEASE_MS
        } else {
            GATEWAY_CHAT_LEASE_MS
        }
    }

    pub async fn claim_next_chat_request(
        &self,
        worker_id: String,
        lease_ms: Option<u64>,
    ) -> Result<Option<GatewayChatClaimedRequest>, String> {
        let worker_id = worker_id.trim().to_string();
        if worker_id.is_empty() {
            return Err("worker_id is required".to_string());
        }
        let lease_ms = lease_ms
            .unwrap_or(GATEWAY_CHAT_LEASE_MS)
            .clamp(1_000, 120_000);
        let now = Instant::now();
        let claimed = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let mut selected_request_id: Option<String> = None;
            let mut selected_created_at: Option<Instant> = None;
            for (request_id, record) in inbox.iter() {
                let state = record.state.trim();
                let lease_expired = record
                    .lease_expires_at
                    .map(|expires_at| now >= expires_at)
                    .unwrap_or(true);
                if (state == "queued"
                    || ((state == "claimed" || state == "starting")
                        && lease_expired
                        && !record.started))
                    && selected_created_at
                        .map(|created_at| record.created_at < created_at)
                        .unwrap_or(true)
                {
                    selected_request_id = Some(request_id.clone());
                    selected_created_at = Some(record.created_at);
                }
            }
            selected_request_id.and_then(|request_id| {
                inbox.get_mut(&request_id).map(|record| {
                    record.state = "claimed".to_string();
                    record.lease_owner = Some(worker_id.clone());
                    record.lease_expires_at = Some(now + Duration::from_millis(lease_ms));
                    record.attempt = record.attempt.saturating_add(1);
                    record.updated_at = now;
                    GatewayChatClaimedRequest {
                        request_id: record.request.request_id.clone(),
                        client_request_id: record.request.client_request_id.clone(),
                        conversation_id: record.request.conversation_id.clone(),
                        state: record.state.clone(),
                        attempt: record.attempt,
                        lease_ms,
                        request: record.request.clone(),
                    }
                })
            })
        };
        if let Some(claimed) = claimed.as_ref() {
            self.send_gateway_chat_control_event(
                claimed.request_id.clone(),
                claimed.conversation_id.clone(),
                "claimed",
            )
            .await?;
        }
        Ok(claimed)
    }

    pub async fn mark_chat_request_started(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let now = Instant::now();
            let record = inbox
                .get_mut(&request_id)
                .ok_or_else(|| "remote chat request lease is no longer active".to_string())?;
            let queued_in_gui = record.state.trim() == "queued_in_gui" && !record.started;
            if !queued_in_gui
                && !Self::remote_chat_record_has_current_lease(record, &worker_id, now)
            {
                return Err("remote chat request lease is no longer active".to_string());
            }
            if record.started {
                return Ok(());
            }
            record.state = "running".to_string();
            record.started = true;
            record.lease_owner = Some(worker_id);
            if !conversation_id.is_empty() {
                record.request.conversation_id = conversation_id.clone();
            }
            record.lease_expires_at =
                Some(now + Duration::from_millis(GATEWAY_CHAT_RUNNING_LEASE_MS));
            record.updated_at = now;
        }
        self.ledger_mark_run_running(&request_id, &conversation_id)?;
        self.send_gateway_chat_control_event(request_id, conversation_id, "started")
            .await
    }

    pub async fn mark_local_chat_run_started(
        &self,
        request_id: String,
        conversation_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        if request_id.is_empty() || conversation_id.is_empty() {
            return Ok(());
        }
        self.ledger_mark_run_running(&request_id, &conversation_id)?;
        self.send_gateway_chat_control_event(request_id, conversation_id, "started")
            .await
    }

    pub async fn mark_local_chat_run_cancelled(
        &self,
        request_id: String,
        conversation_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        if request_id.is_empty() || conversation_id.is_empty() {
            return Ok(());
        }
        if !self.ledger_mark_run_terminal(
            &request_id,
            &conversation_id,
            ChatRunLedgerState::Cancelled,
            "",
            "",
        )? {
            return Ok(());
        }
        Ok(())
    }

    pub async fn mark_chat_request_queued_in_gui(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let should_send = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let Some(record) = inbox.get_mut(&request_id) else {
                return Ok(());
            };
            if record.started {
                return Ok(());
            }
            if !Self::remote_chat_record_is_owned_by_worker(record, &worker_id) {
                return Ok(());
            }
            record.state = "queued_in_gui".to_string();
            record.lease_owner = None;
            record.lease_expires_at = None;
            if !conversation_id.is_empty() {
                record.request.conversation_id = conversation_id.clone();
            }
            record.updated_at = Instant::now();
            true
        };
        if !should_send {
            return Ok(());
        }
        self.send_gateway_chat_control_event(request_id, conversation_id, "queued_in_gui")
            .await
    }

    pub async fn complete_chat_request(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let should_finish = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let Some(record) = inbox.get(&request_id) else {
                return Ok(());
            };
            if !Self::remote_chat_record_is_owned_by_worker(record, &worker_id) {
                return Ok(());
            }
            inbox.remove(&request_id);
            true
        };
        if !should_finish {
            return Ok(());
        }
        self.ledger_mark_run_terminal(
            &request_id,
            &conversation_id,
            ChatRunLedgerState::Completed,
            "",
            "",
        )?;
        Ok(())
    }

    pub async fn fail_chat_request(
        &self,
        request_id: String,
        conversation_id: Option<String>,
        error_code: String,
        message: String,
        terminal: bool,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let conversation_id = conversation_id.unwrap_or_default();
        // None: inbox record already gone; Some(true): accepted; Some(false): rejected.
        let inbox_outcome = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            match inbox.get_mut(&request_id) {
                None => None,
                Some(record) => {
                    let queued_in_gui = terminal && record.state.trim() == "queued_in_gui";
                    if !queued_in_gui
                        && !Self::remote_chat_record_is_owned_by_worker(record, &worker_id)
                    {
                        Some(false)
                    } else {
                        record.state = if terminal { "failed" } else { "queued" }.to_string();
                        record.lease_owner = None;
                        record.lease_expires_at = None;
                        record.last_error = Some(message.clone());
                        record.updated_at = Instant::now();
                        if terminal {
                            inbox.remove(&request_id);
                        }
                        Some(true)
                    }
                }
            }
        };
        match inbox_outcome {
            Some(false) => return Ok(()),
            Some(true) => {}
            None => {
                // The inbox record can be gone while the run is still live in
                // the diagnostic ledger (for example, a complete/fail race).
                if !terminal || !self.ledger_has_live_run(&request_id)? {
                    return Ok(());
                }
            }
        }
        if terminal {
            self.ledger_mark_run_terminal(
                &request_id,
                &conversation_id,
                ChatRunLedgerState::Failed,
                &error_code,
                &message,
            )?;
        }
        Ok(())
    }

    pub async fn cancel_chat_request(
        &self,
        request_id: String,
        conversation_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim().to_string();
        let conversation_id = conversation_id.trim().to_string();
        let worker_id = worker_id.trim().to_string();
        let should_cancel = {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let Some(record) = inbox.get(&request_id) else {
                return Ok(());
            };
            let queued_in_gui = record.state.trim() == "queued_in_gui";
            if !queued_in_gui && !Self::remote_chat_record_is_owned_by_worker(record, &worker_id) {
                return Ok(());
            }
            inbox.remove(&request_id);
            true
        };
        if !should_cancel {
            return Ok(());
        }
        self.ledger_mark_run_terminal(
            &request_id,
            &conversation_id,
            ChatRunLedgerState::Cancelled,
            "",
            "",
        )?;
        Ok(())
    }

    pub fn heartbeat_chat_request(
        &self,
        request_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let worker_id = worker_id.trim();
        if request_id.is_empty() || worker_id.is_empty() {
            return Ok(());
        }
        {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            if let Some(record) = inbox.get_mut(request_id) {
                if record.lease_owner.as_deref() == Some(worker_id) {
                    let lease_ms = Self::remote_chat_record_lease_ms(record);
                    record.lease_expires_at =
                        Some(Instant::now() + Duration::from_millis(lease_ms));
                    record.updated_at = Instant::now();
                }
            }
        }
        self.ledger_touch_run(request_id, "")
    }

    pub async fn publish_chat_runtime_status(
        &self,
        worker_id: String,
        state: String,
        visible: bool,
        active_run_count: u32,
    ) -> Result<(), String> {
        let worker_id = worker_id.trim().to_string();
        if worker_id.is_empty() {
            return Ok(());
        }
        let state = match state.trim() {
            "draining" => "draining",
            "busy" => "busy",
            "suspended" => "suspended",
            _ => "ready",
        }
        .to_string();
        self.record_runtime_status_for_republish(&worker_id, &state, visible, active_run_count)?;
        self.send_chat_runtime_status_envelope(worker_id, state, visible, active_run_count)
            .await
    }

    // The republish record's age is stamped only here — by the webview's own
    // publishes — so the Rust echo stops for a webview that vanished without
    // saying "suspended" instead of impersonating it forever.
    fn record_runtime_status_for_republish(
        &self,
        worker_id: &str,
        state: &str,
        visible: bool,
        active_run_count: u32,
    ) -> Result<(), String> {
        let mut slot = self
            .runtime_status_republish
            .lock()
            .map_err(|_| "gateway runtime status republish lock poisoned".to_string())?;
        *slot = Self::next_runtime_status_republish_record(
            worker_id,
            state,
            visible,
            active_run_count,
            Instant::now(),
        );
        Ok(())
    }

    pub(crate) fn next_runtime_status_republish_record(
        worker_id: &str,
        state: &str,
        visible: bool,
        active_run_count: u32,
        now: Instant,
    ) -> Option<RuntimeStatusRepublishRecord> {
        if state == "suspended" {
            return None;
        }
        Some(RuntimeStatusRepublishRecord {
            worker_id: worker_id.to_string(),
            state: state.to_string(),
            visible,
            active_run_count,
            updated_at: now,
        })
    }

    pub(crate) fn runtime_status_republish_payload(
        record: Option<&RuntimeStatusRepublishRecord>,
        now: Instant,
    ) -> Option<(String, String, bool, u32)> {
        let record = record?;
        if now.saturating_duration_since(record.updated_at)
            > GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE
        {
            return None;
        }
        Some((
            record.worker_id.clone(),
            record.state.clone(),
            record.visible,
            record.active_run_count,
        ))
    }

    pub(crate) fn runtime_status_republish_snapshot(&self) -> Option<(String, String, bool, u32)> {
        let slot = self.runtime_status_republish.lock().ok()?;
        Self::runtime_status_republish_payload(slot.as_ref(), Instant::now())
    }

    pub(crate) async fn send_chat_runtime_status_envelope(
        &self,
        worker_id: String,
        state: String,
        visible: bool,
        active_run_count: u32,
    ) -> Result<(), String> {
        let (active_reports, finished_reports) = {
            let (now, _now_ms) = chat_run_ledger_now();
            let ledger = self
                .chat_run_ledger
                .lock()
                .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
            (ledger.active_reports(now), ledger.recent_terminal_reports())
        };
        let active_run_count =
            active_run_count.max(u32::try_from(active_reports.len()).unwrap_or(u32::MAX));
        let envelope = build_gateway_runtime_status_envelope(
            worker_id,
            state,
            visible,
            active_run_count,
            active_reports
                .iter()
                .map(chat_run_report_from_entry)
                .collect(),
            finished_reports
                .iter()
                .map(chat_run_report_from_entry)
                .collect(),
        );
        match self.send_agent_envelope(envelope).await {
            Ok(()) => Ok(()),
            Err(error) if error.contains("outbound stream is offline") => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn release_chat_request_lease(
        &self,
        request_id: String,
        worker_id: String,
    ) -> Result<(), String> {
        let request_id = request_id.trim();
        let worker_id = worker_id.trim();
        let mut inbox = self
            .remote_chat_inbox
            .lock()
            .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
        if let Some(record) = inbox.get_mut(request_id) {
            if record.lease_owner.as_deref() == Some(worker_id) && !record.started {
                record.state = "queued".to_string();
                record.lease_owner = None;
                record.lease_expires_at = None;
                record.updated_at = Instant::now();
            }
        }
        Ok(())
    }

    pub(crate) async fn expire_remote_chat_leases(&self) -> Result<(), String> {
        let mut failed: Vec<(String, String)> = Vec::new();
        let mut wake = false;
        {
            let mut inbox = self
                .remote_chat_inbox
                .lock()
                .map_err(|_| "gateway remote chat inbox lock poisoned".to_string())?;
            let now = Instant::now();
            for record in inbox.values_mut() {
                let Some(expires_at) = record.lease_expires_at else {
                    continue;
                };
                if now < expires_at {
                    continue;
                }
                if record.started {
                    record.state = "failed".to_string();
                    failed.push((
                        record.request.request_id.clone(),
                        record.request.conversation_id.clone(),
                    ));
                    continue;
                }
                record.state = "queued".to_string();
                record.lease_owner = None;
                record.lease_expires_at = None;
                record.updated_at = now;
                wake = true;
            }
            for (request_id, _) in &failed {
                inbox.remove(request_id);
            }
        }
        if wake {
            let _ = self.app_handle.emit(
                "gateway:chat-request-ready",
                json!({ "reason": "lease_expired" }),
            );
        }
        for (request_id, conversation_id) in failed {
            self.ledger_mark_run_terminal(
                &request_id,
                &conversation_id,
                ChatRunLedgerState::Failed,
                "desktop_runtime_lease_expired",
                "Desktop chat runtime stopped before completing the remote request.",
            )?;
        }
        Ok(())
    }

    pub(crate) fn with_chat_run_ledger<T>(
        &self,
        f: impl FnOnce(&mut ChatRunLedger) -> T,
    ) -> Result<T, String> {
        let mut ledger = self
            .chat_run_ledger
            .lock()
            .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
        Ok(f(&mut ledger))
    }

    pub(crate) fn ledger_mark_run_running(
        &self,
        run_id: &str,
        conversation_id: &str,
    ) -> Result<(), String> {
        let (now, now_ms) = chat_run_ledger_now();
        self.with_chat_run_ledger(|ledger| {
            ledger.mark_running(run_id, conversation_id, now, now_ms);
        })
    }

    pub(crate) fn ledger_touch_run(
        &self,
        run_id: &str,
        conversation_id: &str,
    ) -> Result<(), String> {
        let (now, now_ms) = chat_run_ledger_now();
        self.with_chat_run_ledger(|ledger| ledger.touch(run_id, conversation_id, now, now_ms))
    }

    pub(crate) fn ledger_mark_run_terminal(
        &self,
        run_id: &str,
        conversation_id: &str,
        state: ChatRunLedgerState,
        error_code: &str,
        message: &str,
    ) -> Result<bool, String> {
        let (now, now_ms) = chat_run_ledger_now();
        self.with_chat_run_ledger(|ledger| {
            ledger.mark_terminal(
                run_id,
                conversation_id,
                state,
                error_code,
                message,
                now,
                now_ms,
            )
        })
    }

    pub(crate) fn ledger_has_live_run(&self, run_id: &str) -> Result<bool, String> {
        self.with_chat_run_ledger(|ledger| {
            ledger
                .get(run_id)
                .map(|entry| !entry.state.is_terminal())
                .unwrap_or(false)
        })
    }

    // A record that is stale relative to the webview's 2s heartbeat cadence
    // but still within the republish max age means the webview is alive yet
    // throttled (hidden/occluded window): its DOM timers — including the 60s
    // run-snapshot keepalive that normally refreshes the ledger through long
    // silent tool calls — are not firing, so an untouched ledger entry proves
    // nothing about the run. Beyond the max age the webview is treated as gone
    // and the normal TTL judgment resumes, keeping diagnostic liveness useful
    // without manufacturing a remote terminal.
    pub(super) fn webview_status_report_stalled_but_alive_at(
        record: Option<&RuntimeStatusRepublishRecord>,
        now: Instant,
    ) -> bool {
        let Some(record) = record else {
            return false;
        };
        if record.active_run_count == 0 {
            return false;
        }
        let age = now.saturating_duration_since(record.updated_at);
        age > GATEWAY_WEBVIEW_REPORT_FRESH_WINDOW && age <= GATEWAY_RUNTIME_STATUS_REPUBLISH_MAX_AGE
    }

    fn webview_status_report_stalled_but_alive(&self) -> bool {
        let Ok(slot) = self.runtime_status_republish.lock() else {
            return false;
        };
        Self::webview_status_report_stalled_but_alive_at(slot.as_ref(), Instant::now())
    }

    // Periodic diagnostic-ledger sweep. Terminal delivery lives in the chat
    // ingress journal; this only refreshes/expires ledger entries.
    pub(crate) fn sweep_chat_run_ledger(&self) -> Result<(), String> {
        if !self.status().online {
            return Ok(());
        }
        let webview_stalled_but_alive = self.webview_status_report_stalled_but_alive();
        {
            let (now, now_ms) = chat_run_ledger_now();
            let mut ledger = self
                .chat_run_ledger
                .lock()
                .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
            // While the webview is merely throttled its keepalive cannot vouch
            // for long-silent runs; stand in for it so the sweep below (and the
            // gateway's active_runs reconcile fed by active_reports) never
            // declares a live run desktop_run_lost during a stall.
            if webview_stalled_but_alive {
                ledger.refresh_running(now, now_ms);
            }
            ledger.sweep(now, now_ms);
        }
        Ok(())
    }

    pub(crate) async fn republish_chat_run_states(&self) -> Result<(), String> {
        let active = {
            let (now, _now_ms) = chat_run_ledger_now();
            let ledger = self
                .chat_run_ledger
                .lock()
                .map_err(|_| "gateway chat run ledger lock poisoned".to_string())?;
            ledger.active_reports(now)
        };
        for entry in active {
            if entry.conversation_id.is_empty() {
                continue;
            }
            // "started" is idempotent on the gateway; replaying it re-anchors
            // runs the gateway may have lost across a restart.
            if let Err(error) = self
                .send_gateway_chat_control_event(
                    entry.run_id.clone(),
                    entry.conversation_id.clone(),
                    "started",
                )
                .await
            {
                eprintln!(
                    "republish gateway chat run {} failed: {error}",
                    entry.run_id
                );
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}
