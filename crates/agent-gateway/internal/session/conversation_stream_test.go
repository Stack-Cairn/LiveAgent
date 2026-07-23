package session

import (
	"encoding/json"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const conversationTestAgentID = "test-agent"

func tokenEvent(conversationID string, text string) *gatewayv2.ChatEvent {
	data, _ := json.Marshal(map[string]any{"text": text})
	return &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_TOKEN,
		ConversationId: conversationID,
		Data:           string(data),
	}
}

func doneEvent(conversationID string) *gatewayv2.ChatEvent {
	return &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_DONE,
		ConversationId: conversationID,
		Data:           `{"title":"Final title"}`,
	}
}

func startedControl(runID string, conversationID string) *gatewayv2.ChatControlEvent {
	return &gatewayv2.ChatControlEvent{
		RequestId:      runID,
		ConversationId: conversationID,
		Type:           "started",
		State:          "running",
	}
}

func completedControl(runID string, conversationID string) *gatewayv2.ChatControlEvent {
	return &gatewayv2.ChatControlEvent{
		RequestId:      runID,
		ConversationId: conversationID,
		Type:           "completed",
		State:          "completed",
	}
}

func drainEvents(t *testing.T, ch <-chan *ConversationEvent, count int) []*ConversationEvent {
	t.Helper()
	events := make([]*ConversationEvent, 0, count)
	timeout := time.After(2 * time.Second)
	for len(events) < count {
		select {
		case event, ok := <-ch:
			if !ok {
				t.Fatalf("event channel closed after %d events, want %d", len(events), count)
			}
			events = append(events, event)
		case <-timeout:
			t.Fatalf("timed out after %d events, want %d", len(events), count)
		}
	}
	return events
}

func eventTypes(events []*ConversationEvent) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.Type)
	}
	return types
}

