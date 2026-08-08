package session

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/chatwire"
	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const (
	chatIngressProjectionMaxBytes    = 64 << 20
	chatIngressEncodedRecordMaxBytes = chatIngressProjectionMaxBytes + (1 << 20)
	chatIngressFragmentDefaultBytes  = 32 << 10
	chatIngressFragmentChunkBytes    = 64 << 10
	chatIngressFragmentMaxCount      = (chatIngressEncodedRecordMaxBytes + chatIngressFragmentDefaultBytes - 1) / chatIngressFragmentDefaultBytes
	chatIngressFragmentTTL           = 30 * time.Second
	// chatIngressBrowserProjectionMaxBytes bounds the projection payload that
	// is relayed to browser subscribers. A projection above this limit would
	// exceed the browser write-queue frame budget and kill every subscriber's
	// socket, so it degrades to a history_required marker instead — history
	// convergence carries the content.
	chatIngressBrowserProjectionMaxBytes = 4 << 20
)

type chatIngressRunState struct {
	conversationID           string
	committedThrough         uint64
	latestCheckpointRevision uint64
	latestCheckpointHash     string
	terminalSeq              uint64
	terminalHash             string
	terminalCommitted        bool
	checkpointRequested      bool
	gapObservedAt            uint64
	replayRequestedAt        uint64
	updatedAt                time.Time
}

type chatIngressFragmentAssembly struct {
	conversationID     string
	fragmentCount      uint32
	encodedRecordBytes uint64
	sha256             string
	chunks             [][]byte
	received           uint32
	receivedBytes      uint64
	expiresAt          time.Time
}

type chatIngressProjection interface {
	GetCoversThroughSeq() uint64
	GetRevision() uint64
	GetCompressedProjection() []byte
	GetUncompressedBytes() uint64
	GetSha256() string
	GetContentComplete() bool
	GetHistoryRequired() bool
}

type chatIngressRecordError struct {
	code    string
	message string
}

func (e *chatIngressRecordError) Error() string {
	return e.message
}

func newChatIngressRecordError(code, format string, args ...any) error {
	return &chatIngressRecordError{code: code, message: fmt.Sprintf(format, args...)}
}

func (m *Manager) ingestChatIngressBatch(agentID string, batch *gatewayv2.ChatIngressBatch) *gatewayv2.ChatIngressAck {
	if batch == nil {
		return rejectedChatIngressAck("", "", nil, "invalid_batch", "chat ingress batch is required")
	}
	return m.ingestChatIngressRecords(
		agentID,
		strings.TrimSpace(batch.GetRunId()),
		strings.TrimSpace(batch.GetConversationId()),
		batch.GetFirstSeq(),
		batch.GetRecords(),
	)
}

