package pbws

import (
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

func TestHistoryResyncAckRejectsExpiredAndWrongGeneration(t *testing.T) {
	now := time.Now()
	latch := historyRecoveryLatch{
		sourceID: "source", generation: "generation", token: "token", cutSeq: 5, createdAt: now,
	}
	valid := &gatewayv2.HistoryResyncAck{
		SourceId: "source", Generation: "generation", ResyncToken: "token", AppliedDeliverySeq: 5,
	}
	if !historyResyncAckMatches(latch, valid, now.Add(59*time.Second)) {
		t.Fatal("valid acknowledgement was rejected")
	}
	if historyResyncAckMatches(latch, valid, now.Add(61*time.Second)) {
		t.Fatal("expired acknowledgement was accepted")
	}
	wrongGeneration := proto.Clone(valid).(*gatewayv2.HistoryResyncAck)
	wrongGeneration.Generation = "old"
	if historyResyncAckMatches(latch, wrongGeneration, now) {
		t.Fatal("old generation acknowledgement was accepted")
	}
	staleSeq := proto.Clone(valid).(*gatewayv2.HistoryResyncAck)
	staleSeq.AppliedDeliverySeq = 4
	if historyResyncAckMatches(latch, staleSeq, now) {
		t.Fatal("acknowledgement below the recovery cut was accepted")
	}
}

func TestHistoryEventQueueDropUsesIndependentRecoveryControl(t *testing.T) {
	core := wscore.NewConn(nil, wscore.Config{
		QueueSize: 1, QueueBytes: 1 << 20, CtrlQueueSize: 1, CtrlQueueBytes: 1 << 20,
		WriteTimeout: 10 * time.Millisecond,
	})
	c := &browserConn{core: core, done: core.Done(), historyRecovery: make(map[string]historyRecoveryLatch)}
	events := make(chan session.Tagged[*gatewayv2.HistorySyncEvent], 2)
	status := make(chan session.Tagged[*gatewayv2.HistorySyncStatus], 1)
	done := make(chan struct{})
	go func() {
		c.forwardHistorySync(&session.HistorySyncSubscription{
			Events: events, Status: status, Acknowledge: func(string, string, uint64) {}, Cleanup: func() {},
		})
		close(done)
	}()
	for seq := uint64(1); seq <= 2; seq++ {
		events <- session.Tagged[*gatewayv2.HistorySyncEvent]{AgentID: "agent", Event: &gatewayv2.HistorySyncEvent{
			Kind: "delete", ConversationId: "conversation", SourceId: "source", Generation: "generation", DeliverySeq: seq,
		}}
	}
	select {
	case frame := <-core.CtrlOutbox:
		var decoded gatewayv2.WebServerFrame
		if err := proto.Unmarshal(frame.Data, &decoded); err != nil {
			t.Fatal(err)
		}
		got := decoded.GetHistorySyncStatus()
		if got == nil || !got.GetNeedsResync() || got.GetResyncToken() == "" || got.GetLatestDeliverySeq() != 2 {
			t.Fatalf("recovery control = %#v", &decoded)
		}
	case <-time.After(time.Second):
		t.Fatal("queue drop did not emit recovery control")
	}
	core.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("history forwarder did not stop")
	}
}

func TestHistorySnapshotPageDoesNotAliasCachedAuthority(t *testing.T) {
	snapshot := &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", ResyncToken: "token",
		Conversations: []*gatewayv2.ConversationSummary{{Id: "one", Title: "Original"}, {Id: "two"}},
		Workdirs:      []*gatewayv2.HistoryWorkdirSummary{{Path: "/project", ConversationCount: 2}},
	}
	page, err := pageHistorySnapshot(snapshot, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	page.Conversations[0].Title = "Changed"
	page.Workdirs[0].Path = "/changed"
	if snapshot.Conversations[0].GetTitle() != "Original" || snapshot.Workdirs[0].GetPath() != "/project" {
		t.Fatal("page mutation changed cached authority")
	}
	if page.GetNextOffset() != 1 || page.GetTotalCount() != 2 {
		t.Fatalf("page cursor = %#v", page)
	}
}
