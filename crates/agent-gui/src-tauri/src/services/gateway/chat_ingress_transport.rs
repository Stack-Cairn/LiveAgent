use std::sync::Arc;

use prost::Message as _;
use uuid::Uuid;

use super::*;

const CHAT_INGRESS_NORMAL_RECORD_BYTES: usize = 32 * 1024;
const CHAT_INGRESS_FRAGMENT_BYTES: usize = 32 * 1024;
const CHAT_INGRESS_HARD_FRAME_BYTES: usize = 64 * 1024;
const CHAT_INGRESS_FLUSH_RECORDS: usize = 4_096;
const CHAT_INGRESS_FLUSH_BYTES: usize = 16 * 1024 * 1024;
const CHAT_INGRESS_BATCH_REQUEST_ID: &str =
    "chat-ingress-batch-00000000-0000-0000-0000-000000000000";
const CHAT_INGRESS_FRAGMENT_REQUEST_ID: &str =
    "chat-ingress-fragment-00000000-0000-0000-0000-000000000000";

impl GatewayController {
    pub async fn accept_chat_ingress_batch(
        self: &Arc<Self>,
        input: GatewayChatIngressBatchInput,
    ) -> Result<GatewayChatIngressAcceptResult, String> {
        let identity = self.chat_ingress_identity()?;
        let result = self.chat_ingress.accept_batch(identity, input).await?;
        self.spawn_chat_ingress_flush();
        Ok(result)
    }

    pub async fn commit_chat_checkpoint(
        self: &Arc<Self>,
        input: GatewayChatCheckpointInput,
    ) -> Result<GatewayChatCheckpointCommitResult, String> {
        let identity = self.chat_ingress_identity()?;
        let result = self.chat_ingress.commit_checkpoint(identity, input).await?;
        self.spawn_chat_ingress_flush();
        Ok(result)
    }

    pub(crate) async fn handle_chat_ingress_ack(
        self: &Arc<Self>,
        _request_id: String,
        ack: proto::ChatIngressAck,
    ) -> Result<(), String> {
        let identity = self.chat_ingress_identity()?;
        let action = proto::chat_ingress_ack::Action::try_from(ack.action)
            .unwrap_or(proto::chat_ingress_ack::Action::Unspecified);
        let should_flush = matches!(
            action,
            proto::chat_ingress_ack::Action::Continue
                | proto::chat_ingress_ack::Action::ReplayFromExpected
        );
        let acknowledge_result = self
            .chat_ingress
            .acknowledge(
                identity,
                ChatIngressAck {
                    run_id: ack.run_id,
                    committed_through: ack.committed_through,
                    expected_next: ack.expected_next,
                    action: match action {
                        proto::chat_ingress_ack::Action::SendCheckpoint => "checkpoint",
                        proto::chat_ingress_ack::Action::Rejected => "rejected",
                        proto::chat_ingress_ack::Action::ReplayFromExpected => "replay",
                        proto::chat_ingress_ack::Action::Continue => "continue",
                        proto::chat_ingress_ack::Action::Unspecified => "unspecified",
                    }
                    .to_string(),
                    terminal_committed: ack.terminal_committed,
                    error: [ack.error_code.trim(), ack.error_message.trim()]
                        .into_iter()
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                        .join(": "),
                },
            )
            .await;
        // An ack that no longer matches local journal state (run evicted by
        // terminal retention, journal reset) is not a transport fault; tearing
        // down the connection here would take terminals/tunnels/settings with
        // it and can loop forever on reconnect. Log and move on — replay and
        // checkpoint fallback repair the mirror on the next flush.
        if let Err(error) = acknowledge_result {
            eprintln!("gateway chat ingress ACK ignored: {error}");
            return Ok(());
        }
        if should_flush {
            self.spawn_chat_ingress_flush();
        }
        Ok(())
    }

    pub(crate) fn spawn_chat_ingress_flush(self: &Arc<Self>) {
        if !self.status().online {
            return;
        }
        let controller = Arc::clone(self);
        crate::compat::async_runtime::spawn(async move {
            if let Err(error) = controller.flush_chat_ingress().await {
                eprintln!("flush gateway chat ingress failed: {error}");
            }
        });
    }

