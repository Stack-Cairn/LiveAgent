package stt

import (
	"context"
	"errors"
	"regexp"
	"sync"
)

type AudioChunk struct {
	Sequence uint32
	PCM      []byte
}
type Command struct {
	Audio  *AudioChunk
	Finish bool
	Cancel bool
}
type Event struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Text      string `json:"text,omitempty"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}
type Adapter interface {
	Run(context.Context, string, map[string]any, <-chan Command, chan<- Event) error
	Test(context.Context, map[string]any) (string, error)
}
type activeSession struct {
	cancel   context.CancelFunc
	commands chan Command
}
type Manager struct {
	store    *Store
	mu       sync.Mutex
	sessions map[string]*activeSession
}

func NewManager(store *Store) *Manager {
	return &Manager{store: store, sessions: map[string]*activeSession{}}
}
func adapterFor(id string) Adapter {
	switch id {
	case "aliyun_dashscope":
		return &AliyunDashScopeAdapter{}
	case "tencent_cloud":
		return &TencentCloudAdapter{}
	case "volcengine_v2":
		return &VolcengineV2Adapter{}
	case "volcengine_seed_v3":
		return &VolcengineSeedV3Adapter{}
	case "baidu_cloud":
		return &BaiduCloudAdapter{}
	}
	return nil
}

// adapterFactory is kept indirect so protocol/session tests can inject a
// deterministic adapter without opening a real provider connection.
var adapterFactory = adapterFor

func (m *Manager) Store() *Store { return m.store }
func (m *Manager) Start(parent context.Context, sessionID, provider string, events chan<- Event) error {
	adapter := adapterFactory(provider)
	if adapter == nil {
		return errors.New("unknown STT provider")
	}
	cfg, err := m.store.Provider(parent, provider)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.sessions[sessionID]; exists {
		return errors.New("STT session already exists")
	}
	ctx, cancel := context.WithCancel(parent)
	active := &activeSession{cancel: cancel, commands: make(chan Command, 128)}
	m.sessions[sessionID] = active
	go func() {
		err := adapter.Run(ctx, sessionID, cfg, active.commands, events)
		if err != nil {
			emitEvent(ctx, events, Event{
				Type:      "error",
				SessionID: sessionID,
				Code:      resultForError(err),
				Message:   sanitizeError(err.Error(), cfg),
			})
		}
		emitEvent(ctx, events, Event{Type: "closed", SessionID: sessionID})
		m.mu.Lock()
		delete(m.sessions, sessionID)
		m.mu.Unlock()
	}()
	return nil
}
func (m *Manager) Send(sessionID string, command Command) error {
	m.mu.Lock()
	active := m.sessions[sessionID]
	m.mu.Unlock()
	if active == nil {
		return errors.New("STT session not found")
	}
	select {
	case active.commands <- command:
		return nil
	default:
		return errors.New("STT write queue full")
	}
}
func (m *Manager) Cancel(sessionID string) {
	m.mu.Lock()
	active := m.sessions[sessionID]
	m.mu.Unlock()
	if active != nil {
		active.cancel()
	}
}
func (m *Manager) Test(ctx context.Context, provider string) (string, error) {
	adapter := adapterFactory(provider)
	if adapter == nil {
		return "protocol_failed", errors.New("unknown provider")
	}
	cfg, err := m.store.Provider(ctx, provider)
	if err != nil {
		return "authentication_failed", err
	}
	result, testErr := adapter.Test(ctx, cfg)
	if testErr != nil {
		return resultForError(testErr), errors.New(sanitizeError(testErr.Error(), cfg))
	}
	return result, nil
}

var providerURLPattern = regexp.MustCompile(`(?i)\b(?:wss?|https?)://\S+`)

func sanitizeError(message string, cfg map[string]any) string {
	for _, field := range secretFields {
		if value, ok := cfg[field].(string); ok && value != "" {
			message = stringReplaceAll(message, value, "[redacted]")
		}
	}
	return providerURLPattern.ReplaceAllString(message, "[provider endpoint]")
}
func stringReplaceAll(s, old, new string) string {
	for {
		next := replaceOnce(s, old, new)
		if next == s {
			return s
		}
		s = next
	}
}
func replaceOnce(s, old, new string) string {
	if old == "" {
		return s
	}
	for i := 0; i+len(old) <= len(s); i++ {
		if s[i:i+len(old)] == old {
			return s[:i] + new + s[i+len(old):]
		}
	}
	return s
}
