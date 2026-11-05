package pbws

import (
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
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

func TestVetAgentRequestAllowsInstalledAppsList(t *testing.T) {
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_InstalledAppsList{
			InstalledAppsList: &gatewayv2.InstalledAppsListRequest{},
		},
	}

	if err := vetAgentRequest(session.AgentView{}, env); err != nil {
		t.Fatalf("vetAgentRequest() error = %v", err)
	}
}

func TestVetAgentRequestAllowsReadOnlyCuaDriverActions(t *testing.T) {
	for _, action := range []string{"probe", "permissions_status"} {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_CuaDriver{
				CuaDriver: &gatewayv2.CuaDriverRequest{Action: action},
			},
		}

		if err := vetAgentRequest(session.AgentView{}, env); err != nil {
			t.Fatalf("vetAgentRequest(%q) error = %v", action, err)
		}
	}
}

// 提示词模板的独立通道已退役：目录走 slash_command_list，展开随 ChatRequest.prompt_command。
func TestVetAgentRequestRejectsRetiredPromptTemplateRequests(t *testing.T) {
	view := composerAgentView(t)
	for name, env := range map[string]*gatewayv2.GatewayEnvelope{
		"list": {Payload: &gatewayv2.GatewayEnvelope_PromptTemplateList{
			PromptTemplateList: &gatewayv2.PromptTemplateListRequest{Workdir: "/repo"},
		}},
		"expand": {Payload: &gatewayv2.GatewayEnvelope_PromptTemplateExpand{
			PromptTemplateExpand: &gatewayv2.PromptTemplateExpandRequest{Name: "review-pr", Text: "123", Workdir: "/repo"},
		}},
	} {
		if err := vetAgentRequest(view, env); err == nil {
			t.Fatalf("vetAgentRequest(%s) error = nil, want rejection", name)
		}
	}
}

func composerAgentView(t *testing.T) session.AgentView {
	t.Helper()
	manager := session.NewManager()
	agent := session.NewAgentSession(session.AuthSnapshot{AgentID: "agent-1", SessionID: "session-1"})
	agent.SetCapabilities([]string{gatewayv2.ComposerCommandsV1Capability})
	manager.SetSession(agent)
	t.Cleanup(func() { manager.ClearSession(agent) })
	return manager.AgentView("agent-1")
}

// 安装与授权是桌面本机动作（联网执行安装脚本 / 弹 macOS TCC 对话框），浏览器不得下发。
func TestVetAgentRequestRejectsCuaDriverProvisioning(t *testing.T) {
	for _, action := range []string{"install", "permissions_grant", ""} {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_CuaDriver{
				CuaDriver: &gatewayv2.CuaDriverRequest{Action: action},
			},
		}

		if err := vetAgentRequest(session.AgentView{}, env); err == nil {
			t.Fatalf("vetAgentRequest(%q) expected rejection", action)
		}
	}
}

func TestVetAgentRequestProxyDetectAllowsOnlyDetectAndTest(t *testing.T) {
	view := proxyDetectAgentView(t)
	for _, action := range []string{"detect", "test"} {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_ProxyDetect{
				ProxyDetect: &gatewayv2.ProxyDetectRequest{
					Action:    action,
					InputJson: `{"type":"http","host":"127.0.0.1","port":7890}`,
				},
			},
		}
		if err := vetAgentRequest(view, env); err != nil {
			t.Fatalf("vetAgentRequest(%q) error = %v", action, err)
		}
	}
	for _, req := range []*gatewayv2.ProxyDetectRequest{
		{Action: "apply"},
		{Action: ""},
		{Action: "test", InputJson: strings.Repeat("x", 1025)},
	} {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_ProxyDetect{ProxyDetect: req},
		}
		if err := vetAgentRequest(view, env); err == nil {
			t.Fatalf("vetAgentRequest(action=%q, len=%d) expected rejection", req.GetAction(), len(req.GetInputJson()))
		}
	}
}

// 旧桌面端不认识 proxy_detect 载荷臂，会静默丢弃；网关要立即拒绝，别让浏览器等到超时。
func TestVetAgentRequestProxyDetectRequiresDesktopCapability(t *testing.T) {
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_ProxyDetect{
			ProxyDetect: &gatewayv2.ProxyDetectRequest{Action: "detect"},
		},
	}
	err := vetAgentRequest(composerAgentView(t), env)
	if err == nil || !strings.Contains(err.Error(), "update LiveAgent") {
		t.Fatalf("vetAgentRequest() error = %v, want capability rejection", err)
	}
}