    pub(crate) async fn reconcile_chat_ingress(self: &Arc<Self>) -> Result<(), String> {
        let identity = self.chat_ingress_identity()?;
        let runs = self.chat_ingress.resume(identity).await?;
        if !runs.is_empty() {
            self.send_agent_ingress_envelope(proto::AgentEnvelope {
                request_id: format!("chat-ingress-resume-{}", Uuid::new_v4()),
                timestamp: now_unix_seconds(),
                payload: Some(proto::agent_envelope::Payload::ChatIngressResume(
                    proto::ChatIngressResume {
                        runs: runs
                            .into_iter()
                            .map(|run| proto::ChatIngressRunResume {
                                run_id: run.run_id,
                                conversation_id: run.conversation_id,
                                replay_from_seq: run.replay_first_seq.unwrap_or(run.next_seq),
                                replay_through_seq: run
                                    .replay_last_seq
                                    .unwrap_or_else(|| run.next_seq.saturating_sub(1)),
                                next_seq: run.next_seq,
                                latest_checkpoint_seq: run.latest_checkpoint_seq.unwrap_or(0),
                                terminal_seq: run.terminal_seq.unwrap_or(0),
                                terminal_pending: run.terminal_pending,
                            })
                            .collect(),
                    },
                )),
            })
            .await?;
        }
        self.flush_chat_ingress().await
    }

    async fn flush_chat_ingress(self: &Arc<Self>) -> Result<(), String> {
        let _guard = self.chat_ingress_flush_lock.lock().await;
        if !self.status().online {
            return Ok(());
        }
        let identity = self.chat_ingress_identity()?;
        let records = self
            .chat_ingress
            .pending_records(
                identity,
                CHAT_INGRESS_FLUSH_RECORDS,
                CHAT_INGRESS_FLUSH_BYTES,
            )
            .await?;
        let mut batch_run = String::new();
        let mut batch_conversation = String::new();
        let mut batch_first_seq = 0_u64;
        let mut batch_records = Vec::new();

        for stored in records {
            let record = stored_record_to_proto(&stored);
            let encoded_len = record.encoded_len();
            let needs_fragment = encoded_len > CHAT_INGRESS_NORMAL_RECORD_BYTES;
            let discontinuous = !batch_records.is_empty()
                && (batch_run != stored.run_id
                    || batch_conversation != stored.conversation_id
                    || batch_first_seq + batch_records.len() as u64 != stored.seq);
            if discontinuous || needs_fragment {
                self.send_chat_ingress_proto_batch(
                    &batch_run,
                    &batch_conversation,
                    batch_first_seq,
                    std::mem::take(&mut batch_records),
                )
                .await?;
            }
            if needs_fragment {
                self.send_chat_ingress_fragments(&stored, record).await?;
                continue;
            }
            if batch_records.is_empty() {
                batch_run = stored.run_id.clone();
                batch_conversation = stored.conversation_id.clone();
                batch_first_seq = stored.seq;
            }
            batch_records.push(record);
            if chat_ingress_batch_wire_bytes(
                &batch_run,
                &batch_conversation,
                batch_first_seq,
                &batch_records,
            ) > CHAT_INGRESS_HARD_FRAME_BYTES
            {
                let record = batch_records
                    .pop()
                    .ok_or_else(|| "gateway chat ingress batch lost its last record".to_string())?;
                self.send_chat_ingress_proto_batch(
                    &batch_run,
                    &batch_conversation,
                    batch_first_seq,
                    std::mem::take(&mut batch_records),
                )
                .await?;
                batch_run = stored.run_id.clone();
                batch_conversation = stored.conversation_id.clone();
                batch_first_seq = stored.seq;
                if chat_ingress_batch_wire_bytes(
                    &batch_run,
                    &batch_conversation,
                    batch_first_seq,
                    std::slice::from_ref(&record),
                ) > CHAT_INGRESS_HARD_FRAME_BYTES
                {
                    self.send_chat_ingress_fragments(&stored, record).await?;
                } else {
                    batch_records.push(record);
                }
            }
        }
        self.send_chat_ingress_proto_batch(
            &batch_run,
            &batch_conversation,
            batch_first_seq,
            batch_records,
        )
        .await
    }

