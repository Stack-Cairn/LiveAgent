use std::sync::Arc;

use super::*;

impl TerminalSessionRegistry {
    pub(crate) fn broadcast(
        &self,
        kind: &str,
        entry: &Arc<TerminalSessionEntry>,
        data: Option<Vec<u8>>,
        output_start_offset: Option<u64>,
        output_end_offset: Option<u64>,
    ) {
        let Ok(record) = entry.record.lock().map(|record| record.clone()) else {
            return;
        };
        let payload = TerminalEventPayload {
            kind: kind.to_string(),
            session_id: record.id.clone(),
            project_path_key: record.project_path_key.clone(),
            session: Some(record),
            data,
            output_start_offset,
            output_end_offset,
            ssh_tabs: None,
            ssh_local_forward: None,
        };

        if let Ok(events) = self.events.lock() {
            if let Some(events) = events.as_ref() {
                events.emit(TERMINAL_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = TerminalEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }

    pub(crate) fn broadcast_output(
        &self,
        entry: &Arc<TerminalSessionEntry>,
        bytes: Vec<u8>,
        start_offset: u64,
        end_offset: u64,
    ) {
        let Ok(record) = entry.record.lock().map(|record| record.clone()) else {
            return;
        };
        let payload = TerminalStreamEventPayload {
            kind: "output".to_string(),
            session_id: record.id,
            project_path_key: record.project_path_key,
            start_offset,
            end_offset,
            bytes,
        };

        let dispatch = self.dispatch_terminal_stream_payload(payload);
        self.broadcast_terminal_stream_subscribers(&dispatch.remote);
        self.emit_terminal_stream_local(&dispatch.local);
    }

    pub(crate) fn dispatch_terminal_stream_payload(
        &self,
        payload: TerminalStreamEventPayload,
    ) -> TerminalOutputDispatch {
        let Ok(mut states) = self.echo_dispatch.lock() else {
            return TerminalOutputDispatch {
                local: vec![payload.clone()],
                remote: vec![payload],
            };
        };
        let session_id = payload.session_id.clone();
        let dispatch = {
            let Some(state) = states.get_mut(&session_id) else {
                return TerminalOutputDispatch {
                    local: vec![payload.clone()],
                    remote: vec![payload],
                };
            };
            state.dispatch(payload)
        };
        if states
            .get(&session_id)
            .is_some_and(TerminalEchoDispatchState::is_empty)
        {
            states.remove(&session_id);
        }
        dispatch
    }

    pub(crate) fn emit_terminal_stream_local(&self, payloads: &[TerminalStreamEventPayload]) {
        if payloads.is_empty() {
            return;
        }
        if let Ok(events) = self.events.lock() {
            if let Some(events) = events.as_ref() {
                for payload in payloads {
                    events.emit(TERMINAL_STREAM_EVENT_NAME, payload);
                }
            }
        }
    }

    pub(crate) fn broadcast_terminal_stream_subscribers(
        &self,
        payloads: &[TerminalStreamEventPayload],
    ) {
        if payloads.is_empty() {
            return;
        }
        let subscribers = self
            .stream_subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for payload in payloads {
            let event = TerminalStreamEvent {
                payload: payload.clone(),
            };
            for subscriber in &subscribers {
                let _ = subscriber.send(event.clone());
            }
        }
    }

    pub(crate) fn broadcast_ssh_tabs_snapshot(&self, snapshot: SshTerminalTabsSnapshot) {
        let payload = TerminalEventPayload {
            kind: "ssh_tabs_updated".to_string(),
            session_id: String::new(),
            project_path_key: snapshot.project_path_key.clone(),
            session: None,
            data: None,
            output_start_offset: None,
            output_end_offset: None,
            ssh_tabs: Some(snapshot),
            ssh_local_forward: None,
        };

        if let Ok(events) = self.events.lock() {
            if let Some(events) = events.as_ref() {
                events.emit(TERMINAL_EVENT_NAME, &payload);
            }
        }

        let subscribers = self
            .subscribers
            .lock()
            .map(|subscribers| subscribers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let event = TerminalEvent { payload };
        for subscriber in subscribers {
            let _ = subscriber.send(event.clone());
        }
    }
}