func proxyDetectAgentView(t *testing.T) session.AgentView {
	t.Helper()
	manager := session.NewManager()
	agent := session.NewAgentSession(session.AuthSnapshot{AgentID: "agent-1", SessionID: "session-1"})
	agent.SetCapabilities([]string{gatewayv2.ProxyDetectV1Capability})
	manager.SetSession(agent)
	t.Cleanup(func() { manager.ClearSession(agent) })
	return manager.AgentView("agent-1")
}

func TestVetAgentRequestAllowsClarifyTurn(t *testing.T) {
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_ClarifyTurn{
			ClarifyTurn: &gatewayv2.ClarifyTurnRequest{
				MessagesJson: `[{"role":"user","content":"hi"}]`,
				ProviderId:   "builtin-gemini",
				Model:        "gemini-2.0-flash",
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

func TestVetAgentRequestAllowsCheckpointActions(t *testing.T) {
	requests := []*gatewayv2.CheckpointRequest{
		{Action: "list", ConversationId: "conversation-1"},
		{Action: "diff", ConversationId: "conversation-1", TurnSeq: 2, AuthorizedRoots: []string{"/work"}},
		// K-brain's first turn is turn_seq 0.
		{Action: "diff", ConversationId: "conversation-1", AuthorizedRoots: []string{"/work"}},
		{Action: "rewind", ConversationId: "conversation-1", AuthorizedRoots: []string{"/work"}},
		{
			Action:          "rewind",
			ConversationId:  "conversation-1",
			TurnSeq:         2,
			AuthorizedRoots: []string{"/work"},
			Expected:        []*gatewayv2.CheckpointExpectedEntry{{Key: "/work\x01a.txt", CurrentHash: "abc"}},
		},
	}

	for _, request := range requests {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_Checkpoint{Checkpoint: request},
		}
		if err := vetAgentRequest(session.AgentView{}, env); err != nil {
			t.Fatalf("vetAgentRequest(%+v) error = %v", request, err)
		}
	}
}

func TestVetAgentRequestRejectsMalformedCheckpoint(t *testing.T) {
	tooManyRoots := make([]string, 65)
	for index := range tooManyRoots {
		tooManyRoots[index] = "/work"
	}
	requests := []*gatewayv2.CheckpointRequest{
		nil,
		{Action: "list", ConversationId: "conversation-1", TurnSeq: 1},
		{Action: "diff", ConversationId: "conversation-1", Expected: []*gatewayv2.CheckpointExpectedEntry{{Key: "/work\x01a.txt", CurrentHash: "abc"}}},
		{Action: "rewind"},
		{Action: "unknown", ConversationId: "conversation-1"},
		{Action: "diff", ConversationId: "conversation-1", TurnSeq: 1, AuthorizedRoots: []string{" "}},
		{Action: "diff", ConversationId: "conversation-1", TurnSeq: 1, AuthorizedRoots: tooManyRoots},
		{
			Action:         "rewind",
			ConversationId: "conversation-1",
			TurnSeq:        1,
			Expected:       []*gatewayv2.CheckpointExpectedEntry{{Key: " ", CurrentHash: "abc"}},
		},
		{
			Action:         "rewind",
			ConversationId: "conversation-1",
			TurnSeq:        1,
			Expected:       []*gatewayv2.CheckpointExpectedEntry{{Key: "/work\x01a.txt"}},
		},
	}

	for _, request := range requests {
		env := &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_Checkpoint{Checkpoint: request},
		}
		if err := vetAgentRequest(session.AgentView{}, env); err == nil {
			t.Fatalf("vetAgentRequest(%+v) unexpectedly succeeded", request)
		}
	}
}

func TestCanonicalTerminalRetainsNativeRemoteGate(t *testing.T) {
	for _, action := range []string{"create", "read", "input", "close", "list"} {
		request := &gatewayv2.TerminalRequest{Action: action, ConversationId: "conversation", RunId: "run", SessionId: "term-1"}
		if err := vetCanonicalTerminal(request); err != nil {
			t.Fatal(err)
		}
		env := &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_TerminalRequest{TerminalRequest: request}}
		if err := vetAgentRequest(session.AgentView{}, env); err == nil {
			t.Fatalf("native Remote gate bypassed: %s", action)
		}
	}
	for _, request := range []*gatewayv2.TerminalRequest{
		{Action: "read", RunId: "run"}, {Action: "create_ssh", ConversationId: "c", RunId: "r"},
		{Action: "resize", ConversationId: "c", RunId: "r", Cols: 65536},
	} {
		if err := vetCanonicalTerminal(request); err == nil {
			t.Fatalf("invalid request accepted: %+v", request)
		}
	}
}

