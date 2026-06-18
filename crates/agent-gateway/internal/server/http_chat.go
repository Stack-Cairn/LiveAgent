package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

const maxChatCommandBytes = 2 * 1024 * 1024
const maxChatCommandsPerMinute = 120
const maxChatEventStreamsPerMinute = 240

func chatCommandsHTTP(cfg *config.Config, sm *session.Manager, limiter *chatRateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !allowStateChangingRequest(w, r) {
			return
		}
		if limiter != nil && !limiter.allow(chatRateLimitKey(r, "chat.commands"), maxChatCommandsPerMinute, time.Minute, time.Now()) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "chat command rate limit exceeded"})
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChatCommandBytes))
		if err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "chat command payload is too large"})
			return
		}
		commandType, body, baseMessageRef, err := decodeChatCommandPayload(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid chat command payload"})
			return
		}

		switch commandType {
		case "chat.submit":
			baseMessageRef = nil
		case "chat.edit_resend":
			if baseMessageRef == nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": "base_message_ref is required"})
				return
			}
			if err := validateChatMessageRef(baseMessageRef); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
		case "chat.cancel":
			handleChatCancelCommandHTTP(w, r, cfg, sm, raw)
			return
		default:
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported chat command"})
			return
		}

		if err := normalizeChatRequestBody(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		traceID := newChatTraceID()
		logChatCommandSpan(traceID, "command_received", "", body.ConversationID, body.ClientRequestID, commandType)
		if !sm.IsOnline() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "agent offline"})
			return
		}

		requestID := "chat-command-" + uuid.NewString()
		initialPayloads := buildAcceptedChatCommandPayloads(body, baseMessageRef)
		start, err := startAcceptedChatCommand(sm, requestID, body, initialPayloads)
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": websocketErrorMessage(err)})
			return
		}
		if start.Created {
			logChatCommandSpan(traceID, "initial_persist_done", start.RunID, start.ConversationID, body.ClientRequestID, commandType)
			go dispatchAcceptedChatCommand(context.Background(), cfg, sm, start, body, baseMessageRef, traceID)
		} else {
			logChatCommandSpan(traceID, "command_deduped", start.RunID, start.ConversationID, body.ClientRequestID, commandType)
		}

		writeJSON(w, http.StatusAccepted, map[string]any{
			"run_id":            start.RunID,
			"conversation_id":   start.ConversationID,
			"client_request_id": body.ClientRequestID,
			"accepted_seq":      start.AcceptedSeq,
			"state":             start.State,
			"deduped":           !start.Created,
		})
	}
}

func handleChatCancelCommandHTTP(
	w http.ResponseWriter,
	r *http.Request,
	cfg *config.Config,
	sm *session.Manager,
	raw []byte,
) {
	type cancelPayload struct {
		Type    string `json:"type"`
		Payload *struct {
			RunID          string `json:"run_id"`
			ConversationID string `json:"conversation_id"`
		} `json:"payload"`
	}
	var payload cancelPayload
	if err := decodeStrictJSON(raw, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid chat.cancel payload"})
		return
	}
	if strings.TrimSpace(payload.Type) != "chat.cancel" || payload.Payload == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid chat.cancel payload"})
		return
	}
	conversationID := strings.TrimSpace(payload.Payload.ConversationID)
	runID := strings.TrimSpace(payload.Payload.RunID)
	if conversationID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "conversation_id is required"})
		return
	}
	if !sm.IsOnline() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "agent offline"})
		return
	}
	if runID == "" {
		if snapshot, ok := sm.ChatRunSnapshot("", conversationID); ok {
			runID = strings.TrimSpace(snapshot.RequestID)
			if conversationID == "" {
				conversationID = strings.TrimSpace(snapshot.ConversationID)
			}
		}
	}
	requestID := runID
	if requestID == "" {
		requestID = "chat-cancel-" + uuid.NewString()
	}
	timeout := 10 * time.Second
	if cfg != nil && cfg.WebSocketWriteTimeout > 0 {
		timeout = cfg.WebSocketWriteTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	if err := sm.SendToAgentContext(ctx, &gatewayv1.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload:   buildChatCancelCommandPayload(conversationID),
	}); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": websocketErrorMessage(err)})
		return
	}
	if runID != "" {
		sm.MarkChatRunControl(runID, conversationID, "cancelled", "", "")
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"accepted": true, "run_id": runID, "conversation_id": conversationID})
}

