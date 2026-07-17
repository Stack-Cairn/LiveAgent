package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
)

type websocketRequest struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type websocketEnvelope struct {
	ID        string `json:"id,omitempty"`
	Type      string `json:"type"`
	Payload   any    `json:"payload,omitempty"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`

	// priority is transport-local metadata and is never serialized. It lets
	// latency-sensitive acknowledgements bypass a congested data queue without
	// promoting every potentially large response.
	priority bool
}

type websocketAuthPayload struct {
	Token string `json:"token"`
}

type websocketTerminalRequestPayload struct {
	SessionID      string `json:"session_id"`
	ProjectPathKey string `json:"project_path_key"`
	Cwd            string `json:"cwd"`
	Shell          string `json:"shell"`
	Title          string `json:"title"`
	Data           string `json:"data"`
	Cols           *int   `json:"cols"`
	Rows           *int   `json:"rows"`
	MaxBytes       *int   `json:"max_bytes"`
	SshHostID      string `json:"ssh_host_id"`
	PromptID       string `json:"prompt_id"`
	PromptAnswer   string `json:"prompt_answer"`
	TrustHostKey   bool   `json:"trust_host_key"`
	SftpEnabled    bool   `json:"sftp_enabled"`
	TabID          string `json:"tab_id"`
	TabKind        string `json:"tab_kind"`
}

type websocketSshKnownHostResetPayload struct {
	Host string `json:"host"`
	Port *int   `json:"port"`
}

type websocketSftpRequestPayload struct {
	SessionID           string `json:"session_id"`
	SessionIDCamel      string `json:"sessionId"`
	ProjectPathKey      string `json:"project_path_key"`
	ProjectPathKeyCamel string `json:"projectPathKey"`
	Workdir             string `json:"workdir"`
	Side                string `json:"side"`
	LocalPath           string `json:"local_path"`
	LocalPathCamel      string `json:"localPath"`
	RemotePath          string `json:"remote_path"`
	RemotePathCamel     string `json:"remotePath"`
	FromPath            string `json:"from_path"`
	FromPathCamel       string `json:"fromPath"`
	SourcePathCamel     string `json:"sourcePath"`
	ToPath              string `json:"to_path"`
	ToPathCamel         string `json:"toPath"`
	Direction           string `json:"direction"`
	TargetPath          string `json:"target_path"`
	TargetPathCamel     string `json:"targetPath"`
	TransferID          string `json:"transfer_id"`
	TransferIDCamel     string `json:"transferId"`
	Recursive           bool   `json:"recursive"`
	Overwrite           bool   `json:"overwrite"`
}

type websocketGitRequestPayload struct {
	Workdir string          `json:"workdir"`
	Args    json.RawMessage `json:"args,omitempty"`
}

const (
	websocketWriteQueueDefault   = 512
	websocketControlQueueSize    = 64
	websocketMaxWriteRetries     = 2
	websocketRetryBackoff        = 100 * time.Millisecond
	websocketHeartbeatGraceFloor = 5 * time.Second
)

type websocketConnection struct {
	cfg *config.Config
	sm  *session.Manager

	conn         *websocket.Conn
	req          *http.Request
	writeMu      sync.Mutex
	writeTimeout time.Duration
	outbox       chan websocketEnvelope
	// ctrlOutbox carries keep-alive and recovery envelopes past a congested
	// data queue so a slow reader can be shed per-stream instead of losing
	// the whole connection.
	ctrlOutbox    chan websocketEnvelope
	droppedFrames atomic.Int64

	closeOnce  sync.Once
	done       chan struct{}
	authorized bool

	lastInboundAt time.Time
	lastInboundMu sync.Mutex

	historyEvents             <-chan *gatewayv1.HistorySyncEvent
	historyEventsCleanup      func()
	settingsEvents            <-chan *gatewayv1.SettingsSyncEvent
	settingsEventsCleanup     func()
	terminalEvents            <-chan *gatewayv1.TerminalEvent
	terminalEventsCleanup     func()
	sftpEvents                <-chan *gatewayv1.SftpEvent
	sftpEventsCleanup         func()
	chatQueueEvents           <-chan *gatewayv1.ChatQueueEvent
	chatQueueEventsCleanup    func()
	chatActivityEvents        <-chan session.ConversationActivityEvent
	chatActivityEventsCleanup func()
	tunnelStateEvents         <-chan *gatewayv1.TunnelStateSnapshot
	tunnelStateEventsCleanup  func()
	statusEvents              <-chan session.Status
	statusEventsCleanup       func()

	managedProcessEvents        <-chan *gatewayv1.ManagedProcessSnapshot
	managedProcessEventsCleanup func()

	heartbeatOnce sync.Once

	terminalInterest *websocketTerminalInterestTracker

	chatStreamsMu sync.Mutex
	chatStreams   map[string]*chatStreamSubscription

	workspaceSubsMu sync.Mutex
	workspaceSubs   map[string]*workspaceActivitySubscription
}

