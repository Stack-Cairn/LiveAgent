package websocket_test

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestV2HistoryResyncRejectsWrongGenerationAndAcceptsCurrentCut(t *testing.T) {
	sm, _, conn, cleanup := newV2BrowserTest(t)
	defer cleanup()

	sm.IngestRemoteHistorySnapshot("desktop-agent", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 7,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "conversation", Title: "Title"}},
	})
	var status *gatewayv2.HistorySyncStatus
	for attempt := 0; attempt < 4 && status == nil; attempt++ {
		status = receiveWebFrameRaw(t, conn).GetHistorySyncStatus()
	}
	if status == nil || !status.GetNeedsResync() || status.GetResyncToken() == "" {
		t.Fatalf("history status = %#v", status)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "history-resync",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_HistoryResync{
			HistoryResync: &gatewayv2.HistoryResyncRequest{ResyncToken: status.GetResyncToken(), Limit: 500},
		},
	})
	snapshotFrame := receiveWebFrameWithID(t, conn, "history-resync")
	snapshot := snapshotFrame.GetHistorySyncSnapshot()
	if snapshot == nil || snapshot.GetCutDeliverySeq() != 7 || len(snapshot.GetConversations()) != 1 {
		t.Fatalf("history snapshot = %#v", snapshotFrame)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "history-ack-token",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_HistoryResyncAck{HistoryResyncAck: &gatewayv2.HistoryResyncAck{
			SourceId: "source", Generation: "generation", ResyncToken: "wrong-token", AppliedDeliverySeq: 7,
		}},
	})
	if frame := receiveWebFrameWithID(t, conn, "history-ack-token"); frame.GetLocalError() == nil {
		t.Fatalf("wrong token acknowledgement = %#v", frame)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "history-ack-old",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_HistoryResyncAck{HistoryResyncAck: &gatewayv2.HistoryResyncAck{
			SourceId: "source", Generation: "old", ResyncToken: status.GetResyncToken(), AppliedDeliverySeq: 7,
		}},
	})
	if frame := receiveWebFrameWithID(t, conn, "history-ack-old"); frame.GetLocalError() == nil {
		t.Fatalf("old acknowledgement = %#v", frame)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "history-ack",
		AgentId:   "desktop-agent",
		Payload: &gatewayv2.WebClientFrame_HistoryResyncAck{HistoryResyncAck: &gatewayv2.HistoryResyncAck{
			SourceId: "source", Generation: "generation", ResyncToken: status.GetResyncToken(), AppliedDeliverySeq: 7,
		}},
	})
	if frame := receiveWebFrameWithID(t, conn, "history-ack"); frame.GetAck() == nil {
		t.Fatalf("current acknowledgement = %#v", frame)
	}

	sm.IngestRemoteHistoryStatus("desktop-agent", &gatewayv2.HistorySyncStatus{
		SourceId: "source", Generation: "generation", LatestDeliverySeq: 7, Available: true,
	})
	for attempt := 0; attempt < 4; attempt++ {
		frame := receiveWebFrameRaw(t, conn)
		if current := frame.GetHistorySyncStatus(); current != nil {
			if current.GetNeedsResync() {
				t.Fatalf("acknowledged recovery remained latched: %#v", current)
			}
			return
		}
	}
	t.Fatal("history status after acknowledgement was not delivered")
}