func (m *Manager) ingestChatIngressRecords(
	agentID string,
	runID string,
	conversationID string,
	firstSeq uint64,
	records []*gatewayv2.ChatIngressRecord,
) *gatewayv2.ChatIngressAck {
	s := m.convStreams
	now := time.Now()
	agentID = strings.TrimSpace(agentID)

	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.ingressRuns[agentScopedKey(agentID, runID)]
	wasAbsent := state == nil
	if agentID == "" || runID == "" || conversationID == "" {
		return rejectedChatIngressAck(runID, conversationID, state, "invalid_identity", "agent_id, run_id and conversation_id are required")
	}
	if firstSeq == 0 || len(records) == 0 {
		return rejectedChatIngressAck(runID, conversationID, state, "invalid_batch", "first_seq and records are required")
	}
	if uint64(len(records)-1) > ^uint64(0)-firstSeq {
		return rejectedChatIngressAck(runID, conversationID, state, "sequence_overflow", "chat ingress sequence overflows uint64")
	}
	if state == nil {
		state = &chatIngressRunState{conversationID: conversationID, updatedAt: now}
		s.ingressRuns[agentScopedKey(agentID, runID)] = state
	} else if state.conversationID != conversationID {
		return rejectedChatIngressAck(runID, conversationID, state, "conversation_mismatch", "run is already bound to another conversation")
	}
	state.updatedAt = now

	expected := state.committedThrough + 1
	lastSeq := firstSeq + uint64(len(records)) - 1
	if lastSeq == math.MaxUint64 {
		return rejectedChatIngressAck(runID, conversationID, state, "sequence_overflow", "chat ingress sequence leaves no representable expected_next")
	}
	if lastSeq <= state.committedThrough {
		if err := validateDuplicateTerminal(state, firstSeq, records); err != nil {
			return rejectedChatIngressAck(runID, conversationID, state, ingressErrorCode(err), "%s", err.Error())
		}
		return continueChatIngressAck(runID, conversationID, state)
	}
	if state.terminalCommitted {
		return rejectedChatIngressAck(runID, conversationID, state, "terminal_already_committed", "run terminal is already committed")
	}
	if firstSeq > expected {
		if wasAbsent {
			noteChatIngressGap(agentID, runID, conversationID, state, expected, "missing_cursor")
			requestChatIngressCheckpoint(agentID, runID, conversationID, state, expected, "missing_cursor")
			return checkpointChatIngressAck(runID, conversationID, state)
		}
		if !state.checkpointRequested || !isChatIngressProjectionRecord(records[0]) {
			return recoverChatIngressGap(
				agentID,
				runID,
				conversationID,
				state,
				expected,
				"producer_sequence_gap",
			)
		}
		projection := projectionFromRecord(records[0])
		if projection == nil || projection.GetCoversThroughSeq() < firstSeq-1 {
			return rejectedChatIngressAck(runID, conversationID, state, "checkpoint_does_not_cover_gap", "checkpoint does not cover the missing producer sequence range")
		}
		expected = firstSeq
	}

	start := uint64(0)
	if firstSeq < expected {
		start = expected - firstSeq
	}
	for offset := start; offset < uint64(len(records)); offset++ {
		producerSeq := firstSeq + offset
		if err := s.commitChatIngressRecordLocked(agentID, runID, conversationID, producerSeq, records[offset], now); err != nil {
			return rejectedChatIngressAck(runID, conversationID, state, ingressErrorCode(err), "%s", err.Error())
		}
		state.committedThrough = producerSeq
		state.updatedAt = now
		state.checkpointRequested = false
		state.gapObservedAt = 0
		state.replayRequestedAt = 0
		if records[offset].GetCheckpoint() != nil {
			checkpoint := records[offset].GetCheckpoint()
			state.latestCheckpointRevision = checkpoint.GetRevision()
			state.latestCheckpointHash = normalizedProjectionHash(checkpoint)
			noteChatIngressCheckpointCommitted(agentID, runID, conversationID, producerSeq, checkpoint)
		}
		if records[offset].GetTerminal() != nil {
			terminal := records[offset].GetTerminal()
			state.latestCheckpointRevision = terminal.GetRevision()
			state.latestCheckpointHash = normalizedProjectionHash(terminal)
			state.terminalSeq = producerSeq
			state.terminalHash = state.latestCheckpointHash
			state.terminalCommitted = true
			noteChatIngressTerminalCommitted(agentID, runID, conversationID, producerSeq, terminal)
		}
	}
	return continueChatIngressAck(runID, conversationID, state)
}

func (s *conversationStreamStore) commitChatIngressRecordLocked(
	agentID string,
	runID string,
	conversationID string,
	producerSeq uint64,
	record *gatewayv2.ChatIngressRecord,
	now time.Time,
) error {
	if record == nil || record.GetPayload() == nil {
		return newChatIngressRecordError("invalid_record", "chat ingress record payload is required")
	}
	state := s.ingressRuns[agentScopedKey(agentID, runID)]
	conversationID = s.resolveConversationLocked(agentID, runID, conversationID, now)
	stream := s.streamLocked(agentID, conversationID, now)
	stream.agentID = agentID

	switch payload := record.GetPayload().(type) {
	case *gatewayv2.ChatIngressRecord_Delta:
		return s.appendChatIngressDeltaLocked(stream, runID, payload.Delta, now)
	case *gatewayv2.ChatIngressRecord_Checkpoint:
		entriesJSON, err := decodeChatIngressProjection(payload.Checkpoint)
		if err != nil {
			return err
		}
		if err := validateProjectionRevision(state, payload.Checkpoint, "checkpoint"); err != nil {
			return err
		}
		if payload.Checkpoint.GetRevision() > math.MaxInt64 {
			return newChatIngressRecordError("invalid_checkpoint_revision", "checkpoint revision exceeds int64")
		}
		if payload.Checkpoint.GetCoversThroughSeq() != producerSeq-1 {
			return newChatIngressRecordError("invalid_checkpoint_coverage", "checkpoint at sequence %d must cover exactly through %d, got %d", producerSeq, producerSeq-1, payload.Checkpoint.GetCoversThroughSeq())
		}
		s.appendChatIngressProjectionLocked(stream, runID, payload.Checkpoint, entriesJSON, now)
		return nil
	case *gatewayv2.ChatIngressRecord_Terminal:
		terminal := payload.Terminal
		if stream.runFinishedRecently(runID) && !s.resurrectRunLocked(stream, runID) {
			return newChatIngressRecordError("terminal_already_committed", "run terminal is already committed")
		}
		status := strings.TrimSpace(terminal.GetState())
		switch status {
		case "completed", "failed", "cancelled":
		default:
			return newChatIngressRecordError("invalid_terminal_state", "unsupported terminal state %q", status)
		}
		entriesJSON, err := decodeChatIngressProjection(terminal)
		if err != nil {
			return err
		}
		if err := validateProjectionRevision(state, terminal, "terminal"); err != nil {
			return err
		}
		if terminal.GetRevision() > math.MaxInt64 {
			return newChatIngressRecordError("invalid_checkpoint_revision", "terminal revision exceeds int64")
		}
		if terminal.GetCoversThroughSeq() != producerSeq-1 {
			return newChatIngressRecordError("invalid_checkpoint_coverage", "terminal at sequence %d must cover exactly through %d, got %d", producerSeq, producerSeq-1, terminal.GetCoversThroughSeq())
		}
		s.appendChatIngressProjectionLocked(stream, runID, terminal, entriesJSON, now)
		s.runFinishedLocked(
			stream,
			runID,
			status,
			strings.TrimSpace(terminal.GetErrorCode()),
			strings.TrimSpace(terminal.GetErrorMessage()),
			nil,
			now,
		)
		return nil
	case *gatewayv2.ChatIngressRecord_Heartbeat:
		s.touchChatIngressRunLocked(stream, runID, now)
		return nil
	default:
		return newChatIngressRecordError("invalid_record", "unsupported chat ingress record payload")
	}
}

