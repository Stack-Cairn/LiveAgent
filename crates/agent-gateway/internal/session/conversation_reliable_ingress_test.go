package session

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/observability"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestChatIngressDeduplicatesAndCommitsTerminalSnapshotBeforeFinish(t *testing.T) {
	manager := NewManager()
	projection := reliableIngressProjection(t, `[{"type":"assistant","content":"hello"}]`)
	batch := &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records: []*gatewayv2.ChatIngressRecord{
			reliableIngressDelta(`{"type":"token","text":"hello"}`),
			reliableIngressTerminal(projection, 1, "completed"),
		},
	}

	ack := manager.ingestChatIngressBatch("agent-1", batch)
	if ack.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || ack.GetCommittedThrough() != 2 || !ack.GetTerminalCommitted() {
		t.Fatalf("first ack = %#v", ack)
	}
	duplicateAck := manager.ingestChatIngressBatch("agent-1", batch)
	if duplicateAck.GetCommittedThrough() != 2 || !duplicateAck.GetTerminalCommitted() {
		t.Fatalf("duplicate ack = %#v", duplicateAck)
	}

	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer subscription.Cleanup()
	gotTypes := eventTypes(subscription.Events)
	wantTypes := []string{"run_started", "token", StreamEventContentSnapshot, "run_finished"}
	if strings.Join(gotTypes, ",") != strings.Join(wantTypes, ",") {
		t.Fatalf("event types = %v, want %v", gotTypes, wantTypes)
	}
	snapshot := subscription.Events[2]
	if snapshot.Payload["entries_json"] != `[{"type":"assistant","content":"hello"}]` {
		t.Fatalf("snapshot entries_json = %#v", snapshot.Payload["entries_json"])
	}
	if snapshot.Seq+1 != subscription.Events[3].Seq {
		t.Fatalf("snapshot seq %d is not immediately before terminal seq %d", snapshot.Seq, subscription.Events[3].Seq)
	}
}

func TestChatIngressResumeAfterTerminalSnapshotReplaysFinish(t *testing.T) {
	manager := NewManager()
	projection := reliableIngressProjection(t, `[{"type":"assistant","content":"complete reply"}]`)
	ack := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records: []*gatewayv2.ChatIngressRecord{
			reliableIngressDelta(`{"type":"token","text":"partial"}`),
			reliableIngressTerminal(projection, 1, "completed"),
		},
	})
	if !ack.GetTerminalCommitted() {
		t.Fatalf("terminal ack = %#v", ack)
	}

	initial := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	var snapshotSeq int64
	for _, event := range initial.Events {
		if event.Type == StreamEventContentSnapshot {
			snapshotSeq = event.Seq
			break
		}
	}
	initial.Cleanup()
	if snapshotSeq == 0 {
		t.Fatalf("terminal snapshot missing from replay: %v", eventTypes(initial.Events))
	}

	resumed := manager.SubscribeConversationStream(
		"agent-1",
		"conv-1",
		snapshotSeq,
		initial.StreamEpoch,
	)
	defer resumed.Cleanup()
	if resumed.Reset {
		t.Fatal("resume after retained snapshot unexpectedly reset")
	}
	if len(resumed.Events) != 1 {
		t.Fatalf("resume events = %v, want only run_finished", eventTypes(resumed.Events))
	}
	finished := resumed.Events[0]
	if finished.Type != StreamEventRunFinished || finished.RunID != "run-1" {
		t.Fatalf("resumed event = %s/%s, want run_finished/run-1", finished.Type, finished.RunID)
	}
	if finished.Seq != snapshotSeq+1 || finished.Payload["status"] != "completed" {
		t.Fatalf("resumed finish seq/status = %d/%v, want %d/completed", finished.Seq, finished.Payload["status"], snapshotSeq+1)
	}
}