func TestConversationStreamSeqMonotonicAcrossRuns(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "hello"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1"))
	m.ingestChatControl(conversationTestAgentID, "run-2", startedControl("run-2", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-2", tokenEvent("conv-1", "again"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()

	var lastSeq int64
	for _, event := range sub.Events {
		if event.Seq <= lastSeq {
			t.Fatalf("seq not monotonic: %d after %d (types %v)", event.Seq, lastSeq, eventTypes(sub.Events))
		}
		lastSeq = event.Seq
	}
	types := eventTypes(sub.Events)
	want := []string{"run_started", "token", "run_finished", "run_started", "token"}
	if len(types) != len(want) {
		t.Fatalf("replayed types = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("replayed types = %v, want %v", types, want)
		}
	}
	if sub.Activity == nil || sub.Activity.RunID != "run-2" || sub.Activity.State != RunActivityRunning {
		t.Fatalf("activity = %#v, want running run-2", sub.Activity)
	}
}

func TestRunFinishedExactlyOnceForDuplicateTerminals(t *testing.T) {
	cases := []struct {
		name   string
		first  func(m *Manager)
		second func(m *Manager)
	}{
		{
			name:  "done event then completed control",
			first: func(m *Manager) { m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1")) },
			second: func(m *Manager) {
				m.ingestChatControl(conversationTestAgentID, "run-1", completedControl("run-1", "conv-1"))
			},
		},
		{
			name: "completed control then terminal snapshot",
			first: func(m *Manager) {
				m.ingestChatControl(conversationTestAgentID, "run-1", completedControl("run-1", "conv-1"))
			},
			second: func(m *Manager) {
				m.ingestRuntimeSnapshot(conversationTestAgentID, &gatewayv2.ChatRuntimeSnapshot{
					RunId: "run-1", ConversationId: "conv-1", State: "completed",
				})
			},
		},
		{
			name: "terminal snapshot then done event",
			first: func(m *Manager) {
				m.ingestRuntimeSnapshot(conversationTestAgentID, &gatewayv2.ChatRuntimeSnapshot{
					RunId: "run-1", ConversationId: "conv-1", State: "cancelled",
				})
			},
			second: func(m *Manager) { m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1")) },
		},
		{
			name:   "force finish then late done",
			first:  func(m *Manager) { m.ForceFinishRun(conversationTestAgentID, "run-1", "cancelled", "", "") },
			second: func(m *Manager) { m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1")) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := NewManager()
			m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
			m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "hello"))
			tc.first(m)
			tc.second(m)

			sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
			defer sub.Cleanup()
			finished := 0
			for _, event := range sub.Events {
				if event.Type == StreamEventRunFinished {
					finished++
				}
			}
			if finished != 1 {
				t.Fatalf("run_finished count = %d, want 1 (types %v)", finished, eventTypes(sub.Events))
			}
			if sub.Activity != nil {
				t.Fatalf("activity should be cleared, got %#v", sub.Activity)
			}
		})
	}
}

func TestSupersessionFinishesPreviousRunFirst(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-a", startedControl("run-a", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-a", tokenEvent("conv-1", "a"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()

	// A queued prompt auto-send: run-b starts before run-a's terminal arrives.
	m.ingestChatControl(conversationTestAgentID, "run-b", startedControl("run-b", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-b", tokenEvent("conv-1", "b"))

	live := drainEvents(t, sub.EventCh, 3)
	types := eventTypes(live)
	if types[0] != StreamEventRunFinished || live[0].RunID != "run-a" {
		t.Fatalf("first live event = %s/%s, want run_finished/run-a", types[0], live[0].RunID)
	}
	if live[0].Payload["reason"] != "superseded" {
		t.Fatalf("superseded reason missing: %#v", live[0].Payload)
	}
	if types[1] != StreamEventRunStarted || live[1].RunID != "run-b" {
		t.Fatalf("second live event = %s/%s, want run_started/run-b", types[1], live[1].RunID)
	}
	if types[2] != "token" || live[2].RunID != "run-b" {
		t.Fatalf("third live event = %s/%s, want token/run-b", types[2], live[2].RunID)
	}

	// The late terminal for run-a is swallowed.
	m.ingestChatControl(conversationTestAgentID, "run-a", completedControl("run-a", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-b", tokenEvent("conv-1", "b2"))
	next := drainEvents(t, sub.EventCh, 1)
	if next[0].Type != "token" || next[0].RunID != "run-b" {
		t.Fatalf("late terminal leaked: got %s/%s", next[0].Type, next[0].RunID)
	}
}

func TestSubscribeResumeAndResetSemantics(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "one"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "two"))

	base := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	base.Cleanup()
	epoch := base.StreamEpoch
	latest := base.LatestSeq

	resume := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", latest-1, epoch)
	resume.Cleanup()
	if resume.Reset {
		t.Fatalf("resume within buffer should not reset")
	}
	if len(resume.Events) != 1 || resume.Events[0].Seq != latest {
		t.Fatalf("resume replay = %v", eventTypes(resume.Events))
	}

	ahead := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", latest+100, epoch)
	ahead.Cleanup()
	if !ahead.Reset || len(ahead.Events) != int(latest) {
		t.Fatalf("client ahead of gateway must reset with full replay, got reset=%v events=%d", ahead.Reset, len(ahead.Events))
	}

	wrongEpoch := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", latest, "different-epoch")
	wrongEpoch.Cleanup()
	if !wrongEpoch.Reset {
		t.Fatalf("epoch mismatch must reset")
	}

	// Gap: force eviction of the early events.
	m.convStreams.mu.Lock()
	stream := m.convStreams.streams[conversationStreamKey(conversationTestAgentID, "conv-1")]
	stream.evictedThroughSeq = 2
	m.convStreams.mu.Unlock()
	gap := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 1, epoch)
	gap.Cleanup()
	if !gap.Reset {
		t.Fatalf("resume below evicted floor must reset")
	}
}

func TestStartChatCommandSeedsAndAgentEchoSwallowed(t *testing.T) {
	m := NewManager()
	start := m.StartChatCommand(conversationTestAgentID, "run-1", "conv-1", "/workspace", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	if start.AcceptedSeq <= 0 {
		t.Fatalf("accepted seq = %d, want > 0", start.AcceptedSeq)
	}

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) != 1 || sub.Events[0].Type != "user_message" {
		t.Fatalf("seeded replay = %v", eventTypes(sub.Events))
	}
	if sub.Events[0].Payload["client_request_id"] != "client-1" {
		t.Fatalf("seeded user_message missing client_request_id: %#v", sub.Events[0].Payload)
	}
	if sub.Activity == nil || sub.Activity.State != RunActivityQueued {
		t.Fatalf("activity = %#v, want queued", sub.Activity)
	}

	// Agent starts the run and echoes the user message: the echo is swallowed.
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	userEcho, _ := json.Marshal(map[string]any{"message": "hello"})
	m.ingestChatEvent(conversationTestAgentID, "run-1", &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_USER_MESSAGE,
		ConversationId: "conv-1",
		Data:           string(userEcho),
	})
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "hi"))

	live := drainEvents(t, sub.EventCh, 2)
	types := eventTypes(live)
	if types[0] != StreamEventRunStarted || types[1] != "token" {
		t.Fatalf("live types = %v, want [run_started token]", types)
	}
}

func TestSeededUserMessageForwardsStableIdentityOnce(t *testing.T) {
	m := NewManager()
	m.StartChatCommand(conversationTestAgentID, "run-1", "conv-1", "/workspace", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	identityEcho, _ := json.Marshal(map[string]any{
		"message":    "hello",
		"message_id": "user-stable-1",
	})
	event := &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_USER_MESSAGE,
		ConversationId: "conv-1",
		Data:           string(identityEcho),
	}
	m.ingestChatEvent(conversationTestAgentID, "run-1", event)
	m.ingestChatEvent(conversationTestAgentID, "run-1", event)

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if got, want := eventTypes(sub.Events), []string{"user_message", StreamEventRunStarted, "user_message"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("replay = %v, want %v", got, want)
	}
	identity := sub.Events[2]
	if identity.Payload["message_id"] != "user-stable-1" {
		t.Fatalf("identity payload = %#v", identity.Payload)
	}
}

func TestPendingRunBindsOnFirstAgentSignal(t *testing.T) {
	m := NewManager()
	updates, cleanupWatch := m.WatchChatCommand(conversationTestAgentID, "run-1")
	defer cleanupWatch()

	start := m.StartChatCommand(conversationTestAgentID, "run-1", "", "/workspace", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	if start.ConversationID != "" || start.AcceptedSeq != 0 {
		t.Fatalf("pending start = %#v", start)
	}

	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-new"))

	select {
	case update := <-updates:
		if update.Phase != "bound" || update.ConversationID != "conv-new" || update.ClientRequestID != "client-1" {
			t.Fatalf("bound update = %#v", update)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no bound update")
	}

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-new", 0, "")
	defer sub.Cleanup()
	types := eventTypes(sub.Events)
	want := []string{"user_message", "run_started"}
	if len(types) != len(want) || types[0] != want[0] || types[1] != want[1] {
		t.Fatalf("bound replay = %v, want %v", types, want)
	}
}

func TestQueuedInGUICompensatesSeededEntries(t *testing.T) {
	m := NewManager()
	updates, cleanupWatch := m.WatchChatCommand(conversationTestAgentID, "run-1")
	defer cleanupWatch()

	m.StartChatCommand(conversationTestAgentID, "run-1", "conv-1", "", "client-1", []map[string]any{
		{"type": "user_message", "message": "queued prompt"},
	})
	m.ingestChatControl(conversationTestAgentID, "run-1", &gatewayv2.ChatControlEvent{
		RequestId:      "run-1",
		ConversationId: "conv-1",
		Type:           "queued_in_gui",
	})

	select {
	case update := <-updates:
		if update.Phase != "queued_in_gui" {
			t.Fatalf("update = %#v", update)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no queued_in_gui update")
	}

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	types := eventTypes(sub.Events)
	if len(types) != 2 || types[0] != "user_message" || types[1] != StreamEventRunQueued {
		t.Fatalf("replay = %v, want [user_message run_queued]", types)
	}
	if sub.Activity != nil {
		t.Fatalf("queued_in_gui must clear activity, got %#v", sub.Activity)
	}
	if m.ChatCommandSettled(conversationTestAgentID, "run-1") != true {
		t.Fatalf("queued_in_gui command must count as settled")
	}

	// Later auto-send: the agent echo must now pass through.
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	userEcho, _ := json.Marshal(map[string]any{"message": "queued prompt"})
	m.ingestChatEvent(conversationTestAgentID, "run-1", &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_USER_MESSAGE,
		ConversationId: "conv-1",
		Data:           string(userEcho),
	})
	live := drainEvents(t, sub.EventCh, 2)
	types = eventTypes(live)
	if types[0] != StreamEventRunStarted || types[1] != "user_message" {
		t.Fatalf("auto-send live types = %v, want [run_started user_message]", types)
	}
}

func TestFailChatCommandPendingAndBound(t *testing.T) {
	m := NewManager()
	updates, cleanupWatch := m.WatchChatCommand(conversationTestAgentID, "run-pending")
	defer cleanupWatch()
	m.StartChatCommand(conversationTestAgentID, "run-pending", "", "", "client-1", nil)
	m.FailChatCommand(conversationTestAgentID, "run-pending", "desktop_runtime_unavailable", "agent offline")
	select {
	case update := <-updates:
		if update.Phase != "failed" || update.ErrorCode != "desktop_runtime_unavailable" {
			t.Fatalf("failed update = %#v", update)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no failed update")
	}

	m.StartChatCommand(conversationTestAgentID, "run-bound", "conv-1", "", "client-2", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	m.FailChatCommand(conversationTestAgentID, "run-bound", "startup_timeout", "did not start")
	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	last := sub.Events[len(sub.Events)-1]
	if last.Type != StreamEventRunFinished || last.Payload["status"] != "failed" {
		t.Fatalf("bound failure tail = %s %#v", last.Type, last.Payload)
	}
	if !m.ChatCommandSettled(conversationTestAgentID, "run-bound") {
		t.Fatalf("failed command should be settled")
	}
}

func TestStartChatCommandDeduplicatesAtomically(t *testing.T) {
	t.Parallel()

	m := NewManager()
	results := make(chan ChatCommandStart, 2)
	start := func(runID string, message string) {
		results <- m.StartChatCommand(conversationTestAgentID, runID, "conv-1", "/workspace", "client-shared", []map[string]any{
			{"type": "user_message", "message": message},
		})
	}
	go start("run-a", "first")
	go start("run-b", "second")
	first := <-results
	second := <-results

	if first.RunID != second.RunID {
		t.Fatalf("concurrent canonical runs = %q and %q", first.RunID, second.RunID)
	}
	if first.Deduped == second.Deduped {
		t.Fatalf("dedupe flags = %v and %v, want exactly one canonical creator", first.Deduped, second.Deduped)
	}
	canonical, ok := m.LookupChatCommand(conversationTestAgentID, "client-shared")
	if !ok || canonical.RunID != first.RunID || !canonical.Deduped {
		t.Fatalf("canonical lookup = %#v, ok=%v", canonical, ok)
	}

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	userMessages := 0
	for _, event := range sub.Events {
		if event.Type == "user_message" {
			userMessages++
		}
	}
	if userMessages != 1 {
		t.Fatalf("concurrent dedupe seeded %d user messages, want 1", userMessages)
	}
}

func TestDeduplicatedPendingCommandReplaysBoundUpdate(t *testing.T) {
	t.Parallel()

	m := NewManager()
	start := m.StartChatCommand(conversationTestAgentID, "run-original", "", "/workspace", "client-bound", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})
	if start.Deduped {
		t.Fatalf("initial command unexpectedly deduped: %#v", start)
	}
	m.ingestChatControl(conversationTestAgentID, "run-original", startedControl("run-original", "conv-bound"))

	retry := m.StartChatCommand(conversationTestAgentID, "run-retry", "", "/other", "client-bound", []map[string]any{
		{"type": "user_message", "message": "duplicate"},
	})
	if !retry.Deduped || retry.RunID != "run-original" || retry.ConversationID != "conv-bound" || retry.AcceptedSeq <= 0 {
		t.Fatalf("deduplicated bound command = %#v", retry)
	}
	updates, cleanup := m.WatchChatCommand(conversationTestAgentID, retry.RunID)
	defer cleanup()
	select {
	case update := <-updates:
		if update.Phase != "bound" || update.ConversationID != "conv-bound" {
			t.Fatalf("replayed bound update = %#v", update)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for replayed bound update")
	}
}

func TestDeduplicatedPendingCommandReplaysFailedUpdate(t *testing.T) {
	t.Parallel()

	m := NewManager()
	m.StartChatCommand(conversationTestAgentID, "run-failed", "", "", "client-failed", nil)
	m.FailChatCommand(conversationTestAgentID, "run-failed", "desktop_runtime_unavailable", "delivery timed out")

	retry := m.StartChatCommand(conversationTestAgentID, "run-retry", "", "", "client-failed", nil)
	if !retry.Deduped || retry.RunID != "run-failed" {
		t.Fatalf("deduplicated failed command = %#v", retry)
	}
	updates, cleanup := m.WatchChatCommand(conversationTestAgentID, retry.RunID)
	defer cleanup()
	select {
	case update := <-updates:
		if update.Phase != "failed" || update.ErrorCode != "desktop_runtime_unavailable" {
			t.Fatalf("replayed failed update = %#v", update)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for replayed failed update")
	}
}

func TestActivityHubCarriesRunIDs(t *testing.T) {
	m := NewManager()
	activity, cleanup := m.SubscribeChatActivity()
	defer cleanup()

	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1"))

	running := <-activity
	if !running.Running || running.RunID != "run-1" || running.State != RunActivityRunning {
		t.Fatalf("running activity = %#v", running)
	}
	idle := <-activity
	if idle.Running || idle.ConversationID != "conv-1" {
		t.Fatalf("idle activity = %#v", idle)
	}

	// A late subscriber replays current activity.
	m.ingestChatControl(conversationTestAgentID, "run-2", startedControl("run-2", "conv-2"))
	late, lateCleanup := m.SubscribeChatActivity()
	defer lateCleanup()
	replayed := <-late
	if replayed.ConversationID != "conv-2" || replayed.RunID != "run-2" || !replayed.Running {
		t.Fatalf("late replay = %#v", replayed)
	}
}

func TestEvictionProtectsActiveRunUntilHardCap(t *testing.T) {
	m := NewManager()
	m.convStreams.eventRetention = time.Millisecond
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "one"))
	time.Sleep(5 * time.Millisecond)
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "two"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	sub.Cleanup()
	if len(sub.Events) != 3 {
		t.Fatalf("active run events must survive retention, got %v", eventTypes(sub.Events))
	}

	// After the run finishes, retention applies again.
	m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1"))
	time.Sleep(5 * time.Millisecond)
	m.convStreams.mu.Lock()
	stream := m.convStreams.streams[conversationStreamKey(conversationTestAgentID, "conv-1")]
	m.convStreams.evictStreamLocked(stream, time.Now())
	remaining := len(stream.events)
	evictedThrough := stream.evictedThroughSeq
	m.convStreams.mu.Unlock()
	if remaining != 0 || evictedThrough == 0 {
		t.Fatalf("idle stream should evict all expired events, remaining=%d evictedThrough=%d", remaining, evictedThrough)
	}

	// Hard cap evicts even active-run events and flags truncation via the
	// evicted floor so subscribers get a reset.
	m2 := NewManager()
	m2.convStreams.maxEvents = 4
	m2.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-x"))
	for i := 0; i < 10; i++ {
		m2.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-x", "t"))
	}
	m2.convStreams.mu.Lock()
	streamX := m2.convStreams.streams[conversationStreamKey(conversationTestAgentID, "conv-x")]
	if len(streamX.events) > 4 {
		m2.convStreams.mu.Unlock()
		t.Fatalf("hard cap not enforced: %d events", len(streamX.events))
	}
	if streamX.evictedThroughSeq == 0 {
		m2.convStreams.mu.Unlock()
		t.Fatalf("evictedThroughSeq not advanced under hard cap")
	}
	m2.convStreams.mu.Unlock()
}

func TestReaperForceFinishesStaleRunsOnlyWhenOnline(t *testing.T) {
	m := NewManager()
	m.convStreams.staleRunTimeout = time.Millisecond
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	time.Sleep(5 * time.Millisecond)

	// Agent offline: the run is left alone.
	m.convStreams.reap(time.Now())
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("offline reap must not finish runs, activities=%d", len(activities))
	}

	// Agent online: the silent run is force-finished.
	m.SetSession(&AgentSession{
		AgentID: conversationTestAgentID,
		toAgent: make(chan *OutboundEnvelope, 1),
		done:    make(chan struct{}),
		streams: make(map[string]*agentStream),
	})
	m.convStreams.reap(time.Now())
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("online reap must finish stale runs, activities=%d", len(activities))
	}

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	sub.Cleanup()
	last := sub.Events[len(sub.Events)-1]
	if last.Type != StreamEventRunFinished || last.Payload["error_code"] != "stale_run" {
		t.Fatalf("stale finish tail = %s %#v", last.Type, last.Payload)
	}
}

func TestCancellingStateAndWatchdog(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))

	runID, ok := m.MarkConversationCancelling(conversationTestAgentID, "conv-1", "")
	if !ok || runID != "run-1" {
		t.Fatalf("cancelling = %q %v", runID, ok)
	}
	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if sub.Activity == nil || sub.Activity.State != RunActivityCancelling {
		t.Fatalf("activity = %#v, want cancelling", sub.Activity)
	}

	// The agent's real terminal wins over the watchdog.
	m.ingestChatControl(conversationTestAgentID, "run-1", &gatewayv2.ChatControlEvent{
		RequestId: "run-1", ConversationId: "conv-1", Type: "cancelled", State: "cancelled",
	})
	m.ForceFinishRun(conversationTestAgentID, "run-1", "cancelled", "cancel_timeout", "watchdog")

	finished := 0
	for _, event := range drainEvents(t, sub.EventCh, 1) {
		if event.Type == StreamEventRunFinished {
			finished++
			if event.Payload["error_code"] == "cancel_timeout" {
				t.Fatalf("watchdog overrode the agent terminal: %#v", event.Payload)
			}
		}
	}
	if finished != 1 {
		t.Fatalf("run_finished count = %d", finished)
	}
}

