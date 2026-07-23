package websocket_test

// v2 多 Agent 寻址集成测试：定向直通、歧义错误、agent_list 目录、广播打标隔离。

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// newV2MultiAgentTest 建两个假 Agent 会话 + 已握手的浏览器连接。
func newV2MultiAgentTest(t *testing.T) (*session.Manager, *session.AgentSession, *session.AgentSession, *websocket.Conn, func()) {
	t.Helper()

	sm := session.NewManager()
	sm.RecordAuthentication("agent-a", "1.0.0", "session-a")
	agentA := session.NewAgentSession(sm.LatestAuthSnapshot("agent-a"))
	sm.SetSession(agentA)
	sm.RecordAuthentication("agent-b", "1.0.0", "session-b")
	agentB := session.NewAgentSession(sm.LatestAuthSnapshot("agent-b"))
	sm.SetSession(agentB)

	handler := pbws.NewServer(newV2TestConfig(), sm, newAgentTokenStore(t)).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	helloV2(t, conn, "ws-token")
	return sm, agentA, agentB, conn, cleanup
}

// answerAgentRequests 消费假 Agent 出站队列并按固定应答回填（history_workdirs 臂）。
func answerAgentRequests(sm *session.Manager, sess *session.AgentSession, marker string) {
	for outbound := range sess.Outbound() {
		outbound.Ack(nil)
		if outbound.GetHistoryWorkdirs() == nil {
			continue
		}
		sm.DispatchFromAgentForSession(sess, &gatewayv2.AgentEnvelope{
			RequestId: outbound.GetRequestId(),
			Payload: &gatewayv2.AgentEnvelope_HistoryWorkdirsResp{
				HistoryWorkdirsResp: &gatewayv2.HistoryWorkdirsResponse{
					Workdirs: []*gatewayv2.HistoryWorkdirSummary{{Path: marker}},
				},
			},
		})
	}
}

func TestV2AgentRequestRoutesToTargetAgent(t *testing.T) {
	t.Parallel()

	sm, agentA, agentB, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()
	go answerAgentRequests(sm, agentA, "/from-agent-a")
	go answerAgentRequests(sm, agentB, "/from-agent-b")

	// 指定 agent-b：响应必须来自 B 且帧回填 agent_id=b。
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "route-b",
		AgentId:   "agent-b",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
					HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
				},
			},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "route-b")
	resp := frame.GetAgentResponse()
	if resp == nil || len(resp.GetHistoryWorkdirsResp().GetWorkdirs()) != 1 ||
		resp.GetHistoryWorkdirsResp().GetWorkdirs()[0].GetPath() != "/from-agent-b" {
		t.Fatalf("agent-b response = %#v", frame)
	}
	if frame.GetAgentId() != "agent-b" {
		t.Fatalf("response agent_id = %q, want agent-b", frame.GetAgentId())
	}

	// 指定 agent-a：同一连接可交替定向。
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "route-a",
		AgentId:   "agent-a",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
					HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
				},
			},
		},
	})
	frame = receiveWebFrameWithID(t, conn, "route-a")
	if workdirs := frame.GetAgentResponse().GetHistoryWorkdirsResp().GetWorkdirs(); len(workdirs) != 1 || workdirs[0].GetPath() != "/from-agent-a" {
		t.Fatalf("agent-a response = %#v", frame)
	}
}

func TestV2AgentRequestRequiresExplicitAgentID(t *testing.T) {
	t.Parallel()

	_, _, _, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "ambiguous",
		Payload: &gatewayv2.WebClientFrame_AgentRequest{
			AgentRequest: &gatewayv2.GatewayEnvelope{
				Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{
					HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{},
				},
			},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "ambiguous")
	localError := frame.GetLocalError()
	if localError == nil || localError.GetMessage() != "agent_id is required" {
		t.Fatalf("agent request without agent_id = %#v, want required-id local_error", frame)
	}
}

func TestV2AgentListReturnsDirectory(t *testing.T) {
	t.Parallel()

	sm, _, agentB, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()

	// B 断线：目录仍应包含离线条目。
	sm.ClearSession(agentB)

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "list",
		Payload:   &gatewayv2.WebClientFrame_AgentList{AgentList: &gatewayv2.AgentListRequest{}},
	})
	frame := receiveWebFrameWithID(t, conn, "list")
	list := frame.GetAgentList()
	if list == nil || len(list.GetAgents()) != 2 {
		t.Fatalf("agent_list = %#v, want 2 entries", frame)
	}
	byID := map[string]*gatewayv2.StatusEvent{}
	for _, entry := range list.GetAgents() {
		byID[entry.GetAgentId()] = entry
	}
	if a := byID["agent-a"]; a == nil || !a.GetOnline() {
		t.Fatalf("agent-a entry = %#v, want online", byID["agent-a"])
	}
	if b := byID["agent-b"]; b == nil || b.GetOnline() {
		t.Fatalf("agent-b entry = %#v, want offline", byID["agent-b"])
	}
}

