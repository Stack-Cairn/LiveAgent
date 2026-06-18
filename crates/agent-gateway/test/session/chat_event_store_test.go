package session_test

import (
	"path/filepath"
	"testing"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newPersistentTestSessionManager(t *testing.T, path string) (*session.Manager, session.ChatEventStore) {
	t.Helper()
	store, err := session.OpenSQLiteChatEventStore(path)
	if err != nil {
		t.Fatalf("OpenSQLiteChatEventStore: %v", err)
	}
	sm, err := session.NewManagerWithChatEventStore(store)
	if err != nil {
		t.Fatalf("NewManagerWithChatEventStore: %v", err)
	}
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot()))
	return sm, store
}

type staleReplayChatEventStore struct {
	snapshot session.ChatRunSnapshot
	replay   []*session.ChatBroadcastEvent
}

func (s *staleReplayChatEventStore) StartRun(input session.ChatRunStoreStart) (session.ChatRunSnapshot, bool, error) {
	return session.ChatRunSnapshot{
		RequestID:       input.RequestID,
		ConversationID:  input.ConversationID,
		ClientRequestID: input.ClientRequestID,
		Workdir:         input.Workdir,
		RunEpoch:        1,
		State:           session.ChatRunStateQueued,
	}, true, nil
}

func (s *staleReplayChatEventStore) AppendEvents([]session.ChatRunEventAppend) error {
	return nil
}

func (s *staleReplayChatEventStore) Replay(
	string,
	string,
	int64,
	int,
) (session.ChatRunSnapshot, []*session.ChatBroadcastEvent, bool, error) {
	return s.snapshot, s.replay, true, nil
}

func (s *staleReplayChatEventStore) FailOpenRuns(string) error {
	return nil
}

func (s *staleReplayChatEventStore) Close() error {
	return nil
}

func TestSQLiteChatEventStoreReplaysCompletedRunAndDedupesCommand(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "gateway-chat.sqlite3")
	sm, store := newPersistentTestSessionManager(t, dbPath)
	snapshot, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
		"/workspace",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun: %v", err)
	}
	if !created || snapshot.RequestID != "request-1" {
		t.Fatalf("created snapshot = %#v created=%v", snapshot, created)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
		"type":    "user_message",
		"message": "hello",
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_TOKEN,
				ConversationId: "conversation-1",
				Data:           `{"text":"hi"}`,
			},
		},
	})
	sm.DispatchFromAgent(&gatewayv1.AgentEnvelope{
		RequestId: "request-1",
		Payload: &gatewayv1.AgentEnvelope_ChatEvent{
			ChatEvent: &gatewayv1.ChatEvent{
				Type:           gatewayv1.ChatEvent_DONE,
				ConversationId: "conversation-1",
				Data:           `{}`,
			},
		},
	})
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	next, nextStore := newPersistentTestSessionManager(t, dbPath)
	defer nextStore.Close()
	duplicate, created, err := next.StartPendingChatCommandRun(
		"request-2",
		"conversation-1",
		"client-submit-1",
		"/workspace",
	)
	if err != nil {
		t.Fatalf("StartPendingChatCommandRun duplicate: %v", err)
	}
	if created || duplicate.RequestID != "request-1" || duplicate.LatestSeq != 4 {
		t.Fatalf("duplicate snapshot = %#v created=%v, want original completed run", duplicate, created)
	}

	ch, _, cleanup, replaySnapshot, err := next.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	if replaySnapshot.RequestID != "request-1" || replaySnapshot.LatestSeq != 4 {
		t.Fatalf("replay snapshot = %#v", replaySnapshot)
	}

	gotTypes := make([]string, 0, 4)
	for len(gotTypes) < 4 {
		select {
		case event := <-ch:
			eventType, _ := event.Payload["type"].(string)
			gotTypes = append(gotTypes, eventType)
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for replay, got types %#v", gotTypes)
		}
	}
	want := []string{"accepted", "user_message", "token", "done"}
	if len(gotTypes) != len(want) {
		t.Fatalf("replayed event types = %#v, want %#v", gotTypes, want)
	}
	for index := range want {
		if gotTypes[index] != want[index] {
			t.Fatalf("replayed event types = %#v, want %#v", gotTypes, want)
		}
	}
}

