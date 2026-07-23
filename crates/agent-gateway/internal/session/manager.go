package session

import (
	"errors"
	"sync"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

var ErrAgentIDRequired = errors.New("agent_id is required")
var ErrAgentOffline = errors.New("agent offline")
var ErrTunnelNotFound = errors.New("tunnel not found")
var ErrTunnelExpired = errors.New("tunnel expired")
var ErrTunnelOverLimit = errors.New("tunnel connection limit exceeded")

const (
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
	registry         *sessionRegistry
	syncHub          *syncHub
	convStreams      *conversationStreamStore
	tunnels          *tunnelRuntime
	workspaceHub     *workspaceActivityHub
	managedProcesses *managedProcessHub
	statusSubs       *statusSubscriberHub
}

type AgentSession struct {
	AgentID      string
	AgentVersion string
	SessionID    string
	ConnectedAt  time.Time
	LastPing     time.Time

	toAgent chan *OutboundEnvelope
	pingCh  chan *gatewayv2.GatewayEnvelope
	done    chan struct{}

	closeOnce sync.Once
	closed    bool

	streamsMu sync.Mutex
	streams   map[string]*agentStream
}

type agentStream struct {
	ch        chan *gatewayv2.AgentEnvelope
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
	m := &Manager{
		registry:         newSessionRegistry(),
		syncHub:          newSyncHub(),
		tunnels:          newTunnelRuntime(),
		workspaceHub:     newWorkspaceActivityHub(),
		managedProcesses: newManagedProcessHub(),
		statusSubs:       newStatusSubscriberHub(),
	}
	m.convStreams = newConversationStreamStore(m.IsOnline)
	go m.tunnelExpirySweepLoop()
	return m
}