func TestChatIngressGapAndInvalidTerminalDoNotAdvanceCursor(t *testing.T) {
	manager := NewManager()
	first := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"a"}`)},
	})
	if first.GetCommittedThrough() != 1 {
		t.Fatalf("first ack = %#v", first)
	}

	gap := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       3,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"c"}`)},
	})
	if gap.GetAction() != gatewayv2.ChatIngressAck_REPLAY_FROM_EXPECTED || gap.GetExpectedNext() != 2 {
		t.Fatalf("gap ack = %#v", gap)
	}

	badProjection := reliableIngressProjection(t, `["complete"]`)
	badProjection.sha256 = strings.Repeat("0", 64)
	rejected := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       2,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(badProjection, 1, "completed")},
	})
	if rejected.GetAction() != gatewayv2.ChatIngressAck_REJECTED || rejected.GetErrorCode() != "projection_hash_mismatch" {
		t.Fatalf("rejected ack = %#v", rejected)
	}
	if rejected.GetCommittedThrough() != 1 || rejected.GetExpectedNext() != 2 || rejected.GetTerminalCommitted() {
		t.Fatalf("rejected cursor = %#v", rejected)
	}

	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer subscription.Cleanup()
	for _, event := range subscription.Events {
		if event.Type == StreamEventContentSnapshot || event.Type == StreamEventRunFinished {
			t.Fatalf("invalid terminal leaked event %q", event.Type)
		}
	}
}

func TestChatIngressRepeatedGapEscalatesToCheckpoint(t *testing.T) {
	manager := NewManager()
	first := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"a"}`)},
	})
	if first.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || first.GetCommittedThrough() != 1 {
		t.Fatalf("first ack = %#v", first)
	}

	late := &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-1",
		FirstSeq:       3,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"late"}`)},
	}
	firstGap := manager.ingestChatIngressBatch("agent-1", late)
	if firstGap.GetAction() != gatewayv2.ChatIngressAck_REPLAY_FROM_EXPECTED || firstGap.GetExpectedNext() != 2 {
		t.Fatalf("first gap ack = %#v", firstGap)
	}
	secondGap := manager.ingestChatIngressBatch("agent-1", late)
	if secondGap.GetAction() != gatewayv2.ChatIngressAck_SEND_CHECKPOINT || secondGap.GetExpectedNext() != 2 {
		t.Fatalf("repeated gap ack = %#v", secondGap)
	}
	stillMissing := manager.ingestChatIngressBatch("agent-1", late)
	if stillMissing.GetAction() != gatewayv2.ChatIngressAck_SEND_CHECKPOINT || stillMissing.GetExpectedNext() != 2 {
		t.Fatalf("post-request gap ack = %#v", stillMissing)
	}

	projection := reliableIngressProjection(t, `[]`)
	recovered := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-1",
		FirstSeq:       4,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressCheckpoint(projection, 3, 1)},
	})
	if recovered.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || recovered.GetCommittedThrough() != 4 || recovered.GetExpectedNext() != 5 {
		t.Fatalf("checkpoint recovery ack = %#v", recovered)
	}
}

func TestChatIngressResumeRequestsAndAcceptsCheckpointBaseline(t *testing.T) {
	manager := NewManager()
	acks := manager.ingestChatIngressResume("agent-1", &gatewayv2.ChatIngressResume{
		Runs: []*gatewayv2.ChatIngressRunResume{{
			RunId:            "run-1",
			ConversationId:   "conv-1",
			ReplayFromSeq:    7,
			ReplayThroughSeq: 9,
			NextSeq:          10,
		}},
	})
	if len(acks) != 1 || acks[0].GetAction() != gatewayv2.ChatIngressAck_SEND_CHECKPOINT {
		t.Fatalf("resume acks = %#v", acks)
	}

	projection := reliableIngressProjection(t, `[]`)
	ack := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       9,
		Records: []*gatewayv2.ChatIngressRecord{{
			Payload: &gatewayv2.ChatIngressRecord_Checkpoint{
				Checkpoint: &gatewayv2.ChatIngressCheckpoint{
					CoversThroughSeq:     8,
					Revision:             1,
					CompressedProjection: projection.compressed,
					UncompressedBytes:    uint64(len(projection.raw)),
					Sha256:               projection.sha256,
					ContentComplete:      false,
					HistoryRequired:      true,
				},
			},
		}},
	})
	if ack.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || ack.GetCommittedThrough() != 9 || ack.GetExpectedNext() != 10 {
		t.Fatalf("checkpoint baseline ack = %#v", ack)
	}
}