func TestGatewayRestartSnapshotRebuildsStream(t *testing.T) {
	// A fresh manager simulates a restarted gateway: the first thing it sees
	// for the conversation is a runtime snapshot of an in-flight run.
	m := NewManager()
	m.ingestRuntimeSnapshot(conversationTestAgentID, &gatewayv2.ChatRuntimeSnapshot{
		RunId:          "run-1",
		ConversationId: "conv-1",
		State:          "running",
		Revision:       7,
		EntriesJson:    `[{"kind":"assistant","text":"partial"}]`,
		ToolStatus:     "Vibing",
	})

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if sub.Activity == nil || sub.Activity.RunID != "run-1" {
		t.Fatalf("activity = %#v", sub.Activity)
	}
	if sub.Activity.ToolStatus != "Vibing" {
		t.Fatalf("tool status = %q", sub.Activity.ToolStatus)
	}
	if sub.Snapshot == nil || sub.Snapshot.Revision != 7 {
		t.Fatalf("late joiner must get the snapshot, got %#v", sub.Snapshot)
	}

	// Live continuation streams normally afterwards.
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "more"))
	live := drainEvents(t, sub.EventCh, 1)
	if live[0].Type != "token" {
		t.Fatalf("live continuation = %v", eventTypes(live))
	}
}

