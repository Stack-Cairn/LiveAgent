package session

import (
	"fmt"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestHistorySyncDropLatchesResetAndSnapshotTracksLatestState(t *testing.T) {
	m := NewManager()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", Conversations: []*gatewayv2.ConversationSummary{{Id: "one"}},
	})
	sub := m.SubscribeHistorySyncRecovery()
	defer sub.Cleanup()

	for seq := uint64(1); seq <= historySubscriberBuffer+1; seq++ {
		id := fmt.Sprintf("item-%d", seq)
		m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
			Kind: "upsert", ConversationId: id, Conversation: &gatewayv2.ConversationSummary{Id: id},
			SourceId: "source", Generation: "generation", DeliverySeq: seq,
		})
	}

	select {
	case status := <-sub.Status:
		if !status.Event.GetNeedsResync() || status.Event.GetLatestDeliverySeq() != historySubscriberBuffer+1 {
			t.Fatalf("drop status = %#v", status.Event)
		}
	case <-time.After(time.Second):
		t.Fatal("full history subscriber did not receive a recovery latch")
	}

	snapshot, ok := m.HistorySyncSnapshot("agent", "token")
	if !ok || snapshot.GetCutDeliverySeq() != historySubscriberBuffer+1 || len(snapshot.GetConversations()) != historySubscriberBuffer+2 {
		t.Fatalf("snapshot = %#v, ok=%v", snapshot, ok)
	}
	sub.Acknowledge("agent", "generation", historySubscriberBuffer+1)
}

func TestHistorySyncUnavailableAndDisconnectReleaseAuthority(t *testing.T) {
	m := NewManager()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", Conversations: []*gatewayv2.ConversationSummary{{Id: "one"}},
	})
	m.updateHistorySyncStatus("agent", &gatewayv2.HistorySyncStatus{
		SourceId: "source", Generation: "generation", Available: false, NeedsResync: true,
	})
	if _, ok := m.HistorySyncSnapshot("agent", "token"); ok {
		t.Fatal("unavailable producer exposed stale history authority")
	}

	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "next", Conversations: []*gatewayv2.ConversationSummary{{Id: "two"}},
	})
	m.ClearHistorySyncState("agent")
	if _, ok := m.HistorySyncSnapshot("agent", "token"); ok {
		t.Fatal("cleared agent retained history authority")
	}
}

func TestHistorySyncRejectsLateGenerationAndSnapshot(t *testing.T) {
	m := NewManager()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "new", CutDeliverySeq: 4,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "current"}},
	})
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "delete", ConversationId: "current", SourceId: "source", Generation: "old", DeliverySeq: 5,
	})
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "new", CutDeliverySeq: 3,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "stale"}},
	})
	snapshot, ok := m.HistorySyncSnapshot("agent", "token")
	if !ok || len(snapshot.GetConversations()) != 1 || snapshot.GetConversations()[0].GetId() != "current" {
		t.Fatalf("late update replaced authority: %#v", snapshot)
	}
}

func TestHistorySyncAcknowledgementCannotClearANewerDrop(t *testing.T) {
	m := NewManager()
	sub := m.SubscribeHistorySyncRecovery()
	defer sub.Cleanup()
	m.syncHub.historyMu.Lock()
	m.syncHub.historyResyncPending[0] = map[string]historyPendingCut{
		"agent": {generation: "generation", cut: 6},
	}
	m.syncHub.historyMu.Unlock()
	sub.Acknowledge("agent", "generation", 5)
	m.syncHub.historyMu.Lock()
	_, pending := m.syncHub.historyResyncPending[0]["agent"]
	m.syncHub.historyMu.Unlock()
	if !pending {
		t.Fatal("old acknowledgement cleared a newer drop")
	}
	sub.Acknowledge("agent", "generation", 6)
	m.syncHub.historyMu.Lock()
	pendingMap := m.syncHub.historyResyncPending[0]
	m.syncHub.historyMu.Unlock()
	if len(pendingMap) != 0 {
		t.Fatal("current acknowledgement did not clear the drop")
	}
}