const maxHistoryListLimit = 200
const defaultHistoryListPage = 1
const defaultHistoryListPageSize = 80

func NewWebSocketServer(cfg *config.Config, sm *session.Manager) http.Handler {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return originAllowed(r)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		conn.SetReadLimit(webSocketReadLimit(cfg))

		queueSize := websocketWriteQueueDefault
		if cfg.WebSocketWriteQueueSize > 0 {
			queueSize = cfg.WebSocketWriteQueueSize
		}
		state := &websocketConnection{
			cfg:              cfg,
			sm:               sm,
			conn:             conn,
			req:              r,
			writeTimeout:     cfg.WebSocketWriteTimeout,
			outbox:           make(chan websocketEnvelope, queueSize),
			ctrlOutbox:       make(chan websocketEnvelope, websocketControlQueueSize),
			done:             make(chan struct{}),
			terminalInterest: newWebsocketTerminalInterestTracker(),
		}
		// Protocol-level pongs are produced by the browser's network stack
		// even while the page's JS is throttled or frozen in a hidden tab, so
		// they are the liveness signal that must count as inbound activity.
		conn.SetPongHandler(func(string) error {
			state.touchInboundActivity()
			return nil
		})
		_ = conn.SetReadDeadline(time.Now().Add(state.idleTimeout()))
		defer state.close()
		state.serve()
	})
}

func webSocketReadLimit(cfg *config.Config) int64 {
	if cfg != nil && cfg.GRPCMaxMessageBytes > 0 {
		return int64(cfg.GRPCMaxMessageBytes)
	}
	return int64(config.DefaultGRPCMaxMessageBytes)
}

func (c *websocketConnection) serve() {
	for {
		var req websocketRequest
		if err := c.conn.ReadJSON(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			return
		}

		// Any inbound frame proves the client is alive — heartbeat pongs are
		// not the only liveness evidence.
		c.touchInboundActivity()

		req.ID = strings.TrimSpace(req.ID)
		req.Type = strings.TrimSpace(req.Type)
		if req.Type == "pong" {
			continue
		}
		// Pre-auth, nothing drains the write queues (writeLoop starts in
		// handleAuth), so error envelopes would only pile up while the
		// malformed frames keep refreshing the read deadline. The only valid
		// first request is auth; anything else ends the connection.
		if req.ID == "" {
			_ = c.writeError("", "request id is required")
			if !c.authorized {
				return
			}
			continue
		}
		if req.Type == "" {
			_ = c.writeError(req.ID, "request type is required")
			if !c.authorized {
				return
			}
			continue
		}

		if req.Type == "auth" {
			c.handleAuth(req)
			continue
		}

		if !c.authorized {
			_ = c.writeError(req.ID, "unauthorized")
			return
		}

		// Subscription lifecycle must keep the client's frame order: a
		// re-subscribe emits [unsubscribe, subscribe] back to back, and
		// concurrent dispatch could let the stale unsubscribe cancel the fresh
		// subscription. These handlers are lock-only and non-blocking, so they
		// run inline on the read loop.
		if req.Type == "chat.subscribe" || req.Type == "chat.unsubscribe" ||
			req.Type == "workspace.subscribe" || req.Type == "workspace.unsubscribe" {
			c.dispatch(req)
			continue
		}

		go c.dispatch(req)
	}
}