func (s *conversationStreamStore) appendChatIngressDeltaLocked(
	stream *conversationStream,
	runID string,
	delta *gatewayv2.ChatIngressDelta,
	now time.Time,
) error {
	if delta == nil {
		return newChatIngressRecordError("invalid_delta", "chat ingress delta is required")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(delta.GetEventJson())), &payload); err != nil || payload == nil {
		return newChatIngressRecordError("invalid_delta_json", "delta event_json must be a JSON object")
	}
	eventType, _ := payload["type"].(string)
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		return newChatIngressRecordError("invalid_delta_type", "delta event type is required")
	}
	if eventType == "run_heartbeat" {
		s.touchChatIngressRunLocked(stream, runID, now)
		return nil
	}
	switch eventType {
	case StreamEventRunStarted, StreamEventRunFinished, StreamEventContentSnapshot, "done", "error":
		return newChatIngressRecordError("reserved_delta_type", "delta event type %q must use a lifecycle record", eventType)
	}
	if stream.runFinishedRecently(runID) && !s.resurrectRunLocked(stream, runID) {
		return newChatIngressRecordError("terminal_already_committed", "run terminal is already committed")
	}
	s.runStartedLocked(stream, runID, "", now)
	if stream.activity == nil || stream.activity.RunID != runID {
		return newChatIngressRecordError("run_not_active", "run could not become active")
	}
	delete(payload, "conversation_id")
	delete(payload, "run_id")
	delete(payload, "seq")
	delete(payload, "type")
	if eventType == "user_message" && !s.prepareReliableUserMessageLocked(stream, runID, payload, now) {
		return nil
	}
	if workerID := strings.TrimSpace(delta.GetWorkerId()); workerID != "" {
		payload["worker_id"] = workerID
	}
	chatwire.TrimLargeToolResultContent(payload, eventType)
	s.appendEventLocked(stream, runID, eventType, payload, now)
	return nil
}

func (s *conversationStreamStore) prepareReliableUserMessageLocked(
	stream *conversationStream,
	runID string,
	payload map[string]any,
	now time.Time,
) bool {
	record := s.runRecordLocked(stream.agentID, runID, stream.conversationID)
	if ref, ok := payload["base_message_ref"].(map[string]any); ok && !record.rebaseSeeded {
		messageID, _ := ref["message_id"].(string)
		contentHash, _ := ref["content_hash"].(string)
		if strings.TrimSpace(messageID) != "" || strings.TrimSpace(contentHash) != "" {
			record.rebaseSeeded = true
			s.appendSeededPayloadsLocked(stream, runID, record.clientRequestID, []map[string]any{{
				"type":             StreamEventRebased,
				"base_message_ref": ref,
				"reason":           "edit_resend",
			}}, now)
		}
	}
	if !record.userMessageSeeded {
		return true
	}
	messageID, _ := payload["message_id"].(string)
	if strings.TrimSpace(messageID) == "" {
		if ref, ok := payload["message_ref"].(map[string]any); ok {
			messageID, _ = ref["message_id"].(string)
		}
	}
	if strings.TrimSpace(messageID) == "" || record.userMessageIdentityForwarded {
		return false
	}
	record.userMessageIdentityForwarded = true
	return true
}