func TestSubscribeChatRunMergesStalePersistedReplayWithBufferedEvents(t *testing.T) {
	store := &staleReplayChatEventStore{}
	sm, err := session.NewManagerWithChatEventStore(store)
	if err != nil {
		t.Fatalf("NewManagerWithChatEventStore: %v", err)
	}
	if _, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
		"type":    "user_message",
		"message": "hello",
	})
	store.snapshot = session.ChatRunSnapshot{
		RequestID:       "request-1",
		ConversationID:  "conversation-1",
		ClientRequestID: "client-submit-1",
		RunEpoch:        1,
		LatestSeq:       1,
		State:           session.ChatRunStateQueued,
	}
	store.replay = []*session.ChatBroadcastEvent{
		{
			RequestID: "request-1",
			Seq:       1,
			Payload: map[string]any{
				"type":            "accepted",
				"conversation_id": "conversation-1",
			},
		},
	}

	ch, _, cleanup, _, err := sm.SubscribeChatRun("request-1", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()

	gotTypes := make([]string, 0, 2)
	for len(gotTypes) < 2 {
		select {
		case event := <-ch:
			eventType := ""
			if event.Payload != nil {
				eventType, _ = event.Payload["type"].(string)
			} else if event.Control != nil {
				eventType = event.Control.GetType()
			}
			gotTypes = append(gotTypes, eventType)
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for merged replay, got %#v", gotTypes)
		}
	}
	want := []string{"accepted", "user_message"}
	for index := range want {
		if gotTypes[index] != want[index] {
			t.Fatalf("merged replay types = %#v, want %#v", gotTypes, want)
		}
	}
}

func TestSQLiteChatEventStoreContinuesConversationSeqAcrossRuns(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "gateway-chat.sqlite3")
	sm, store := newPersistentTestSessionManager(t, dbPath)
	if _, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-1 created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	sm.MarkChatRunPayload("request-1", "conversation-1", map[string]any{
		"type":    "user_message",
		"message": "first",
	})
	sm.MarkChatRunControl("request-1", "conversation-1", "completed", "", "")
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	next, nextStore := newPersistentTestSessionManager(t, dbPath)
	defer nextStore.Close()
	snapshot, created, err := next.StartPendingChatCommandRun(
		"request-2",
		"conversation-1",
		"client-submit-2",
	)
	if err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun request-2 created=%v err=%v", created, err)
	}
	if snapshot.LatestSeq != 3 {
		t.Fatalf("second run initial snapshot = %#v, want latest seq 3", snapshot)
	}
	next.MarkChatRunControl("request-2", "conversation-1", "accepted", "", "")

	ch, _, cleanup, replaySnapshot, err := next.SubscribeChatRun("request-2", "conversation-1", 3)
	if err != nil {
		t.Fatalf("SubscribeChatRun request-2: %v", err)
	}
	defer cleanup()
	if replaySnapshot.LatestSeq != 4 {
		t.Fatalf("second replay snapshot = %#v, want latest seq 4", replaySnapshot)
	}
	select {
	case event := <-ch:
		if event.Seq != 4 {
			t.Fatalf("second run accepted seq = %d, want 4", event.Seq)
		}
		eventType, _ := event.Payload["type"].(string)
		if eventType != "accepted" {
			t.Fatalf("second run event type = %q, want accepted", eventType)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second run accepted event")
	}

	conversationCh, _, conversationCleanup, conversationSnapshot, err := next.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun conversation replay: %v", err)
	}
	defer conversationCleanup()
	if conversationSnapshot.RequestID != "request-2" || conversationSnapshot.LatestSeq != 4 {
		t.Fatalf("conversation replay snapshot = %#v, want latest run request-2 seq 4", conversationSnapshot)
	}
	got := make([]string, 0, 4)
	for len(got) < 4 {
		select {
		case event := <-conversationCh:
			eventType, _ := event.Payload["type"].(string)
			got = append(got, event.RequestID+":"+eventType)
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for conversation replay, got %#v", got)
		}
	}
	want := []string{
		"request-1:accepted",
		"request-1:user_message",
		"request-1:completed",
		"request-2:accepted",
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("conversation replay = %#v, want %#v", got, want)
		}
	}
}

func TestSQLiteChatEventStoreFailsOpenRunsOnManagerStartup(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "gateway-chat.sqlite3")
	sm, store := newPersistentTestSessionManager(t, dbPath)
	if _, created, err := sm.StartPendingChatCommandRun(
		"request-1",
		"conversation-1",
		"client-submit-1",
	); err != nil || !created {
		t.Fatalf("StartPendingChatCommandRun created=%v err=%v", created, err)
	}
	sm.MarkChatRunControl("request-1", "conversation-1", "accepted", "", "")
	if err := store.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}

	next, nextStore := newPersistentTestSessionManager(t, dbPath)
	defer nextStore.Close()
	ch, _, cleanup, snapshot, err := next.SubscribeChatRun("", "conversation-1", 0)
	if err != nil {
		t.Fatalf("SubscribeChatRun: %v", err)
	}
	defer cleanup()
	if snapshot.State != session.ChatRunStateFailed || !snapshot.Done || snapshot.LatestSeq != 2 {
		t.Fatalf("snapshot after restart = %#v, want failed terminal run", snapshot)
	}

	gotTypes := make([]string, 0, 2)
	for len(gotTypes) < 2 {
		select {
		case event := <-ch:
			eventType, _ := event.Payload["type"].(string)
			gotTypes = append(gotTypes, eventType)
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for failed replay, got %#v", gotTypes)
		}
	}
	if gotTypes[0] != "accepted" || gotTypes[1] != "failed" {
		t.Fatalf("replayed event types = %#v, want accepted then failed", gotTypes)
	}
}
