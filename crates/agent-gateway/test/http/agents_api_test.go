package httproutes

// Agent 目录与凭证管理 API 测试：签发→轮换/删除→踢线的闭环，及管理 token 门禁。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

func newAgentsAPIServer(t *testing.T) (http.Handler, *session.Manager, *agenttoken.Store) {
	t.Helper()
	database, err := db.Open(filepath.Join(t.TempDir(), "agent-tokens.db"))
	if err != nil {
		t.Fatalf("open gateway db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store, err := agenttoken.NewStore(database)
	if err != nil {
		t.Fatalf("init agent token store: %v", err)
	}
	sm := session.NewManager()
	handler := server.NewHTTPServer(&config.Config{
		Token:          "admin-token",
		RequestTimeout: time.Second,
	}, sm, store)
	return handler, sm, store
}

func agentTokenAuthenticates(
	t *testing.T,
	store *agenttoken.Store,
	agentID string,
	token string,
) bool {
	t.Helper()
	_, err := store.AuthenticateAndRegister(agentID, token, false)
	if err == nil {
		return true
	}
	if errors.Is(err, agenttoken.ErrUnauthorized) {
		return false
	}
	t.Fatalf("authenticate agent token: %v", err)
	return false
}

func doAgentsRequest(t *testing.T, handler http.Handler, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://gateway.test"+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func doAgentsJSONRequest(
	t *testing.T,
	handler http.Handler,
	method, path, token, body string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "http://gateway.test"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestAgentsAPIIssueRevokeKicksSession(t *testing.T) {
	t.Parallel()

	handler, sm, store := newAgentsAPIServer(t)
	agentID := testAgentID(1)

	// 签发：明文只出现在响应里。
	rec := doAgentsRequest(t, handler, http.MethodPost, "/api/agents/"+agentID+"/token", "admin-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("issue status = %d body=%s", rec.Code, rec.Body.String())
	}
	var issued struct {
		AgentID string `json:"agent_id"`
		Token   string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &issued); err != nil {
		t.Fatalf("decode issue response: %v", err)
	}
	if issued.AgentID != agentID || !strings.HasPrefix(issued.Token, "agt_") {
		t.Fatalf("issued = %#v", issued)
	}
	if !agentTokenAuthenticates(t, store, agentID, issued.Token) {
		t.Fatal("issued token must validate")
	}

	// 模拟该 Agent 在线。
	sm.RecordAuthentication(agentID, "1.0.0", "session-a")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot(agentID))
	sm.SetSession(sess)
	if !sm.IsOnline(agentID) {
		t.Fatal("agent should be online")
	}

	// 目录能看到在线 + 已签发，并带分页元信息。
	rec = doAgentsRequest(t, handler, http.MethodGet, "/api/agents", "admin-token")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"agent_id":"`+agentID+`"`) {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var listResp struct {
		Agents   []map[string]any `json:"agents"`
		Total    int              `json:"total"`
		Page     int              `json:"page"`
		PageSize int              `json:"page_size"`
		HasMore  bool             `json:"has_more"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if listResp.Total != 1 || listResp.Page != 1 || len(listResp.Agents) != 1 || listResp.HasMore {
		t.Fatalf("list pagination = %#v", listResp)
	}
	if online, _ := listResp.Agents[0]["online"].(bool); !online {
		t.Fatalf("agent should show online in directory: %#v", listResp.Agents[0])
	}

	// 删除：整条记录消失、凭证失效且活跃会话被踢。
	rec = doAgentsRequest(t, handler, http.MethodDelete, "/api/agents/"+agentID, "admin-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke status = %d body=%s", rec.Code, rec.Body.String())
	}
	if agentTokenAuthenticates(t, store, agentID, issued.Token) {
		t.Fatal("deleted token must be invalid")
	}
	select {
	case <-sess.Done():
	case <-time.After(time.Second):
		t.Fatal("delete must disconnect the live session")
	}
	if sm.IsOnline(agentID) {
		t.Fatal("agent must be absent after delete")
	}
}

func TestAgentsAPIRotationKicksLiveSession(t *testing.T) {
	t.Parallel()

	handler, sm, store := newAgentsAPIServer(t)
	agentID := testAgentID(2)

	first := doAgentsRequest(t, handler, http.MethodPost, "/api/agents/"+agentID+"/token", "admin-token")
	if first.Code != http.StatusOK {
		t.Fatalf("initial issue status = %d body=%s", first.Code, first.Body.String())
	}
	var firstIssued struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &firstIssued); err != nil {
		t.Fatalf("decode initial issue response: %v", err)
	}

	sm.RecordAuthentication(agentID, "1.0.0", "session-rotation")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot(agentID))
	sm.SetSession(sess)
	if !sm.IsOnline(agentID) {
		t.Fatal("agent should be online before rotation")
	}

	rotated := doAgentsRequest(t, handler, http.MethodPost, "/api/agents/"+agentID+"/token", "admin-token")
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotation status = %d body=%s", rotated.Code, rotated.Body.String())
	}
	var rotatedResponse struct {
		Token        string `json:"token"`
		Disconnected bool   `json:"disconnected"`
	}
	if err := json.Unmarshal(rotated.Body.Bytes(), &rotatedResponse); err != nil {
		t.Fatalf("decode rotation response: %v", err)
	}
	if !rotatedResponse.Disconnected {
		t.Fatal("rotation must report and perform live-session disconnect")
	}
	if agentTokenAuthenticates(t, store, agentID, firstIssued.Token) {
		t.Fatal("rotated-out token must be invalid")
	}
	if !agentTokenAuthenticates(t, store, agentID, rotatedResponse.Token) {
		t.Fatal("rotated-in token must be valid")
	}
	select {
	case <-sess.Done():
	case <-time.After(time.Second):
		t.Fatal("rotation must disconnect the live session")
	}
	if sm.IsOnline(agentID) {
		t.Fatal("agent must be offline after rotation")
	}
}