    async fn send_chat_ingress_proto_batch(
        &self,
        run_id: &str,
        conversation_id: &str,
        first_seq: u64,
        records: Vec<proto::ChatIngressRecord>,
    ) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }
        let envelope = proto::AgentEnvelope {
            request_id: format!("chat-ingress-batch-{}", Uuid::new_v4()),
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::ChatIngressBatch(
                proto::ChatIngressBatch {
                    run_id: run_id.to_string(),
                    conversation_id: conversation_id.to_string(),
                    first_seq,
                    records,
                },
            )),
        };
        ensure_chat_ingress_wire_limit("batch", &envelope)?;
        self.send_agent_ingress_envelope(envelope).await
    }

    async fn send_chat_ingress_fragments(
        &self,
        stored: &ChatIngressStoredRecord,
        record: proto::ChatIngressRecord,
    ) -> Result<(), String> {
        let encoded = record.encode_to_vec();
        let encoded_record_bytes = encoded.len() as u64;
        let sha256 = sha256_hex(&encoded);
        let chunk_bytes = chat_ingress_fragment_chunk_bytes(stored, encoded_record_bytes, &sha256)?;
        let chunks = encoded.chunks(chunk_bytes).collect::<Vec<_>>();
        let fragment_count = u32::try_from(chunks.len())
            .map_err(|_| "gateway chat ingress record has too many fragments".to_string())?;
        for (index, chunk) in chunks.into_iter().enumerate() {
            let envelope = chat_ingress_fragment_envelope(
                stored,
                u32::try_from(index).map_err(|_| "gateway chat ingress fragment index overflow")?,
                fragment_count,
                chunk.to_vec(),
                encoded_record_bytes,
                sha256.clone(),
                format!("chat-ingress-fragment-{}", Uuid::new_v4()),
                now_unix_seconds(),
            );
            ensure_chat_ingress_wire_limit("fragment", &envelope)?;
            self.send_agent_ingress_envelope(envelope).await?;
        }
        Ok(())
    }

    fn chat_ingress_identity(&self) -> Result<String, String> {
        let config = self.config_tx.borrow().clone();
        let agent_id = effective_agent_id(&config)?;
        if config.gateway_url.trim().is_empty() || config.token.trim().is_empty() {
            return Err("gateway chat ingress requires a configured gateway identity".to_string());
        }
        let token_hash = sha256_hex(config.token.trim().as_bytes());
        let material = format!(
            "{}|{}|{}|{}",
            config.gateway_url.trim().trim_end_matches('/'),
            config.gateway_port,
            agent_id,
            token_hash
        );
        Ok(sha256_hex(material.as_bytes()))
    }
}

fn chat_ingress_wire_bytes(envelope: &proto::AgentEnvelope) -> usize {
    proto::AgentClientFrame {
        payload: Some(proto::agent_client_frame::Payload::Envelope(
            envelope.clone(),
        )),
    }
    .encoded_len()
}

fn ensure_chat_ingress_wire_limit(
    kind: &str,
    envelope: &proto::AgentEnvelope,
) -> Result<(), String> {
    let wire_bytes = chat_ingress_wire_bytes(envelope);
    if wire_bytes > CHAT_INGRESS_HARD_FRAME_BYTES {
        return Err(format!(
            "gateway chat ingress {kind} frame is {wire_bytes} bytes, exceeding hard limit {CHAT_INGRESS_HARD_FRAME_BYTES}"
        ));
    }
    Ok(())
}

fn chat_ingress_batch_wire_bytes(
    run_id: &str,
    conversation_id: &str,
    first_seq: u64,
    records: &[proto::ChatIngressRecord],
) -> usize {
    chat_ingress_wire_bytes(&proto::AgentEnvelope {
        request_id: CHAT_INGRESS_BATCH_REQUEST_ID.to_string(),
        timestamp: i64::MIN,
        payload: Some(proto::agent_envelope::Payload::ChatIngressBatch(
            proto::ChatIngressBatch {
                run_id: run_id.to_string(),
                conversation_id: conversation_id.to_string(),
                first_seq,
                records: records.to_vec(),
            },
        )),
    })
}