func TestSubscriberOverflowClosesAndResumes(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()

	for i := 0; i < conversationSubscriberBuffer+8; i++ {
		m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "x"))
	}

	deadline := time.After(2 * time.Second)
	closed := false
	received := 0
	for !closed {
		select {
		case _, ok := <-sub.EventCh:
			if !ok {
				closed = true
				break
			}
			received++
			if received > conversationSubscriberBuffer+8 {
				t.Fatalf("received more events than sent")
			}
		case <-deadline:
			t.Fatalf("subscriber channel never closed on overflow")
		}
	}
	if !sub.Overflowed() {
		t.Fatalf("overflow flag not set")
	}

	// Resume from the last seen seq replays the tail without loss.
	resume := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", int64(received)+1, sub.StreamEpoch)
	resume.Cleanup()
	if resume.Reset {
		t.Fatalf("resume after overflow should not reset while buffer covers the gap")
	}
	total := received + len(resume.Events)
	if total < conversationSubscriberBuffer+8 {
		t.Fatalf("lost events across overflow: saw %d", total)
	}
}

func TestReaperSparesSilentRunsWhileReportsVouch(t *testing.T) {
	m := NewManager()
	m.convStreams.staleRunTimeout = 10 * time.Millisecond
	m.SetSession(&AgentSession{
		AgentID: conversationTestAgentID,
		toAgent: make(chan *OutboundEnvelope, 1),
		done:    make(chan struct{}),
		streams: make(map[string]*agentStream),
	})

	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	time.Sleep(20 * time.Millisecond)

	// A silent long tool call: no events, but the run report vouches for it.
	m.convStreams.onRuntimeStatus(conversationTestAgentID, &gatewayv2.RuntimeStatusEvent{
		ActiveRuns: []*gatewayv2.ChatRunReport{
			{RunId: "run-1", ConversationId: "conv-1", State: "running"},
		},
	}, time.Now())
	m.convStreams.reap(time.Now())
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("vouched silent run must be spared, activities=%d", len(activities))
	}

	// Once the reports stop vouching for it, the run is reaped after the
	// timeout elapses again.
	time.Sleep(20 * time.Millisecond)
	m.convStreams.reap(time.Now())
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("stale run must be reaped once vouching stops, activities=%d", len(activities))
	}
}