func TestAgentsAPIRequiresManagementToken(t *testing.T) {
	t.Parallel()

	handler, _, store := newAgentsAPIServer(t)
	agentToken, err := store.Issue("agent-a", "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}

	// 无 token 与 Agent 凭证都不能访问管理 API（Agent 凭证不授权管理面）。
	if rec := doAgentsRequest(t, handler, http.MethodGet, "/api/agents", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-token list status = %d", rec.Code)
	}
	if rec := doAgentsRequest(t, handler, http.MethodPost, "/api/agents/agent-b/token", agentToken); rec.Code != http.StatusUnauthorized {
		t.Fatalf("agent-token issue status = %d", rec.Code)
	}
}

func TestAgentsAPIValidatesIDAndUpdatesOptionalName(t *testing.T) {
	t.Parallel()

	handler, _, _ := newAgentsAPIServer(t)
	invalid := doAgentsJSONRequest(t, handler, http.MethodPost, "/api/agents/hhhh/token", "admin-token", `{}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d body=%s", invalid.Code, invalid.Body.String())
	}

	agentID := testAgentID(20)
	issued := doAgentsJSONRequest(t, handler, http.MethodPost, "/api/agents/"+agentID+"/token", "admin-token", `{"name":" Office desktop "}`)
	if issued.Code != http.StatusOK {
		t.Fatalf("issue named agent status = %d body=%s", issued.Code, issued.Body.String())
	}

	updated := doAgentsJSONRequest(t, handler, http.MethodPatch, "/api/agents/"+agentID, "admin-token", `{"name":""}`)
	if updated.Code != http.StatusOK {
		t.Fatalf("clear name status = %d body=%s", updated.Code, updated.Body.String())
	}

	tooLongName, _ := json.Marshal(map[string]string{"name": strings.Repeat("名", 65)})
	tooLong := doAgentsJSONRequest(t, handler, http.MethodPatch, "/api/agents/"+agentID, "admin-token", string(tooLongName))
	if tooLong.Code != http.StatusBadRequest {
		t.Fatalf("long name status = %d body=%s", tooLong.Code, tooLong.Body.String())
	}

	listed := doAgentsRequest(t, handler, http.MethodGet, "/api/agents", "admin-token")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"name":""`) {
		t.Fatalf("cleared name list status = %d body=%s", listed.Code, listed.Body.String())
	}
}

func TestAgentsAPIListsRegisteredAgentWithoutIndependentToken(t *testing.T) {
	t.Parallel()

	handler, sm, store := newAgentsAPIServer(t)
	if err := store.Register("shared-token-agent"); err != nil {
		t.Fatalf("register: %v", err)
	}
	sm.RecordAuthentication("shared-token-agent", "1.0.0", "session-shared")
	sess := session.NewAgentSession(sm.LatestAuthSnapshot("shared-token-agent"))
	sm.SetSession(sess)
	t.Cleanup(func() { sm.ClearSession(sess) })

	rec := doAgentsRequest(t, handler, http.MethodGet,
		"/api/agents?status=online&page=1&page_size=50", "admin-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Agents []struct {
			AgentID      string `json:"agent_id"`
			Online       bool   `json:"online"`
			HasToken     bool   `json:"has_token"`
			RegisteredAt string `json:"registered_at"`
		} `json:"agents"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 1 || len(resp.Agents) != 1 || resp.Agents[0].AgentID != "shared-token-agent" ||
		!resp.Agents[0].Online || resp.Agents[0].HasToken || resp.Agents[0].RegisteredAt == "" {
		t.Fatalf("registered agent response = %#v", resp)
	}
}

func TestAgentsAPIPaginatesDirectory(t *testing.T) {
	t.Parallel()

	handler, _, _ := newAgentsAPIServer(t)
	// 签发凭证会同时登记 120 个 Agent。
	for i := 0; i < 120; i++ {
		rec := doAgentsRequest(t, handler, http.MethodPost,
			"/api/agents/"+testAgentID(i)+"/token", "admin-token")
		if rec.Code != http.StatusOK {
			t.Fatalf("issue %d: %d", i, rec.Code)
		}
	}

	rec := doAgentsRequest(t, handler, http.MethodGet, "/api/agents?page=2&page_size=50", "admin-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("list page 2: %d", rec.Code)
	}
	var resp struct {
		Agents   []map[string]any `json:"agents"`
		Total    int              `json:"total"`
		Page     int              `json:"page"`
		PageSize int              `json:"page_size"`
		HasMore  bool             `json:"has_more"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 120 || resp.Page != 2 || resp.PageSize != 50 ||
		len(resp.Agents) != 50 || !resp.HasMore {
		t.Fatalf("page 2 = %#v", resp)
	}

	// 末页余 20 条、无更多。
	rec = doAgentsRequest(t, handler, http.MethodGet, "/api/agents?page=3&page_size=50", "admin-token")
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Agents) != 20 || resp.HasMore {
		t.Fatalf("page 3 = len %d hasMore %v", len(resp.Agents), resp.HasMore)
	}
}