func TestChatIngressAbsentGapRequiresCheckpointAndExactCoverage(t *testing.T) {
	manager := NewManager()
	gap := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-1",
		FirstSeq:       3,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"late"}`)},
	})
	if gap.GetAction() != gatewayv2.ChatIngressAck_SEND_CHECKPOINT || gap.GetExpectedNext() != 1 {
		t.Fatalf("absent gap ack = %#v", gap)
	}

	projection := reliableIngressProjection(t, `[]`)
	badCoverage := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-1",
		FirstSeq:       3,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressCheckpoint(projection, 3, 1)},
	})
	if badCoverage.GetAction() != gatewayv2.ChatIngressAck_REJECTED || badCoverage.GetErrorCode() != "invalid_checkpoint_coverage" {
		t.Fatalf("bad coverage ack = %#v", badCoverage)
	}
	if badCoverage.GetCommittedThrough() != 0 {
		t.Fatalf("bad coverage advanced cursor: %#v", badCoverage)
	}

	accepted := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-1",
		FirstSeq:       3,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressCheckpoint(projection, 2, 1)},
	})
	if accepted.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || accepted.GetCommittedThrough() != 3 {
		t.Fatalf("checkpoint baseline ack = %#v", accepted)
	}
}

func TestChatIngressRejectsConflictingDuplicateTerminal(t *testing.T) {
	manager := NewManager()
	firstProjection := reliableIngressProjection(t, `[{"type":"assistant","content":"one"}]`)
	first := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-terminal",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(firstProjection, 0, "completed")},
	})
	if !first.GetTerminalCommitted() {
		t.Fatalf("first terminal ack = %#v", first)
	}

	conflictingProjection := reliableIngressProjection(t, `[{"type":"assistant","content":"two"}]`)
	conflict := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-terminal",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(conflictingProjection, 0, "completed")},
	})
	if conflict.GetAction() != gatewayv2.ChatIngressAck_REJECTED || conflict.GetErrorCode() != "conflicting_terminal" {
		t.Fatalf("conflicting terminal ack = %#v", conflict)
	}
}

func TestChatIngressFragmentReassemblesOneLogicalRecord(t *testing.T) {
	manager := NewManager()
	record := reliableIngressDelta(`{"type":"token","text":"fragmented"}`)
	encoded, err := proto.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(encoded)
	digest := hex.EncodeToString(hash[:])
	cut := len(encoded) / 2
	chunks := [][]byte{encoded[:cut], encoded[cut:]}

	for _, index := range []int{1, 0} {
		ack := manager.ingestChatIngressFragment("agent-1", &gatewayv2.ChatIngressFragment{
			RunId:              "run-1",
			ConversationId:     "conv-1",
			SourceSeq:          1,
			FragmentIndex:      uint32(index),
			FragmentCount:      uint32(len(chunks)),
			EncodedRecordChunk: chunks[index],
			EncodedRecordBytes: uint64(len(encoded)),
			Sha256:             digest,
		})
		if index == 1 && ack != nil {
			t.Fatalf("incomplete fragment unexpectedly acked: %#v", ack)
		}
		if index == 0 && (ack == nil || ack.GetAction() != gatewayv2.ChatIngressAck_CONTINUE) {
			t.Fatalf("fragment %d ack = %#v", index, ack)
		}
	}

	manager.convStreams.mu.Lock()
	state := cloneChatIngressRunState(manager.convStreams.ingressRuns[agentScopedKey("agent-1", "run-1")])
	manager.convStreams.mu.Unlock()
	if state == nil || state.committedThrough != 1 {
		t.Fatalf("fragment cursor = %#v", state)
	}
	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer subscription.Cleanup()
	if got := eventTypes(subscription.Events); strings.Join(got, ",") != "run_started,token" {
		t.Fatalf("fragment events = %v", got)
	}
}

func TestChatIngressRepeatedFragmentGapEscalatesToCheckpoint(t *testing.T) {
	manager := NewManager()
	first := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-fragment-gap",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"a"}`)},
	})
	if first.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || first.GetCommittedThrough() != 1 {
		t.Fatalf("first ack = %#v", first)
	}

	late := reliableIngressFragment(t, "run-fragment-gap", "conv-1", 3, reliableIngressDelta(`{"type":"token","text":"late"}`))
	firstGap := manager.ingestChatIngressFragment("agent-1", late)
	if firstGap.GetAction() != gatewayv2.ChatIngressAck_REPLAY_FROM_EXPECTED || firstGap.GetExpectedNext() != 2 {
		t.Fatalf("first fragment gap ack = %#v", firstGap)
	}
	secondGap := manager.ingestChatIngressFragment("agent-1", late)
	if secondGap.GetAction() != gatewayv2.ChatIngressAck_SEND_CHECKPOINT || secondGap.GetExpectedNext() != 2 {
		t.Fatalf("repeated fragment gap ack = %#v", secondGap)
	}

	projection := reliableIngressProjection(t, `[]`)
	checkpointFragments := reliableIngressFragments(
		t,
		"run-fragment-gap",
		"conv-1",
		4,
		reliableIngressCheckpoint(projection, 3, 1),
		2,
	)
	if incomplete := manager.ingestChatIngressFragment("agent-1", checkpointFragments[1]); incomplete != nil {
		t.Fatalf("incomplete checkpoint fragment ack = %#v", incomplete)
	}
	recovered := manager.ingestChatIngressFragment("agent-1", checkpointFragments[0])
	if recovered.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || recovered.GetCommittedThrough() != 4 || recovered.GetExpectedNext() != 5 {
		t.Fatalf("fragment checkpoint recovery ack = %#v", recovered)
	}
}

