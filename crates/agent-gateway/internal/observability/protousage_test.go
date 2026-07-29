package observability

import "testing"

func TestProtoUsageSnapshotIncludesReliableIngressAndTransportCounters(t *testing.T) {
	var usage ProtoUsage
	usage.V2AgentInboundOverflowsTotal.Add(1)
	usage.ChatIngressGapsTotal.Add(2)
	usage.ChatIngressCheckpointRequestsTotal.Add(3)
	usage.ChatIngressCheckpointsCommittedTotal.Add(4)
	usage.ChatIngressReplayRequestsTotal.Add(5)
	usage.ChatIngressTerminalsCommittedTotal.Add(6)
	usage.ChatIngressFragmentRejectsTotal.Add(7)
	usage.WebSocketWriterClosesTotal.Add(8)
	usage.WebSocketQueueByteOverflowsTotal.Add(9)

	snapshot := usage.Snapshot()
	want := map[string]int64{
		"v2_agent_inbound_overflows_total":         1,
		"chat_ingress_gaps_total":                  2,
		"chat_ingress_checkpoint_requests_total":   3,
		"chat_ingress_checkpoints_committed_total": 4,
		"chat_ingress_replay_requests_total":       5,
		"chat_ingress_terminals_committed_total":   6,
		"chat_ingress_fragment_rejects_total":      7,
		"websocket_writer_closes_total":            8,
		"websocket_queue_byte_overflows_total":     9,
	}
	for key, expected := range want {
		if got := snapshot[key]; got != expected {
			t.Fatalf("Snapshot[%q] = %d, want %d", key, got, expected)
		}
	}
}