func TestHistorySyncSequenceGapInvalidatesAuthorityUntilFullSnapshot(t *testing.T) {
	m := NewManager()
	sub := m.SubscribeHistorySyncRecovery()
	defer sub.Cleanup()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 0,
	})
	// Consume the initial snapshot recovery status.
	<-sub.Status
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: "one", Conversation: &gatewayv2.ConversationSummary{Id: "one"},
		SourceId: "source", Generation: "generation", DeliverySeq: 1,
	})
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: "three", Conversation: &gatewayv2.ConversationSummary{Id: "three"},
		SourceId: "source", Generation: "generation", DeliverySeq: 3,
	})
	if _, ok := m.HistorySyncSnapshot("agent", "token"); ok {
		t.Fatal("sequence gap exposed a partial authority")
	}
	select {
	case status := <-sub.Status:
		if !status.Event.GetNeedsResync() || status.Event.GetAvailable() {
			t.Fatalf("gap status = %#v", status.Event)
		}
	case <-time.After(time.Second):
		t.Fatal("sequence gap did not latch recovery")
	}
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 3,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "one"}, {Id: "two"}, {Id: "three"}},
	})
	if snapshot, ok := m.HistorySyncSnapshot("agent", "token"); !ok || len(snapshot.GetConversations()) != 3 {
		t.Fatalf("full snapshot did not repair authority: %#v, %v", snapshot, ok)
	}
}

func TestHistorySyncDuplicateSequenceIsIdempotent(t *testing.T) {
	m := NewManager()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 0,
	})
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: "one", Conversation: &gatewayv2.ConversationSummary{Id: "one"},
		SourceId: "source", Generation: "generation", DeliverySeq: 1,
	})
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "delete", ConversationId: "one", SourceId: "source", Generation: "generation", DeliverySeq: 1,
	})
	snapshot, ok := m.HistorySyncSnapshot("agent", "token")
	if !ok || snapshot.GetCutDeliverySeq() != 1 || len(snapshot.GetConversations()) != 1 || snapshot.GetConversations()[0].GetId() != "one" {
		t.Fatalf("duplicate sequence changed authority: %#v, %v", snapshot, ok)
	}
}

func TestHistorySyncIncrementalAuthorityHonorsTotalByteBudget(t *testing.T) {
	m := NewManager()
	sub := m.SubscribeHistorySyncRecovery()
	defer sub.Cleanup()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 0,
	})
	<-sub.Status
	m.syncHub.historyMu.Lock()
	m.syncHub.historyStates["agent"].conversationBytes = maxHistorySnapshotBytes
	m.syncHub.historyMu.Unlock()
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: "one", Conversation: &gatewayv2.ConversationSummary{Id: "one"},
		SourceId: "source", Generation: "generation", DeliverySeq: 1,
	})
	if _, ok := m.HistorySyncSnapshot("agent", "token"); ok {
		t.Fatal("incremental authority exceeded its byte budget")
	}
	select {
	case status := <-sub.Status:
		if !status.Event.GetNeedsResync() || status.Event.GetAvailable() {
			t.Fatalf("budget status = %#v", status.Event)
		}
	case <-time.After(time.Second):
		t.Fatal("budget overflow did not latch recovery")
	}
}

func TestHistorySyncLegacyMutationCannotReplaceV2Generation(t *testing.T) {
	m := NewManager()
	m.updateHistorySyncSnapshot("agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "v2-generation", CutDeliverySeq: 0,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "one", Title: "Initial"}},
	})
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: "one", Conversation: &gatewayv2.ConversationSummary{Id: "one", Title: "Legacy"},
	})
	m.broadcastHistorySync("agent", &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: "one", Conversation: &gatewayv2.ConversationSummary{Id: "one", Title: "Current"},
		SourceId: "source", Generation: "v2-generation", DeliverySeq: 1,
	})
	snapshot, ok := m.HistorySyncSnapshot("agent", "token")
	if !ok || snapshot.GetGeneration() != "v2-generation" || snapshot.GetCutDeliverySeq() != 1 ||
		len(snapshot.GetConversations()) != 1 || snapshot.GetConversations()[0].GetTitle() != "Current" {
		t.Fatalf("legacy event replaced v2 authority: %#v, %v", snapshot, ok)
	}
}