func TestChatIngressFragmentLimitsCoverMaximumProjectionWithDefaultChunks(t *testing.T) {
	if chatIngressEncodedRecordMaxBytes <= chatIngressProjectionMaxBytes {
		t.Fatalf("encoded record limit %d must leave room above projection limit %d", chatIngressEncodedRecordMaxBytes, chatIngressProjectionMaxBytes)
	}
	required := (chatIngressEncodedRecordMaxBytes + chatIngressFragmentDefaultBytes - 1) / chatIngressFragmentDefaultBytes
	if chatIngressFragmentMaxCount < required {
		t.Fatalf("fragment count limit %d cannot carry %d bytes in %d-byte chunks", chatIngressFragmentMaxCount, chatIngressEncodedRecordMaxBytes, chatIngressFragmentDefaultBytes)
	}
}

func TestChatIngressRunHeartbeatAdvancesCursorWithoutBrowserEvent(t *testing.T) {
	manager := NewManager()
	ack := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"run_heartbeat","conversation_id":"conv-1"}`)},
	})
	if ack.GetCommittedThrough() != 1 || ack.GetExpectedNext() != 2 {
		t.Fatalf("heartbeat ack = %#v", ack)
	}
	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer subscription.Cleanup()
	if len(subscription.Events) != 0 {
		t.Fatalf("heartbeat leaked browser events: %v", eventTypes(subscription.Events))
	}
}

func TestChatIngressOversizedProjectionDegradesToHistoryRequired(t *testing.T) {
	manager := NewManager()
	oversized := `[{"type":"assistant","content":"` +
		strings.Repeat("x", chatIngressBrowserProjectionMaxBytes) + `"}]`
	projection := reliableIngressProjection(t, oversized)
	ack := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records: []*gatewayv2.ChatIngressRecord{
			reliableIngressDelta(`{"type":"token","text":"hello"}`),
			reliableIngressCheckpoint(projection, 1, 1),
		},
	})
	if ack.GetAction() != gatewayv2.ChatIngressAck_CONTINUE || ack.GetCommittedThrough() != 2 {
		t.Fatalf("oversized projection ack = %#v", ack)
	}

	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer subscription.Cleanup()
	var snapshot *ConversationEvent
	for _, event := range subscription.Events {
		if event.Payload["type"] == StreamEventContentSnapshot {
			snapshot = event
		}
	}
	if snapshot == nil {
		t.Fatalf("no content snapshot event: %v", eventTypes(subscription.Events))
	}
	if snapshot.Payload["entries_json"] != "[]" {
		t.Fatalf("oversized projection was relayed to browsers: %d bytes", len(snapshot.Payload["entries_json"].(string)))
	}
	if snapshot.Payload["history_required"] != true || snapshot.Payload["content_complete"] != false {
		t.Fatalf("degraded snapshot flags = %#v", snapshot.Payload)
	}
	if snapshot.Payload["sha256"] != "" {
		t.Fatalf("degraded snapshot kept the original projection sha256: %#v", snapshot.Payload["sha256"])
	}
	// RunSnapshot carries no degradation flags, so hydration consumers would
	// treat "[]" as authoritative content; the degraded commit must leave
	// latestSnapshot untouched (nil here) so the snapshot-less resubscribe
	// path marks contentStale and history converges.
	manager.convStreams.mu.Lock()
	stream := manager.convStreams.streams[conversationStreamKey("agent-1", "conv-1")]
	latest := stream.latestSnapshot
	manager.convStreams.mu.Unlock()
	if latest != nil {
		t.Fatalf("degraded projection overwrote latestSnapshot: %#v", latest)
	}
}