func (s *conversationStreamStore) touchChatIngressRunLocked(stream *conversationStream, runID string, now time.Time) {
	stream.lastEventAt = now
	stream.updatedAt = now
	if stream.activity != nil && stream.activity.RunID == runID {
		stream.activity.UpdatedAt = now
	}
}

func (s *conversationStreamStore) appendChatIngressProjectionLocked(
	stream *conversationStream,
	runID string,
	projection chatIngressProjection,
	entriesJSON string,
	now time.Time,
) {
	s.runStartedLocked(stream, runID, "", now)
	contentComplete := projection.GetContentComplete()
	historyRequired := projection.GetHistoryRequired()
	sha := strings.ToLower(strings.TrimSpace(projection.GetSha256()))
	degraded := len(entriesJSON) > chatIngressBrowserProjectionMaxBytes
	if degraded {
		// Deliverability bound: browsers cannot receive a frame this large.
		// The stream event degrades to a history_required marker; the sha of
		// the replaced projection would be misleading, so it is dropped.
		entriesJSON = "[]"
		contentComplete = false
		historyRequired = true
		sha = ""
	}
	payload := map[string]any{
		"revision":         projection.GetRevision(),
		"entries_json":     entriesJSON,
		"content_complete": contentComplete,
		"history_required": historyRequired,
		"sha256":           sha,
	}
	stream.latestContentSnapshotSeq = stream.lastSeq + 1
	event := s.appendEventLocked(stream, runID, StreamEventContentSnapshot, payload, now)
	if degraded {
		// RunSnapshot carries no history_required/content_complete flags, so
		// hydration consumers would treat "[]" as authoritative and wipe the
		// streamed content. Keep the previous snapshot state; the snapshot-less
		// resubscribe path marks contentStale and history converges.
		return
	}
	stream.latestSnapshot = &RunSnapshot{
		RunID:       runID,
		Revision:    int64(projection.GetRevision()),
		EntriesJSON: entriesJSON,
		AsOfSeq:     event.Seq,
		UpdatedAt:   now,
	}
	stream.runNeedsSnapshot = false
	stream.snapshotDirty = false
}

