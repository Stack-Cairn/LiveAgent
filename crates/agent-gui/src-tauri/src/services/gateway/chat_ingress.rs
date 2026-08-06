use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::{now_unix_seconds, GATEWAY_CHAT_CHECKPOINT_REQUESTED_EVENT};
use crate::events::EventEmitter;
use crate::events::EventEmitterExt;

const CHAT_INGRESS_DB_FILENAME: &str = "gateway-chat-sync.sqlite3";
const CHAT_INGRESS_DB_SCHEMA_VERSION: i64 = 2;
const CHAT_INGRESS_BUSY_TIMEOUT: Duration = Duration::from_secs(30);
const CHAT_INGRESS_MAX_JOURNAL_BYTES: u64 = 256 * 1024 * 1024;
const CHAT_INGRESS_MAX_BATCH_RECORDS: usize = 64;
const CHAT_INGRESS_MAX_BATCH_BYTES: usize = 64 * 1024;
const CHAT_INGRESS_MAX_RECORD_BYTES: usize = 64 * 1024;
const CHAT_INGRESS_MAX_PROJECTION_BYTES: usize = 64 * 1024 * 1024;
const CHAT_INGRESS_RUN_RING_RECORDS: usize = 4_096;
const CHAT_INGRESS_RUN_RING_BYTES: usize = 2 * 1024 * 1024;
const CHAT_INGRESS_GLOBAL_RING_BYTES: usize = 16 * 1024 * 1024;
const CHAT_INGRESS_TERMINAL_ACK_RETENTION_SECONDS: i64 = 10 * 60;
const CHAT_INGRESS_TERMINAL_ACK_CAP: usize = 32;
const CHAT_INGRESS_RUNNING_CHECKPOINT_RETENTION_SECONDS: i64 = 60 * 60;
const CHAT_INGRESS_CHECKPOINT_COMPRESSION_LEVEL: i32 = 3;
const CHAT_INGRESS_ACTOR_QUEUE_COMMANDS: usize = 64;
const CHAT_INGRESS_ACTOR_QUEUE_BYTES: usize = 96 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatIngressBatchInput {
    pub run_id: String,
    pub conversation_id: String,
    #[serde(default)]
    pub records: Vec<GatewayChatIngressDeltaInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatIngressDeltaInput {
    pub event_json: String,
    #[serde(default)]
    pub worker_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatCheckpointInput {
    pub run_id: String,
    pub conversation_id: String,
    pub entries_json: String,
    pub revision: u64,
    #[serde(default = "default_checkpoint_kind")]
    pub kind: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub error_code: String,
    #[serde(default)]
    pub error_message: String,
    #[serde(default)]
    pub content_complete: bool,
    #[serde(default)]
    pub history_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatIngressAcceptResult {
    pub first_seq: u64,
    pub last_seq: u64,
    pub locally_accepted: bool,
    pub journal_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatCheckpointCommitResult {
    pub source_seq: u64,
    pub durably_persisted: bool,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub sha256: String,
    pub journal_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayChatCheckpointRequestedEvent {
    pub run_id: String,
    pub conversation_id: String,
    pub reason: String,
    pub expected_next_seq: u64,
    pub delta_records: usize,
    pub delta_bytes: usize,
    pub journal_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) enum ChatIngressRecordPayload {
    Delta {
        event_json: String,
        worker_id: String,
    },
    Checkpoint {
        covers_through_seq: u64,
        revision: u64,
        compressed_projection: Vec<u8>,
        uncompressed_bytes: u64,
        sha256: String,
        content_complete: bool,
        history_required: bool,
    },
    Terminal {
        covers_through_seq: u64,
        revision: u64,
        compressed_projection: Vec<u8>,
        uncompressed_bytes: u64,
        sha256: String,
        content_complete: bool,
        history_required: bool,
        state: String,
        error_code: String,
        error_message: String,
    },
    Heartbeat {
        worker_id: String,
    },
}

fn default_checkpoint_kind() -> String {
    "checkpoint".to_string()
}

#[derive(Debug, Clone)]
pub(crate) struct ChatIngressStoredRecord {
    pub identity: String,
    pub run_id: String,
    pub conversation_id: String,
    pub seq: u64,
    pub payload: ChatIngressRecordPayload,
}

#[derive(Debug, Clone)]
pub(crate) struct ChatIngressResumeRun {
    pub run_id: String,
    pub conversation_id: String,
    pub next_seq: u64,
    pub replay_first_seq: Option<u64>,
    pub replay_last_seq: Option<u64>,
    pub latest_checkpoint_seq: Option<u64>,
    pub terminal_seq: Option<u64>,
    pub terminal_pending: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ChatIngressAck {
    pub run_id: String,
    pub committed_through: u64,
    pub expected_next: u64,
    pub action: String,
    pub terminal_committed: bool,
    pub error: String,
}

#[derive(Clone)]
pub(crate) struct ChatIngressMirror {
    tx: std_mpsc::SyncSender<QueuedChatIngressCommand>,
    queued_bytes: Arc<AtomicUsize>,
}

struct QueuedChatIngressCommand {
    command: ChatIngressCommand,
    reserved_bytes: usize,
}

enum ChatIngressCommand {
    AcceptBatch {
        identity: String,
        input: GatewayChatIngressBatchInput,
        reply: oneshot::Sender<Result<GatewayChatIngressAcceptResult, String>>,
    },
    CommitCheckpoint {
        identity: String,
        input: GatewayChatCheckpointInput,
        reply: oneshot::Sender<Result<GatewayChatCheckpointCommitResult, String>>,
    },
    PendingRecords {
        identity: String,
        limit_records: usize,
        limit_bytes: usize,
        reply: oneshot::Sender<Result<Vec<ChatIngressStoredRecord>, String>>,
    },
    Resume {
        identity: String,
        reply: oneshot::Sender<Result<Vec<ChatIngressResumeRun>, String>>,
    },
    Ack {
        identity: String,
        ack: ChatIngressAck,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

impl ChatIngressMirror {
    pub(crate) fn spawn(event_emitter: Arc<dyn EventEmitter>) -> Self {
        let (tx, rx) = std_mpsc::sync_channel(CHAT_INGRESS_ACTOR_QUEUE_COMMANDS);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let actor_queued_bytes = Arc::clone(&queued_bytes);
        thread::Builder::new()
            .name("gateway-chat-ingress".to_string())
            .spawn(move || run_actor(event_emitter, rx, actor_queued_bytes))
            .expect("spawn gateway chat ingress actor");
        Self { tx, queued_bytes }
    }

    fn enqueue(&self, command: ChatIngressCommand) -> Result<(), String> {
        let reserved_bytes = command.estimated_bytes();
        reserve_actor_queue_bytes(&self.queued_bytes, reserved_bytes)?;
        match self.tx.try_send(QueuedChatIngressCommand {
            command,
            reserved_bytes,
        }) {
            Ok(()) => Ok(()),
            Err(std_mpsc::TrySendError::Full(_)) => {
                self.queued_bytes
                    .fetch_sub(reserved_bytes, Ordering::AcqRel);
                Err("gateway chat ingress actor queue is full".to_string())
            }
            Err(std_mpsc::TrySendError::Disconnected(_)) => {
                self.queued_bytes
                    .fetch_sub(reserved_bytes, Ordering::AcqRel);
                Err("gateway chat ingress actor stopped".to_string())
            }
        }
    }

    pub(crate) async fn accept_batch(
        &self,
        identity: String,
        input: GatewayChatIngressBatchInput,
    ) -> Result<GatewayChatIngressAcceptResult, String> {
        let (reply, rx) = oneshot::channel();
        self.enqueue(ChatIngressCommand::AcceptBatch {
            identity,
            input,
            reply,
        })?;
        rx.await
            .map_err(|_| "gateway chat ingress actor dropped batch reply".to_string())?
    }

    pub(crate) async fn commit_checkpoint(
        &self,
        identity: String,
        input: GatewayChatCheckpointInput,
    ) -> Result<GatewayChatCheckpointCommitResult, String> {
        let (reply, rx) = oneshot::channel();
        self.enqueue(ChatIngressCommand::CommitCheckpoint {
            identity,
            input,
            reply,
        })?;
        rx.await
            .map_err(|_| "gateway chat ingress actor dropped checkpoint reply".to_string())?
    }

    pub(crate) async fn pending_records(
        &self,
        identity: String,
        limit_records: usize,
        limit_bytes: usize,
    ) -> Result<Vec<ChatIngressStoredRecord>, String> {
        let (reply, rx) = oneshot::channel();
        self.enqueue(ChatIngressCommand::PendingRecords {
            identity,
            limit_records,
            limit_bytes,
            reply,
        })?;
        rx.await
            .map_err(|_| "gateway chat ingress actor dropped pending reply".to_string())?
    }

    pub(crate) async fn resume(
        &self,
        identity: String,
    ) -> Result<Vec<ChatIngressResumeRun>, String> {
        let (reply, rx) = oneshot::channel();
        self.enqueue(ChatIngressCommand::Resume { identity, reply })?;
        rx.await
            .map_err(|_| "gateway chat ingress actor dropped resume reply".to_string())?
    }

    pub(crate) async fn acknowledge(
        &self,
        identity: String,
        ack: ChatIngressAck,
    ) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.enqueue(ChatIngressCommand::Ack {
            identity,
            ack,
            reply,
        })?;
        rx.await
            .map_err(|_| "gateway chat ingress actor dropped ACK reply".to_string())?
    }
}

impl ChatIngressCommand {
    fn estimated_bytes(&self) -> usize {
        match self {
            Self::AcceptBatch {
                identity, input, ..
            } => input.records.iter().fold(
                identity
                    .len()
                    .saturating_add(input.run_id.len())
                    .saturating_add(input.conversation_id.len())
                    .saturating_add(256),
                |bytes, record| {
                    bytes
                        .saturating_add(record.event_json.len())
                        .saturating_add(record.worker_id.as_deref().unwrap_or_default().len())
                        .saturating_add(32)
                },
            ),
            Self::CommitCheckpoint {
                identity, input, ..
            } => identity
                .len()
                .saturating_add(input.run_id.len())
                .saturating_add(input.conversation_id.len())
                .saturating_add(input.entries_json.len())
                .saturating_add(input.kind.len())
                .saturating_add(input.state.len())
                .saturating_add(input.error_code.len())
                .saturating_add(input.error_message.len())
                .saturating_add(512),
            Self::PendingRecords { identity, .. } | Self::Resume { identity, .. } => {
                identity.len().saturating_add(128)
            }
            Self::Ack { identity, ack, .. } => identity
                .len()
                .saturating_add(ack.run_id.len())
                .saturating_add(ack.action.len())
                .saturating_add(ack.error.len())
                .saturating_add(256),
        }
    }
}

fn reserve_actor_queue_bytes(queued_bytes: &AtomicUsize, bytes: usize) -> Result<(), String> {
    let mut current = queued_bytes.load(Ordering::Acquire);
    loop {
        let next = current
            .checked_add(bytes)
            .ok_or_else(|| "gateway chat ingress actor queue byte size overflow".to_string())?;
        if next > CHAT_INGRESS_ACTOR_QUEUE_BYTES {
            return Err(format!(
                "gateway chat ingress actor queue exceeds its {} MiB byte limit",
                CHAT_INGRESS_ACTOR_QUEUE_BYTES / 1024 / 1024
            ));
        }
        match queued_bytes.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => return Ok(()),
            Err(observed) => current = observed,
        }
    }
}

struct ChatIngressActor {
    journal: Result<ChatIngressJournal, String>,
    rings: HashMap<(String, String), RunDeltaRing>,
    global_ring_bytes: usize,
    event_emitter: Option<Arc<dyn EventEmitter>>,
}

#[derive(Default)]
struct RunDeltaRing {
    conversation_id: String,
    deltas: VecDeque<RingDelta>,
    bytes: usize,
    checkpoint_requested: bool,
}

struct RingDelta {
    record: ChatIngressStoredRecord,
    bytes: usize,
}

fn run_actor(
    event_emitter: Arc<dyn EventEmitter>,
    rx: std_mpsc::Receiver<QueuedChatIngressCommand>,
    queued_bytes: Arc<AtomicUsize>,
) {
    let journal = chat_ingress_db_path().and_then(ChatIngressJournal::open);
    let mut actor = ChatIngressActor {
        journal,
        rings: HashMap::new(),
        global_ring_bytes: 0,
        event_emitter: Some(event_emitter),
    };
    while let Ok(queued) = rx.recv() {
        actor.handle(queued.command);
        queued_bytes.fetch_sub(queued.reserved_bytes, Ordering::AcqRel);
    }
}

impl ChatIngressActor {
    fn handle(&mut self, command: ChatIngressCommand) {
        match command {
            ChatIngressCommand::AcceptBatch {
                identity,
                input,
                reply,
            } => {
                let _ = reply.send(self.accept_batch(identity, input));
            }
            ChatIngressCommand::CommitCheckpoint {
                identity,
                input,
                reply,
            } => {
                let _ = reply.send(self.commit_checkpoint(identity, input));
            }
            ChatIngressCommand::PendingRecords {
                identity,
                limit_records,
                limit_bytes,
                reply,
            } => {
                let result = self.pending_records(&identity, limit_records, limit_bytes);
                let _ = reply.send(result);
            }
            ChatIngressCommand::Resume { identity, reply } => {
                let result = self.resume(&identity);
                let _ = reply.send(result);
            }
            ChatIngressCommand::Ack {
                identity,
                ack,
                reply,
            } => {
                let result = self.acknowledge(&identity, ack);
                let _ = reply.send(result);
            }
        }
    }

    fn accept_batch(
        &mut self,
        identity: String,
        input: GatewayChatIngressBatchInput,
    ) -> Result<GatewayChatIngressAcceptResult, String> {
        validate_identity_and_run(&identity, &input.run_id, &input.conversation_id)?;
        if input.records.is_empty() {
            return Err("gateway chat ingress batch records are required".to_string());
        }
        if input.records.len() > CHAT_INGRESS_MAX_BATCH_RECORDS {
            return Err(format!(
                "gateway chat ingress batch exceeds {CHAT_INGRESS_MAX_BATCH_RECORDS} records"
            ));
        }
        let batch_bytes = validate_delta_batch(&input)?;
        let key = (identity.clone(), input.run_id.clone());
        let (run_records, run_bytes) = self
            .rings
            .get(&key)
            .map(|ring| (ring.deltas.len(), ring.bytes))
            .unwrap_or_default();
        if run_records.saturating_add(input.records.len()) > CHAT_INGRESS_RUN_RING_RECORDS
            || run_bytes.saturating_add(batch_bytes) > CHAT_INGRESS_RUN_RING_BYTES
            || self.global_ring_bytes.saturating_add(batch_bytes) > CHAT_INGRESS_GLOBAL_RING_BYTES
        {
            let expected = self
                .journal
                .as_mut()
                .map_err(|error| error.clone())?
                .ensure_and_next_seq(&identity, &input.run_id, &input.conversation_id)?;
            self.emit_checkpoint_request(
                &identity,
                &input.run_id,
                &input.conversation_id,
                "replay_window_hard_limit",
                expected,
                0,
            );
            return Err(
                "gateway chat ingress replay window is full; checkpoint required".to_string(),
            );
        }
        let journal = self.journal.as_mut().map_err(|error| error.clone())?;
        let (first_seq, next_expected_seq, journal_bytes) = journal.allocate_delta_range(
            &identity,
            &input.run_id,
            &input.conversation_id,
            input.records.len(),
        )?;
        let records = build_batch_records(&identity, &input, first_seq)?;
        for record in records {
            let bytes = match &record.payload {
                ChatIngressRecordPayload::Delta { event_json, .. } => event_json.len(),
                _ => 0,
            };
            self.push_ring_delta(record, bytes);
        }
        let high_water = self
            .rings
            .get(&key)
            .map(|ring| {
                ring.deltas.len() >= CHAT_INGRESS_RUN_RING_RECORDS / 2
                    || ring.bytes >= CHAT_INGRESS_RUN_RING_BYTES / 2
            })
            .unwrap_or(false)
            || self.global_ring_bytes >= CHAT_INGRESS_GLOBAL_RING_BYTES / 2;
        let should_request = if high_water {
            self.rings
                .get_mut(&key)
                .map(|ring| {
                    if ring.checkpoint_requested {
                        false
                    } else {
                        ring.checkpoint_requested = true;
                        true
                    }
                })
                .unwrap_or(false)
        } else {
            false
        };
        if should_request {
            self.emit_checkpoint_request(
                &identity,
                &input.run_id,
                &input.conversation_id,
                "replay_window_high_water",
                next_expected_seq,
                journal_bytes,
            );
        }
        Ok(GatewayChatIngressAcceptResult {
            first_seq,
            last_seq: next_expected_seq.saturating_sub(1),
            locally_accepted: true,
            journal_bytes,
        })
    }

    fn commit_checkpoint(
        &mut self,
        identity: String,
        mut input: GatewayChatCheckpointInput,
    ) -> Result<GatewayChatCheckpointCommitResult, String> {
        validate_identity_and_run(&identity, &input.run_id, &input.conversation_id)?;
        let kind = input.kind.trim().to_string();
        if !matches!(kind.as_str(), "checkpoint" | "terminal") {
            return Err("gateway chat checkpoint kind must be checkpoint or terminal".to_string());
        }
        if kind == "terminal" && !matches!(input.state.trim(), "completed" | "failed" | "cancelled")
        {
            return Err(
                "gateway chat terminal state must be completed, failed, or cancelled".to_string(),
            );
        }
        if input.entries_json.is_empty() {
            return Err("gateway chat checkpoint entries_json is required".to_string());
        }
        if input.entries_json.len() > CHAT_INGRESS_MAX_PROJECTION_BYTES {
            if kind == "terminal" {
                input.entries_json = "[]".to_string();
                input.content_complete = false;
                input.history_required = true;
            } else {
                return Err(format!(
                    "gateway chat checkpoint projection exceeds {} MiB",
                    CHAT_INGRESS_MAX_PROJECTION_BYTES / 1024 / 1024
                ));
            }
        }
        let projection = serde_json::from_str::<serde_json::Value>(&input.entries_json)
            .map_err(|error| format!("gateway chat checkpoint entries_json is invalid: {error}"))?;
        if !projection.is_array() {
            return Err("gateway chat checkpoint entries_json must be a JSON array".to_string());
        }
        let uncompressed = input.entries_json.as_bytes();
        let uncompressed_bytes = u64::try_from(uncompressed.len())
            .map_err(|_| "gateway chat checkpoint is too large".to_string())?;
        let sha256 = sha256_hex(uncompressed);
        let compressed_projection =
            zstd::bulk::compress(uncompressed, CHAT_INGRESS_CHECKPOINT_COMPRESSION_LEVEL)
                .map_err(|error| format!("compress gateway chat checkpoint failed: {error}"))?;
        let compressed_bytes = u64::try_from(compressed_projection.len())
            .map_err(|_| "compressed gateway chat checkpoint is too large".to_string())?;
        let mut protected_runs = self.rings.keys().cloned().collect::<HashSet<_>>();
        protected_runs.insert((identity.clone(), input.run_id.clone()));
        let journal = self.journal.as_mut().map_err(|error| error.clone())?;
        journal.cleanup_inactive_running_checkpoints(&protected_runs)?;
        if let Some(existing) = journal.existing_terminal(&identity, &input.run_id)? {
            let ChatIngressRecordPayload::Terminal {
                revision,
                compressed_projection,
                uncompressed_bytes,
                sha256: existing_sha256,
                content_complete,
                history_required,
                state,
                error_code,
                error_message,
                ..
            } = existing.payload
            else {
                unreachable!("existing_terminal only returns terminal records");
            };
            if kind == "terminal"
                && revision == input.revision
                && existing_sha256 == sha256
                && content_complete == input.content_complete
                && history_required == input.history_required
                && state == input.state.trim()
                && error_code == input.error_code.trim()
                && error_message == input.error_message.trim()
            {
                return Ok(GatewayChatCheckpointCommitResult {
                    source_seq: existing.seq,
                    durably_persisted: true,
                    compressed_bytes: compressed_projection.len() as u64,
                    uncompressed_bytes,
                    sha256: existing_sha256,
                    journal_bytes: journal.stored_bytes()?,
                });
            }
            return Err(format!(
                "gateway chat ingress run {} already has a terminal checkpoint",
                input.run_id
            ));
        }
        let source_seq =
            journal.ensure_and_next_seq(&identity, &input.run_id, &input.conversation_id)?;
        let covers_through_seq = source_seq.saturating_sub(1);
        let payload = if kind == "terminal" {
            ChatIngressRecordPayload::Terminal {
                covers_through_seq,
                revision: input.revision,
                compressed_projection,
                uncompressed_bytes,
                sha256: sha256.clone(),
                content_complete: input.content_complete,
                history_required: input.history_required,
                state: input.state.trim().to_string(),
                error_code: input.error_code.trim().to_string(),
                error_message: input.error_message.trim().to_string(),
            }
        } else {
            ChatIngressRecordPayload::Checkpoint {
                covers_through_seq,
                revision: input.revision,
                compressed_projection,
                uncompressed_bytes,
                sha256: sha256.clone(),
                content_complete: input.content_complete,
                history_required: input.history_required,
            }
        };
        let record = ChatIngressStoredRecord {
            identity: identity.clone(),
            run_id: input.run_id.clone(),
            conversation_id: input.conversation_id.clone(),
            seq: source_seq,
            payload,
        };
        let accepted = journal.commit_checkpoint(&identity, &input, record)?;
        self.prune_ring(&identity, &input.run_id, covers_through_seq);
        if let Some(ring) = self.rings.get_mut(&(identity, input.run_id.clone())) {
            ring.checkpoint_requested = false;
        }
        Ok(GatewayChatCheckpointCommitResult {
            source_seq: accepted.accepted_through,
            durably_persisted: true,
            compressed_bytes,
            uncompressed_bytes,
            sha256,
            journal_bytes: accepted.journal_bytes,
        })
    }

    fn acknowledge(&mut self, identity: &str, ack: ChatIngressAck) -> Result<(), String> {
        let run_id = ack.run_id.trim();
        if identity.trim().is_empty() || run_id.is_empty() {
            return Err("gateway chat ingress ACK identity and run_id are required".to_string());
        }
        if !ack.error.trim().is_empty() {
            self.emit_checkpoint_request(
                identity,
                run_id,
                "",
                "gateway_error",
                ack.expected_next,
                0,
            );
        }
        if ack.action.trim() == "checkpoint" {
            self.emit_checkpoint_request(
                identity,
                run_id,
                "",
                "gateway_requested",
                ack.expected_next,
                0,
            );
        }
        // The gateway has committed through this sequence: ring records at or
        // below it are redundant regardless of journal state, so prune before
        // the journal write — a stale ack for a journal-evicted run must not
        // leave its ring entries pinned against the global budget.
        self.prune_ring(identity, run_id, ack.committed_through);
        self.journal
            .as_mut()
            .map_err(|error| error.clone())?
            .acknowledge(identity, &ack)?;
        Ok(())
    }

    fn pending_records(
        &self,
        identity: &str,
        limit_records: usize,
        limit_bytes: usize,
    ) -> Result<Vec<ChatIngressStoredRecord>, String> {
        let mut records = self
            .journal
            .as_ref()
            .map_err(Clone::clone)?
            .pending_records(identity, limit_records, limit_bytes)?;
        for ((ring_identity, _), ring) in &self.rings {
            if ring_identity != identity {
                continue;
            }
            records.extend(ring.deltas.iter().map(|delta| delta.record.clone()));
        }
        records.sort_by(|left, right| {
            left.run_id
                .cmp(&right.run_id)
                .then_with(|| left.seq.cmp(&right.seq))
        });
        let mut output = Vec::new();
        let mut bytes = 0_usize;
        for record in records {
            let record_bytes =
                usize::try_from(record_stored_bytes(&record.payload)).unwrap_or(usize::MAX);
            if !output.is_empty()
                && (output.len() >= limit_records
                    || bytes.saturating_add(record_bytes) > limit_bytes)
            {
                break;
            }
            bytes = bytes.saturating_add(record_bytes);
            output.push(record);
        }
        Ok(output)
    }

    fn resume(&self, identity: &str) -> Result<Vec<ChatIngressResumeRun>, String> {
        let mut runs = self
            .journal
            .as_ref()
            .map_err(Clone::clone)?
            .resume(identity)?
            .into_iter()
            .map(|run| (run.run_id.clone(), run))
            .collect::<HashMap<_, _>>();
        for ((ring_identity, run_id), ring) in &self.rings {
            if ring_identity != identity || ring.deltas.is_empty() {
                continue;
            }
            let first = ring.deltas.front().map(|delta| delta.record.seq);
            let last = ring.deltas.back().map(|delta| delta.record.seq);
            let entry = runs
                .entry(run_id.clone())
                .or_insert_with(|| ChatIngressResumeRun {
                    run_id: run_id.clone(),
                    conversation_id: ring.conversation_id.clone(),
                    next_seq: last.unwrap_or(0).saturating_add(1),
                    replay_first_seq: None,
                    replay_last_seq: None,
                    latest_checkpoint_seq: None,
                    terminal_seq: None,
                    terminal_pending: false,
                });
            entry.replay_first_seq = match (entry.replay_first_seq, first) {
                (Some(left), Some(right)) => Some(left.min(right)),
                (None, value) | (value, None) => value,
            };
            entry.replay_last_seq = match (entry.replay_last_seq, last) {
                (Some(left), Some(right)) => Some(left.max(right)),
                (None, value) | (value, None) => value,
            };
        }
        let mut output = runs.into_values().collect::<Vec<_>>();
        output.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        Ok(output)
    }

    fn push_ring_delta(&mut self, record: ChatIngressStoredRecord, bytes: usize) {
        let key = (record.identity.clone(), record.run_id.clone());
        let ring = self.rings.entry(key).or_default();
        ring.conversation_id = record.conversation_id.clone();
        ring.deltas.push_back(RingDelta { record, bytes });
        ring.bytes = ring.bytes.saturating_add(bytes);
        self.global_ring_bytes = self.global_ring_bytes.saturating_add(bytes);
    }

    fn prune_ring(&mut self, identity: &str, run_id: &str, through: u64) {
        let key = (identity.to_string(), run_id.to_string());
        let Some(ring) = self.rings.get_mut(&key) else {
            return;
        };
        while ring
            .deltas
            .front()
            .map(|delta| delta.record.seq <= through)
            .unwrap_or(false)
        {
            if let Some(delta) = ring.deltas.pop_front() {
                ring.bytes = ring.bytes.saturating_sub(delta.bytes);
                self.global_ring_bytes = self.global_ring_bytes.saturating_sub(delta.bytes);
            }
        }
        if ring.deltas.is_empty() {
            self.rings.remove(&key);
        }
    }

    fn emit_checkpoint_request(
        &self,
        identity: &str,
        run_id: &str,
        conversation_id: &str,
        reason: &str,
        expected_next_seq: u64,
        journal_bytes: u64,
    ) {
        let ring = self.rings.get(&(identity.to_string(), run_id.to_string()));
        let event = GatewayChatCheckpointRequestedEvent {
            run_id: run_id.to_string(),
            conversation_id: if conversation_id.is_empty() {
                ring.map(|ring| ring.conversation_id.clone())
                    .unwrap_or_default()
            } else {
                conversation_id.to_string()
            },
            reason: reason.to_string(),
            expected_next_seq,
            delta_records: ring.map(|ring| ring.deltas.len()).unwrap_or(0),
            delta_bytes: ring.map(|ring| ring.bytes).unwrap_or(0),
            journal_bytes,
        };
        if let Some(event_emitter) = &self.event_emitter {
            if let Err(error) = event_emitter.emit(GATEWAY_CHAT_CHECKPOINT_REQUESTED_EVENT, event) {
                eprintln!("emit gateway chat checkpoint request failed: {error}");
            }
        }
    }
}

fn validate_identity_and_run(
    identity: &str,
    run_id: &str,
    conversation_id: &str,
) -> Result<(), String> {
    if identity.trim().is_empty() {
        return Err("gateway chat ingress identity is required".to_string());
    }
    if run_id.trim().is_empty() {
        return Err("gateway chat ingress run_id is required".to_string());
    }
    if conversation_id.trim().is_empty() {
        return Err("gateway chat ingress conversation_id is required".to_string());
    }
    Ok(())
}

fn build_batch_records(
    identity: &str,
    input: &GatewayChatIngressBatchInput,
    first_seq: u64,
) -> Result<Vec<ChatIngressStoredRecord>, String> {
    input
        .records
        .iter()
        .enumerate()
        .map(|(offset, record)| {
            let seq = first_seq
                .checked_add(u64::try_from(offset).map_err(|_| "chat ingress sequence overflow")?)
                .ok_or_else(|| "gateway chat ingress sequence overflow".to_string())?;
            if record.event_json.is_empty() {
                return Err("gateway chat ingress delta event_json is required".to_string());
            }
            if record.event_json.len() > CHAT_INGRESS_MAX_RECORD_BYTES {
                return Err(format!(
                    "gateway chat ingress delta exceeds {CHAT_INGRESS_MAX_RECORD_BYTES} bytes"
                ));
            }
            validate_delta_event_json(&record.event_json)?;
            let payload = ChatIngressRecordPayload::Delta {
                event_json: record.event_json.clone(),
                worker_id: record.worker_id.clone().unwrap_or_default(),
            };
            Ok(ChatIngressStoredRecord {
                identity: identity.to_string(),
                run_id: input.run_id.trim().to_string(),
                conversation_id: input.conversation_id.trim().to_string(),
                seq,
                payload,
            })
        })
        .collect()
}

fn validate_delta_batch(input: &GatewayChatIngressBatchInput) -> Result<usize, String> {
    let mut bytes = input
        .run_id
        .len()
        .saturating_add(input.conversation_id.len())
        .saturating_add(32);
    for record in &input.records {
        if record.event_json.is_empty() {
            return Err("gateway chat ingress delta event_json is required".to_string());
        }
        if record.event_json.len() > CHAT_INGRESS_MAX_RECORD_BYTES {
            return Err(format!(
                "gateway chat ingress delta exceeds {CHAT_INGRESS_MAX_RECORD_BYTES} bytes"
            ));
        }
        validate_delta_event_json(&record.event_json)?;
        bytes = bytes
            .saturating_add(record.event_json.len())
            .saturating_add(record.worker_id.as_deref().unwrap_or_default().len())
            .saturating_add(16);
    }
    if bytes > CHAT_INGRESS_MAX_BATCH_BYTES {
        return Err(format!(
            "gateway chat ingress batch exceeds {CHAT_INGRESS_MAX_BATCH_BYTES} bytes"
        ));
    }
    Ok(bytes)
}

fn validate_delta_event_json(event_json: &str) -> Result<(), String> {
    let event = serde_json::from_str::<serde_json::Value>(event_json)
        .map_err(|error| format!("gateway chat ingress delta event_json is invalid: {error}"))?;
    if !event.is_object() {
        return Err("gateway chat ingress delta event_json must be a JSON object".to_string());
    }
    // Mirror the gateway's delta validation (conversation_reliable_ingress.go):
    // a record it would reject wedges the run's sequence ahead of its terminal,
    // so fail at the source instead of poisoning the journal. Lifecycle types
    // travel as dedicated records; a missing type is rejected outright.
    let event_type = event
        .get("type")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or_default();
    if event_type.is_empty() {
        return Err("gateway chat ingress delta requires a non-empty type".to_string());
    }
    if matches!(
        event_type,
        "run_started" | "run_finished" | "run_content_snapshot" | "done" | "error"
    ) {
        return Err(format!(
            "gateway chat ingress delta type {event_type:?} is reserved for lifecycle records"
        ));
    }
    Ok(())
}

fn chat_ingress_db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir).map_err(|error| format!("创建网关聊天镜像目录失败：{error}"))?;
    Ok(dir.join(CHAT_INGRESS_DB_FILENAME))
}

#[derive(Debug)]
struct AcceptRecordsResult {
    accepted_through: u64,
    journal_bytes: u64,
}

struct ChatIngressJournal {
    conn: Connection,
}

impl ChatIngressJournal {
    fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let conn = Connection::open(path)
            .map_err(|error| format!("open gateway chat ingress journal failed: {error}"))?;
        conn.busy_timeout(CHAT_INGRESS_BUSY_TIMEOUT)
            .map_err(|error| {
                format!("configure gateway chat ingress busy timeout failed: {error}")
            })?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA wal_autocheckpoint = 1000;",
        )
        .map_err(|error| format!("configure gateway chat ingress journal failed: {error}"))?;
        let mut journal = Self { conn };
        journal.migrate()?;
        Ok(journal)
    }

    fn migrate(&mut self) -> Result<(), String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("begin gateway chat ingress migration failed: {error}"))?;
        let version = tx
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("read gateway chat ingress schema version failed: {error}"))?;
        if version > CHAT_INGRESS_DB_SCHEMA_VERSION {
            return Err(format!(
                "gateway chat ingress schema version {version} is newer than supported {CHAT_INGRESS_DB_SCHEMA_VERSION}"
            ));
        }
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS ingress_runs (
                identity TEXT NOT NULL,
                run_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                next_seq INTEGER NOT NULL,
                acked_through INTEGER NOT NULL DEFAULT 0,
                terminal_committed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(identity, run_id)
             );
             CREATE TABLE IF NOT EXISTS ingress_records (
                identity TEXT NOT NULL,
                run_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                kind TEXT NOT NULL,
                event_json TEXT,
                worker_id TEXT,
                covers_through_seq INTEGER,
                revision INTEGER,
                compressed_projection BLOB,
                uncompressed_bytes INTEGER,
                sha256 TEXT,
                content_complete INTEGER,
                history_required INTEGER,
                terminal_state TEXT,
                error_code TEXT,
                error_message TEXT,
                stored_bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(identity, run_id, seq),
                FOREIGN KEY(identity, run_id) REFERENCES ingress_runs(identity, run_id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_ingress_records_pending
                ON ingress_records(identity, run_id, seq);
             PRAGMA user_version = 1;",
        )
        .map_err(|error| format!("migrate gateway chat ingress journal failed: {error}"))?;
        let has_terminal_committed_at = {
            let mut statement = tx
                .prepare("PRAGMA table_info(ingress_runs)")
                .map_err(|error| format!("inspect gateway chat ingress schema failed: {error}"))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|error| format!("read gateway chat ingress columns failed: {error}"))?;
            columns
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("decode gateway chat ingress columns failed: {error}"))?
                .iter()
                .any(|column| column == "terminal_committed_at")
        };
        if !has_terminal_committed_at {
            tx.execute_batch("ALTER TABLE ingress_runs ADD COLUMN terminal_committed_at INTEGER;")
                .map_err(|error| format!("migrate gateway terminal retention failed: {error}"))?;
        }
        tx.execute_batch("PRAGMA user_version = 2;")
            .map_err(|error| {
                format!("update gateway chat ingress schema version failed: {error}")
            })?;
        tx.execute(
            "DELETE FROM ingress_records WHERE kind IN ('delta', 'heartbeat')",
            [],
        )
        .map_err(|error| format!("remove legacy durable gateway chat deltas failed: {error}"))?;
        cleanup_inactive_running_checkpoints(&tx, now_unix_seconds(), &HashSet::new())?;
        cleanup_retained_terminals(&tx, now_unix_seconds())?;
        tx.commit()
            .map_err(|error| format!("commit gateway chat ingress migration failed: {error}"))
    }

    fn ensure_and_next_seq(
        &mut self,
        identity: &str,
        run_id: &str,
        conversation_id: &str,
    ) -> Result<u64, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("begin gateway chat ingress sequence read failed: {error}"))?;
        ensure_run(&tx, identity, run_id, conversation_id, now_unix_seconds())?;
        let next_seq = run_next_seq(&tx, identity, run_id)?;
        tx.commit().map_err(|error| {
            format!("commit gateway chat ingress sequence read failed: {error}")
        })?;
        Ok(next_seq)
    }

    fn allocate_delta_range(
        &mut self,
        identity: &str,
        run_id: &str,
        conversation_id: &str,
        count: usize,
    ) -> Result<(u64, u64, u64), String> {
        let count = u64::try_from(count)
            .map_err(|_| "gateway chat ingress batch size overflow".to_string())?;
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("begin gateway chat ingress allocation failed: {error}"))?;
        let now = now_unix_seconds();
        ensure_run(&tx, identity, run_id, conversation_id, now)?;
        if run_has_terminal(&tx, identity, run_id)? {
            return Err(format!(
                "gateway chat ingress run {run_id} already has a terminal checkpoint"
            ));
        }
        let first_seq = run_next_seq(&tx, identity, run_id)?;
        let next_seq = first_seq
            .checked_add(count)
            .ok_or_else(|| "gateway chat ingress sequence overflow".to_string())?;
        tx.execute(
            "UPDATE ingress_runs SET next_seq = ?3, updated_at = ?4
             WHERE identity = ?1 AND run_id = ?2",
            params![identity, run_id, to_i64(next_seq)?, now],
        )
        .map_err(|error| format!("allocate gateway chat ingress sequence failed: {error}"))?;
        let journal_bytes = journal_stored_bytes(&tx)?;
        tx.commit()
            .map_err(|error| format!("commit gateway chat ingress allocation failed: {error}"))?;
        Ok((first_seq, next_seq, journal_bytes))
    }

    fn commit_checkpoint(
        &mut self,
        identity: &str,
        input: &GatewayChatCheckpointInput,
        record: ChatIngressStoredRecord,
    ) -> Result<AcceptRecordsResult, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("begin gateway chat checkpoint failed: {error}"))?;
        let now = now_unix_seconds();
        ensure_run(&tx, identity, &input.run_id, &input.conversation_id, now)?;
        cleanup_retained_terminals(&tx, now)?;
        let next_seq = run_next_seq(&tx, identity, &input.run_id)?;
        if record.seq < next_seq {
            verify_duplicate(&tx, &record)?;
            let bytes = journal_stored_bytes(&tx)?;
            tx.commit().map_err(|error| {
                format!("commit duplicate gateway chat checkpoint failed: {error}")
            })?;
            return Ok(AcceptRecordsResult {
                accepted_through: record.seq,
                journal_bytes: bytes,
            });
        }
        if record.seq != next_seq {
            return Err(format!(
                "gateway chat checkpoint sequence gap for run {}: expected {next_seq}, got {}",
                input.run_id, record.seq
            ));
        }
        if matches!(&record.payload, ChatIngressRecordPayload::Checkpoint { .. }) {
            tx.execute(
                "DELETE FROM ingress_records
                 WHERE identity = ?1 AND run_id = ?2 AND kind = 'checkpoint'",
                params![identity, input.run_id],
            )
            .map_err(|error| format!("replace gateway chat checkpoint failed: {error}"))?;
        }
        let stored_bytes = record_stored_bytes(&record.payload);
        let before_bytes = journal_stored_bytes(&tx)?;
        if before_bytes.saturating_add(stored_bytes) > CHAT_INGRESS_MAX_JOURNAL_BYTES {
            return Err(format!(
                "gateway chat ingress journal reached its {} MiB safety limit",
                CHAT_INGRESS_MAX_JOURNAL_BYTES / 1024 / 1024
            ));
        }
        insert_record(&tx, &record)?;
        let new_next = record
            .seq
            .checked_add(1)
            .ok_or_else(|| "gateway chat checkpoint sequence overflow".to_string())?;
        tx.execute(
            "UPDATE ingress_runs SET next_seq = ?3, updated_at = ?4
             WHERE identity = ?1 AND run_id = ?2",
            params![identity, input.run_id, to_i64(new_next)?, now],
        )
        .map_err(|error| format!("advance gateway chat checkpoint sequence failed: {error}"))?;
        tx.commit()
            .map_err(|error| format!("commit gateway chat checkpoint failed: {error}"))?;
        Ok(AcceptRecordsResult {
            accepted_through: record.seq,
            journal_bytes: before_bytes.saturating_add(stored_bytes),
        })
    }

    fn pending_records(
        &self,
        identity: &str,
        limit_records: usize,
        limit_bytes: usize,
    ) -> Result<Vec<ChatIngressStoredRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT e.identity, e.run_id, e.conversation_id, e.seq, e.kind, e.event_json, e.worker_id,
                        e.covers_through_seq, e.revision, e.compressed_projection, e.uncompressed_bytes,
                        e.sha256, e.content_complete, e.history_required, e.terminal_state, e.error_code,
                        e.error_message
                 FROM ingress_records e
                 JOIN ingress_runs r ON r.identity = e.identity AND r.run_id = e.run_id
                 WHERE e.identity = ?1 AND r.terminal_committed = 0
                 ORDER BY e.created_at ASC, e.run_id ASC, e.seq ASC",
            )
            .map_err(|error| format!("prepare pending gateway chat ingress query failed: {error}"))?;
        let rows = statement
            .query_map([identity], decode_record)
            .map_err(|error| format!("query pending gateway chat ingress failed: {error}"))?;
        let mut output = Vec::new();
        let mut bytes = 0_usize;
        for row in rows {
            let record = row
                .map_err(|error| format!("decode pending gateway chat ingress failed: {error}"))?;
            let record_bytes =
                usize::try_from(record_stored_bytes(&record.payload)).unwrap_or(usize::MAX);
            if !output.is_empty()
                && (output.len() >= limit_records
                    || bytes.saturating_add(record_bytes) > limit_bytes)
            {
                break;
            }
            bytes = bytes.saturating_add(record_bytes);
            output.push(record);
        }
        Ok(output)
    }

    fn resume(&self, identity: &str) -> Result<Vec<ChatIngressResumeRun>, String> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT r.run_id, r.conversation_id, r.next_seq,
                        MIN(e.seq), MAX(e.seq),
                        MAX(CASE WHEN e.kind = 'checkpoint' THEN e.seq END),
                        MAX(CASE WHEN e.kind = 'terminal' THEN e.seq END),
                        MAX(CASE WHEN e.kind = 'terminal' THEN 1 ELSE 0 END)
                 FROM ingress_runs r
                 LEFT JOIN ingress_records e
                   ON e.identity = r.identity AND e.run_id = r.run_id
                 WHERE r.identity = ?1 AND r.terminal_committed = 0
                 GROUP BY r.run_id, r.conversation_id, r.next_seq
                 ORDER BY r.updated_at ASC",
            )
            .map_err(|error| format!("prepare gateway chat ingress resume failed: {error}"))?;
        let rows = statement
            .query_map([identity], |row| {
                Ok(ChatIngressResumeRun {
                    run_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    next_seq: from_i64(row.get(2)?)?,
                    replay_first_seq: optional_u64(row.get(3)?)?,
                    replay_last_seq: optional_u64(row.get(4)?)?,
                    latest_checkpoint_seq: optional_u64(row.get(5)?)?,
                    terminal_seq: optional_u64(row.get(6)?)?,
                    terminal_pending: row.get::<_, i64>(7)? != 0,
                })
            })
            .map_err(|error| format!("query gateway chat ingress resume failed: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("decode gateway chat ingress resume failed: {error}"))
    }

    fn acknowledge(&mut self, identity: &str, ack: &ChatIngressAck) -> Result<(), String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("begin gateway chat ingress ACK failed: {error}"))?;
        let next_seq = run_next_seq(&tx, identity, &ack.run_id)?;
        if ack.committed_through >= next_seq {
            return Err(format!(
                "gateway chat ingress ACK {} exceeds produced sequence {} for run {}",
                ack.committed_through,
                next_seq.saturating_sub(1),
                ack.run_id
            ));
        }
        if ack.terminal_committed {
            tx.execute(
                "DELETE FROM ingress_records
                 WHERE identity = ?1 AND run_id = ?2 AND seq <= ?3 AND kind != 'terminal'",
                params![identity, ack.run_id, to_i64(ack.committed_through)?],
            )
            .map_err(|error| {
                format!("clean pre-terminal gateway chat ingress records failed: {error}")
            })?;
            tx.execute(
                "UPDATE ingress_runs
                 SET acked_through = MAX(acked_through, ?3), terminal_committed = 1,
                     terminal_committed_at = ?4, updated_at = ?4
                 WHERE identity = ?1 AND run_id = ?2",
                params![
                    identity,
                    ack.run_id,
                    to_i64(ack.committed_through)?,
                    now_unix_seconds()
                ],
            )
            .map_err(|error| format!("retain committed gateway chat terminal failed: {error}"))?;
            cleanup_retained_terminals(&tx, now_unix_seconds())?;
        } else {
            tx.execute(
                "DELETE FROM ingress_records
                 WHERE identity = ?1 AND run_id = ?2 AND seq <= ?3",
                params![identity, ack.run_id, to_i64(ack.committed_through)?],
            )
            .map_err(|error| {
                format!("clean committed gateway chat ingress records failed: {error}")
            })?;
            tx.execute(
                "UPDATE ingress_runs
                 SET acked_through = MAX(acked_through, ?3), updated_at = ?4
                 WHERE identity = ?1 AND run_id = ?2",
                params![
                    identity,
                    ack.run_id,
                    to_i64(ack.committed_through)?,
                    now_unix_seconds()
                ],
            )
            .map_err(|error| format!("advance gateway chat ingress ACK failed: {error}"))?;
        }
        tx.commit()
            .map_err(|error| format!("commit gateway chat ingress ACK failed: {error}"))
    }

    fn existing_terminal(
        &self,
        identity: &str,
        run_id: &str,
    ) -> Result<Option<ChatIngressStoredRecord>, String> {
        self.conn
            .query_row(
                "SELECT identity, run_id, conversation_id, seq, kind, event_json, worker_id,
                        covers_through_seq, revision, compressed_projection, uncompressed_bytes,
                        sha256, content_complete, history_required, terminal_state, error_code,
                        error_message
                 FROM ingress_records
                 WHERE identity = ?1 AND run_id = ?2 AND kind = 'terminal'
                 ORDER BY seq DESC LIMIT 1",
                params![identity, run_id],
                decode_record,
            )
            .optional()
            .map_err(|error| format!("read existing gateway chat terminal failed: {error}"))
    }

    fn cleanup_inactive_running_checkpoints(
        &mut self,
        protected_runs: &HashSet<(String, String)>,
    ) -> Result<(), String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| format!("begin gateway chat checkpoint cleanup failed: {error}"))?;
        cleanup_inactive_running_checkpoints(&tx, now_unix_seconds(), protected_runs)?;
        tx.commit()
            .map_err(|error| format!("commit gateway chat checkpoint cleanup failed: {error}"))
    }

    fn stored_bytes(&self) -> Result<u64, String> {
        let bytes = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(stored_bytes), 0) FROM ingress_records",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("measure gateway chat ingress journal failed: {error}"))?;
        from_i64(bytes).map_err(|error| error.to_string())
    }
}

