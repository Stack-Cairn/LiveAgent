package chatcmd

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestConversationReferencesSurviveGatewayCommandRoundTrip(t *testing.T) {
	request := &gatewayv2.ChatRequest{
		ConversationId:  "conversation-current",
		ClientRequestId: "client-reference-roundtrip",
		Message:         "compare prior conversations",
		ReferencedConversations: []*gatewayv2.ChatConversationReference{
			{Id: "conversation-current", Title: "Current"},
			{Id: "conversation-a", Title: "  Earlier   investigation  ", Cwd: " /source "},
			{Id: "conversation-a", Title: "Duplicate"},
			{Id: "conversation-b", Title: "Second"},
			{Id: "conversation-c", Title: "Third"},
			{Id: "conversation-d", Title: "Fourth"},
		},
	}
	body := RequestBodyFromProto(request)
	if err := NormalizeRequestBody(&body); err != nil {
		t.Fatalf("NormalizeRequestBody() error = %v", err)
	}

	envelope := buildCommandEnvelope("run-reference-roundtrip", "chat.submit", body, nil)
	forwarded := envelope.GetChatCommand().GetRequest().GetReferencedConversations()
	if len(forwarded) != 3 {
		t.Fatalf("forwarded references = %#v, want 3 normalized entries", forwarded)
	}
	if forwarded[0].GetId() != "conversation-a" ||
		forwarded[0].GetTitle() != "Earlier investigation" ||
		forwarded[0].GetCwd() != "/source" {
		t.Fatalf("first forwarded reference = %#v", forwarded[0])
	}
	if forwarded[1].GetId() != "conversation-b" || forwarded[2].GetId() != "conversation-c" {
		t.Fatalf("forwarded reference ids = %q, %q", forwarded[1].GetId(), forwarded[2].GetId())
	}
}

func TestComposerCommandSurvivesGatewayCommandRoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		request *gatewayv2.ChatRequest
		action  string
		text    string
		prompt  bool
		plan    bool
	}{
		{
			name:    "goal set",
			request: &gatewayv2.ChatRequest{GoalAction: " set ", GoalText: "  ship it  "},
			action:  "set", text: "ship it",
		},
		{
			name:    "goal resume drops text",
			request: &gatewayv2.ChatRequest{GoalAction: "resume", GoalText: ""},
			action:  "resume",
		},
		{
			name:    "prompt command",
			request: &gatewayv2.ChatRequest{PromptCommand: true},
			prompt:  true,
		},
		{
			name:    "plan command",
			request: &gatewayv2.ChatRequest{PlanCommand: true},
			plan:    true,
		},
	}
	for _, tc := range cases {
		tc.request.ConversationId = "conversation-1"
		tc.request.ClientRequestId = "client-" + tc.name
		tc.request.Message = "/cmd args"
		body := RequestBodyFromProto(tc.request)
		if err := NormalizeRequestBody(&body); err != nil {
			t.Fatalf("%s: NormalizeRequestBody() error = %v", tc.name, err)
		}
		if !HasComposerCommand(body) {
			t.Fatalf("%s: HasComposerCommand() = false", tc.name)
		}
		forwarded := buildCommandEnvelope("run-1", "chat.submit", body, nil).GetChatCommand().GetRequest()
		if forwarded.GetGoalAction() != tc.action ||
			forwarded.GetGoalText() != tc.text ||
			forwarded.GetPromptCommand() != tc.prompt || forwarded.GetPlanCommand() != tc.plan {
			t.Fatalf("%s: forwarded = action %q text %q prompt %v", tc.name,
				forwarded.GetGoalAction(), forwarded.GetGoalText(), forwarded.GetPromptCommand())
		}
	}
}

func TestNormalizeRequestBodyRejectsInvalidComposerCommands(t *testing.T) {
	for name, body := range map[string]handler.ChatRequestBody{
		"unknown goal action":      {GoalAction: "clear"},
		"goal set without text":    {GoalAction: "set", GoalText: "  "},
		"goal text too long":       {GoalAction: "set", GoalText: strings.Repeat("g", MaxGoalTextLen+1)},
		"goal text without action": {GoalText: "ship it"},
		"goal with prompt command": {GoalAction: "resume", PromptCommand: true},
		"plan with goal":           {PlanCommand: true, GoalAction: "resume"},
		"plan with prompt":         {PlanCommand: true, PromptCommand: true},
		"plan with goal text":      {PlanCommand: true, GoalText: "task"},
	} {
		body.ConversationID = "conversation-1"
		body.ClientRequestID = "client-1"
		body.Message = "/goal x"
		if err := NormalizeRequestBody(&body); err == nil {
			t.Fatalf("%s: NormalizeRequestBody() error = nil, want rejection", name)
		}
	}
	plain := handler.ChatRequestBody{ConversationID: "c", ClientRequestID: "r", Message: "hello"}
	if err := NormalizeRequestBody(&plain); err != nil || HasComposerCommand(plain) {
		t.Fatalf("plain message: err = %v, composer = %v", err, HasComposerCommand(plain))
	}
}

func newCommandTestManager(t *testing.T) (*session.Manager, *session.AgentSession) {
	t.Helper()
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "test", "session-test")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(sess)
	t.Cleanup(func() { sm.ClearSession(sess) })
	return sm, sess
}

func TestProbeRuntimeRejectsDesktopWithoutChatIngressV1(t *testing.T) {
	sm, sess := newCommandTestManager(t)

	err := ProbeRuntime(context.Background(), sm, "desktop-agent")
	if !errors.Is(err, session.ErrChatProtocolIncompatible) {
		t.Fatalf("ProbeRuntime() error = %v, want ErrChatProtocolIncompatible", err)
	}
	select {
	case outbound := <-sess.Outbound():
		t.Fatalf("incompatible desktop received probe envelope: %#v", outbound.GatewayEnvelope)
	default:
	}
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