func TestReliableIngressRunIgnoresLegacyTerminalSignals(t *testing.T) {
	manager := NewManager()
	manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"hello"}`)},
	})
	manager.ingestChatEvent("agent-1", "run-1", &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_DONE,
		ConversationId: "conv-1",
		Data:           `{}`,
	})
	manager.ingestChatControl("agent-1", "run-1", &gatewayv2.ChatControlEvent{
		RequestId:      "run-1",
		ConversationId: "conv-1",
		Type:           "completed",
	})
	manager.ingestRuntimeSnapshot("agent-1", &gatewayv2.ChatRuntimeSnapshot{
		RunId:          "run-1",
		ConversationId: "conv-1",
		State:          "completed",
	})
	manager.convStreams.onRuntimeStatus("agent-1", &gatewayv2.RuntimeStatusEvent{
		FinishedRuns: []*gatewayv2.ChatRunReport{{
			RunId:          "run-1",
			ConversationId: "conv-1",
			State:          "completed",
		}},
	}, time.Now())

	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	for _, event := range subscription.Events {
		if event.Type == StreamEventRunFinished {
			subscription.Cleanup()
			t.Fatal("legacy signal finished a reliable ingress run")
		}
	}
	subscription.Cleanup()

	projection := reliableIngressProjection(t, `[]`)
	ack := manager.ingestChatIngressBatch("agent-1", &gatewayv2.ChatIngressBatch{
		RunId:          "run-1",
		ConversationId: "conv-1",
		FirstSeq:       2,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(projection, 1, "completed")},
	})
	if !ack.GetTerminalCommitted() {
		t.Fatalf("reliable terminal ack = %#v", ack)
	}
	finalSubscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer finalSubscription.Cleanup()
	finished := 0
	for _, event := range finalSubscription.Events {
		if event.Type == StreamEventRunFinished {
			finished++
		}
	}
	if finished != 1 {
		t.Fatalf("run_finished count = %d, want 1", finished)
	}
}

func TestAgentStreamOverflowClosesOnlySlowStream(t *testing.T) {
	stream := &agentStream{
		ch:   make(chan *gatewayv2.AgentEnvelope, 1),
		done: make(chan struct{}),
	}
	if !stream.send(&gatewayv2.AgentEnvelope{RequestId: "first"}) {
		t.Fatal("first send failed")
	}
	result := make(chan bool, 1)
	go func() {
		result <- stream.send(&gatewayv2.AgentEnvelope{RequestId: "overflow"})
	}()
	select {
	case sent := <-result:
		if sent {
			t.Fatal("overflow send unexpectedly succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("slow agent stream blocked dispatcher")
	}
	select {
	case <-stream.done:
	default:
		t.Fatal("overflowed stream was not closed")
	}
}

func TestDispatchFromAgentQueuesChatIngressAck(t *testing.T) {
	manager := NewManager()
	agentSession := NewAgentSession(AuthSnapshot{AgentID: "agent-1", SessionID: "session-1"})
	manager.SetSession(agentSession)
	defer manager.ClearSession(agentSession)

	manager.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: "ingress-1",
		Payload: &gatewayv2.AgentEnvelope_ChatIngressBatch{
			ChatIngressBatch: &gatewayv2.ChatIngressBatch{
				RunId:          "run-1",
				ConversationId: "conv-1",
				FirstSeq:       1,
				Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"hello"}`)},
			},
		},
	})

	select {
	case outbound := <-agentSession.Outbound():
		if outbound.GetRequestId() != "ingress-1" {
			t.Fatalf("ack request id = %q", outbound.GetRequestId())
		}
		ack := outbound.GetChatIngressAck()
		if ack == nil || ack.GetCommittedThrough() != 1 || ack.GetAction() != gatewayv2.ChatIngressAck_CONTINUE {
			t.Fatalf("queued ack = %#v", ack)
		}
	case <-time.After(time.Second):
		t.Fatal("chat ingress ack was not queued")
	}
}