func TestSupersessionKeepsSeededUserMessageReplayable(t *testing.T) {
	m := NewManager()
	m.convStreams.eventRetention = time.Millisecond

	// Run A streams while a webui command for the same conversation is
	// accepted and seeded; B later starts via supersession.
	m.ingestChatControl(conversationTestAgentID, "run-a", startedControl("run-a", "conv-1"))
	m.StartChatCommand(conversationTestAgentID, "run-b", "conv-1", "", "client-b", []map[string]any{
		{"type": "user_message", "message": "seeded prompt"},
	})
	m.ingestChatEvent(conversationTestAgentID, "run-a", tokenEvent("conv-1", "working"))
	m.ingestChatControl(conversationTestAgentID, "run-b", startedControl("run-b", "conv-1"))

	// Age everything past retention, then trigger eviction: run B's activity
	// window must still protect the seeded user_message.
	time.Sleep(5 * time.Millisecond)
	m.ingestChatEvent(conversationTestAgentID, "run-b", tokenEvent("conv-1", "reply"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	hasSeed := false
	for _, event := range sub.Events {
		if event.Type == "user_message" && event.RunID == "run-b" {
			hasSeed = true
		}
	}
	if !hasSeed {
		t.Fatalf("seeded user_message evicted despite active run: %v", eventTypes(sub.Events))
	}
}

func TestWatchChatCommandCleanupClosesChannel(t *testing.T) {
	m := NewManager()
	updates, cleanup := m.WatchChatCommand(conversationTestAgentID, "run-1")
	cleanup()
	select {
	case _, ok := <-updates:
		if ok {
			t.Fatalf("expected closed channel, got value")
		}
	case <-time.After(time.Second):
		t.Fatalf("watch channel not closed by cleanup")
	}
}

func TestSeedsDeferredWhileAnotherRunIsActive(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-a", startedControl("run-a", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-a", tokenEvent("conv-1", "streaming"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()

	// Command accepted mid-run: nothing may reach the log yet — a seeded
	// user_message here would flash a bubble until queued_in_gui compensates.
	start := m.StartChatCommand(conversationTestAgentID, "run-b", "conv-1", "", "client-b", []map[string]any{
		{"type": "user_message", "message": "queued while busy"},
	})
	if start.AcceptedSeq != sub.LatestSeq {
		t.Fatalf("deferred accept must not append events: acceptedSeq=%d latest=%d", start.AcceptedSeq, sub.LatestSeq)
	}

	// The desktop parks it: still nothing in the log (no run_queued needed).
	m.ingestChatControl(conversationTestAgentID, "run-b", &gatewayv2.ChatControlEvent{
		RequestId: "run-b", ConversationId: "conv-1", Type: "queued_in_gui",
	})
	m.ingestChatEvent(conversationTestAgentID, "run-a", tokenEvent("conv-1", "more"))
	live := drainEvents(t, sub.EventCh, 1)
	if live[0].Type != "token" {
		t.Fatalf("expected only run-a token after deferred accept + park, got %v", eventTypes(live))
	}

	// The queued item eventually auto-sends: the agent echo is authoritative.
	m.ingestChatEvent(conversationTestAgentID, "run-a", doneEvent("conv-1"))
	m.ingestChatControl(conversationTestAgentID, "run-b", startedControl("run-b", "conv-1"))
	echo, _ := json.Marshal(map[string]any{"message": "queued while busy"})
	m.ingestChatEvent(conversationTestAgentID, "run-b", &gatewayv2.ChatEvent{
		Type: gatewayv2.ChatEvent_USER_MESSAGE, ConversationId: "conv-1", Data: string(echo),
	})
	tail := drainEvents(t, sub.EventCh, 3)
	types := eventTypes(tail)
	if types[0] != StreamEventRunFinished || types[1] != StreamEventRunStarted || types[2] != "user_message" {
		t.Fatalf("auto-send tail = %v, want [run_finished run_started user_message]", types)
	}
}

func TestDeferredSeedsFlushWhenRunStartsDirectly(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-a", startedControl("run-a", "conv-1"))

	m.StartChatCommand(conversationTestAgentID, "run-b", "conv-1", "", "client-b", []map[string]any{
		{"type": "user_message", "message": "interrupt prompt"},
	})

	// The desktop runs the command immediately (interrupt policy): the
	// deferred seeds surface right before run_started, and the agent's echo
	// is swallowed as usual.
	m.ingestChatControl(conversationTestAgentID, "run-b", startedControl("run-b", "conv-1"))
	echo, _ := json.Marshal(map[string]any{"message": "interrupt prompt"})
	m.ingestChatEvent(conversationTestAgentID, "run-b", &gatewayv2.ChatEvent{
		Type: gatewayv2.ChatEvent_USER_MESSAGE, ConversationId: "conv-1", Data: string(echo),
	})
	m.ingestChatEvent(conversationTestAgentID, "run-b", tokenEvent("conv-1", "reply"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	types := eventTypes(sub.Events)
	want := []string{"run_started", "run_finished", "user_message", "run_started", "token"}
	if len(types) != len(want) {
		t.Fatalf("replay = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("replay = %v, want %v", types, want)
		}
	}
	userMessages := 0
	for _, event := range sub.Events {
		if event.Type == "user_message" {
			userMessages++
			if event.Payload["client_request_id"] != "client-b" {
				t.Fatalf("seeded user_message missing client_request_id: %#v", event.Payload)
			}
		}
	}
	if userMessages != 1 {
		t.Fatalf("user_message count = %d, want 1 (echo swallowed)", userMessages)
	}
}

func editResendUserMessageEvent(conversationID string, message string, ref map[string]any) *gatewayv2.ChatEvent {
	payload := map[string]any{"message": message}
	if ref != nil {
		payload["base_message_ref"] = ref
		payload["reason"] = "edit_resend"
	}
	data, _ := json.Marshal(payload)
	return &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_USER_MESSAGE,
		ConversationId: conversationID,
		Data:           string(data),
	}
}

func testBaseMessageRef() map[string]any {
	return map[string]any{
		"segment_index": 0,
		"message_index": 2,
		"segment_id":    "seg-1",
		"message_id":    "msg-2",
		"role":          "user",
		"content_hash":  "hash-2",
	}
}

func countEventType(events []*ConversationEvent, eventType string) int {
	count := 0
	for _, event := range events {
		if event.Type == eventType {
			count++
		}
	}
	return count
}

// GUI-local edit-resend, "started" control first (the usual desktop order):
// the ref-bearing user_message seeds one rebased event after run_started.
func TestGUIEditResendSeedsRebasedAfterRunStarted(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", editResendUserMessageEvent("conv-1", "edited prompt", testBaseMessageRef()))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "reply"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	types := eventTypes(sub.Events)
	want := []string{StreamEventRunStarted, StreamEventRebased, "user_message", "token"}
	if len(types) != len(want) {
		t.Fatalf("replay = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("replay = %v, want %v", types, want)
		}
	}
	rebased := sub.Events[1]
	ref, ok := rebased.Payload["base_message_ref"].(map[string]any)
	if !ok || ref["message_id"] != "msg-2" || ref["content_hash"] != "hash-2" {
		t.Fatalf("rebased base_message_ref = %#v", rebased.Payload["base_message_ref"])
	}
	if rebased.Payload["reason"] != "edit_resend" {
		t.Fatalf("rebased reason = %#v, want edit_resend", rebased.Payload["reason"])
	}
}

// No prior control signal: the rebased seed still lands, before the
// synthesized run_started.
func TestGUIEditResendSeedsRebasedBeforeRunStarted(t *testing.T) {
	m := NewManager()
	m.ingestChatEvent(conversationTestAgentID, "run-1", editResendUserMessageEvent("conv-1", "edited prompt", testBaseMessageRef()))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	types := eventTypes(sub.Events)
	want := []string{StreamEventRebased, StreamEventRunStarted, "user_message"}
	if len(types) != len(want) {
		t.Fatalf("replay = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("replay = %v, want %v", types, want)
		}
	}
}

// A reconnect replay redelivers the same ref-bearing user_message: exactly
// one rebased event is seeded for the run.
func TestGUIEditResendRebasedSeededOnce(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", editResendUserMessageEvent("conv-1", "edited prompt", testBaseMessageRef()))
	m.ingestChatEvent(conversationTestAgentID, "run-1", editResendUserMessageEvent("conv-1", "edited prompt", testBaseMessageRef()))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if got := countEventType(sub.Events, StreamEventRebased); got != 1 {
		t.Fatalf("rebased count = %d (types %v), want 1", got, eventTypes(sub.Events))
	}
}

// Plain sends (no ref, a null ref — the desktop bridge always serializes the
// key, as null when unset — or an empty ref) must not seed a truncation.
func TestUserMessageWithoutRefSeedsNoRebased(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", editResendUserMessageEvent("conv-1", "plain prompt", nil))

	nullRef, _ := json.Marshal(map[string]any{
		"message":          "null ref prompt",
		"base_message_ref": nil,
	})
	m.ingestChatControl(conversationTestAgentID, "run-1", completedControl("run-1", "conv-1"))
	m.ingestChatControl(conversationTestAgentID, "run-2", startedControl("run-2", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-2", &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_USER_MESSAGE,
		ConversationId: "conv-1",
		Data:           string(nullRef),
	})

	emptyRef, _ := json.Marshal(map[string]any{
		"message":          "empty ref prompt",
		"base_message_ref": map[string]any{"message_id": "", "content_hash": "  "},
	})
	m.ingestChatControl(conversationTestAgentID, "run-2", completedControl("run-2", "conv-1"))
	m.ingestChatControl(conversationTestAgentID, "run-3", startedControl("run-3", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-3", &gatewayv2.ChatEvent{
		Type:           gatewayv2.ChatEvent_USER_MESSAGE,
		ConversationId: "conv-1",
		Data:           string(emptyRef),
	})

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if got := countEventType(sub.Events, StreamEventRebased); got != 0 {
		t.Fatalf("rebased count = %d (types %v), want 0", got, eventTypes(sub.Events))
	}
}

// A webui-initiated edit_resend already seeds its rebased at accept time;
// the agent's ref-bearing echo is swallowed and must not seed a second one.
func TestWebuiEditResendEchoSeedsNoSecondRebased(t *testing.T) {
	m := NewManager()
	ref := testBaseMessageRef()
	m.StartChatCommand(conversationTestAgentID, "run-1", "conv-1", "/workspace", "client-1", []map[string]any{
		{"type": StreamEventRebased, "base_message_ref": ref, "reason": "edit_resend"},
		{"type": "user_message", "message": "edited prompt", "base_message_ref": ref, "reason": "edit_resend"},
	})
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", editResendUserMessageEvent("conv-1", "edited prompt", ref))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "reply"))

	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	defer sub.Cleanup()
	if got := countEventType(sub.Events, StreamEventRebased); got != 1 {
		t.Fatalf("rebased count = %d (types %v), want 1", got, eventTypes(sub.Events))
	}
	if got := countEventType(sub.Events, "user_message"); got != 1 {
		t.Fatalf("user_message count = %d (types %v), want 1 (echo swallowed)", got, eventTypes(sub.Events))
	}
}