func chatEventsHTTP(_ *config.Config, sm *session.Manager, limiter *chatRateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !originAllowed(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden origin"})
			return
		}
		if limiter != nil && !limiter.allow(chatRateLimitKey(r, "chat.events"), maxChatEventStreamsPerMinute, time.Minute, time.Now()) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "chat event stream rate limit exceeded"})
			return
		}

		requestID := strings.TrimSpace(r.URL.Query().Get("run_id"))
		conversationID := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
		afterSeq := parseAfterSeq(r.URL.Query().Get("after_seq"))
		if afterSeq <= 0 {
			afterSeq = parseAfterSeq(r.Header.Get("Last-Event-ID"))
		}
		if requestID == "" && conversationID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "run_id or conversation_id is required"})
			return
		}

		eventCh, eventDone, cleanup, snapshot, err := sm.SubscribeChatRun(requestID, conversationID, afterSeq)
		if err != nil {
			status := http.StatusNotFound
			if !errors.Is(err, session.ErrChatRunNotFound) {
				status = http.StatusBadGateway
			}
			writeJSON(w, status, map[string]any{"error": websocketErrorMessage(err)})
			return
		}
		defer cleanup()

		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}

		heartbeat := time.NewTicker(15 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-eventDone:
				return
			case <-heartbeat.C:
				if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			case event, ok := <-eventCh:
				if !ok {
					return
				}
				terminal, err := writeChatSSE(w, flusher, snapshot.RequestID, event)
				if err != nil {
					return
				}
				if terminal && strings.TrimSpace(event.RequestID) == strings.TrimSpace(snapshot.RequestID) {
					return
				}
			}
		}
	}
}

func writeChatSSE(
	w io.Writer,
	flusher http.Flusher,
	snapshotRunID string,
	event *session.ChatBroadcastEvent,
) (bool, error) {
	if event == nil {
		return false, nil
	}
	payload, terminal := chatBroadcastPayload(event)
	if payload == nil {
		return false, nil
	}
	seq := event.Seq
	runID := strings.TrimSpace(event.RequestID)
	if runID == "" {
		runID = strings.TrimSpace(snapshotRunID)
	}
	conversationID, _ := payload["conversation_id"].(string)
	envelope := map[string]any{
		"specversion":     "1.0",
		"id":              fmt.Sprintf("%s/%d", runID, seq),
		"source":          "liveagent.gateway.chat",
		"type":            cloudChatEventType(payload),
		"time":            time.Now().UTC().Format(time.RFC3339Nano),
		"run_id":          runID,
		"snapshot_run_id": strings.TrimSpace(snapshotRunID),
		"conversation_id": strings.TrimSpace(conversationID),
		"seq":             seq,
		"payload":         payload,
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return terminal, err
	}
	eventName := "chat.event"
	if isChatControlPayload(payload) {
		eventName = "chat.control"
	}
	if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", seq, eventName, data); err != nil {
		return terminal, err
	}
	if flusher != nil {
		flusher.Flush()
	}
	return terminal, nil
}

