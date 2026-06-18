package session

import (
	"errors"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

var ErrAgentOffline = errors.New("agent offline")
var ErrChatRunNotFound = errors.New("chat run not found")
var ErrTunnelNotFound = errors.New("tunnel not found")
var ErrTunnelExpired = errors.New("tunnel expired")
var ErrTunnelOverLimit = errors.New("tunnel connection limit exceeded")
var ErrTunnelLimitExceeded = errors.New("tunnel limit exceeded")

const (
	maxBufferedChatRunEvents = 50000
	chatRunDoneRetention     = time.Hour
	chatRunStartRetention    = 5 * time.Minute
	chatRunStaleRetention    = 12 * time.Hour

	agentDisconnectedChatRunMessage = "Desktop agent disconnected. Please retry."

	chatRuntimeReadyTTL      = 15 * time.Second
	agentSessionHeartbeatTTL = 90 * time.Second
	defaultRuntimeReadyState = "ready"
)

type AuthSnapshot struct {
	AgentID      string
	AgentVersion string
	SessionID    string
}

type Manager struct {
	registry  *sessionRegistry
	syncHub   *syncHub
	chatStore *chatRunStore
	tunnels   *tunnelStore
}

type AgentSession struct {
	AgentID      string
	AgentVersion string
	SessionID    string
	ConnectedAt  time.Time
	LastPing     time.Time

	toAgent chan *OutboundEnvelope
	done    chan struct{}

	closeOnce sync.Once
	closed    bool

	streamsMu sync.Mutex
	streams   map[string]*agentStream
}

type agentStream struct {
	ch        chan *gatewayv1.AgentEnvelope
	done      chan struct{}
	closeOnce sync.Once
}

type ChatBroadcastEvent struct {
	RequestID string
	Event     *gatewayv1.ChatEvent
	Control   *gatewayv1.ChatControlEvent
	Payload   map[string]any
	Seq       int64
	Workdir   string
}

type ChatRunSnapshot struct {
	RequestID       string
	ConversationID  string
	ClientRequestID string
	Workdir         string
	FirstSeq        int64
	LatestSeq       int64
	RunEpoch        int64
	State           string
	ErrorCode       string
	Done            bool
}

type ActiveChatRunSummary struct {
	ConversationID string
	RequestID      string
	Workdir        string
	FirstSeq       int64
	LatestSeq      int64
	RunEpoch       int64
	UpdatedAt      int64
}

const (
	ChatRunStateQueued    = "queued"
	ChatRunStateDelivered = "delivered"
	ChatRunStateClaimed   = "claimed"
	ChatRunStateStarting  = "starting"
	ChatRunStateRunning   = "running"
	ChatRunStateCompleted = "completed"
	ChatRunStateFailed    = "failed"
	ChatRunStateCancelled = "cancelled"
)

type chatRun struct {
	requestID        string
	conversationID   string
	clientRequestID  string
	workdir          string
	sessionEpoch     uint64
	runEpoch         int64
	events           []*ChatBroadcastEvent
	nextSeq          int64
	state            string
	errorCode        string
	accepted         bool
	started          bool
	firstDeltaLogged bool
	done             bool
	updatedAt        time.Time
	expiresAt        time.Time
	subscribers      map[int]*chatRunSubscriber
}

type activeHistoryRun struct {
	conversationID string
	workdir        string
	updatedAt      time.Time
}

type chatRunSubscriber struct {
	ch        chan *ChatBroadcastEvent
	done      chan struct{}
	closeOnce sync.Once
}

type Status struct {
	Online                bool   `json:"online"`
	AgentReady            bool   `json:"agent_ready"`
	ChatRuntimeReady      bool   `json:"chat_runtime_ready"`
	AgentID               string `json:"agent_id"`
	AgentVersion          string `json:"agent_version"`
	SessionID             string `json:"session_id,omitempty"`
	ConnectedSince        int64  `json:"connected_since"`
	LastHeartbeat         int64  `json:"last_heartbeat"`
	RuntimeState          string `json:"runtime_state,omitempty"`
	RuntimeLastHeartbeat  int64  `json:"runtime_last_heartbeat,omitempty"`
	RuntimeWorkerID       string `json:"runtime_worker_id,omitempty"`
	RuntimeVisible        bool   `json:"runtime_visible,omitempty"`
	RuntimeActiveRunCount uint32 `json:"runtime_active_run_count,omitempty"`
}

func NewManager() *Manager {
	return &Manager{
		registry:  newSessionRegistry(),
		syncHub:   newSyncHub(),
		chatStore: newChatRunStore(),
		tunnels:   newTunnelStore(),
	}
}

func NewManagerWithChatEventStore(store ChatEventStore) (*Manager, error) {
	manager := NewManager()
	manager.chatStore.eventStore = store
	if store != nil {
		if err := store.FailOpenRuns("Gateway restarted before the remote chat run finished. Please retry."); err != nil {
			return nil, err
		}
	}
	return manager, nil
}