func (c *websocketConnection) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.historyEventsCleanup != nil {
			c.historyEventsCleanup()
			c.historyEventsCleanup = nil
		}
		if c.settingsEventsCleanup != nil {
			c.settingsEventsCleanup()
			c.settingsEventsCleanup = nil
		}
		if c.terminalEventsCleanup != nil {
			c.terminalEventsCleanup()
			c.terminalEventsCleanup = nil
		}
		if c.sftpEventsCleanup != nil {
			c.sftpEventsCleanup()
			c.sftpEventsCleanup = nil
		}
		if c.chatQueueEventsCleanup != nil {
			c.chatQueueEventsCleanup()
			c.chatQueueEventsCleanup = nil
		}
		if c.chatActivityEventsCleanup != nil {
			c.chatActivityEventsCleanup()
			c.chatActivityEventsCleanup = nil
		}
		if c.tunnelStateEventsCleanup != nil {
			c.tunnelStateEventsCleanup()
			c.tunnelStateEventsCleanup = nil
		}
		if c.statusEventsCleanup != nil {
			c.statusEventsCleanup()
			c.statusEventsCleanup = nil
		}
		if c.managedProcessEventsCleanup != nil {
			c.managedProcessEventsCleanup()
			c.managedProcessEventsCleanup = nil
		}
		c.cleanupChatStreamSubscriptions()
		c.cleanupWorkspaceSubscriptions()
		if c.conn != nil {
			_ = c.conn.Close()
		}
	})
}

func (c *websocketConnection) handleAuth(req websocketRequest) {
	var payload websocketAuthPayload
	if err := decodeWebSocketPayload(req.Payload, &payload); err != nil {
		_ = c.writeError(req.ID, "invalid auth payload")
		c.close()
		return
	}

	if !auth.ValidateToken(payload.Token, c.cfg.Token) {
		_ = c.writeError(req.ID, "unauthorized")
		c.close()
		return
	}

	c.authorized = true
	// The pre-auth deadline was deliberately left un-refreshed; re-arm it now
	// so a slow-to-auth client does not die moments after succeeding.
	c.touchInboundActivity()
	go c.writeLoop()
	c.startHistorySyncForwarder()
	c.startSettingsSyncForwarder()
	c.startTerminalEventForwarder()
	c.startSftpEventForwarder()
	c.startChatQueueEventForwarder()
	c.startChatActivityForwarder()
	c.startTunnelStateForwarder()
	c.startManagedProcessStateForwarder()
	c.startStatusEventForwarder()
	c.startWebSocketHeartbeat()
	if err := c.writeResponse(req.ID, map[string]any{"ok": true}); err != nil {
		c.close()
		return
	}
	c.replayTerminalSessionSnapshot()
	c.replayTunnelStateSnapshot()
	c.replayManagedProcessSnapshot()
	c.replayStatusSnapshot()
}