func TestCapableSessionRejectsLegacyChatMirrorTerminalPaths(t *testing.T) {
	manager := NewManager()
	agentSession := NewAgentSession(AuthSnapshot{AgentID: "agent-1", SessionID: "session-1"})
	agentSession.SetCapabilities([]string{gatewayv2.ChatIngressV1Capability})
	manager.SetSession(agentSession)
	defer manager.ClearSession(agentSession)

	manager.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: "run-legacy",
		Payload: &gatewayv2.AgentEnvelope_ChatEvent{ChatEvent: &gatewayv2.ChatEvent{
			Type:           gatewayv2.ChatEvent_DONE,
			ConversationId: "conv-1",
		}},
	})
	manager.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: "run-legacy",
		Payload: &gatewayv2.AgentEnvelope_ChatRuntimeSnapshot{ChatRuntimeSnapshot: &gatewayv2.ChatRuntimeSnapshot{
			RunId:          "run-legacy",
			ConversationId: "conv-1",
			State:          "completed",
		}},
	})
	manager.DispatchFromAgentForSession(agentSession, &gatewayv2.AgentEnvelope{
		RequestId: "run-legacy",
		Payload: &gatewayv2.AgentEnvelope_ChatControl{ChatControl: &gatewayv2.ChatControlEvent{
			RequestId:      "run-legacy",
			ConversationId: "conv-1",
			Type:           "completed",
		}},
	})

	subscription := manager.SubscribeConversationStream("agent-1", "conv-1", 0, "")
	defer subscription.Cleanup()
	if len(subscription.Events) != 0 {
		t.Fatalf("legacy mirror paths leaked events: %v", eventTypes(subscription.Events))
	}
}