fn ensure_run(
    tx: &Transaction<'_>,
    identity: &str,
    run_id: &str,
    conversation_id: &str,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO ingress_runs(
            identity, run_id, conversation_id, next_seq, acked_through,
            terminal_committed, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 1, 0, 0, ?4, ?4)
         ON CONFLICT(identity, run_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            updated_at = excluded.updated_at
         WHERE ingress_runs.conversation_id = excluded.conversation_id",
        params![identity, run_id, conversation_id, now],
    )
    .map_err(|error| format!("ensure gateway chat ingress run failed: {error}"))?;
    let stored_conversation: String = tx
        .query_row(
            "SELECT conversation_id FROM ingress_runs WHERE identity = ?1 AND run_id = ?2",
            params![identity, run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("read gateway chat ingress run identity failed: {error}"))?;
    if stored_conversation != conversation_id {
        return Err(format!(
            "gateway chat ingress run {run_id} already belongs to another conversation"
        ));
    }
    Ok(())
}

fn run_next_seq(tx: &Transaction<'_>, identity: &str, run_id: &str) -> Result<u64, String> {
    let value = tx
        .query_row(
            "SELECT next_seq FROM ingress_runs WHERE identity = ?1 AND run_id = ?2",
            params![identity, run_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("read gateway chat ingress next sequence failed: {error}"))?
        .ok_or_else(|| format!("gateway chat ingress run {run_id} does not exist"))?;
    from_i64(value).map_err(|error| error.to_string())
}

fn run_has_terminal(tx: &Transaction<'_>, identity: &str, run_id: &str) -> Result<bool, String> {
    tx.query_row(
        "SELECT terminal_committed != 0 OR EXISTS(
            SELECT 1 FROM ingress_records e
            WHERE e.identity = ingress_runs.identity
              AND e.run_id = ingress_runs.run_id AND e.kind = 'terminal'
         )
         FROM ingress_runs WHERE identity = ?1 AND run_id = ?2",
        params![identity, run_id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|error| format!("read gateway chat terminal state failed: {error}"))
}

fn verify_duplicate(tx: &Transaction<'_>, record: &ChatIngressStoredRecord) -> Result<(), String> {
    let stored = tx
        .query_row(
            "SELECT kind, stored_bytes FROM ingress_records
             WHERE identity = ?1 AND run_id = ?2 AND seq = ?3",
            params![record.identity, record.run_id, to_i64(record.seq)?],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("verify duplicate gateway chat ingress record failed: {error}"))?;
    let expected_kind = record_kind(&record.payload);
    let expected_bytes = i64::try_from(record_stored_bytes(&record.payload))
        .map_err(|_| "gateway chat ingress record size overflow".to_string())?;
    match stored {
        Some((kind, bytes)) if kind == expected_kind && bytes == expected_bytes => Ok(()),
        Some(_) => Err(format!(
            "gateway chat ingress sequence {} was replayed with different content",
            record.seq
        )),
        None => Err(format!(
            "gateway chat ingress sequence {} is older than the retained replay window",
            record.seq
        )),
    }
}

fn insert_record(tx: &Transaction<'_>, record: &ChatIngressStoredRecord) -> Result<(), String> {
    if matches!(
        &record.payload,
        ChatIngressRecordPayload::Delta { .. } | ChatIngressRecordPayload::Heartbeat { .. }
    ) {
        return Err("gateway chat deltas and heartbeats are memory-only".to_string());
    }
    let (
        kind,
        event_json,
        worker_id,
        covers_through_seq,
        revision,
        compressed_projection,
        uncompressed_bytes,
        sha256,
        content_complete,
        history_required,
        terminal_state,
        error_code,
        error_message,
    ) = match &record.payload {
        ChatIngressRecordPayload::Delta {
            event_json,
            worker_id,
        } => (
            "delta",
            Some(event_json.as_str()),
            Some(worker_id.as_str()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ),
        ChatIngressRecordPayload::Checkpoint {
            covers_through_seq,
            revision,
            compressed_projection,
            uncompressed_bytes,
            sha256,
            content_complete,
            history_required,
        } => (
            "checkpoint",
            None,
            None,
            Some(to_i64(*covers_through_seq)?),
            Some(to_i64(*revision)?),
            Some(compressed_projection.as_slice()),
            Some(to_i64(*uncompressed_bytes)?),
            Some(sha256.as_str()),
            Some(i64::from(*content_complete)),
            Some(i64::from(*history_required)),
            None,
            None,
            None,
        ),
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
        } => (
            "terminal",
            None,
            None,
            Some(to_i64(*covers_through_seq)?),
            Some(to_i64(*revision)?),
            Some(compressed_projection.as_slice()),
            Some(to_i64(*uncompressed_bytes)?),
            Some(sha256.as_str()),
            Some(i64::from(*content_complete)),
            Some(i64::from(*history_required)),
            Some(state.as_str()),
            Some(error_code.as_str()),
            Some(error_message.as_str()),
        ),
        ChatIngressRecordPayload::Heartbeat { worker_id } => (
            "heartbeat",
            None,
            Some(worker_id.as_str()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ),
    };
    tx.execute(
        "INSERT INTO ingress_records(
            identity, run_id, conversation_id, seq, kind, event_json, worker_id,
            covers_through_seq, revision, compressed_projection, uncompressed_bytes,
            sha256, content_complete, history_required, terminal_state, error_code,
            error_message, stored_bytes, created_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
         )",
        params![
            record.identity,
            record.run_id,
            record.conversation_id,
            to_i64(record.seq)?,
            kind,
            event_json,
            worker_id,
            covers_through_seq,
            revision,
            compressed_projection,
            uncompressed_bytes,
            sha256,
            content_complete,
            history_required,
            terminal_state,
            error_code,
            error_message,
            to_i64(record_stored_bytes(&record.payload))?,
            now_unix_seconds(),
        ],
    )
    .map_err(|error| format!("insert gateway chat ingress record failed: {error}"))?;
    Ok(())
}

fn decode_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatIngressStoredRecord> {
    let kind: String = row.get(4)?;
    let payload = match kind.as_str() {
        "delta" => ChatIngressRecordPayload::Delta {
            event_json: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            worker_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        },
        "checkpoint" => ChatIngressRecordPayload::Checkpoint {
            covers_through_seq: from_i64(row.get::<_, Option<i64>>(7)?.unwrap_or_default())?,
            revision: from_i64(row.get::<_, Option<i64>>(8)?.unwrap_or_default())?,
            compressed_projection: row.get::<_, Option<Vec<u8>>>(9)?.unwrap_or_default(),
            uncompressed_bytes: from_i64(row.get::<_, Option<i64>>(10)?.unwrap_or_default())?,
            sha256: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            content_complete: row.get::<_, Option<i64>>(12)?.unwrap_or_default() != 0,
            history_required: row.get::<_, Option<i64>>(13)?.unwrap_or_default() != 0,
        },
        "terminal" => ChatIngressRecordPayload::Terminal {
            covers_through_seq: from_i64(row.get::<_, Option<i64>>(7)?.unwrap_or_default())?,
            revision: from_i64(row.get::<_, Option<i64>>(8)?.unwrap_or_default())?,
            compressed_projection: row.get::<_, Option<Vec<u8>>>(9)?.unwrap_or_default(),
            uncompressed_bytes: from_i64(row.get::<_, Option<i64>>(10)?.unwrap_or_default())?,
            sha256: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            content_complete: row.get::<_, Option<i64>>(12)?.unwrap_or_default() != 0,
            history_required: row.get::<_, Option<i64>>(13)?.unwrap_or_default() != 0,
            state: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
            error_code: row.get::<_, Option<String>>(15)?.unwrap_or_default(),
            error_message: row.get::<_, Option<String>>(16)?.unwrap_or_default(),
        },
        "heartbeat" => ChatIngressRecordPayload::Heartbeat {
            worker_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        },
        _ => {
            return Err(rusqlite::Error::InvalidColumnType(
                4,
                "kind".to_string(),
                rusqlite::types::Type::Text,
            ))
        }
    };
    Ok(ChatIngressStoredRecord {
        identity: row.get(0)?,
        run_id: row.get(1)?,
        conversation_id: row.get(2)?,
        seq: from_i64(row.get(3)?)?,
        payload,
    })
}

fn journal_stored_bytes(tx: &Transaction<'_>) -> Result<u64, String> {
    let bytes = tx
        .query_row(
            "SELECT COALESCE(SUM(stored_bytes), 0) FROM ingress_records",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("measure gateway chat ingress journal failed: {error}"))?;
    from_i64(bytes).map_err(|error| error.to_string())
}

fn cleanup_inactive_running_checkpoints(
    tx: &Transaction<'_>,
    now: i64,
    protected_runs: &HashSet<(String, String)>,
) -> Result<(), String> {
    let cutoff = now.saturating_sub(CHAT_INGRESS_RUNNING_CHECKPOINT_RETENTION_SECONDS);
    let mut statement = tx
        .prepare(
            "SELECT identity, run_id FROM ingress_runs
             WHERE terminal_committed = 0 AND updated_at < ?1
               AND NOT EXISTS(
                 SELECT 1 FROM ingress_records e
                 WHERE e.identity = ingress_runs.identity
                   AND e.run_id = ingress_runs.run_id AND e.kind = 'terminal'
               )",
        )
        .map_err(|error| {
            format!("prepare inactive gateway chat checkpoint cleanup failed: {error}")
        })?;
    let stale_runs = statement
        .query_map([cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("query inactive gateway chat checkpoints failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("decode inactive gateway chat checkpoints failed: {error}"))?;
    drop(statement);
    for (identity, run_id) in stale_runs {
        if protected_runs.contains(&(identity.clone(), run_id.clone())) {
            continue;
        }
        tx.execute(
            "DELETE FROM ingress_runs WHERE identity = ?1 AND run_id = ?2",
            params![identity, run_id],
        )
        .map_err(|error| format!("expire inactive gateway chat checkpoints failed: {error}"))?;
    }
    Ok(())
}

fn cleanup_retained_terminals(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    let cutoff = now.saturating_sub(CHAT_INGRESS_TERMINAL_ACK_RETENTION_SECONDS);
    tx.execute(
        "DELETE FROM ingress_runs
         WHERE terminal_committed = 1
           AND terminal_committed_at IS NOT NULL AND terminal_committed_at < ?1",
        [cutoff],
    )
    .map_err(|error| format!("expire retained gateway chat terminals failed: {error}"))?;
    let mut statement = tx
        .prepare(
            "SELECT identity, run_id FROM ingress_runs
             WHERE terminal_committed = 1
             ORDER BY terminal_committed_at DESC, updated_at DESC
             LIMIT -1 OFFSET ?1",
        )
        .map_err(|error| format!("prepare retained gateway terminal cap failed: {error}"))?;
    let overflow = statement
        .query_map(
            [i64::try_from(CHAT_INGRESS_TERMINAL_ACK_CAP).unwrap_or(32)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("query retained gateway terminal cap failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("decode retained gateway terminal cap failed: {error}"))?;
    drop(statement);
    for (identity, run_id) in overflow {
        tx.execute(
            "DELETE FROM ingress_runs WHERE identity = ?1 AND run_id = ?2",
            params![identity, run_id],
        )
        .map_err(|error| format!("cap retained gateway chat terminals failed: {error}"))?;
    }
    Ok(())
}

fn record_kind(payload: &ChatIngressRecordPayload) -> &'static str {
    match payload {
        ChatIngressRecordPayload::Delta { .. } => "delta",
        ChatIngressRecordPayload::Checkpoint { .. } => "checkpoint",
        ChatIngressRecordPayload::Terminal { .. } => "terminal",
        ChatIngressRecordPayload::Heartbeat { .. } => "heartbeat",
    }
}

fn record_stored_bytes(payload: &ChatIngressRecordPayload) -> u64 {
    match payload {
        ChatIngressRecordPayload::Delta {
            event_json,
            worker_id,
        } => (event_json.len() + worker_id.len()) as u64,
        ChatIngressRecordPayload::Checkpoint {
            compressed_projection,
            sha256,
            ..
        } => (compressed_projection.len() + sha256.len()) as u64,
        ChatIngressRecordPayload::Terminal {
            compressed_projection,
            sha256,
            state,
            error_code,
            error_message,
            ..
        } => {
            (compressed_projection.len()
                + sha256.len()
                + state.len()
                + error_code.len()
                + error_message.len()) as u64
        }
        ChatIngressRecordPayload::Heartbeat { worker_id } => worker_id.len() as u64,
    }
}

fn to_i64(value: u64) -> Result<i64, String> {
    i64::try_from(value)
        .map_err(|_| "gateway chat ingress integer exceeds SQLite range".to_string())
}

fn from_i64(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn optional_u64(value: Option<i64>) -> rusqlite::Result<Option<u64>> {
    value.map(from_i64).transpose()
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> (tempfile::TempDir, ChatIngressJournal) {
        let dir = tempfile::tempdir().expect("tempdir");
        let journal =
            ChatIngressJournal::open(dir.path().join("chat-sync.sqlite3")).expect("open journal");
        (dir, journal)
    }

    fn actor() -> (tempfile::TempDir, ChatIngressActor) {
        let (dir, journal) = journal();
        (
            dir,
            ChatIngressActor {
                journal: Ok(journal),
                rings: HashMap::new(),
                global_ring_bytes: 0,
                event_emitter: None,
            },
        )
    }

    fn delta_batch(run_id: &str, conversation_id: &str) -> GatewayChatIngressBatchInput {
        GatewayChatIngressBatchInput {
            run_id: run_id.to_string(),
            conversation_id: conversation_id.to_string(),
            records: vec![GatewayChatIngressDeltaInput {
                event_json: format!(
                    r#"{{"type":"token","text":"hello","conversation_id":"{conversation_id}"}}"#
                ),
                worker_id: None,
            }],
        }
    }

    fn checkpoint_input(kind: &str) -> GatewayChatCheckpointInput {
        GatewayChatCheckpointInput {
            run_id: "run-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            entries_json: r#"[{"type":"assistant","text":"hello"}]"#.to_string(),
            revision: 7,
            kind: kind.to_string(),
            state: if kind == "terminal" { "completed" } else { "" }.to_string(),
            error_code: String::new(),
            error_message: String::new(),
            content_complete: true,
            history_required: false,
        }
    }

    fn durable_record(
        identity: &str,
        input: &GatewayChatCheckpointInput,
        seq: u64,
    ) -> ChatIngressStoredRecord {
        let compressed = zstd::bulk::compress(
            input.entries_json.as_bytes(),
            CHAT_INGRESS_CHECKPOINT_COMPRESSION_LEVEL,
        )
        .unwrap();
        let common = (
            seq.saturating_sub(1),
            input.revision,
            compressed,
            input.entries_json.len() as u64,
            sha256_hex(input.entries_json.as_bytes()),
        );
        let payload = if input.kind == "terminal" {
            ChatIngressRecordPayload::Terminal {
                covers_through_seq: common.0,
                revision: common.1,
                compressed_projection: common.2,
                uncompressed_bytes: common.3,
                sha256: common.4,
                content_complete: true,
                history_required: false,
                state: input.state.clone(),
                error_code: String::new(),
                error_message: String::new(),
            }
        } else {
            ChatIngressRecordPayload::Checkpoint {
                covers_through_seq: common.0,
                revision: common.1,
                compressed_projection: common.2,
                uncompressed_bytes: common.3,
                sha256: common.4,
                content_complete: true,
                history_required: false,
            }
        };
        ChatIngressStoredRecord {
            identity: identity.to_string(),
            run_id: input.run_id.clone(),
            conversation_id: input.conversation_id.clone(),
            seq,
            payload,
        }
    }

    #[test]
    fn delta_allocation_advances_sequence_without_persisting_payloads() {
        let (_dir, mut journal) = journal();
        let (first, next, bytes) = journal
            .allocate_delta_range("identity-a", "run-1", "conversation-1", 2)
            .unwrap();
        assert_eq!((first, next, bytes), (1, 3, 0));
        assert!(journal
            .pending_records("identity-a", 10, 1024)
            .unwrap()
            .is_empty());
        assert_eq!(journal.resume("identity-a").unwrap()[0].next_seq, 3);
    }

    #[test]
    fn running_checkpoint_replaces_the_previous_checkpoint() {
        let (_dir, mut journal) = journal();
        journal
            .allocate_delta_range("identity-a", "run-1", "conversation-1", 2)
            .unwrap();
        let input = checkpoint_input("checkpoint");
        journal
            .commit_checkpoint(
                "identity-a",
                &input,
                durable_record("identity-a", &input, 3),
            )
            .unwrap();
        journal
            .allocate_delta_range("identity-a", "run-1", "conversation-1", 1)
            .unwrap();
        journal
            .commit_checkpoint(
                "identity-a",
                &input,
                durable_record("identity-a", &input, 5),
            )
            .unwrap();
        let pending = journal
            .pending_records("identity-a", 10, 1024 * 1024)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].seq, 5);
    }

    #[test]
    fn restart_recovers_checkpoint_but_not_delta_payloads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("chat-sync.sqlite3");
        let input = checkpoint_input("checkpoint");
        {
            let mut journal = ChatIngressJournal::open(&path).unwrap();
            journal
                .allocate_delta_range("identity-a", "run-1", "conversation-1", 2)
                .unwrap();
            journal
                .commit_checkpoint(
                    "identity-a",
                    &input,
                    durable_record("identity-a", &input, 3),
                )
                .unwrap();
        }
        let reopened = ChatIngressJournal::open(&path).unwrap();
        let pending = reopened
            .pending_records("identity-a", 10, 1024 * 1024)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert!(matches!(
            pending[0].payload,
            ChatIngressRecordPayload::Checkpoint { .. }
        ));
    }

    #[test]
    fn terminal_ack_hides_but_retains_terminal_for_diagnostics() {
        let (_dir, mut journal) = journal();
        let input = checkpoint_input("terminal");
        journal
            .commit_checkpoint(
                "identity-a",
                &input,
                durable_record("identity-a", &input, 1),
            )
            .unwrap();
        journal
            .acknowledge(
                "identity-a",
                &ChatIngressAck {
                    run_id: "run-1".to_string(),
                    committed_through: 1,
                    expected_next: 2,
                    action: "continue".to_string(),
                    terminal_committed: true,
                    error: String::new(),
                },
            )
            .unwrap();
        assert!(journal
            .pending_records("identity-a", 10, 1024)
            .unwrap()
            .is_empty());
        assert!(journal.resume("identity-a").unwrap().is_empty());
        let retained: i64 = journal
            .conn
            .query_row(
                "SELECT COUNT(*) FROM ingress_records WHERE kind = 'terminal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 1);
    }

    #[test]
    fn durable_checkpoint_prunes_the_covered_delta_ring() {
        let (_dir, mut actor) = actor();
        actor
            .accept_batch(
                "identity-a".to_string(),
                delta_batch("run-1", "conversation-1"),
            )
            .unwrap();
        assert_eq!(actor.rings.len(), 1);
        assert!(actor.global_ring_bytes > 0);

        let committed = actor
            .commit_checkpoint("identity-a".to_string(), checkpoint_input("checkpoint"))
            .unwrap();

        assert_eq!(committed.source_seq, 2);
        assert!(actor.rings.is_empty());
        assert_eq!(actor.global_ring_bytes, 0);
        let pending = actor
            .pending_records("identity-a", 10, 1024 * 1024)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].seq, 2);
        assert!(matches!(
            pending[0].payload,
            ChatIngressRecordPayload::Checkpoint {
                covers_through_seq: 1,
                ..
            }
        ));
    }

    #[test]
    fn terminal_is_idempotent_and_blocks_later_delta() {
        let (_dir, mut actor) = actor();
        let input = checkpoint_input("terminal");
        let first = actor
            .commit_checkpoint("identity-a".to_string(), input.clone())
            .unwrap();
        let duplicate = actor
            .commit_checkpoint("identity-a".to_string(), input)
            .unwrap();

        assert_eq!(first.source_seq, duplicate.source_seq);
        assert_eq!(first.sha256, duplicate.sha256);
        let error = actor
            .accept_batch(
                "identity-a".to_string(),
                delta_batch("run-1", "conversation-1"),
            )
            .unwrap_err();
        assert!(error.contains("already has a terminal checkpoint"));
    }

    #[test]
    fn conflicting_terminal_is_rejected() {
        let (_dir, mut actor) = actor();
        actor
            .commit_checkpoint("identity-a".to_string(), checkpoint_input("terminal"))
            .unwrap();
        let mut conflicting = checkpoint_input("terminal");
        conflicting.entries_json = r#"[{"type":"assistant","text":"different"}]"#.to_string();

        let error = actor
            .commit_checkpoint("identity-a".to_string(), conflicting)
            .unwrap_err();

        assert!(error.contains("already has a terminal checkpoint"));
    }

    #[test]
    fn checkpoint_projection_must_be_a_json_array() {
        let (_dir, mut actor) = actor();
        let mut input = checkpoint_input("checkpoint");
        input.entries_json = r#"{"type":"assistant","text":"hello"}"#.to_string();

        let error = actor
            .commit_checkpoint("identity-a".to_string(), input)
            .unwrap_err();

        assert!(error.contains("must be a JSON array"));
    }

    #[test]
    fn oversized_terminal_falls_back_to_history_required() {
        let (_dir, mut actor) = actor();
        let mut input = checkpoint_input("terminal");
        input.entries_json = format!("[\"{}\"]", "x".repeat(CHAT_INGRESS_MAX_PROJECTION_BYTES));

        actor
            .commit_checkpoint("identity-a".to_string(), input)
            .unwrap();
        let pending = actor
            .pending_records("identity-a", 10, 1024 * 1024)
            .unwrap();
        let ChatIngressRecordPayload::Terminal {
            compressed_projection,
            uncompressed_bytes,
            sha256,
            content_complete,
            history_required,
            ..
        } = &pending[0].payload
        else {
            panic!("expected terminal record");
        };
        let projection =
            zstd::bulk::decompress(compressed_projection, *uncompressed_bytes as usize).unwrap();
        assert_eq!(projection, b"[]");
        assert_eq!(*uncompressed_bytes, 2);
        assert_eq!(sha256, &sha256_hex(b"[]"));
        assert!(!content_complete);
        assert!(history_required);
    }

    #[test]
    fn retained_terminal_cap_is_global_across_identities() {
        let (_dir, mut journal) = journal();
        for index in 0..=CHAT_INGRESS_TERMINAL_ACK_CAP {
            let identity = format!("identity-{index}");
            let mut input = checkpoint_input("terminal");
            input.run_id = format!("run-{index}");
            input.conversation_id = format!("conversation-{index}");
            journal
                .commit_checkpoint(&identity, &input, durable_record(&identity, &input, 1))
                .unwrap();
            journal
                .acknowledge(
                    &identity,
                    &ChatIngressAck {
                        run_id: input.run_id,
                        committed_through: 1,
                        expected_next: 2,
                        action: "continue".to_string(),
                        terminal_committed: true,
                        error: String::new(),
                    },
                )
                .unwrap();
        }

        let retained: i64 = journal
            .conn
            .query_row(
                "SELECT COUNT(*) FROM ingress_runs WHERE terminal_committed = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained as usize, CHAT_INGRESS_TERMINAL_ACK_CAP);
    }

    #[test]
    fn inactive_checkpoint_cleanup_preserves_unacked_terminal() {
        let (_dir, mut journal) = journal();
        let checkpoint = checkpoint_input("checkpoint");
        journal
            .commit_checkpoint(
                "identity-a",
                &checkpoint,
                durable_record("identity-a", &checkpoint, 1),
            )
            .unwrap();
        let mut terminal = checkpoint_input("terminal");
        terminal.run_id = "run-terminal".to_string();
        terminal.conversation_id = "conversation-terminal".to_string();
        journal
            .commit_checkpoint(
                "identity-b",
                &terminal,
                durable_record("identity-b", &terminal, 1),
            )
            .unwrap();
        let stale = now_unix_seconds()
            .saturating_sub(CHAT_INGRESS_RUNNING_CHECKPOINT_RETENTION_SECONDS)
            .saturating_sub(1);
        journal
            .conn
            .execute("UPDATE ingress_runs SET updated_at = ?1", [stale])
            .unwrap();

        let tx = journal.conn.transaction().unwrap();
        cleanup_inactive_running_checkpoints(&tx, now_unix_seconds(), &HashSet::new()).unwrap();
        tx.commit().unwrap();

        let checkpoint_runs: i64 = journal
            .conn
            .query_row(
                "SELECT COUNT(*) FROM ingress_runs WHERE run_id = 'run-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let terminal_runs: i64 = journal
            .conn
            .query_row(
                "SELECT COUNT(*) FROM ingress_runs WHERE run_id = 'run-terminal'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(checkpoint_runs, 0);
        assert_eq!(terminal_runs, 1);
    }

    #[test]
    fn journal_records_are_isolated_by_agent_identity() {
        let (_dir, mut journal) = journal();
        let input = checkpoint_input("checkpoint");
        for identity in ["identity-a", "identity-b"] {
            journal
                .commit_checkpoint(identity, &input, durable_record(identity, &input, 1))
                .unwrap();
        }

        for identity in ["identity-a", "identity-b"] {
            let pending = journal.pending_records(identity, 10, 1024 * 1024).unwrap();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].identity, identity);
        }
    }

    #[test]
    fn actor_queue_enforces_frame_and_byte_limits() {
        let (tx, _rx) = std_mpsc::sync_channel(1);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        let mirror = ChatIngressMirror {
            tx,
            queued_bytes: Arc::clone(&queued_bytes),
        };
        let (first_reply, _first_rx) = oneshot::channel();
        let first = ChatIngressCommand::Resume {
            identity: "identity-a".to_string(),
            reply: first_reply,
        };
        let first_bytes = first.estimated_bytes();
        mirror.enqueue(first).unwrap();
        assert_eq!(queued_bytes.load(Ordering::Acquire), first_bytes);

        let (second_reply, _second_rx) = oneshot::channel();
        let error = mirror
            .enqueue(ChatIngressCommand::Resume {
                identity: "identity-b".to_string(),
                reply: second_reply,
            })
            .unwrap_err();
        assert!(error.contains("queue is full"));
        assert_eq!(queued_bytes.load(Ordering::Acquire), first_bytes);

        let reserved = AtomicUsize::new(CHAT_INGRESS_ACTOR_QUEUE_BYTES - 1);
        let error = reserve_actor_queue_bytes(&reserved, 2).unwrap_err();
        assert!(error.contains("byte limit"));
        assert_eq!(
            reserved.load(Ordering::Acquire),
            CHAT_INGRESS_ACTOR_QUEUE_BYTES - 1
        );
    }
}