func TestAgentsAPIFiltersBeforeDatabasePaging(t *testing.T) {
	t.Parallel()

	handler, sm, store := newAgentsAPIServer(t)
	for i := 0; i < 6; i++ {
		agentID := "agent-" + leftPad(i)
		if _, err := store.Issue(agentID, ""); err != nil {
			t.Fatalf("issue %s: %v", agentID, err)
		}
		if i%2 == 0 {
			sm.RecordAuthentication(agentID, "1.0.0", "session-"+leftPad(i))
			sess := session.NewAgentSession(sm.LatestAuthSnapshot(agentID))
			sm.SetSession(sess)
			t.Cleanup(func() { sm.ClearSession(sess) })
		}
	}

	testCases := []struct {
		name      string
		status    string
		wantFirst string
	}{
		{name: "online", status: "online", wantFirst: "agent-004"},
		{name: "offline", status: "offline", wantFirst: "agent-005"},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doAgentsRequest(t, handler, http.MethodGet,
				"/api/agents?status="+tc.status+"&page=2&page_size=2", "admin-token")
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
			}
			var resp struct {
				Agents  []map[string]any `json:"agents"`
				Total   int              `json:"total"`
				HasMore bool             `json:"has_more"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if resp.Total != 3 || len(resp.Agents) != 1 || resp.HasMore || resp.Agents[0]["agent_id"] != tc.wantFirst {
				t.Fatalf("filtered page = %#v", resp)
			}
		})
	}

	invalid := doAgentsRequest(t, handler, http.MethodGet, "/api/agents?status=busy", "admin-token")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid filter status = %d body=%s", invalid.Code, invalid.Body.String())
	}
}

func leftPad(i int) string {
	s := strconv.Itoa(i)
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

func testAgentID(i int) string {
	return fmt.Sprintf("agent-00000000-0000-4000-8000-%012d", i)
}
