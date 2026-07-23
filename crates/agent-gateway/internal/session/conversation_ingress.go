package session

import (
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/chatwire"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Ingress normalization: the three agent-facing envelope payloads (ChatEvent,
// ChatControlEvent, ChatRuntimeSnapshot) converge here into one append API on
// the conversation stream store. Payload shaping and tool-result trimming
// happen exactly once, so every subscriber observes identical events.

func (m *Manager) ingestChatEvent(agentID, requestID string, event *gatewayv2.ChatEvent) {
	if event == nil {
		return
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	s := m.convStreams
	runID := strings.TrimSpace(requestID)
	if runID == "" {
		return
	}
	now := time.Now()
	epoch := m.sessionEpochOf(agentID)

	s.mu.Lock()
	defer s.mu.Unlock()

	conversationID := s.resolveConversationLocked(agentID, runID, strings.TrimSpace(event.GetConversationId()), now)
	if conversationID == "" {
		return
	}
	existingStream := s.streams[conversationStreamKey(agentID, conversationID)]
	streamWasUnknown := existingStream == nil ||
		(existingStream.lastSeq == 0 && existingStream.activity == nil)
	stream := s.streamLocked(agentID, conversationID, now)
	// 入站事件按已认证会话身份盖章会话流归属（伪造不可能：id 来自握手）。
	if agentID != "" {
		stream.agentID = agentID
	}
	s.noteAgentEpochLocked(stream, epoch)

	payload := chatwire.EventPayload(event, 0)
	eventType, _ := payload["type"].(string)
	if eventType == "" {
		eventType = chatwire.EventTypeName(event.GetType())
	}

	if event.GetType() == gatewayv2.ChatEvent_USER_MESSAGE {
		if record := s.runs[agentScopedKey(agentID, runID)]; record != nil && record.userMessageSeeded {
			messageID, _ := payload["message_id"].(string)
			if strings.TrimSpace(messageID) == "" {
				// The full stable ref (edit-resend rebase anchoring) carries
				// the same id; either field proves the echo has new identity.
				if ref, ok := payload["message_ref"].(map[string]any); ok {
					refMessageID, _ := ref["message_id"].(string)
					messageID = refMessageID
				}
			}
			if strings.TrimSpace(messageID) == "" || record.userMessageIdentityForwarded {
				// The gateway already appended this run's user_message at accept
				// time. A plain or replayed agent echo adds no new identity.
				return
			}
			// Forward one authoritative desktop echo carrying the stable message
			// identity (message_id, plus message_ref so a follow-up edit-resend
			// can anchor its rebase). WebUI upserts it into the run's single user
			// slot, so this enriches identity without creating a second bubble.
			record.userMessageIdentityForwarded = true
		}
	}

	if stream.runFinishedRecently(runID) {
		// A live event for a run whose terminal was merely inferred proves the
		// inference wrong — reopen the run instead of dropping its stream.
		if !s.resurrectRunLocked(stream, runID) {
			// Late straggler after a genuine or duplicate terminal; drop it.
			return
		}
	}

	switch event.GetType() {
	case gatewayv2.ChatEvent_DONE:
		delete(payload, "type")
		delete(payload, "seq")
		s.runFinishedLocked(stream, runID, "completed", "", "", payload, now)
		return
	case gatewayv2.ChatEvent_ERROR:
		message, _ := payload["message"].(string)
		delete(payload, "type")
		delete(payload, "seq")
		delete(payload, "message")
		s.runFinishedLocked(stream, runID, "failed", "", strings.TrimSpace(message), payload, now)
		return
	}

	if event.GetType() == gatewayv2.ChatEvent_USER_MESSAGE {
		// A GUI-local edit-resend: the desktop truncated its own history and
		// stamped the truncation base onto its user_message. Broadcast the
		// same rebased event the webui edit path seeds, so every subscriber
		// truncates before the new user message renders (webui commands never
		// reach here — their echo was swallowed above).
		if ref, ok := payload["base_message_ref"].(map[string]any); ok {
			messageID, _ := ref["message_id"].(string)
			contentHash, _ := ref["content_hash"].(string)
			if strings.TrimSpace(messageID) != "" || strings.TrimSpace(contentHash) != "" {
				record := s.runRecordLocked(agentID, runID, conversationID)
				if !record.rebaseSeeded {
					record.rebaseSeeded = true
					s.appendSeededPayloadsLocked(stream, runID, record.clientRequestID, []map[string]any{{
						"type":             StreamEventRebased,
						"base_message_ref": ref,
						"reason":           "edit_resend",
					}}, now)
				}
			}
		}
	}

	workdir, _ := payload["workdir"].(string)
	s.runStartedLocked(stream, runID, strings.TrimSpace(workdir), now)
	if stream.activity == nil || stream.activity.RunID != runID {
		// runStartedLocked declined (e.g. the run finished during
		// supersession bookkeeping); do not attribute events to another run.
		return
	}
	if streamWasUnknown && event.GetType() != gatewayv2.ChatEvent_USER_MESSAGE {
		// A mid-run delta recreated this stream (gateway restarted while the
		// run was streaming): the run's earlier events are unrecoverable from
		// the log, so late joiners must hydrate from the runtime snapshot.
		stream.runNeedsSnapshot = true
	}

	if event.GetType() == gatewayv2.ChatEvent_TOOL_STATUS {
		status, _ := payload["status"].(string)
		isCompaction, _ := payload["isCompaction"].(bool)
		stream.activity.ToolStatus = strings.TrimSpace(status)
		stream.activity.ToolStatusIsCompaction = isCompaction
		stream.activity.UpdatedAt = now
	}

	delete(payload, "seq")
	s.appendEventLocked(stream, runID, eventType, payload, now)
}

func (m *Manager) ingestChatControl(agentID, requestID string, control *gatewayv2.ChatControlEvent) {
	if control == nil {
		return
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	s := m.convStreams
	runID := strings.TrimSpace(requestID)
	if runID == "" {
		runID = strings.TrimSpace(control.GetRequestId())
	}
	if runID == "" {
		return
	}
	controlType := strings.TrimSpace(control.GetType())
	if controlType == "" {
		controlType = strings.TrimSpace(control.GetState())
	}
	errorCode := strings.TrimSpace(control.GetErrorCode())
	message := strings.TrimSpace(control.GetMessage())
	now := time.Now()
	epoch := m.sessionEpochOf(agentID)

	s.mu.Lock()
	defer s.mu.Unlock()

	conversationID := s.resolveConversationLocked(agentID, runID, strings.TrimSpace(control.GetConversationId()), now)
	if conversationID == "" {
		// A control for a run the gateway has no conversation for yet (the
		// binding signal must carry a conversation id); ignore.
		return
	}
	stream := s.streamLocked(agentID, conversationID, now)
	// 入站事件按已认证会话身份盖章会话流归属（伪造不可能：id 来自握手）。
	if agentID != "" {
		stream.agentID = agentID
	}
	s.noteAgentEpochLocked(stream, epoch)

	switch controlType {
	case "started":
		// A reconnect republish may re-anchor a run this store wrongly gave up
		// on (inferred loss); resurrect before the started no-ops against the
		// finished set.
		if stream.runFinishedRecently(runID) && !s.resurrectRunLocked(stream, runID) {
			return
		}
		s.runStartedLocked(stream, runID, "", now)
	case "completed", "failed", "cancelled":
		inferredLoss := controlType == "failed" && isInferredRunLossCode(errorCode)
		if stream.runFinishedRecently(runID) {
			if inferredLoss || !s.resurrectRunLocked(stream, runID) {
				return
			}
		}
		// The desktop ledger flushes inferred losses (desktop_run_lost & co)
		// through this same channel. For the conversation's active run, ignore
		// such a verdict while the run's own events are fresh or it was
		// already falsified once — genuine terminals always pass.
		if inferredLoss &&
			stream.activity != nil && stream.activity.RunID == runID {
			record := s.runs[agentScopedKey(agentID, runID)]
			eventsFresh := !stream.lastEventAt.IsZero() &&
				now.Sub(stream.lastEventAt) < s.runReportLostTimeout
			if eventsFresh || (record != nil && record.revived) {
				return
			}
		}
		s.runFinishedLocked(stream, runID, controlType, errorCode, message, nil, now)
	case "queued_in_gui":
		s.markRunQueuedInGUILocked(stream, runID, now)
	case "accepted", "delivered", "claimed", "starting":
		record := s.runRecordLocked(agentID, runID, conversationID)
		s.markRunQueuedLocked(stream, runID, record.clientRequestID, now)
	}
}

// markRunQueuedInGUILocked handles a command the desktop app parked in its
// prompt queue: the run will not start now. Any provisionally seeded entries
// are compensated with a run_queued event so clients drop them (the prompt is
// visible in the queue UI instead), and the agent's later user_message echo —
// when the queued item finally runs — must pass through.
func (s *conversationStreamStore) markRunQueuedInGUILocked(
	stream *conversationStream,
	runID string,
	now time.Time,
) {
	if stream.runFinishedRecently(runID) {
		return
	}
	record := s.runRecordLocked(stream.agentID, runID, stream.conversationID)
	record.queuedInGUI = true
	seeded := record.userMessageSeeded
	record.userMessageSeeded = false
	// Seeds deferred at accept time never reached the log: drop them. The
	// prompt now lives in the desktop queue (editable there), and the agent's
	// echo is the authoritative text when the item eventually runs.
	record.deferredSeeds = nil

	if seeded {
		payload := map[string]any{}
		if record.clientRequestID != "" {
			payload["client_request_id"] = record.clientRequestID
		}
		s.appendEventLocked(stream, runID, StreamEventRunQueued, payload, now)
	}
	if stream.activity != nil && stream.activity.RunID == runID {
		stream.activity = nil
		s.publishActivityLocked(stream, now)
	}
	s.fireCommandUpdateLocked(ChatCommandUpdate{
		AgentID:         stream.agentID,
		RunID:           runID,
		ClientRequestID: record.clientRequestID,
		ConversationID:  stream.conversationID,
		Phase:           "queued_in_gui",
	})
}

func (m *Manager) ingestRuntimeSnapshot(agentID string, snapshot *gatewayv2.ChatRuntimeSnapshot) {
	if snapshot == nil {
		return
	}
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	s := m.convStreams
	runID := strings.TrimSpace(snapshot.GetRunId())
	conversationID := strings.TrimSpace(snapshot.GetConversationId())
	if runID == "" || conversationID == "" {
		return
	}
	state := strings.TrimSpace(snapshot.GetState())
	now := time.Now()
	epoch := m.sessionEpochOf(agentID)

	s.mu.Lock()
	defer s.mu.Unlock()

	conversationID = s.resolveConversationLocked(agentID, runID, conversationID, now)
	existingStream := s.streams[conversationStreamKey(agentID, conversationID)]
	streamWasUnknown := existingStream == nil || (existingStream.lastSeq == 0 && existingStream.activity == nil)
	stream := s.streamLocked(agentID, conversationID, now)
	// 入站事件按已认证会话身份盖章会话流归属（伪造不可能：id 来自握手）。
	if agentID != "" {
		stream.agentID = agentID
	}
	s.noteAgentEpochLocked(stream, epoch)
	if stream.runFinishedRecently(runID) {
		// Both running and terminal snapshots are authoritative runtime
		// evidence. A terminal snapshot must be able to correct an earlier
		// inferred loss even when no token arrived between the two verdicts.
		if !s.resurrectRunLocked(stream, runID) {
			return
		}
	}

	switch state {
	case "completed", "failed", "cancelled":
		s.runFinishedLocked(stream, runID, state, "", "", nil, now)
		return
	}
	next := &RunSnapshot{
		RunID:                  runID,
		Revision:               snapshot.GetRevision(),
		EntriesJSON:            strings.TrimSpace(snapshot.GetEntriesJson()),
		ToolStatus:             strings.TrimSpace(snapshot.GetToolStatus()),
		ToolStatusIsCompaction: snapshot.GetToolStatusIsCompaction(),
		Workdir:                strings.TrimSpace(snapshot.GetCwd()),
		AsOfSeq:                stream.lastSeq,
		UpdatedAt:              now,
	}
	if current := stream.latestSnapshot; current != nil &&
		current.RunID == runID &&
		current.Revision > next.Revision {
		// Stale revision; keep the newer snapshot.
		return
	}
	stream.latestSnapshot = next
	stream.updatedAt = now
	stream.lastEventAt = now

	if state == "running" || state == "" {
		if streamWasUnknown {
			// The gateway (re)started while this run was already streaming;
			// buffered history is gone, so late joiners need the snapshot.
			stream.runNeedsSnapshot = true
		}
		s.runStartedLocked(stream, runID, next.Workdir, now)
		if stream.activity != nil && stream.activity.RunID == runID {
			if next.ToolStatus != "" || stream.activity.ToolStatus != "" {
				stream.activity.ToolStatus = next.ToolStatus
				stream.activity.ToolStatusIsCompaction = next.ToolStatusIsCompaction
			}
			stream.activity.UpdatedAt = now
		}
	}

	if stream.snapshotDirty {
		// The agent reconnected mid-run: tokens streamed during the outage are
		// unrecoverable, so push the snapshot inline for attached subscribers.
		stream.snapshotDirty = false
		s.publishSnapshotLocked(stream, runID, next, now)
	}
}

// publishSnapshotLocked delivers a seq-less snapshot event to current
// subscribers without storing it in the log.
func (s *conversationStreamStore) publishSnapshotLocked(
	stream *conversationStream,
	runID string,
	snapshot *RunSnapshot,
	now time.Time,
) {
	payload := map[string]any{
		"conversation_id":           stream.conversationID,
		"run_id":                    runID,
		"type":                      StreamEventSnapshot,
		"revision":                  snapshot.Revision,
		"entries_json":              snapshot.EntriesJSON,
		"tool_status":               snapshot.ToolStatus,
		"tool_status_is_compaction": snapshot.ToolStatusIsCompaction,
		"as_of_seq":                 snapshot.AsOfSeq,
	}
	event := &ConversationEvent{
		ConversationID: stream.conversationID,
		RunID:          runID,
		Seq:            0,
		Type:           StreamEventSnapshot,
		Payload:        payload,
		ReceivedAt:     now,
	}
	s.publishLocked(stream, event)
}

// resolveConversationLocked determines the conversation a run belongs to,
// binding a pending webui command when the first agent signal carries a
// conversation id.
func (s *conversationStreamStore) resolveConversationLocked(
	agentID string,
	runID string,
	conversationID string,
	now time.Time,
) string {
	runKey := agentScopedKey(agentID, runID)
	if pending := s.pendingRuns[runKey]; pending != nil && conversationID != "" {
		s.bindPendingRunLocked(pending, conversationID, now)
	}
	if conversationID != "" {
		s.runRecordLocked(agentID, runID, conversationID)
		return conversationID
	}
	if record := s.runs[runKey]; record != nil {
		return record.conversationID
	}
	return ""
}

func (s *conversationStreamStore) bindPendingRunLocked(
	pending *pendingChatRun,
	conversationID string,
	now time.Time,
) {
	delete(s.pendingRuns, agentScopedKey(pending.agentID, pending.runID))
	stream := s.streamLocked(pending.agentID, conversationID, now)
	if pending.workdir != "" {
		stream.workdir = pending.workdir
	}
	record := s.runRecordLocked(pending.agentID, pending.runID, conversationID)
	record.clientRequestID = pending.clientRequestID
	s.markRunQueuedLocked(stream, pending.runID, pending.clientRequestID, now)
	acceptedSeq := s.appendSeededPayloadsLocked(
		stream, pending.runID, pending.clientRequestID, pending.seeded, now,
	)
	record.userMessageSeeded = seededPayloadsIncludeUserMessage(pending.seeded)
	record.rebaseSeeded = seededPayloadsIncludeRebased(pending.seeded)
	s.updateChatCommandDedupeLocked(
		pending.agentID,
		pending.clientRequestID,
		pending.runID,
		conversationID,
		acceptedSeq,
		now,
	)
	s.fireCommandUpdateLocked(ChatCommandUpdate{
		AgentID:         pending.agentID,
		RunID:           pending.runID,
		ClientRequestID: pending.clientRequestID,
		ConversationID:  conversationID,
		Phase:           "bound",
	})
}

// noteAgentEpochLocked tracks the agent session epoch per stream: when the
// agent reconnects mid-run, tokens streamed during the outage are lost, so
// the next runtime snapshot is pushed inline and offered to late joiners.
func (s *conversationStreamStore) noteAgentEpochLocked(stream *conversationStream, epoch uint64) {
	if epoch == 0 || stream.agentEpoch == epoch {
		return
	}
	if stream.agentEpoch != 0 && stream.activity != nil {
		stream.snapshotDirty = true
		stream.runNeedsSnapshot = true
	}
	stream.agentEpoch = epoch
}