func TestVetAgentRequestAllowsSlashCommandsGoalsAndLoops(t *testing.T) {
	view := composerAgentView(t)
	for name, env := range map[string]*gatewayv2.GatewayEnvelope{
		"slash commands": {Payload: &gatewayv2.GatewayEnvelope_SlashCommandList{
			SlashCommandList: &gatewayv2.SlashCommandListRequest{Workdir: "/repo"},
		}},
		"goal clear": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: "clear"},
		}},
		"goal get": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: "get"},
		}},
		"goal pause": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: "pause"},
		}},
		"goal update": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: "update", Goal: "ship the release notes"},
		}},
		"loops list": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "sess-1", Action: "list"},
		}},
		"loops list ignores stray interval": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "sess-1", Action: "list", Interval: strings.Repeat("9", 64)},
		}},
		"loop create": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{
				ConversationId: "sess-1", Action: "create", Cron: "0 */10 * * * *",
				Interval: "10m", Prompt: "report the build",
			},
		}},
		"loop cancel": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "sess-1", Action: "cancel", LoopId: "loop-1"},
		}},
	} {
		if err := vetAgentRequest(view, env); err != nil {
			t.Fatalf("vetAgentRequest(%s) error = %v", name, err)
		}
	}
}

func TestVetAgentRequestNormalizesComposerActions(t *testing.T) {
	view := composerAgentView(t)
	goal := &gatewayv2.GoalManageRequest{ConversationId: " sess-1 ", Action: " clear "}
	if err := vetAgentRequest(view, &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_GoalManage{GoalManage: goal}}); err != nil {
		t.Fatal(err)
	}
	if goal.GetAction() != "clear" || goal.GetConversationId() != "sess-1" {
		t.Fatalf("goal request not normalized: %+v", goal)
	}
	paused := &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: "pause", Goal: "stray"}
	if err := vetAgentRequest(view, &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_GoalManage{GoalManage: paused}}); err != nil {
		t.Fatal(err)
	}
	if paused.GetGoal() != "" {
		t.Fatalf("goal text must only travel with update: %+v", paused)
	}
	updated := &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: " update ", Goal: "  new goal  "}
	if err := vetAgentRequest(view, &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_GoalManage{GoalManage: updated}}); err != nil {
		t.Fatal(err)
	}
	if updated.GetAction() != "update" || updated.GetGoal() != "new goal" {
		t.Fatalf("goal update not normalized: %+v", updated)
	}
	loop := &gatewayv2.LoopManageRequest{ConversationId: "sess-1", Action: " cancel ", LoopId: " loop-1 ", Prompt: "stray"}
	if err := vetAgentRequest(view, &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_LoopManage{LoopManage: loop}}); err != nil {
		t.Fatal(err)
	}
	if loop.GetAction() != "cancel" || loop.GetLoopId() != "loop-1" || loop.GetPrompt() != "" {
		t.Fatalf("loop request not normalized: %+v", loop)
	}
}

func TestVetAgentRequestRejectsComposerActionsWithoutCapability(t *testing.T) {
	for name, env := range map[string]*gatewayv2.GatewayEnvelope{
		"slash commands": {Payload: &gatewayv2.GatewayEnvelope_SlashCommandList{
			SlashCommandList: &gatewayv2.SlashCommandListRequest{},
		}},
		"goal clear": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "sess-1", Action: "clear"},
		}},
		"loops list": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "sess-1", Action: "list"},
		}},
	} {
		err := vetAgentRequest(session.AgentView{}, env)
		if err == nil || err.Error() != errComposerCommandsUnsupported {
			t.Fatalf("vetAgentRequest(%s) error = %v, want capability rejection", name, err)
		}
	}
}

