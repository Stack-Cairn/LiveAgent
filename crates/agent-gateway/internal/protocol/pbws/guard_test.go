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

func TestVetAgentRequestAllowsWorkspaceRootGrantListApplyAndRevoke(t *testing.T) {
	id := "grant-1"
	requests := []*gatewayv2.WorkspaceRootGrantsRequest{
		{Action: "list", ProjectId: "project-1", ProjectPath: "/work/project"},
		{
			Action:      "apply",
			ProjectId:   "project-1",
			ProjectPath: "/work/project",
			Grants: []*gatewayv2.WorkspaceRootGrantDraft{
				{Id: &id, Alias: "shared", DisplayPath: "/work/shared", Access: "read"},
			},
		},
		{Action: "revoke", ProjectId: "project-1"},
	}

	for _, request := range requests {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_WorkspaceRootGrants{
				WorkspaceRootGrants: request,
			},
		}
		if err := vetAgentRequest(session.AgentView{}, env); err != nil {
			t.Fatalf("vetAgentRequest(%+v) error = %v", request, err)
		}
	}
}

func TestVetAgentRequestRejectsMalformedWorkspaceRootGrants(t *testing.T) {
	emptyID := " "
	requests := []*gatewayv2.WorkspaceRootGrantsRequest{
		nil,
		{Action: "list", ProjectId: "", ProjectPath: "/work/project"},
		{Action: "list", ProjectId: "project-1", ProjectPath: ""},
		{
			Action:      "list",
			ProjectId:   "project-1",
			ProjectPath: "/work/project",
			Grants:      []*gatewayv2.WorkspaceRootGrantDraft{{Alias: "shared"}},
		},
		{
			Action:      "apply",
			ProjectId:   "project-1",
			ProjectPath: "/work/project",
			Grants: []*gatewayv2.WorkspaceRootGrantDraft{
				{Id: &emptyID, Alias: "shared", DisplayPath: "/work/shared", Access: "read"},
			},
		},
		{
			Action:      "apply",
			ProjectId:   "project-1",
			ProjectPath: "/work/project",
			Grants: []*gatewayv2.WorkspaceRootGrantDraft{
				{Alias: "shared", DisplayPath: "/work/shared", Access: "admin"},
			},
		},
		{Action: "revoke", ProjectId: "project-1", ProjectPath: "/work/project"},
		{
			Action:    "revoke",
			ProjectId: "project-1",
			Grants:    []*gatewayv2.WorkspaceRootGrantDraft{{Alias: "shared"}},
		},
	}

	for _, request := range requests {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_WorkspaceRootGrants{
				WorkspaceRootGrants: request,
			},
		}
		if err := vetAgentRequest(session.AgentView{}, env); err == nil {
			t.Fatalf("vetAgentRequest(%+v) unexpectedly succeeded", request)
		}
	}
}