func decodeChatIngressProjection(projection chatIngressProjection) (string, error) {
	if projection == nil {
		return "", newChatIngressRecordError("invalid_checkpoint", "checkpoint projection is required")
	}
	declared := projection.GetUncompressedBytes()
	if declared > chatIngressProjectionMaxBytes {
		return "", newChatIngressRecordError("projection_too_large", "uncompressed projection exceeds 64 MiB")
	}
	if len(projection.GetCompressedProjection()) == 0 {
		return "", newChatIngressRecordError("invalid_checkpoint", "compressed projection is required")
	}
	if len(projection.GetCompressedProjection()) > chatIngressProjectionMaxBytes {
		return "", newChatIngressRecordError("projection_too_large", "compressed projection exceeds 64 MiB")
	}
	decoder, err := zstd.NewReader(
		bytes.NewReader(projection.GetCompressedProjection()),
		zstd.WithDecoderMaxMemory(chatIngressProjectionMaxBytes),
	)
	if err != nil {
		return "", newChatIngressRecordError("invalid_projection_compression", "cannot initialize zstd decoder: %v", err)
	}
	defer decoder.Close()
	decoded, err := io.ReadAll(io.LimitReader(decoder, chatIngressProjectionMaxBytes+1))
	if err != nil {
		return "", newChatIngressRecordError("invalid_projection_compression", "cannot decompress projection: %v", err)
	}
	if len(decoded) > chatIngressProjectionMaxBytes {
		return "", newChatIngressRecordError("projection_too_large", "uncompressed projection exceeds 64 MiB")
	}
	if uint64(len(decoded)) != declared {
		return "", newChatIngressRecordError("projection_size_mismatch", "projection size is %d bytes, expected %d", len(decoded), declared)
	}
	wantHash := strings.ToLower(strings.TrimSpace(projection.GetSha256()))
	if len(wantHash) != sha256.Size*2 {
		return "", newChatIngressRecordError("invalid_projection_sha256", "projection sha256 must be a 64-character hex digest")
	}
	if _, err := hex.DecodeString(wantHash); err != nil {
		return "", newChatIngressRecordError("invalid_projection_sha256", "projection sha256 is not valid hexadecimal")
	}
	actualHash := sha256.Sum256(decoded)
	if hex.EncodeToString(actualHash[:]) != wantHash {
		return "", newChatIngressRecordError("projection_hash_mismatch", "projection sha256 does not match decompressed content")
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(decoded, &entries); err != nil || entries == nil {
		return "", newChatIngressRecordError("invalid_projection_json", "projection must be a JSON array")
	}
	return string(decoded), nil
}

func (m *Manager) ingestChatIngressResume(agentID string, resume *gatewayv2.ChatIngressResume) []*gatewayv2.ChatIngressAck {
	if resume == nil {
		return nil
	}
	s := m.convStreams
	now := time.Now()
	agentID = strings.TrimSpace(agentID)
	s.mu.Lock()
	defer s.mu.Unlock()

	acks := make([]*gatewayv2.ChatIngressAck, 0, len(resume.GetRuns()))
	for _, run := range resume.GetRuns() {
		if run == nil {
			continue
		}
		runID := strings.TrimSpace(run.GetRunId())
		conversationID := strings.TrimSpace(run.GetConversationId())
		key := agentScopedKey(agentID, runID)
		state := s.ingressRuns[key]
		if agentID == "" || runID == "" || conversationID == "" || run.GetNextSeq() == 0 {
			acks = append(acks, rejectedChatIngressAck(runID, conversationID, state, "invalid_resume", "run_id, conversation_id and next_seq are required"))
			continue
		}
		if state == nil {
			state = &chatIngressRunState{
				conversationID: conversationID,
				updatedAt:      now,
			}
			s.ingressRuns[key] = state
			s.startReaper()
			requestChatIngressCheckpoint(agentID, runID, conversationID, state, 1, "missing_cursor")
			acks = append(acks, checkpointChatIngressAck(runID, conversationID, state))
			continue
		}
		if state.conversationID != conversationID {
			acks = append(acks, rejectedChatIngressAck(runID, conversationID, state, "conversation_mismatch", "run is already bound to another conversation"))
			continue
		}
		state.updatedAt = now
		if state.terminalCommitted {
			acks = append(acks, continueChatIngressAck(runID, conversationID, state))
			continue
		}
		expected := state.committedThrough + 1
		switch {
		case expected == run.GetNextSeq():
			acks = append(acks, continueChatIngressAck(runID, conversationID, state))
		case expected > run.GetNextSeq():
			acks = append(acks, continueChatIngressAck(runID, conversationID, state))
		case run.GetReplayFromSeq() > 0 && expected >= run.GetReplayFromSeq() && expected <= run.GetReplayThroughSeq():
			noteChatIngressReplay(agentID, runID, conversationID, state, expected, "resume_replay")
			acks = append(acks, replayChatIngressAck(runID, conversationID, state))
		default:
			state.updatedAt = now
			requestChatIngressCheckpoint(agentID, runID, conversationID, state, expected, "replay_window_miss")
			acks = append(acks, checkpointChatIngressAck(runID, conversationID, state))
		}
	}
	return acks
}

func (m *Manager) ingestChatIngressFragment(agentID string, fragment *gatewayv2.ChatIngressFragment) *gatewayv2.ChatIngressAck {
	if fragment == nil {
		return rejectedChatIngressFragmentAck(agentID, nil, nil, "invalid_fragment", "chat ingress fragment is required")
	}
	runID := strings.TrimSpace(fragment.GetRunId())
	conversationID := strings.TrimSpace(fragment.GetConversationId())
	fragmentHash := strings.ToLower(strings.TrimSpace(fragment.GetSha256()))
	key := chatIngressFragmentKey(agentID, runID, fragment.GetSourceSeq())
	now := time.Now()
	s := m.convStreams

	s.mu.Lock()
	for fragmentKey, assembly := range s.ingressFragments {
		if now.After(assembly.expiresAt) {
			delete(s.ingressFragments, fragmentKey)
		}
	}
	state := s.ingressRuns[agentScopedKey(agentID, runID)]
	if strings.TrimSpace(agentID) == "" || runID == "" || conversationID == "" || fragment.GetSourceSeq() == 0 {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "invalid_fragment", "agent_id, run_id, conversation_id and source_seq are required")
	}
	if state != nil && state.conversationID != conversationID {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "conversation_mismatch", "run is already bound to another conversation")
	}
	if state != nil {
		state.updatedAt = now
	}
	if fragment.GetFragmentCount() == 0 || fragment.GetFragmentCount() > chatIngressFragmentMaxCount || fragment.GetFragmentIndex() >= fragment.GetFragmentCount() {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "invalid_fragment_index", "fragment index or count is invalid")
	}
	if len(fragment.GetEncodedRecordChunk()) == 0 || len(fragment.GetEncodedRecordChunk()) > chatIngressFragmentChunkBytes {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "fragment_chunk_too_large", "fragment chunk must be between 1 byte and 64 KiB")
	}
	if fragment.GetEncodedRecordBytes() == 0 || fragment.GetEncodedRecordBytes() > chatIngressEncodedRecordMaxBytes {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "fragment_record_too_large", "encoded record exceeds the bounded projection framing limit")
	}
	if len(fragmentHash) != sha256.Size*2 {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "invalid_fragment_sha256", "fragment sha256 must be a 64-character hex digest")
	}
	if _, err := hex.DecodeString(fragmentHash); err != nil {
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "invalid_fragment_sha256", "fragment sha256 is not valid hexadecimal")
	}
	if state != nil {
		expected := state.committedThrough + 1
		if fragment.GetSourceSeq() < expected {
			s.mu.Unlock()
			return continueChatIngressAck(runID, conversationID, state)
		}
		if fragment.GetSourceSeq() > expected && !state.checkpointRequested {
			ack := recoverChatIngressGap(
				agentID,
				runID,
				conversationID,
				state,
				expected,
				"fragment_sequence_gap",
			)
			s.mu.Unlock()
			return ack
		}
	}
	assembly := s.ingressFragments[key]
	if assembly == nil {
		assembly = &chatIngressFragmentAssembly{
			conversationID:     conversationID,
			fragmentCount:      fragment.GetFragmentCount(),
			encodedRecordBytes: fragment.GetEncodedRecordBytes(),
			sha256:             fragmentHash,
			chunks:             make([][]byte, fragment.GetFragmentCount()),
			expiresAt:          now.Add(chatIngressFragmentTTL),
		}
		s.ingressFragments[key] = assembly
		s.startReaper()
	}
	if assembly.conversationID != conversationID ||
		assembly.fragmentCount != fragment.GetFragmentCount() ||
		assembly.encodedRecordBytes != fragment.GetEncodedRecordBytes() ||
		assembly.sha256 != fragmentHash {
		delete(s.ingressFragments, key)
		s.mu.Unlock()
		return rejectedChatIngressFragmentAck(agentID, fragment, state, "fragment_metadata_mismatch", "fragment metadata changed during assembly")
	}
	chunk := fragment.GetEncodedRecordChunk()
	index := fragment.GetFragmentIndex()
	if existing := assembly.chunks[index]; existing != nil {
		if !bytes.Equal(existing, chunk) {
			delete(s.ingressFragments, key)
			s.mu.Unlock()
			return rejectedChatIngressFragmentAck(agentID, fragment, state, "fragment_conflict", "duplicate fragment index contains different bytes")
		}
	} else {
		assembly.chunks[index] = append([]byte(nil), chunk...)
		assembly.received++
		assembly.receivedBytes += uint64(len(chunk))
		if assembly.receivedBytes > assembly.encodedRecordBytes {
			delete(s.ingressFragments, key)
			s.mu.Unlock()
			return rejectedChatIngressFragmentAck(agentID, fragment, state, "fragment_size_mismatch", "assembled fragment bytes exceed encoded_record_bytes")
		}
	}
	if assembly.received != assembly.fragmentCount {
		s.mu.Unlock()
		return nil
	}
	encoded := make([]byte, 0, assembly.receivedBytes)
	for _, assembledChunk := range assembly.chunks {
		encoded = append(encoded, assembledChunk...)
	}
	delete(s.ingressFragments, key)
	stateSnapshot := cloneChatIngressRunState(state)
	s.mu.Unlock()

	if uint64(len(encoded)) != assembly.encodedRecordBytes {
		return rejectedChatIngressFragmentAck(agentID, fragment, stateSnapshot, "fragment_size_mismatch", "assembled record is %d bytes, expected %d", len(encoded), assembly.encodedRecordBytes)
	}
	actualHash := sha256.Sum256(encoded)
	if hex.EncodeToString(actualHash[:]) != assembly.sha256 {
		return rejectedChatIngressFragmentAck(agentID, fragment, stateSnapshot, "fragment_hash_mismatch", "assembled record sha256 does not match")
	}
	var record gatewayv2.ChatIngressRecord
	if err := proto.Unmarshal(encoded, &record); err != nil {
		return rejectedChatIngressFragmentAck(agentID, fragment, stateSnapshot, "invalid_fragment_record", "assembled record is not valid protobuf: %v", err)
	}
	return m.ingestChatIngressRecords(agentID, runID, conversationID, fragment.GetSourceSeq(), []*gatewayv2.ChatIngressRecord{&record})
}