func (c *websocketConnection) startHistorySyncForwarder() {
	if c.historyEvents != nil || c.historyEventsCleanup != nil {
		return
	}

	historyEvents, cleanup := c.sm.SubscribeHistorySync()
	c.historyEvents = historyEvents
	c.historyEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-historyEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("history.event", websocketHistorySyncPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatActivityForwarder() {
	if c.chatActivityEvents != nil || c.chatActivityEventsCleanup != nil {
		return
	}

	activityEvents, cleanup := c.sm.SubscribeChatActivity()
	c.chatActivityEvents = activityEvents
	c.chatActivityEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-activityEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("chat.activity", websocketChatActivityPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// startStatusEventForwarder pushes agent online/offline transitions so the
// client does not depend on a (background-throttled) status poll to notice
// them. Frames are sheddable: the fallback poll reconciles missed ones.
func (c *websocketConnection) startStatusEventForwarder() {
	if c.statusEvents != nil || c.statusEventsCleanup != nil {
		return
	}

	statusEvents, cleanup := c.sm.SubscribeStatus()
	c.statusEvents = statusEvents
	c.statusEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case status, ok := <-statusEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("status.event", status); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// replayStatusSnapshot paints the freshly authenticated socket with the
// current agent status so no poll round-trip is needed after (re)connect.
func (c *websocketConnection) replayStatusSnapshot() {
	_ = c.writeEvent("status.event", c.sm.Status())
}

func (c *websocketConnection) startSettingsSyncForwarder() {
	if c.settingsEvents != nil || c.settingsEventsCleanup != nil {
		return
	}

	settingsEvents, cleanup := c.sm.SubscribeSettingsSync()
	c.settingsEvents = settingsEvents
	c.settingsEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-settingsEvents:
				if !ok {
					return
				}
				payload, err := websocketSettingsJSONPayload(event.GetSettingsJson())
				if err != nil {
					return
				}
				if err := c.writeEvent("settings.event", payload); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startTerminalEventForwarder() {
	if c.terminalEvents != nil || c.terminalEventsCleanup != nil {
		return
	}

	terminalEvents, cleanup := c.sm.SubscribeTerminalEvents()
	c.terminalEvents = terminalEvents
	c.terminalEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-terminalEvents:
				if !ok {
					return
				}
				if !c.shouldForwardTerminalEvent(event) {
					continue
				}
				if err := c.writeEvent("terminal.event", websocketTerminalEventPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startSftpEventForwarder() {
	if c.sftpEvents != nil || c.sftpEventsCleanup != nil {
		return
	}

	sftpEvents, cleanup := c.sm.SubscribeSftpEvents()
	c.sftpEvents = sftpEvents
	c.sftpEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-sftpEvents:
				if !ok {
					return
				}
				if !c.sm.WebSshTerminalEnabled() {
					continue
				}
				if err := c.writeEvent("sftp.event", websocketSftpEventPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) startChatQueueEventForwarder() {
	if c.chatQueueEvents != nil || c.chatQueueEventsCleanup != nil {
		return
	}

	chatQueueEvents, cleanup := c.sm.SubscribeChatQueueEvents()
	c.chatQueueEvents = chatQueueEvents
	c.chatQueueEventsCleanup = cleanup

	go func() {
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-chatQueueEvents:
				if !ok {
					return
				}
				if err := c.writeEvent("chat_queue.event", websocketChatQueueEventPayload(event)); err != nil {
					if errors.Is(err, errWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

func (c *websocketConnection) replayTerminalSessionSnapshot() {
	if !c.terminalFeaturesEnabled() {
		return
	}
	for _, terminalSession := range c.sm.TerminalSessionSnapshot("") {
		if !c.terminalSessionAllowed(terminalSession) {
			continue
		}
		if err := c.writeEvent("terminal.event", websocketTerminalEventPayload(&gatewayv1.TerminalEvent{
			Kind:           "created",
			SessionId:      terminalSession.GetId(),
			ProjectPathKey: terminalSession.GetProjectPathKey(),
			Session:        terminalSession,
		})); err != nil {
			return
		}
	}
}

func (c *websocketConnection) rememberTerminalProject(projectPathKey string) {
	c.terminalInterest.rememberProject(projectPathKey)
}

func (c *websocketConnection) rememberTerminalSession(sessionID string, projectPathKey string) {
	c.terminalInterest.rememberSession(sessionID, projectPathKey)
}

func (c *websocketConnection) forgetTerminalInterest(sessionID string, projectPathKey string) {
	c.terminalInterest.forget(sessionID, projectPathKey)
}

func (c *websocketConnection) shouldForwardTerminalEvent(event *gatewayv1.TerminalEvent) bool {
	return c.terminalEventAllowed(event) && c.terminalInterest.shouldForward(event)
}

func (c *websocketConnection) startWebSocketHeartbeat() {
	c.heartbeatOnce.Do(func() {
		period := c.cfg.WebSocketHeartbeatPeriod
		if period <= 0 {
			period = 15 * time.Second
		}
		go func() {
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			for {
				select {
				case <-c.done:
					return
				case <-ticker.C:
					c.lastInboundMu.Lock()
					lastInbound := c.lastInboundAt
					c.lastInboundMu.Unlock()
					if time.Since(lastInbound) > c.idleTimeout() {
						c.close()
						return
					}
					// Protocol ping first: browsers answer it from the network
					// process with no JS involvement, so a throttled or frozen
					// tab keeps proving liveness. WriteControl is documented
					// safe concurrently with the write loop.
					deadline := time.Now().Add(c.controlWriteTimeout())
					_ = c.conn.WriteControl(websocket.PingMessage, nil, deadline)
					// The JSON ping stays for the page's benefit: it is the
					// only inbound activity the client's JS can observe, and
					// its stall heuristics depend on it. Best-effort — the
					// idle check above is the sole eviction authority.
					_ = c.writeEnvelope(websocketEnvelope{
						Type: "ping",
						Payload: map[string]any{
							"timestamp": time.Now().Unix(),
						},
					})
				}
			}
		}()
	})
}

// touchInboundActivity records liveness for every inbound frame and pushes the
// read deadline forward accordingly. Pre-auth the initial deadline stands
// un-refreshed: whatever a client sends, it gets one idleTimeout window to
// authenticate. (authorized is only written on the read loop, and both this
// function's callers — the read loop and gorilla's pong handler — run there.)
func (c *websocketConnection) touchInboundActivity() {
	c.lastInboundMu.Lock()
	c.lastInboundAt = time.Now()
	c.lastInboundMu.Unlock()
	if !c.authorized {
		return
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(c.idleTimeout()))
}

func (c *websocketConnection) idleTimeout() time.Duration {
	period := c.cfg.WebSocketHeartbeatPeriod
	if period <= 0 {
		period = 15 * time.Second
	}
	grace := c.cfg.WebSocketHeartbeatGrace
	if grace <= 0 {
		grace = websocketHeartbeatGraceFloor
	}
	return period*3 + grace
}

func (c *websocketConnection) controlWriteTimeout() time.Duration {
	if c.writeTimeout > 0 {
		return c.writeTimeout
	}
	return 10 * time.Second
}

func (c *websocketConnection) dispatch(req websocketRequest) {
	handler := websocketRequestHandlers[req.Type]
	if handler == nil {
		_ = c.writeError(req.ID, "unsupported request type")
		return
	}
	handler(c, req)
}

func (c *websocketConnection) awaitAgentResponse(
	requestID string,
	envelope *gatewayv1.GatewayEnvelope,
) (*gatewayv1.AgentEnvelope, error) {
	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return awaitAgentUnaryResponse(ctx, c.sm, requestID, envelope)
}

func (c *websocketConnection) sendToAgent(envelope *gatewayv1.GatewayEnvelope) error {
	timeout := c.cfg.WebSocketWriteTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()

	return c.sm.SendToAgentContext(ctx, envelope)
}

func (c *websocketConnection) writeResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:      requestID,
		Type:    "response",
		Payload: payload,
	})
}

func (c *websocketConnection) writePriorityResponse(requestID string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:       requestID,
		Type:     "response",
		Payload:  payload,
		priority: true,
	})
}

func (c *websocketConnection) writeError(requestID string, message string) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:    requestID,
		Type:  "error",
		Error: message,
	})
}

func (c *websocketConnection) writeErrorCode(requestID string, message string, code string) error {
	return c.writeEnvelope(websocketEnvelope{
		ID:        requestID,
		Type:      "error",
		Error:     message,
		ErrorCode: code,
	})
}

func (c *websocketConnection) writeEvent(eventType string, payload any) error {
	return c.writeEnvelope(websocketEnvelope{
		Type:    eventType,
		Payload: payload,
	})
}

var errWriteQueueFull = errors.New("write queue full")

// isControlEnvelopeType reports envelopes that must reach the client even
// when the data queue is congested: keep-alive pings and the signals a client
// needs to recover a shed stream.
func isControlEnvelopeType(envelopeType string) bool {
	switch envelopeType {
	case "ping", "error", "chat.subscription_reset", "chat.command_update":
		return true
	default:
		return false
	}
}

// writeEnvelope queues an envelope for delivery. Control envelopes ride a
// small priority queue; shed-able event/stream data reports errWriteQueueFull
// without dropping the whole link. Correlated unary responses are different:
// silently losing one leaves the browser pending until its much later timeout,
// so a persistently full data queue closes the socket and lets the client
// reconnect/retry instead. Direct-write failures likewise terminate it.
func (c *websocketConnection) writeEnvelope(envelope websocketEnvelope) error {
	if envelope.priority || isControlEnvelopeType(envelope.Type) {
		return c.enqueueControlEnvelope(envelope)
	}
	err := c.enqueueEnvelope(envelope)
	if errors.Is(err, errWriteQueueFull) {
		c.noteDroppedEnvelope(envelope.Type)
		if envelope.Type == "response" && envelope.ID != "" {
			c.close()
		}
	}
	return err
}

// enqueueEnvelope waits up to writeTimeout for a slot when the outbox is
// momentarily full (token bursts to a slow reader); only a persistent backlog
// reports errWriteQueueFull. The fast path allocates nothing.
func (c *websocketConnection) enqueueEnvelope(envelope websocketEnvelope) error {
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.outbox <- envelope:
		return nil
	default:
	}

	timer := time.NewTimer(c.controlWriteTimeout())
	defer timer.Stop()
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.outbox <- envelope:
		return nil
	case <-timer.C:
		return errWriteQueueFull
	}
}

func (c *websocketConnection) enqueueControlEnvelope(envelope websocketEnvelope) error {
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.ctrlOutbox <- envelope:
		return nil
	default:
	}

	if envelope.Type == "ping" {
		// Keep-alive pings are periodic; when the control queue is full the
		// next tick supersedes this one.
		c.noteDroppedEnvelope(envelope.Type)
		return nil
	}

	timer := time.NewTimer(c.controlWriteTimeout())
	defer timer.Stop()
	select {
	case <-c.done:
		return errors.New("connection closed")
	case c.ctrlOutbox <- envelope:
		return nil
	case <-timer.C:
		c.noteDroppedEnvelope(envelope.Type)
		return errWriteQueueFull
	}
}

func (c *websocketConnection) noteDroppedEnvelope(envelopeType string) {
	dropped := c.droppedFrames.Add(1)
	// Log the first drop and every 100th after it: enough to see shedding in
	// production without a log line per frame during a burst.
	if dropped == 1 || dropped%100 == 0 {
		remote := ""
		if c.req != nil {
			remote = c.req.RemoteAddr
		}
		log.Printf(
			"websocket: shed %q frame for slow client (dropped=%d remote=%s)",
			envelopeType,
			dropped,
			remote,
		)
	}
}

// writeLoop drains the control queue ahead of the data queue (mirroring the
// agent link's dedicated ping channel) so congestion cannot starve keep-alive
// or stream-recovery envelopes.
func (c *websocketConnection) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case envelope := <-c.ctrlOutbox:
			if !c.deliverEnvelope(envelope) {
				return
			}
		case envelope := <-c.outbox:
			if !c.deliverEnvelope(envelope) {
				return
			}
			for drained := 0; drained < 64; drained++ {
				select {
				case extra := <-c.ctrlOutbox:
					if !c.deliverEnvelope(extra) {
						return
					}
					continue
				default:
				}
				select {
				case extra := <-c.outbox:
					if !c.deliverEnvelope(extra) {
						return
					}
				default:
					goto batchDone
				}
			}
		batchDone:
		}
	}
}

// deliverEnvelope writes one envelope with bounded retries; exhausting them
// means the socket itself is unwritable (dead link), which is the only
// congestion-adjacent condition allowed to close the connection.
func (c *websocketConnection) deliverEnvelope(envelope websocketEnvelope) bool {
	if err := c.writeEnvelopeDirect(envelope); err == nil {
		return true
	}
	for attempt := 0; attempt < websocketMaxWriteRetries; attempt++ {
		select {
		case <-c.done:
			return false
		case <-time.After(websocketRetryBackoff):
		}
		if err := c.writeEnvelopeDirect(envelope); err == nil {
			return true
		}
	}
	c.close()
	return false
}

func (c *websocketConnection) writeEnvelopeDirect(envelope websocketEnvelope) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeTimeout > 0 {
		if err := c.conn.SetWriteDeadline(time.Now().Add(c.writeTimeout)); err != nil {
			return err
		}
		defer func() {
			_ = c.conn.SetWriteDeadline(time.Time{})
		}()
	}
	return c.conn.WriteJSON(envelope)
}
