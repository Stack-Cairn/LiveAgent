package websocket_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Settings → 权限 on a direct K-brain target: the WebUI's permission_rules request is
// answered by the Gateway's relay without a desktop, and a malformed one never
// reaches K-brain.
func TestV2KBrainPermissionRulesWithoutDesktop(t *testing.T) {
	var (
		lock sync.Mutex
		seen []string
	)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if strings.HasPrefix(r.URL.Path, "/v1/permissions/") {
			lock.Lock()
			seen = append(seen, r.Method+" "+r.URL.RequestURI()+" "+string(body))
			lock.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/permissions/rules":
			_, _ = w.Write([]byte(`{"rules":[{"id":"r_1","rule":"Bash(ls:*)","effect":"allow","scope":"user"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/permissions/rules":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"permission rule \"Bash(\": missing closing parenthesis"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	cfg := newV2TestConfig()
	cfg.KBrainURL, cfg.KBrainAgentID = backend.URL, "rules-kbrain"
	srv := pbws.NewServer(cfg, session.NewManager(), nil)
	defer srv.Close()
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())
	browser, cleanup := dialV2Path(t, mux, "/ws/v2")
	defer cleanup()
	helloV2(t, browser, cfg.Token)
	send := func(id, action, input string) *gatewayv2.WebServerFrame {
		env := &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_PermissionRules{
			PermissionRules: &gatewayv2.PermissionRulesRequest{Action: action, InputJson: input},
		}}
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{RequestId: id, AgentId: cfg.KBrainAgentID,
			Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: env}})
		return receiveWebFrameWithID(t, browser, id)
	}

	listed := send("list", "list", `{}`)
	if !strings.Contains(listed.GetAgentResponse().GetPermissionRulesResp().GetResultJson(), `"r_1"`) {
		t.Fatalf("list: %v", listed)
	}
	refused := send("refused", "add", `{"rule":"Bash(","effect":"deny","scope":"user"}`)
	if message := refused.GetLocalError().GetMessage(); !strings.Contains(message, "missing closing parenthesis") {
		t.Fatalf("refused add: %v", refused)
	}
	invalid := send("invalid", "rename", `{}`)
	if invalid.GetLocalError() == nil {
		t.Fatalf("invalid action: %v", invalid)
	}
	lock.Lock()
	defer lock.Unlock()
	if len(seen) != 2 {
		t.Fatalf("K-brain saw %d requests, want list and add only: %v", len(seen), seen)
	}
}