func cloneChatIngressRunState(state *chatIngressRunState) *chatIngressRunState {
	if state == nil {
		return nil
	}
	cloned := *state
	return &cloned
}

func noteChatIngressGap(
	agentID string,
	runID string,
	conversationID string,
	state *chatIngressRunState,
	expected uint64,
	reason string,
) {
	if state == nil || state.gapObservedAt == expected {
		return
	}
	state.gapObservedAt = expected
	observability.Usage.ChatIngressGapsTotal.Add(1)
	slog.Warn("chat_ingress_gap",
		"agent_id", agentID,
		"run_id", runID,
		"conversation_id", conversationID,
		"seq", expected,
		"reason", reason,
	)
}

func recoverChatIngressGap(
	agentID string,
	runID string,
	conversationID string,
	state *chatIngressRunState,
	expected uint64,
	reason string,
) *gatewayv2.ChatIngressAck {
	noteChatIngressGap(agentID, runID, conversationID, state, expected, reason)
	if state.checkpointRequested || state.replayRequestedAt == expected {
		requestChatIngressCheckpoint(agentID, runID, conversationID, state, expected, reason)
		return checkpointChatIngressAck(runID, conversationID, state)
	}
	noteChatIngressReplay(agentID, runID, conversationID, state, expected, reason)
	return replayChatIngressAck(runID, conversationID, state)
}

