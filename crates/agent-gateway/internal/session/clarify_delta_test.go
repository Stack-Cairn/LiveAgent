package session

import (
	"sync"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestWatchClarifyDeltasForwardsMatchingRequest(t *testing.T) {
	m := NewManager()
	var got []string
	unwatch := m.WatchClarifyDeltas("ns-req-1", func(delta *gatewayv2.ClarifyTurnDelta) {
		got = append(got, delta.GetText())
	})
	t.Cleanup(unwatch)

	m.forwardClarifyTurnDelta("ns-req-1", &gatewayv2.ClarifyTurnDelta{Text: "hel"})
	m.forwardClarifyTurnDelta("ns-req-1", &gatewayv2.ClarifyTurnDelta{Text: "lo"})
	m.forwardClarifyTurnDelta("other", &gatewayv2.ClarifyTurnDelta{Text: "nope"})

	if len(got) != 2 || got[0] != "hel" || got[1] != "lo" {
		t.Fatalf("got %#v", got)
	}
}

func TestWatchClarifyDeltasUnwatchStopsDelivery(t *testing.T) {
	m := NewManager()
	var mu sync.Mutex
	var n int
	unwatch := m.WatchClarifyDeltas("r", func(*gatewayv2.ClarifyTurnDelta) {
		mu.Lock()
		n++
		mu.Unlock()
	})
	m.forwardClarifyTurnDelta("r", &gatewayv2.ClarifyTurnDelta{Text: "a"})
	unwatch()
	m.forwardClarifyTurnDelta("r", &gatewayv2.ClarifyTurnDelta{Text: "b"})
	mu.Lock()
	defer mu.Unlock()
	if n != 1 {
		t.Fatalf("n=%d", n)
	}
}

func TestDispatchClarifyTurnDeltaDoesNotOccupyUnaryStream(t *testing.T) {
	m := NewManager()
	var got string
	unwatch := m.WatchClarifyDeltas("turn-1", func(delta *gatewayv2.ClarifyTurnDelta) {
		got = delta.GetText()
	})
	t.Cleanup(unwatch)

	sess := newTestSession(m, "agent-a", "session-a")
	m.SetSession(sess)
	t.Cleanup(func() { m.ClearSession(sess) })

	dispatchFor(m, sess, &gatewayv2.AgentEnvelope{
		RequestId: "turn-1",
		Payload: &gatewayv2.AgentEnvelope_ClarifyTurnDelta{
			ClarifyTurnDelta: &gatewayv2.ClarifyTurnDelta{Text: "流"},
		},
	})
	if got != "流" {
		t.Fatalf("delta not forwarded: %q", got)
	}
}
