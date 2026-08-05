package chatcmd

import (
	"context"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newCommandTestManager(t *testing.T) (*session.Manager, *session.AgentSession) {
	t.Helper()
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "test", "session-test")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(sess)
	t.Cleanup(func() { sm.ClearSession(sess) })
	return sm, sess
}

func TestChatTimeoutDefaultsAreShortAndDedicated(t *testing.T) {
	t.Parallel()

	if got := PrepareTimeout(nil); got != 2*time.Second {
		t.Fatalf("PrepareTimeout(nil) = %s, want 2s", got)
	}
	if got := DeliveryTimeout(nil); got != 5*time.Second {
		t.Fatalf("DeliveryTimeout(nil) = %s, want 5s", got)
	}
	if got := StartTimeout(nil); got != 5*time.Second {
		t.Fatalf("StartTimeout(nil) = %s, want 5s", got)
	}
	if got := RenderStartTimeout(nil); got != 10*time.Second {
		t.Fatalf("RenderStartTimeout(nil) = %s, want 10s", got)
	}
}

func TestDispatchAcceptedCommandUsesDeliveryTimeout(t *testing.T) {
	t.Parallel()

	sm, _ := newCommandTestManager(t)
	start := sm.StartChatCommand("desktop-agent", "run-delivery-timeout", "conv-1", "", "client-1", nil)
	cfg := &config.Config{ChatDeliveryTimeout: 30 * time.Millisecond}
	body := handler.ChatRequestBody{
		ConversationID:  "conv-1",
		ClientRequestID: "client-1",
		Message:         "hello",
	}

	startedAt := time.Now()
	DispatchAcceptedCommand(
		context.Background(), cfg, sm, "desktop-agent", nil, start, body, nil, "trace-delivery-timeout",
	)
	elapsed := time.Since(startedAt)
	if elapsed < 20*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("delivery timeout elapsed = %s, want about 30ms", elapsed)
	}

	sub := sm.SubscribeConversationStream("desktop-agent", "conv-1", 0, "")
	defer sub.Cleanup()
	if len(sub.Events) == 0 {
		t.Fatal("delivery timeout did not terminalize the accepted run")
	}
	last := sub.Events[len(sub.Events)-1]
	if last.Type != session.StreamEventRunFinished ||
		last.Payload["error_code"] != "desktop_runtime_unavailable" {
		t.Fatalf("delivery timeout terminal = %s %#v", last.Type, last.Payload)
	}
}

func TestChatStartupWatchdogUsesShortCombinedWindow(t *testing.T) {
	t.Parallel()

	sm, _ := newCommandTestManager(t)
	sm.StartChatCommand("desktop-agent", "run-start-timeout", "conv-1", "", "client-1", nil)
	cfg := &config.Config{
		ChatStartTimeout:       15 * time.Millisecond,
		ChatRenderStartTimeout: 20 * time.Millisecond,
	}

	startedAt := time.Now()
	WatchAcceptedCommandStartup(context.Background(), cfg, sm, "desktop-agent", "run-start-timeout")
	elapsed := time.Since(startedAt)
	if elapsed < 25*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("startup watchdog elapsed = %s, want about 35ms", elapsed)
	}

	sub := sm.SubscribeConversationStream("desktop-agent", "conv-1", 0, "")
	defer sub.Cleanup()
	last := sub.Events[len(sub.Events)-1]
	if last.Type != session.StreamEventRunFinished || last.Payload["error_code"] != "startup_timeout" {
		t.Fatalf("startup watchdog terminal = %s %#v", last.Type, last.Payload)
	}
}
