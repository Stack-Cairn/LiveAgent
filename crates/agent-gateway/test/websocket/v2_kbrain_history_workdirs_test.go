package websocket_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestV2KBrainHistoryWorkdirsAggregatesPaginatedSessions(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/sessions" {
			http.NotFound(w, r)
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if r.URL.Query().Get("page_size") != "200" || r.URL.Query().Get("cwd") != "" || r.URL.Query().Get("cwd_empty") != "" {
			t.Errorf("unexpected list query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		switch page {
		case 1:
			_, _ = fmt.Fprint(w, `{"sessions":[{"id":"one","cwd":"/workspace/a","updated_at":"2026-09-30T10:00:00Z"}],"total_count":401}`)
		case 2:
			_, _ = fmt.Fprint(w, `{"sessions":[{"id":"two","cwd":"/workspace/b","updated_at":"2026-09-30T10:02:00Z"}],"total_count":401}`)
		case 3:
			_, _ = fmt.Fprint(w, `{"sessions":[],"total_count":401}`)
		default:
			t.Errorf("unexpected page %d", page)
		}
	}))
	defer backend.Close()

	cfg := newV2TestConfig()
	cfg.KBrainURL = backend.URL
	cfg.KBrainAgentID = "kbrain-history-workdirs"
	server := pbws.NewServer(cfg, session.NewManager(), nil)
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", server.BrowserHandler())
	browser, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browser, cfg.Token)

	sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
		RequestId: "workdirs-1",
		AgentId:   cfg.KBrainAgentID,
		Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{
			Payload: &gatewayv2.GatewayEnvelope_HistoryWorkdirs{HistoryWorkdirs: &gatewayv2.HistoryWorkdirsRequest{}},
		}},
	})
	frame := receiveWebFrameWithID(t, browser, "workdirs-1")
	if frame.GetLocalError() != nil {
		t.Fatalf("history.workdirs local error=%s", frame.GetLocalError().GetMessage())
	}
	response := frame.GetAgentResponse().GetHistoryWorkdirsResp()
	if response == nil || len(response.GetWorkdirs()) != 2 {
		t.Fatalf("history.workdirs=%#v", frame)
	}
	if response.GetWorkdirs()[0].GetPath() != "/workspace/b" || response.GetWorkdirs()[0].GetConversationCount() != 1 {
		t.Fatalf("first workdir=%#v", response.GetWorkdirs()[0])
	}
	if response.GetWorkdirs()[1].GetPath() != "/workspace/a" || response.GetWorkdirs()[1].GetConversationCount() != 1 {
		t.Fatalf("second workdir=%#v", response.GetWorkdirs()[1])
	}
	if _, err := json.Marshal(response); err != nil {
		t.Fatal(err)
	}
}