func TestReliableIngressObservabilityCountsStateTransitionsOnce(t *testing.T) {
	manager := NewManager()
	gapBefore := observability.Usage.ChatIngressGapsTotal.Load()
	replayBefore := observability.Usage.ChatIngressReplayRequestsTotal.Load()
	checkpointRequestBefore := observability.Usage.ChatIngressCheckpointRequestsTotal.Load()
	checkpointCommittedBefore := observability.Usage.ChatIngressCheckpointsCommittedTotal.Load()
	terminalBefore := observability.Usage.ChatIngressTerminalsCommittedTotal.Load()
	fragmentRejectBefore := observability.Usage.ChatIngressFragmentRejectsTotal.Load()

	manager.ingestChatIngressBatch("agent-observe", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-gap",
		FirstSeq:       1,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"one"}`)},
	})
	gapBatch := &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-gap",
		FirstSeq:       3,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressDelta(`{"type":"token","text":"three"}`)},
	}
	manager.ingestChatIngressBatch("agent-observe", gapBatch)
	manager.ingestChatIngressBatch("agent-observe", gapBatch)

	resume := &gatewayv2.ChatIngressResume{Runs: []*gatewayv2.ChatIngressRunResume{{
		RunId:            "run-checkpoint",
		ConversationId:   "conv-checkpoint",
		ReplayFromSeq:    4,
		ReplayThroughSeq: 4,
		NextSeq:          5,
	}}}
	manager.ingestChatIngressResume("agent-observe", resume)
	manager.ingestChatIngressResume("agent-observe", resume)
	projection := reliableIngressProjection(t, `[]`)
	manager.ingestChatIngressBatch("agent-observe", &gatewayv2.ChatIngressBatch{
		RunId:          "run-checkpoint",
		ConversationId: "conv-checkpoint",
		FirstSeq:       4,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressCheckpoint(projection, 3, 1)},
	})
	manager.ingestChatIngressBatch("agent-observe", &gatewayv2.ChatIngressBatch{
		RunId:          "run-gap",
		ConversationId: "conv-gap",
		FirstSeq:       2,
		Records:        []*gatewayv2.ChatIngressRecord{reliableIngressTerminal(projection, 1, "completed")},
	})
	manager.ingestChatIngressFragment("agent-observe", &gatewayv2.ChatIngressFragment{
		RunId:              "run-fragment",
		ConversationId:     "conv-fragment",
		SourceSeq:          1,
		FragmentIndex:      1,
		FragmentCount:      1,
		EncodedRecordChunk: []byte("x"),
		EncodedRecordBytes: 1,
		Sha256:             strings.Repeat("0", 64),
	})

	if got := observability.Usage.ChatIngressGapsTotal.Load() - gapBefore; got != 1 {
		t.Fatalf("gap metric delta = %d, want 1", got)
	}
	if got := observability.Usage.ChatIngressReplayRequestsTotal.Load() - replayBefore; got != 1 {
		t.Fatalf("replay metric delta = %d, want 1", got)
	}
	if got := observability.Usage.ChatIngressCheckpointRequestsTotal.Load() - checkpointRequestBefore; got != 2 {
		t.Fatalf("checkpoint request metric delta = %d, want 2", got)
	}
	if got := observability.Usage.ChatIngressCheckpointsCommittedTotal.Load() - checkpointCommittedBefore; got != 1 {
		t.Fatalf("checkpoint committed metric delta = %d, want 1", got)
	}
	if got := observability.Usage.ChatIngressTerminalsCommittedTotal.Load() - terminalBefore; got != 1 {
		t.Fatalf("terminal metric delta = %d, want 1", got)
	}
	if got := observability.Usage.ChatIngressFragmentRejectsTotal.Load() - fragmentRejectBefore; got != 1 {
		t.Fatalf("fragment reject metric delta = %d, want 1", got)
	}
}

type reliableIngressProjectionData struct {
	raw        []byte
	compressed []byte
	sha256     string
}

func reliableIngressProjection(t *testing.T, entriesJSON string) reliableIngressProjectionData {
	t.Helper()
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer encoder.Close()
	raw := []byte(entriesJSON)
	compressed := encoder.EncodeAll(raw, nil)
	hash := sha256.Sum256(raw)
	return reliableIngressProjectionData{
		raw:        raw,
		compressed: compressed,
		sha256:     hex.EncodeToString(hash[:]),
	}
}

func reliableIngressDelta(eventJSON string) *gatewayv2.ChatIngressRecord {
	return &gatewayv2.ChatIngressRecord{
		Payload: &gatewayv2.ChatIngressRecord_Delta{
			Delta: &gatewayv2.ChatIngressDelta{EventJson: eventJSON},
		},
	}
}

func reliableIngressFragment(
	t *testing.T,
	runID string,
	conversationID string,
	sourceSeq uint64,
	record *gatewayv2.ChatIngressRecord,
) *gatewayv2.ChatIngressFragment {
	t.Helper()
	return reliableIngressFragments(t, runID, conversationID, sourceSeq, record, 1)[0]
}

func reliableIngressFragments(
	t *testing.T,
	runID string,
	conversationID string,
	sourceSeq uint64,
	record *gatewayv2.ChatIngressRecord,
	fragmentCount int,
) []*gatewayv2.ChatIngressFragment {
	t.Helper()
	encoded, err := proto.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if fragmentCount <= 0 || fragmentCount > len(encoded) {
		t.Fatalf("invalid fragment count %d for %d encoded bytes", fragmentCount, len(encoded))
	}
	hash := sha256.Sum256(encoded)
	fragments := make([]*gatewayv2.ChatIngressFragment, 0, fragmentCount)
	for index := 0; index < fragmentCount; index++ {
		start := len(encoded) * index / fragmentCount
		end := len(encoded) * (index + 1) / fragmentCount
		fragments = append(fragments, &gatewayv2.ChatIngressFragment{
			RunId:              runID,
			ConversationId:     conversationID,
			SourceSeq:          sourceSeq,
			FragmentIndex:      uint32(index),
			FragmentCount:      uint32(fragmentCount),
			EncodedRecordChunk: encoded[start:end],
			EncodedRecordBytes: uint64(len(encoded)),
			Sha256:             hex.EncodeToString(hash[:]),
		})
	}
	return fragments
}

func reliableIngressTerminal(projection reliableIngressProjectionData, coversThrough uint64, state string) *gatewayv2.ChatIngressRecord {
	return &gatewayv2.ChatIngressRecord{
		Payload: &gatewayv2.ChatIngressRecord_Terminal{
			Terminal: &gatewayv2.ChatIngressTerminal{
				CoversThroughSeq:     coversThrough,
				Revision:             1,
				CompressedProjection: projection.compressed,
				UncompressedBytes:    uint64(len(projection.raw)),
				Sha256:               projection.sha256,
				ContentComplete:      true,
				State:                state,
			},
		},
	}
}

func reliableIngressCheckpoint(projection reliableIngressProjectionData, coversThrough, revision uint64) *gatewayv2.ChatIngressRecord {
	return &gatewayv2.ChatIngressRecord{
		Payload: &gatewayv2.ChatIngressRecord_Checkpoint{
			Checkpoint: &gatewayv2.ChatIngressCheckpoint{
				CoversThroughSeq:     coversThrough,
				Revision:             revision,
				CompressedProjection: projection.compressed,
				UncompressedBytes:    uint64(len(projection.raw)),
				Sha256:               projection.sha256,
			},
		},
	}
}
