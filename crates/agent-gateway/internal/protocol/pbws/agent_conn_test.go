package pbws

import (
	"sync/atomic"
	"testing"

	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestAgentInboundByteBudgetIsBoundedAndReleased(t *testing.T) {
	t.Parallel()

	var queued atomic.Int64
	if !reserveAgentInboundBytes(&queued, agentInboundQueueBytes) {
		t.Fatal("reserve exact inbound byte budget = false, want true")
	}
	if reserveAgentInboundBytes(&queued, 1) {
		t.Fatal("reserve beyond inbound byte budget = true, want false")
	}
	releaseAgentInboundBytes(&queued, agentInboundQueueBytes)
	if got := queued.Load(); got != 0 {
		t.Fatalf("queued inbound bytes after release = %d, want 0", got)
	}
	if !reserveAgentInboundBytes(&queued, 1) {
		t.Fatal("reserve after release = false, want true")
	}
}

func TestAgentInboundRejectsOversizedFrame(t *testing.T) {
	t.Parallel()

	var queued atomic.Int64
	if reserveAgentInboundBytes(&queued, agentInboundQueueBytes+1) {
		t.Fatal("oversized inbound frame reserve = true, want false")
	}
	if got := queued.Load(); got != 0 {
		t.Fatalf("queued inbound bytes after oversized frame = %d, want 0", got)
	}
}

func TestAgentInboundOverflowIncrementsProtocolUsage(t *testing.T) {
	before := observability.Usage.V2AgentInboundOverflowsTotal.Load()
	agentSession := session.NewAgentSession(session.AuthSnapshot{
		AgentID:   "agent-observe",
		SessionID: "session-observe",
	})
	defer agentSession.Close()
	noteAgentInboundOverflow(agentSession, 1024, "frame_limit")
	if got := observability.Usage.V2AgentInboundOverflowsTotal.Load() - before; got != 1 {
		t.Fatalf("agent inbound overflow metric delta = %d, want 1", got)
	}
}