func chatBroadcastPayload(event *session.ChatBroadcastEvent) (map[string]any, bool) {
	if len(event.Payload) > 0 {
		payload := cloneChatPayload(event.Payload)
		if seq := event.Seq; seq > 0 {
			payload["seq"] = seq
		}
		if len(event.Workdir) > 0 {
			if workdir := strings.TrimSpace(event.Workdir); workdir != "" {
				payload["workdir"] = workdir
			}
		}
		return publicChatPayload(payload), isTerminalChatPayload(payload)
	}
	if event.Control != nil {
		payload := chatControlPayload(event.Control, event.Seq, event.Workdir)
		return publicChatPayload(payload), isTerminalChatControlPayload(event.Control)
	}
	if event.Event != nil {
		payload := chatEventPayload(event.Event, event.Seq, event.Workdir)
		return publicChatPayload(payload), event.Event.GetType() == gatewayv1.ChatEvent_DONE ||
			event.Event.GetType() == gatewayv1.ChatEvent_ERROR
	}
	return nil, false
}

func isTerminalChatPayload(payload map[string]any) bool {
	eventType, _ := payload["type"].(string)
	switch strings.TrimSpace(eventType) {
	case "done", "completed", "error", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func cloudChatEventType(payload map[string]any) string {
	eventType, _ := payload["type"].(string)
	switch strings.TrimSpace(eventType) {
	case "accepted":
		return "run.accepted"
	case "user_message":
		return "user.message.appended"
	case "rebased":
		return "conversation.rebased"
	case "projection_updated":
		return "projection.updated"
	case "delivered", "claimed", "starting", "progress":
		return "context.preparing"
	case "started":
		return "runtime.started"
	case "token":
		return "assistant.delta"
	case "thinking":
		return "thinking.delta"
	case "tool_call":
		return "tool.call"
	case "tool_result":
		return "tool.result"
	case "done", "completed":
		return "run.completed"
	case "error", "failed":
		return "run.failed"
	case "cancelled":
		return "run.cancelled"
	default:
		return "chat.event"
	}
}

func isChatControlPayload(payload map[string]any) bool {
	eventType, _ := payload["type"].(string)
	switch strings.TrimSpace(eventType) {
	case "accepted", "user_message", "rebased", "projection_updated", "delivered", "claimed", "starting", "started", "progress", "completed", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func cloneChatPayload(input map[string]any) map[string]any {
	if len(input) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func publicChatPayload(payload map[string]any) map[string]any {
	delete(payload, "request_id")
	return payload
}

func parseAfterSeq(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
		return parsed
	}
	return 0
}

func allowStateChangingRequest(w http.ResponseWriter, r *http.Request) bool {
	if !originAllowed(r) {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden origin"})
		return false
	}
	if strings.TrimSpace(r.Header.Get("X-LiveAgent-CSRF")) == "" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing csrf header"})
		return false
	}
	return true
}

func originAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	requestURL := requestURLForOriginCheck(r)
	if requestURL == nil {
		return false
	}
	if sameOrigin(parsed, requestURL) {
		return true
	}
	originHost := strings.TrimSpace(parsed.Hostname())
	requestHost := strings.TrimSpace(requestURL.Hostname())
	if originHost == "" || requestHost == "" {
		return false
	}
	return isLoopbackHost(originHost) && isLoopbackHost(requestHost)
}

func requestURLForOriginCheck(r *http.Request) *url.URL {
	if r == nil {
		return nil
	}
	scheme := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	scheme = strings.ToLower(strings.TrimSpace(strings.Split(scheme, ",")[0]))
	switch scheme {
	case "http", "https":
	default:
		return nil
	}
	host := strings.TrimSpace(r.Host)
	if host == "" {
		return nil
	}
	return &url.URL{Scheme: scheme, Host: host}
}

func sameOrigin(a *url.URL, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(a.Scheme), strings.TrimSpace(b.Scheme)) {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(a.Hostname()), strings.TrimSpace(b.Hostname())) {
		return false
	}
	return originPort(a) == originPort(b)
}

func originPort(u *url.URL) string {
	if u == nil {
		return ""
	}
	if port := strings.TrimSpace(u.Port()); port != "" {
		return port
	}
	switch strings.ToLower(strings.TrimSpace(u.Scheme)) {
	case "http", "ws":
		return "80"
	case "https", "wss":
		return "443"
	default:
		return ""
	}
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
