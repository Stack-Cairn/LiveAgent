package pbws

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestVetAgentRequestAllowsProviderUsage(t *testing.T) {
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_ProviderUsage{
			ProviderUsage: &gatewayv2.ProviderUsageRequest{
				ProviderId: "provider-1",
				Refresh:    true,
			},
		},
	}

	if err := vetAgentRequest(session.AgentView{}, env); err != nil {
		t.Fatalf("vetAgentRequest() error = %v", err)
	}
}

func TestVetAgentRequestAllowsHistorySkills(t *testing.T) {
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_HistorySkills{
			HistorySkills: &gatewayv2.HistorySkillsRequest{
				ConversationId: "conversation-1",
				SkillPresetId:  "focused-review",
				SkillsDisabled: true,
			},
		},
	}

	if err := vetAgentRequest(session.AgentView{}, env); err != nil {
		t.Fatalf("vetAgentRequest() error = %v", err)
	}
}

func TestVetAgentRequestAllowsValidChatFileOpen(t *testing.T) {
	line := uint32(12)
	column := uint32(4)
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_ChatFileOpen{
			ChatFileOpen: &gatewayv2.ChatFileOpenRequest{
				ConversationId: "conversation-1",
				Workdir:        `C:\work`,
				Path:           `src\a.ts`,
				Source:         "relative",
				Line:           &line,
				Column:         &column,
			},
		},
	}

	if err := vetAgentRequest(session.AgentView{}, env); err != nil {
		t.Fatalf("vetAgentRequest() error = %v", err)
	}
}

func TestVetAgentRequestRejectsMalformedChatFileOpen(t *testing.T) {
	zero := uint32(0)
	tests := []*gatewayv2.ChatFileOpenRequest{
		nil,
		{ConversationId: "", Workdir: "/work", Path: "a.ts", Source: "relative"},
		{ConversationId: "conversation-1", Workdir: "/work", Path: "a.ts", Source: "javascript"},
		{ConversationId: "conversation-1", Workdir: "/work", Path: "a.ts", Source: "relative", Line: &zero},
	}
	for _, request := range tests {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_ChatFileOpen{ChatFileOpen: request},
		}
		if err := vetAgentRequest(session.AgentView{}, env); err == nil {
			t.Fatalf("vetAgentRequest(%+v) unexpectedly succeeded", request)
		}
	}
}