func TestVetAgentRequestRejectsInvalidGoalAndLoopRequests(t *testing.T) {
	view := composerAgentView(t)
	for name, env := range map[string]*gatewayv2.GatewayEnvelope{
		"slash workdir too long": {Payload: &gatewayv2.GatewayEnvelope_SlashCommandList{
			SlashCommandList: &gatewayv2.SlashCommandListRequest{Workdir: strings.Repeat("a", maxSlashCommandWorkdirLen+1)},
		}},
		"goal nil": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{}},
		"goal without conversation": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{Action: "clear"},
		}},
		"goal unknown action": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "s", Action: "stop"},
		}},
		"goal resume over the manage route": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "s", Action: "resume"},
		}},
		"goal update without text": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "s", Action: "update", Goal: "   "},
		}},
		"goal update too long": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "s", Action: "update", Goal: strings.Repeat("g", chatcmd.MaxGoalTextLen+1)},
		}},
		"goal set over the manage route": {Payload: &gatewayv2.GatewayEnvelope_GoalManage{
			GoalManage: &gatewayv2.GoalManageRequest{ConversationId: "s", Action: "set"},
		}},
		"loop nil": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{}},
		"loop unknown action": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "s", Action: "pause"},
		}},
		"loop create without schedule": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "s", Action: "create", Prompt: "x"},
		}},
		"loop create without prompt": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "s", Action: "create", Cron: "0 */10 * * * *"},
		}},
		"loop create interval too long": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "s", Action: "create", Cron: "0 */10 * * * *", Prompt: "x", Interval: strings.Repeat("9", maxLoopIntervalLen+1)},
		}},
		"loop prompt too long": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "s", Action: "create", Cron: "0 */10 * * * *", Prompt: strings.Repeat("p", maxLoopPromptLen+1)},
		}},
		"loop cancel without id": {Payload: &gatewayv2.GatewayEnvelope_LoopManage{
			LoopManage: &gatewayv2.LoopManageRequest{ConversationId: "s", Action: "cancel"},
		}},
	} {
		if err := vetAgentRequest(view, env); err == nil {
			t.Fatalf("vetAgentRequest(%s) error = nil, want rejection", name)
		}
	}
}

// 权限规则（设置 → 权限）：只放行 list/add/delete，参数必须是 JSON 对象且限长。
func TestVetAgentRequestPermissionRulesAllowsOnlyListAddDelete(t *testing.T) {
	view := permissionRulesAgentView(t)
	for _, req := range []*gatewayv2.PermissionRulesRequest{
		{Action: "list", InputJson: `{"workspace":"D:\\work\\a"}`},
		{Action: "list"},
		{Action: "add", InputJson: `{"rule":"Bash(rm:*)","effect":"deny","scope":"user"}`},
		{Action: "delete", InputJson: `{"id":"r_1","scope":"project","workspace":"/w"}`},
	} {
		env := &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_PermissionRules{PermissionRules: req}}
		if err := vetAgentRequest(view, env); err != nil {
			t.Fatalf("vetAgentRequest(%q) error = %v", req.GetAction(), err)
		}
	}
	for _, req := range []*gatewayv2.PermissionRulesRequest{
		{Action: "update", InputJson: `{}`},
		{Action: ""},
		{Action: "add", InputJson: `["Bash(rm:*)"]`},
		{Action: "add", InputJson: `{not json`},
		{Action: "add", InputJson: `{"rule":"` + strings.Repeat("x", 40000) + `"}`},
	} {
		env := &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_PermissionRules{PermissionRules: req}}
		if err := vetAgentRequest(view, env); err == nil {
			t.Fatalf("vetAgentRequest(action=%q, len=%d) expected rejection", req.GetAction(), len(req.GetInputJson()))
		}
	}
}

// 旧桌面端不认识 permission_rules 载荷臂，会静默丢弃；网关要立即拒绝并提示更新桌面端。
func TestVetAgentRequestPermissionRulesRequiresDesktopCapability(t *testing.T) {
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_PermissionRules{PermissionRules: &gatewayv2.PermissionRulesRequest{Action: "list"}},
	}
	err := vetAgentRequest(proxyDetectAgentView(t), env)
	if err == nil || !strings.Contains(err.Error(), "update LiveAgent") {
		t.Fatalf("vetAgentRequest() error = %v, want capability rejection", err)
	}
}

func permissionRulesAgentView(t *testing.T) session.AgentView {
	t.Helper()
	manager := session.NewManager()
	agent := session.NewAgentSession(session.AuthSnapshot{AgentID: "agent-1", SessionID: "session-1"})
	agent.SetCapabilities([]string{gatewayv2.PermissionRulesV1Capability})
	manager.SetSession(agent)
	t.Cleanup(func() { manager.ClearSession(agent) })
	return manager.AgentView("agent-1")
}
