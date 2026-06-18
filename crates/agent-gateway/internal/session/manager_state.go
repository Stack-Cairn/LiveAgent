package session

import (
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

type sessionRegistry struct {
	mu           sync.RWMutex
	session      *AgentSession
	sessionEpoch uint64
	lastAuth     AuthSnapshot
	authValid    bool

	runtimeState          string
	runtimeWorkerID       string
	runtimeLastHeartbeat  time.Time
	runtimeVisible        bool
	runtimeActiveRunCount uint32
}

func newSessionRegistry() *sessionRegistry {
	return &sessionRegistry{}
}

type syncHub struct {
	historyMu          sync.Mutex
	nextHistorySubID   int
	historySubscribers map[int]chan *gatewayv1.HistorySyncEvent

	settingsMu          sync.Mutex
	nextSettingsSubID   int
	settingsSubscribers map[int]chan *gatewayv1.SettingsSyncEvent
	settingsSnapshotMu  sync.RWMutex
	settingsSnapshot    map[string]any

	terminalMu          sync.Mutex
	nextTerminalSubID   int
	terminalSubscribers map[int]chan *gatewayv1.TerminalEvent
	terminalSessions    map[string]*gatewayv1.TerminalSession

	sftpMu          sync.Mutex
	nextSftpSubID   int
	sftpSubscribers map[int]chan *gatewayv1.SftpEvent
}

func newSyncHub() *syncHub {
	return &syncHub{
		historySubscribers:  make(map[int]chan *gatewayv1.HistorySyncEvent),
		settingsSubscribers: make(map[int]chan *gatewayv1.SettingsSyncEvent),
		terminalSubscribers: make(map[int]chan *gatewayv1.TerminalEvent),
		terminalSessions:    make(map[string]*gatewayv1.TerminalSession),
		sftpSubscribers:     make(map[int]chan *gatewayv1.SftpEvent),
	}
}

type chatRunStore struct {
	chatCommandMu          sync.Mutex
	chatMu                 sync.Mutex
	eventStore             ChatEventStore
	nextChatRunSubID       int
	nextChatRunEpoch       int64
	chatRuns               map[string]*chatRun
	chatRunByConversation  map[string]string
	chatRunByClientRequest map[string]string
	historyActiveRuns      map[string]activeHistoryRun
}

func newChatRunStore() *chatRunStore {
	return &chatRunStore{
		chatRuns:               make(map[string]*chatRun),
		chatRunByConversation:  make(map[string]string),
		chatRunByClientRequest: make(map[string]string),
		historyActiveRuns:      make(map[string]activeHistoryRun),
	}
}
