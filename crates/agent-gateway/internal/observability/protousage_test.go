package observability

import "testing"

func TestProtoUsageSnapshotIncludesReliableIngressAndTransportCounters(t *testing.T) {
	var usage ProtoUsage
	usage.V2AgentInboundOverflowsTotal.Add(1)
	usage.WebSocketWriterClosesTotal.Add(8)
	usage.WebSocketQueueByteOverflowsTotal.Add(9)

	snapshot := usage.Snapshot()
	want := map[string]int64{
		"v2_agent_inbound_overflows_total":     1,
		"websocket_writer_closes_total":        8,
		"websocket_queue_byte_overflows_total": 9,
	}
	for key, expected := range want {
		if got := snapshot[key]; got != expected {
			t.Fatalf("Snapshot[%q] = %d, want %d", key, got, expected)
		}
	}
}
