package kbrain

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const protocolVersion = "kbrain.agent.v1"

// Client is the small HTTP/SSE boundary used by Gateway remote targets. The
// provider wire format remains behind K-brain; Gateway only sees canonical
// sessions, runs, and events.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client

	handshakeMu  sync.Mutex
	handshake    Health
	handshakeErr error
	// handshakeGen increments on every observed contract violation; a probe
	// started before the newest violation may not repopulate the cache.
	handshakeGen   uint64
	handshakeURL   string
	handshakeToken string
	handshakeAt    time.Time
}

type ModelRef struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

type Session struct {
	ID                string    `json:"id"`
	Title             string    `json:"title"`
	CWD               string    `json:"cwd"`
	Model             ModelRef  `json:"model"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
	MessageCount      int32     `json:"message_count"`
	Pinned            bool      `json:"pinned"`
	Shared            bool      `json:"shared"`
	Messages          []Message `json:"messages,omitempty"`
	TotalMessageCount int32     `json:"total_message_count,omitempty"`
}

type SessionPage struct {
	Sessions   []Session `json:"sessions"`
	TotalCount int32     `json:"total_count"`
}

type HistorySearchMatch struct {
	Source         string   `json:"source"`
	ConversationID string   `json:"conversationId"`
	Title          string   `json:"title"`
	CWD            string   `json:"cwd,omitempty"`
	SegmentIndex   int32    `json:"segmentIndex"`
	SegmentID      string   `json:"segmentId"`
	MessageIndex   *int32   `json:"messageIndex,omitempty"`
	MessageID      string   `json:"messageId,omitempty"`
	Role           string   `json:"role,omitempty"`
	Snippet        string   `json:"snippet"`
	Score          float64  `json:"score"`
	RawScore       *float64 `json:"rawScore,omitempty"`
	UpdatedAt      int64    `json:"updatedAt"`
}

type HistorySearchResponse struct {
	Matches   []HistorySearchMatch `json:"matches"`
	Truncated bool                 `json:"truncated,omitempty"`
}

func (p *SessionPage) UnmarshalJSON(data []byte) error {
	var list []Session
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal(data, &list); err != nil {
			return err
		}
		p.Sessions, p.TotalCount = list, int32(len(list))
		return nil
	}
	type sessionPage SessionPage
	var decoded sessionPage
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*p = SessionPage(decoded)
	if p.TotalCount == 0 {
		p.TotalCount = int32(len(p.Sessions))
	}
	return nil
}

type HistoryResponse struct {
	Session           Session `json:"session"`
	Revision          string  `json:"revision"`
	OldestOffset      int32   `json:"oldest_offset"`
	MessageOffsets    []int32 `json:"message_offsets"`
	TotalMessageCount int32   `json:"total_message_count"`
	HasMoreBefore     bool    `json:"has_more_before"`
}

type Message struct {
	ID           string            `json:"id,omitempty"`
	Role         string            `json:"role"`
	Content      []ContentBlock    `json:"content,omitempty"`
	ToolCalls    []ToolCall        `json:"tool_calls,omitempty"`
	ToolCallID   string            `json:"tool_call_id,omitempty"`
	Name         string            `json:"name,omitempty"`
	Provider     string            `json:"provider,omitempty"`
	Model        string            `json:"model,omitempty"`
	Usage        *Usage            `json:"usage,omitempty"`
	HostedSearch []json.RawMessage `json:"hosted_search,omitempty"`
	StopReason   string            `json:"stop_reason,omitempty"`
	CreatedAt    time.Time         `json:"created_at,omitempty"`
}

type ContentBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
	FileURL  string `json:"file_url,omitempty"`
	Filename string `json:"filename,omitempty"`
	MIMEType string `json:"mime_type,omitempty"`
}

type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type Usage struct {
	InputTokens      int32 `json:"input_tokens,omitempty"`
	OutputTokens     int32 `json:"output_tokens,omitempty"`
	CachedTokens     int32 `json:"cached_tokens,omitempty"`
	CacheWriteTokens int32 `json:"cache_write_tokens,omitempty"`
}

type RunOptions struct {
	Reasoning       string          `json:"reasoning,omitempty"`
	Mode            string          `json:"mode,omitempty"`
	Search          string          `json:"search,omitempty"`
	ApprovalPolicy  string          `json:"approval_policy,omitempty"`
	PermissionMode  string          `json:"permission_mode,omitempty"`
	WorkspaceRoots  []WorkspaceRoot `json:"workspace_roots,omitempty"`
	Tools           *ToolSelection  `json:"tools,omitempty"`
	PlanModeEnabled bool            `json:"plan_mode_enabled,omitempty"`
	MCPServerIDs    []string        `json:"mcp_server_ids,omitempty"`
}

type WorkspaceRoot struct {
	Path   string `json:"path"`
	Access string `json:"access"`
}

type ToolSelection struct {
	Policies map[string]string `json:"policies,omitempty"`
	Enabled  []string          `json:"enabled,omitempty"`
	Disabled []string          `json:"disabled,omitempty"`
}

type PromptRequest struct {
	ConversationID  string `json:"conversation_id"`
	ClientRequestID string `json:"client_request_id"`
	Prompt          string `json:"prompt,omitempty"`
	// PromptCommand 表示 Prompt 是 "/name args" 提示词指令，由 K-brain 展开，历史保留原文。
	PromptCommand bool        `json:"prompt_command,omitempty"`
	Model         *ModelRef   `json:"model,omitempty"`
	Options       *RunOptions `json:"options,omitempty"`
}

type RunAccepted struct {
	Version        string `json:"version"`
	ConversationID string `json:"conversation_id"`
	RunID          string `json:"run_id"`
	AcceptedSeq    int64  `json:"accepted_seq"`
}

type Event struct {
	Version        string          `json:"version"`
	Seq            int64           `json:"seq"`
	ConversationID string          `json:"conversation_id"`
	RunID          string          `json:"run_id"`
	ParentRunID    string          `json:"parent_run_id,omitempty"`
	Type           string          `json:"type"`
	CreatedAt      time.Time       `json:"created_at"`
	Payload        json.RawMessage `json:"payload,omitempty"`
}

func New(baseURL, token string, httpClient *http.Client) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, errors.New("kbrain base URL is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &Client{BaseURL: baseURL, Token: strings.TrimSpace(token), HTTP: httpClient}, nil
}

func (c *Client) request(ctx context.Context, method, path string, input any, output any) (*http.Response, error) {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		body = strings.NewReader(string(data))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if output != nil {
		defer func() { _ = resp.Body.Close() }()
		if err := json.NewDecoder(resp.Body).Decode(output); err != nil {
			return resp, err
		}
	}
	return resp, nil
}

func (c *Client) ListSessions(ctx context.Context, page, pageSize int, cwd string, cwdEmpty, shared bool) (SessionPage, error) {
	query := url.Values{}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 50
	}
	query.Set("page", strconv.Itoa(page))
	query.Set("page_size", strconv.Itoa(pageSize))
	if cwd != "" {
		query.Set("cwd", cwd)
	}
	if cwdEmpty {
		query.Set("cwd_empty", "true")
	}
	if shared {
		query.Set("shared", "true")
	}
	var out SessionPage
	resp, err := c.request(ctx, http.MethodGet, "/v1/sessions?"+query.Encode(), nil, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain list sessions: %s", resp.Status)
	}
	if out.TotalCount == 0 {
		out.TotalCount = int32(len(out.Sessions))
	}
	return out, nil
}

func (c *Client) SearchHistory(ctx context.Context, query string, limit int) (HistorySearchResponse, error) {
	var out HistorySearchResponse
	resp, err := c.request(ctx, http.MethodPost, "/v1/history/search", map[string]any{"query": strings.TrimSpace(query), "limit": limit}, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain history search: %s", resp.Status)
	}
	return out, nil
}

func (c *Client) UpdateSession(ctx context.Context, sessionID string, input map[string]any) (Session, error) {
	var out Session
	resp, err := c.request(ctx, http.MethodPatch, "/v1/sessions/"+url.PathEscape(sessionID), input, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain update session: %s", resp.Status)
	}
	return out, nil
}

func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	resp, err := c.request(ctx, http.MethodDelete, "/v1/sessions/"+url.PathEscape(sessionID), nil, nil)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("kbrain delete session: %s", resp.Status)
	}
	return nil
}

func (c *Client) GetSession(ctx context.Context, sessionID string) (Session, error) {
	var out Session
	resp, err := c.request(ctx, http.MethodGet, "/v1/sessions/"+url.PathEscape(sessionID), nil, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain get session: %s", resp.Status)
	}
	return out, nil
}

func (c *Client) GetHistory(ctx context.Context, sessionID string, maxMessages int, beforeOffset *int32) (HistoryResponse, error) {
	return c.getHistoryPage(ctx, sessionID, maxMessages, beforeOffset, "")
}

func (c *Client) getHistoryPage(ctx context.Context, sessionID string, maxMessages int, beforeOffset *int32, revision string) (HistoryResponse, error) {
	query := url.Values{}
	if maxMessages < 1 {
		maxMessages = 360
	}
	query.Set("max_messages", strconv.Itoa(maxMessages))
	query.Set("include_active", "false")
	if revision != "" {
		query.Set("expected_revision", revision)
	}
	if beforeOffset != nil {
		query.Set("before_offset", strconv.Itoa(int(*beforeOffset)))
	}
	var out HistoryResponse
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/history?" + query.Encode()
	resp, err := c.request(ctx, http.MethodGet, path, nil, &out)
	if err != nil {
		return out, err
	}
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("kbrain get history: %s", resp.Status)
	}
	return out, nil
}

func (c *Client) CreateSession(ctx context.Context, cwd string, model ModelRef) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	resp, err := c.request(ctx, http.MethodPost, "/v1/sessions", map[string]any{"cwd": cwd, "model": model}, &out)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("kbrain create session: %s", resp.Status)
	}
	if strings.TrimSpace(out.ID) == "" {
		return "", errors.New("kbrain create session returned no id")
	}
	return out.ID, nil
}

func (c *Client) StartRun(ctx context.Context, sessionID string, in PromptRequest) (RunAccepted, int, error) {
	var out RunAccepted
	// Every run needs a valid handshake: a backend that contradicts
	// kbrain.agent.v1 must not accept work in any permission mode.
	mode := ""
	if in.Options != nil {
		mode = in.Options.PermissionMode
	}
	if err := c.requireHandshake(ctx, mode); err != nil {
		return out, 0, err
	}
	resp, err := c.request(ctx, http.MethodPost, "/v1/sessions/"+sessionID+"/runs", in, &out)
	if err != nil {
		return out, 0, err
	}
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return out, resp.StatusCode, fmt.Errorf("kbrain start run: %s", resp.Status)
	}
	if out.Version != "" && out.Version != protocolVersion {
		return out, resp.StatusCode, fmt.Errorf("unsupported kbrain protocol %q", out.Version)
	}
	if strings.TrimSpace(out.ConversationID) != "" && out.ConversationID != sessionID {
		return out, resp.StatusCode, fmt.Errorf("kbrain run accepted for unexpected session %q", out.ConversationID)
	}
	if strings.TrimSpace(out.RunID) == "" {
		return out, resp.StatusCode, errors.New("kbrain run accepted without run_id")
	}
	if out.AcceptedSeq < 1 {
		return out, resp.StatusCode, errors.New("kbrain run accepted without accepted_seq")
	}
	return out, resp.StatusCode, nil
}

func (c *Client) GetSettings(ctx context.Context) (json.RawMessage, error) {
	return c.settingsRequest(ctx, http.MethodGet, "/v1/settings", nil)
}

func (c *Client) UpdateSettings(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	return c.settingsRequest(ctx, http.MethodPut, "/v1/settings", args)
}

// Discovery applies a draft without persisting it; credential reuse is owned
// by K-brain, which rejects reuse against a changed endpoint.
func (c *Client) DiscoverProviderModels(ctx context.Context, providerID string, input any) (json.RawMessage, error) {
	providerID = strings.TrimSpace(providerID)
	if providerID == "" {
		providerID = "draft"
	}
	return c.settingsRequest(ctx, http.MethodPost, "/v1/settings/providers/"+url.PathEscape(providerID)+"/models", input)
}

func (c *Client) settingsRequest(ctx context.Context, method, path string, input any) (json.RawMessage, error) {
	resp, err := c.request(ctx, method, path, input, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("kbrain settings request: %s", resp.Status)
	}
	var out json.RawMessage
	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(&out); err != nil {
		return nil, fmt.Errorf("decode kbrain settings response: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("kbrain settings response must contain one JSON value")
	}
	return out, nil
}

func (c *Client) HistorySearch(ctx context.Context, args json.RawMessage) (json.RawMessage, error) {
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	var out json.RawMessage
	resp, err := c.request(ctx, http.MethodPost, "/v1/history/search", args, &out)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("kbrain history search: %s", resp.Status)
	}
	if len(out) == 0 {
		return json.RawMessage(`{}`), nil
	}
	return out, nil
}

func (c *Client) MemoryManage(ctx context.Context, command string, args json.RawMessage) (json.RawMessage, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, errors.New("memory command is required")
	}
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage(`{}`)
	}
	input := struct {
		Command string          `json:"command"`
		Args    json.RawMessage `json:"args"`
	}{Command: command, Args: args}
	var out json.RawMessage
	resp, err := c.request(ctx, http.MethodPost, "/v1/memory/manage", input, &out)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("kbrain memory manage: %s", resp.Status)
	}
	if len(out) == 0 {
		return json.RawMessage(`null`), nil
	}
	return out, nil
}

func (c *Client) CancelRun(ctx context.Context, sessionID, runID string) error {
	resp, err := c.request(ctx, http.MethodPost, "/v1/sessions/"+sessionID+"/runs/"+runID+"/cancel", map[string]any{}, nil)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("kbrain cancel run: %s", resp.Status)
	}
	return nil
}

// CronManage exposes the shipped backend cron API through one Gateway action
// boundary. The K-brain backend remains the owner of task and run state.
// cronOpsAdvanceWork reports whether a cron_apply payload can add or re-enable
// scheduled work. Only delete, reorder and `{"enabled": false}` updates are
// work-reducing; anything else, including payloads it cannot read, fails closed.
func cronOpsAdvanceWork(input any) bool {
	body, ok := input.(map[string]any)
	if !ok {
		return true
	}
	ops, ok := body["ops"].([]any)
	if !ok {
		return true
	}
	for _, raw := range ops {
		op, ok := raw.(map[string]any)
		if !ok {
			return true
		}
		switch op["op"] {
		case "delete", "reorder":
			continue
		case "update":
			patch, ok := op["patch"].(map[string]any)
			if ok && len(patch) == 1 && patch["enabled"] == false {
				continue
			}
		}
		return true
	}
	return false
}

func (c *Client) CronManage(ctx context.Context, action, taskID, taskJSON string) (json.RawMessage, error) {
	action = strings.TrimSpace(action)
	taskID = strings.TrimSpace(taskID)
	var input any
	if strings.TrimSpace(taskJSON) != "" {
		if err := json.Unmarshal([]byte(taskJSON), &input); err != nil {
			return nil, fmt.Errorf("invalid cron payload: %w", err)
		}
	}
	// Starting or scheduling agent work needs a valid handshake; reads, cancels,
	// clears and changes that only remove or disable tasks stay available on a
	// broken backend so users can still stop scheduled work.
	if action == "run_now" || action == "cron_apply" && cronOpsAdvanceWork(input) {
		if err := c.requireHandshake(ctx, ""); err != nil {
			return nil, err
		}
	}
	var method, path string
	var body any
	switch action {
	case "snapshot":
		cron, err := c.cronRequest(ctx, http.MethodGet, "/v1/cron", nil)
		if err != nil {
			return nil, err
		}
		hooks, err := c.cronRequest(ctx, http.MethodGet, "/v1/hooks", nil)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]json.RawMessage{"cron": cron, "hooks": hooks})
	case "occurrences":
		return c.cronRequest(ctx, http.MethodPost, "/v1/planning", map[string]any{"action": "cron.occurrences", "input": input})
	case "cron_apply":
		method, path, body = http.MethodPut, "/v1/cron", input
	case "hooks_apply":
		method, path, body = http.MethodPut, "/v1/hooks", input
	case "list_runs":
		if taskID == "" {
			return nil, errors.New("cron list_runs requires task_id")
		}
		limit := 100
		if obj, ok := input.(map[string]any); ok {
			if value, ok := obj["limit"].(float64); ok && value > 0 {
				limit = int(value)
			}
		}
		path = "/v1/cron/" + url.PathEscape(taskID) + "/runs?limit=" + strconv.Itoa(limit)
		method = http.MethodGet
	case "clear_runs":
		if taskID == "" {
			return nil, errors.New("cron clear_runs requires task_id")
		}
		method, path = http.MethodDelete, "/v1/cron/"+url.PathEscape(taskID)+"/runs"
	case "run_now":
		if taskID == "" {
			return nil, errors.New("cron run_now requires task_id")
		}
		method, path = http.MethodPost, "/v1/cron/"+url.PathEscape(taskID)+"/run-now"
	case "cancel_run":
		if taskID == "" {
			return nil, errors.New("cron cancel_run requires task_id")
		}
		method, path = http.MethodPost, "/v1/cron/"+url.PathEscape(taskID)+"/cancel"
		if obj, ok := input.(map[string]any); ok {
			if executionID, ok := obj["executionId"].(string); ok && strings.TrimSpace(executionID) != "" {
				path = "/v1/cron/" + url.PathEscape(taskID) + "/runs/" + url.PathEscape(executionID) + "/cancel"
			}
		}
	case "validate":
		method, path, body = http.MethodPost, "/v1/cron/validate", input
	default:
		return nil, fmt.Errorf("unsupported cron action %q", action)
	}
	return c.cronRequest(ctx, method, path, body)
}

func (c *Client) cronRequest(ctx context.Context, method, path string, input any) (json.RawMessage, error) {
	var raw json.RawMessage
	resp, err := c.request(ctx, method, path, input, &raw)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		message := strings.TrimSpace(string(raw))
		if message == "" {
			message = resp.Status
		}
		return nil, fmt.Errorf("kbrain cron request: %s", message)
	}
	return raw, nil
}

// Events consumes the canonical SSE journal from afterSeq. The callback runs
// in order and the response remains open until a terminal event is observed or
// the caller cancels the context.
func (c *Client) Events(ctx context.Context, sessionID string, afterSeq int64, onEvent func(Event) error) error {
	return c.events(ctx, sessionID, afterSeq, "", onEvent)
}

// EventsForRun keeps a session SSE subscription open across terminal events
// belonging to other runs in the same session. K-brain sessions may publish
// subagent/background lifecycle events on the shared journal.
func (c *Client) EventsForRun(ctx context.Context, sessionID string, afterSeq int64, runID string, onEvent func(Event) error) error {
	return c.events(ctx, sessionID, afterSeq, strings.TrimSpace(runID), onEvent)
}

func (c *Client) events(ctx context.Context, sessionID string, afterSeq int64, targetRunID string, onEvent func(Event) error) error {
	path := "/v1/sessions/" + url.PathEscape(sessionID) + "/events?after_seq=" + url.QueryEscape(strconv.FormatInt(afterSeq, 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("kbrain events: %s", resp.Status)
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 8<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var event Event
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event); err != nil {
			return err
		}
		if event.Version != "" && event.Version != protocolVersion {
			return fmt.Errorf("unsupported kbrain event protocol %q", event.Version)
		}
		if err := onEvent(event); err != nil {
			return err
		}
		if (targetRunID == "" || event.RunID == targetRunID) && (event.Type == "run.completed" || event.Type == "run.failed" || event.Type == "run.cancelled") {
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.EOF
}