fn chat_ingress_fragment_envelope(
    stored: &ChatIngressStoredRecord,
    fragment_index: u32,
    fragment_count: u32,
    encoded_record_chunk: Vec<u8>,
    encoded_record_bytes: u64,
    sha256: String,
    request_id: String,
    timestamp: i64,
) -> proto::AgentEnvelope {
    proto::AgentEnvelope {
        request_id,
        timestamp,
        payload: Some(proto::agent_envelope::Payload::ChatIngressFragment(
            proto::ChatIngressFragment {
                run_id: stored.run_id.clone(),
                conversation_id: stored.conversation_id.clone(),
                source_seq: stored.seq,
                fragment_index,
                fragment_count,
                encoded_record_chunk,
                encoded_record_bytes,
                sha256,
            },
        )),
    }
}

fn chat_ingress_fragment_chunk_bytes(
    stored: &ChatIngressStoredRecord,
    encoded_record_bytes: u64,
    sha256: &str,
) -> Result<usize, String> {
    let mut lower = 0_usize;
    let mut upper = CHAT_INGRESS_FRAGMENT_BYTES;
    while lower < upper {
        let candidate = lower + (upper - lower + 1) / 2;
        let envelope = chat_ingress_fragment_envelope(
            stored,
            u32::MAX,
            u32::MAX,
            vec![0; candidate],
            encoded_record_bytes,
            sha256.to_string(),
            CHAT_INGRESS_FRAGMENT_REQUEST_ID.to_string(),
            i64::MIN,
        );
        if chat_ingress_wire_bytes(&envelope) <= CHAT_INGRESS_HARD_FRAME_BYTES {
            lower = candidate;
        } else {
            upper = candidate - 1;
        }
    }
    if lower == 0 {
        return Err(
            "gateway chat ingress fragment metadata exceeds the hard frame limit".to_string(),
        );
    }
    Ok(lower)
}

fn stored_record_to_proto(stored: &ChatIngressStoredRecord) -> proto::ChatIngressRecord {
    let payload = match &stored.payload {
        ChatIngressRecordPayload::Delta {
            event_json,
            worker_id,
        } => proto::chat_ingress_record::Payload::Delta(proto::ChatIngressDelta {
            event_json: event_json.clone(),
            worker_id: worker_id.clone(),
        }),
        ChatIngressRecordPayload::Checkpoint {
            covers_through_seq,
            revision,
            compressed_projection,
            uncompressed_bytes,
            sha256,
            content_complete,
            history_required,
        } => proto::chat_ingress_record::Payload::Checkpoint(proto::ChatIngressCheckpoint {
            covers_through_seq: *covers_through_seq,
            revision: *revision,
            compressed_projection: compressed_projection.clone(),
            uncompressed_bytes: *uncompressed_bytes,
            sha256: sha256.clone(),
            content_complete: *content_complete,
            history_required: *history_required,
        }),
        ChatIngressRecordPayload::Terminal {
            covers_through_seq,
            revision,
            compressed_projection,
            uncompressed_bytes,
            sha256,
            content_complete,
            history_required,
            state,
            error_code,
            error_message,
        } => proto::chat_ingress_record::Payload::Terminal(proto::ChatIngressTerminal {
            covers_through_seq: *covers_through_seq,
            revision: *revision,
            compressed_projection: compressed_projection.clone(),
            uncompressed_bytes: *uncompressed_bytes,
            sha256: sha256.clone(),
            content_complete: *content_complete,
            history_required: *history_required,
            state: state.clone(),
            error_code: error_code.clone(),
            error_message: error_message.clone(),
        }),
        ChatIngressRecordPayload::Heartbeat { .. } => {
            proto::chat_ingress_record::Payload::Heartbeat(proto::ChatIngressHeartbeat {
                updated_at: now_unix_seconds().saturating_mul(1_000),
            })
        }
    };
    proto::ChatIngressRecord {
        payload: Some(payload),
    }
}

#[cfg(test)]
mod wire_limit_tests {
    use super::*;