func requestChatIngressCheckpoint(
	agentID string,
	runID string,
	conversationID string,
	state *chatIngressRunState,
	expected uint64,
	reason string,
) {
	if state == nil || state.checkpointRequested {
		return
	}
	state.checkpointRequested = true
	state.replayRequestedAt = 0
	observability.Usage.ChatIngressCheckpointRequestsTotal.Add(1)
	slog.Info("chat_ingress_checkpoint_requested",
		"agent_id", agentID,
		"run_id", runID,
		"conversation_id", conversationID,
		"seq", expected,
		"reason", reason,
	)
}

func noteChatIngressReplay(
	agentID string,
	runID string,
	conversationID string,
	state *chatIngressRunState,
	expected uint64,
	reason string,
) {
	if state == nil || state.replayRequestedAt == expected {
		return
	}
	state.replayRequestedAt = expected
	observability.Usage.ChatIngressReplayRequestsTotal.Add(1)
	slog.Warn("chat_ingress_replay_requested",
		"agent_id", agentID,
		"run_id", runID,
		"conversation_id", conversationID,
		"seq", expected,
		"reason", reason,
	)
}

func noteChatIngressCheckpointCommitted(
	agentID string,
	runID string,
	conversationID string,
	producerSeq uint64,
	checkpoint *gatewayv2.ChatIngressCheckpoint,
) {
	observability.Usage.ChatIngressCheckpointsCommittedTotal.Add(1)
	slog.Info("chat_ingress_checkpoint_committed",
		"agent_id", agentID,
		"run_id", runID,
		"conversation_id", conversationID,
		"seq", producerSeq,
		"hash", normalizedProjectionHash(checkpoint),
		"size", checkpoint.GetUncompressedBytes(),
		"reason", "checkpoint_committed",
	)
}

func noteChatIngressTerminalCommitted(
	agentID string,
	runID string,
	conversationID string,
	producerSeq uint64,
	terminal *gatewayv2.ChatIngressTerminal,
) {
	observability.Usage.ChatIngressTerminalsCommittedTotal.Add(1)
	slog.Info("chat_ingress_terminal_committed",
		"agent_id", agentID,
		"run_id", runID,
		"conversation_id", conversationID,
		"seq", producerSeq,
		"hash", normalizedProjectionHash(terminal),
		"size", terminal.GetUncompressedBytes(),
		"reason", "terminal_"+strings.TrimSpace(terminal.GetState()),
	)
}

func rejectedChatIngressFragmentAck(
	agentID string,
	fragment *gatewayv2.ChatIngressFragment,
	state *chatIngressRunState,
	code string,
	format string,
	args ...any,
) *gatewayv2.ChatIngressAck {
	runID := ""
	conversationID := ""
	var sourceSeq uint64
	var size uint64
	hash := ""
	if fragment != nil {
		runID = strings.TrimSpace(fragment.GetRunId())
		conversationID = strings.TrimSpace(fragment.GetConversationId())
		sourceSeq = fragment.GetSourceSeq()
		size = fragment.GetEncodedRecordBytes()
		hash = safeChatIngressHash(fragment.GetSha256())
	}
	rejected := observability.Usage.ChatIngressFragmentRejectsTotal.Add(1)
	if rejected == 1 || rejected%100 == 0 {
		slog.Warn("chat_ingress_fragment_rejected",
			"agent_id", strings.TrimSpace(agentID),
			"run_id", runID,
			"conversation_id", conversationID,
			"seq", sourceSeq,
			"hash", hash,
			"size", size,
			"reason", code,
		)
	}
	return rejectedChatIngressAck(runID, conversationID, state, code, format, args...)
}