func TestV2AgentListIncludesRegistryNotesAndGlobalOrder(t *testing.T) {
	t.Parallel()

	store := newAgentTokenStore(t)
	if _, err := store.Issue("agent-a", "Office desktop"); err != nil {
		t.Fatalf("issue agent-a token: %v", err)
	}
	if _, err := store.Issue("agent-c", "Spare laptop"); err != nil {
		t.Fatalf("issue agent-c token: %v", err)
	}

	sm := session.NewManager()
	sm.RecordAuthentication("agent-a", "1.0.0", "session-a")
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot("agent-a")))
	sm.RecordAuthentication("agent-b", "1.0.0", "session-b")
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot("agent-b")))

	handler := pbws.NewServer(newV2TestConfig(), sm, store).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	helloV2(t, conn, "ws-token")

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "list-with-notes",
		Payload: &gatewayv2.WebClientFrame_AgentList{
			AgentList: &gatewayv2.AgentListRequest{},
		},
	})
	list := receiveWebFrameWithID(t, conn, "list-with-notes").GetAgentList()
	if list == nil || len(list.GetAgents()) != 3 {
		t.Fatalf("agent_list = %#v, want 3 entries", list)
	}
	if got := []string{
		list.GetAgents()[0].GetAgentId(),
		list.GetAgents()[1].GetAgentId(),
		list.GetAgents()[2].GetAgentId(),
	}; got[0] != "agent-a" || got[1] != "agent-b" || got[2] != "agent-c" {
		t.Fatalf("agent order = %v, want [agent-a agent-b agent-c]", got)
	}
	if got := list.GetAgents()[0].GetName(); got != "Office desktop" {
		t.Fatalf("agent-a name = %q, want Office desktop", got)
	}
	if got := list.GetAgents()[1].GetName(); got != "" {
		t.Fatalf("agent-b name = %q, want empty", got)
	}
	if got := list.GetAgents()[2].GetName(); got != "Spare laptop" {
		t.Fatalf("agent-c name = %q, want Spare laptop", got)
	}
}

func TestV2AgentListReturnsDatabaseError(t *testing.T) {
	t.Parallel()

	database, store := openAgentTokenDB(t, filepath.Join(t.TempDir(), "agent-list.db"))
	handler := pbws.NewServer(newV2TestConfig(), session.NewManager(), store).BrowserHandler()
	conn, cleanup := dialV2(t, handler)
	defer cleanup()
	helloV2(t, conn, "ws-token")
	if err := database.Close(); err != nil {
		t.Fatalf("close agent database: %v", err)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "list-db-error",
		Payload: &gatewayv2.WebClientFrame_AgentList{
			AgentList: &gatewayv2.AgentListRequest{},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "list-db-error")
	if frame.GetAgentList() != nil {
		t.Fatalf("database failure was hidden as agent_list: %#v", frame)
	}
	if got := frame.GetLocalError().GetMessage(); got != "agent directory unavailable" {
		t.Fatalf("agent directory error = %q, want agent directory unavailable", got)
	}
}

func TestV2BroadcastFramesCarrySourceAgentID(t *testing.T) {
	t.Parallel()

	sm, agentA, agentB, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()

	sm.DispatchFromAgentForSession(agentA, &gatewayv2.AgentEnvelope{
		Payload: &gatewayv2.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "conv-a"},
		},
	})
	sm.DispatchFromAgentForSession(agentB, &gatewayv2.AgentEnvelope{
		Payload: &gatewayv2.AgentEnvelope_HistorySync{
			HistorySync: &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "conv-b"},
		},
	})

	// 两条广播帧各自携带来源 agent_id（顺序不定，按 conversation 对账）。
	seen := map[string]string{}
	deadline := time.Now().Add(2 * time.Second)
	for len(seen) < 2 && time.Now().Before(deadline) {
		frame := receiveWebFrameRaw(t, conn)
		if history := frame.GetHistoryEvent(); history != nil {
			seen[history.GetConversationId()] = frame.GetAgentId()
		}
	}
	if seen["conv-a"] != "agent-a" || seen["conv-b"] != "agent-b" {
		t.Fatalf("broadcast tags = %#v, want conv-a→agent-a conv-b→agent-b", seen)
	}
}

func TestV2WorkspaceSubscribeRequiresExplicitAgentID(t *testing.T) {
	t.Parallel()

	_, _, _, conn, cleanup := newV2MultiAgentTest(t)
	defer cleanup()

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "workspace-ambiguous",
		Payload: &gatewayv2.WebClientFrame_WorkspaceSubscribe{
			WorkspaceSubscribe: &gatewayv2.WorkspaceSubscribeRequest{Workdir: "/repo"},
		},
	})
	frame := receiveWebFrameWithID(t, conn, "workspace-ambiguous")
	localError := frame.GetLocalError()
	if localError == nil || localError.GetMessage() != "agent_id is required" {
		t.Fatalf("workspace subscribe without agent_id = %#v, want required-id local_error", frame)
	}
}