    fn delta_record(event_bytes: usize) -> proto::ChatIngressRecord {
        proto::ChatIngressRecord {
            payload: Some(proto::chat_ingress_record::Payload::Delta(
                proto::ChatIngressDelta {
                    event_json: "x".repeat(event_bytes),
                    worker_id: "worker-1".to_string(),
                },
            )),
        }
    }

    fn stored_record(run_id: String, conversation_id: String) -> ChatIngressStoredRecord {
        ChatIngressStoredRecord {
            identity: "identity-1".to_string(),
            run_id,
            conversation_id,
            seq: 7,
            payload: ChatIngressRecordPayload::Heartbeat {
                worker_id: "worker-1".to_string(),
            },
        }
    }

    #[test]
    fn batch_wire_limit_includes_all_protobuf_wrappers() {
        let records = vec![delta_record(32_700), delta_record(32_700)];
        let record_bytes = records
            .iter()
            .map(|record| record.encoded_len())
            .sum::<usize>();

        assert!(record_bytes <= CHAT_INGRESS_HARD_FRAME_BYTES);
        assert!(
            chat_ingress_batch_wire_bytes("run-1", "conversation-1", 1, &records)
                > CHAT_INGRESS_HARD_FRAME_BYTES
        );
    }

    #[test]
    fn fragment_chunk_shrinks_to_keep_full_wire_frame_bounded() {
        let stored = stored_record("r".repeat(25_000), "c".repeat(25_000));
        let chunk_bytes = chat_ingress_fragment_chunk_bytes(&stored, 128 * 1024, &"a".repeat(64))
            .expect("fragment metadata should leave room for payload");

        assert!(chunk_bytes < CHAT_INGRESS_FRAGMENT_BYTES);
        let envelope = chat_ingress_fragment_envelope(
            &stored,
            u32::MAX,
            u32::MAX,
            vec![0; chunk_bytes],
            128 * 1024,
            "a".repeat(64),
            CHAT_INGRESS_FRAGMENT_REQUEST_ID.to_string(),
            i64::MIN,
        );
        assert!(chat_ingress_wire_bytes(&envelope) <= CHAT_INGRESS_HARD_FRAME_BYTES);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_record_carries_the_durable_projection() {
        let stored = ChatIngressStoredRecord {
            identity: "identity-a".to_string(),
            run_id: "run-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            seq: 9,
            payload: ChatIngressRecordPayload::Terminal {
                covers_through_seq: 8,
                revision: 4,
                compressed_projection: vec![1, 2, 3],
                uncompressed_bytes: 128,
                sha256: "abc".to_string(),
                content_complete: true,
                history_required: false,
                state: "failed".to_string(),
                error_code: "provider_error".to_string(),
                error_message: "upstream failed".to_string(),
            },
        };
        let record = stored_record_to_proto(&stored);
        let Some(proto::chat_ingress_record::Payload::Terminal(terminal)) = record.payload else {
            panic!("expected terminal record");
        };
        assert_eq!(terminal.covers_through_seq, 8);
        assert_eq!(terminal.revision, 4);
        assert_eq!(terminal.compressed_projection, vec![1, 2, 3]);
        assert_eq!(terminal.uncompressed_bytes, 128);
        assert_eq!(terminal.sha256, "abc");
        assert!(terminal.content_complete);
        assert_eq!(terminal.state, "failed");
        assert_eq!(terminal.error_code, "provider_error");
    }

    #[test]
    fn oversized_records_are_split_below_the_hard_frame_limit() {
        let record = proto::ChatIngressRecord {
            payload: Some(proto::chat_ingress_record::Payload::Delta(
                proto::ChatIngressDelta {
                    event_json: "x".repeat(CHAT_INGRESS_HARD_FRAME_BYTES * 2),
                    worker_id: "worker-1".to_string(),
                },
            )),
        };
        let encoded = record.encode_to_vec();
        let chunks = encoded
            .chunks(CHAT_INGRESS_FRAGMENT_BYTES)
            .collect::<Vec<_>>();
        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= CHAT_INGRESS_FRAGMENT_BYTES));
        assert!(CHAT_INGRESS_FRAGMENT_BYTES <= CHAT_INGRESS_HARD_FRAME_BYTES);
    }
}