func safeChatIngressHash(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if len(normalized) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(normalized); err != nil {
		return ""
	}
	return normalized
}

func (s *conversationStreamStore) reliableIngressOwnsRunLocked(agentID, runID string) bool {
	return s.ingressRuns[agentScopedKey(agentID, runID)] != nil
}

func chatIngressFragmentKey(agentID, runID string, sourceSeq uint64) string {
	return fmt.Sprintf("%s\x00%s\x00%d", strings.TrimSpace(agentID), strings.TrimSpace(runID), sourceSeq)
}

func isChatIngressProjectionRecord(record *gatewayv2.ChatIngressRecord) bool {
	return record != nil && (record.GetCheckpoint() != nil || record.GetTerminal() != nil)
}

func projectionFromRecord(record *gatewayv2.ChatIngressRecord) chatIngressProjection {
	if record == nil {
		return nil
	}
	if checkpoint := record.GetCheckpoint(); checkpoint != nil {
		return checkpoint
	}
	if terminal := record.GetTerminal(); terminal != nil {
		return terminal
	}
	return nil
}

func normalizedProjectionHash(projection chatIngressProjection) string {
	if projection == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(projection.GetSha256()))
}

func validateProjectionRevision(state *chatIngressRunState, projection chatIngressProjection, kind string) error {
	if state == nil || projection == nil {
		return nil
	}
	revision := projection.GetRevision()
	if revision < state.latestCheckpointRevision {
		return newChatIngressRecordError("stale_checkpoint", "%s revision %d is older than committed revision %d", kind, revision, state.latestCheckpointRevision)
	}
	if revision == state.latestCheckpointRevision && state.latestCheckpointHash != "" && normalizedProjectionHash(projection) != state.latestCheckpointHash {
		return newChatIngressRecordError("conflicting_checkpoint_revision", "%s revision %d conflicts with the committed projection hash", kind, revision)
	}
	return nil
}

func validateDuplicateTerminal(state *chatIngressRunState, firstSeq uint64, records []*gatewayv2.ChatIngressRecord) error {
	if state == nil || !state.terminalCommitted || state.terminalSeq < firstSeq {
		return nil
	}
	offset := state.terminalSeq - firstSeq
	if offset >= uint64(len(records)) {
		return nil
	}
	terminal := records[offset].GetTerminal()
	if terminal == nil || normalizedProjectionHash(terminal) != state.terminalHash {
		return newChatIngressRecordError("conflicting_terminal", "producer sequence %d conflicts with the committed terminal", state.terminalSeq)
	}
	return nil
}

func ingressErrorCode(err error) string {
	if ingressErr, ok := err.(*chatIngressRecordError); ok {
		return ingressErr.code
	}
	return "invalid_record"
}

func continueChatIngressAck(runID, conversationID string, state *chatIngressRunState) *gatewayv2.ChatIngressAck {
	return chatIngressAck(runID, conversationID, state, gatewayv2.ChatIngressAck_CONTINUE, "", "")
}

func replayChatIngressAck(runID, conversationID string, state *chatIngressRunState) *gatewayv2.ChatIngressAck {
	return chatIngressAck(runID, conversationID, state, gatewayv2.ChatIngressAck_REPLAY_FROM_EXPECTED, "sequence_gap", "producer sequence gap detected")
}

func checkpointChatIngressAck(runID, conversationID string, state *chatIngressRunState) *gatewayv2.ChatIngressAck {
	return chatIngressAck(runID, conversationID, state, gatewayv2.ChatIngressAck_SEND_CHECKPOINT, "checkpoint_required", "gateway cursor is outside the retained replay window")
}

func rejectedChatIngressAck(runID, conversationID string, state *chatIngressRunState, code, format string, args ...any) *gatewayv2.ChatIngressAck {
	return chatIngressAck(runID, conversationID, state, gatewayv2.ChatIngressAck_REJECTED, code, fmt.Sprintf(format, args...))
}

func chatIngressAck(
	runID string,
	conversationID string,
	state *chatIngressRunState,
	action gatewayv2.ChatIngressAck_Action,
	errorCode string,
	errorMessage string,
) *gatewayv2.ChatIngressAck {
	ack := &gatewayv2.ChatIngressAck{
		RunId:          runID,
		ConversationId: conversationID,
		ExpectedNext:   1,
		Action:         action,
		ErrorCode:      errorCode,
		ErrorMessage:   errorMessage,
	}
	if state != nil {
		ack.CommittedThrough = state.committedThrough
		ack.ExpectedNext = state.committedThrough + 1
		ack.TerminalCommitted = state.terminalCommitted
	}
	return ack
}
