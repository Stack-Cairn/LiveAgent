package session

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

var ErrAgentOffline = errors.New("agent offline")
var ErrChatRunNotFound = errors.New("chat run not found")

const (
	maxBufferedChatRunEvents = 50000
	chatRunDoneRetention     = time.Hour
	chatRunStaleRetention    = 12 * time.Hour

	agentDisconnectedChatRunMessage = "Desktop agent disconnected. Please retry."
)

type AuthSnapshot struct {
	AgentID      string
	AgentVersion string
	SessionID    string
}

type Manager struct {
	mu           sync.RWMutex
	session      *AgentSession
	sessionEpoch uint64
	lastAuth     AuthSnapshot
	authValid    bool

	historyMu          sync.Mutex
	nextHistorySubID   int
	historySubscribers map[int]chan *gatewayv1.HistorySyncEvent

	settingsMu          sync.Mutex
	nextSettingsSubID   int
	settingsSubscribers map[int]chan *gatewayv1.SettingsSyncEvent

	chatMu                 sync.Mutex
	nextChatSubID          int
	chatSubscribers        map[int]chan *ChatBroadcastEvent
	nextChatRunSubID       int
	chatRuns               map[string]*chatRun
	chatRunByConversation  map[string]string
	chatRunByClientRequest map[string]string
	historyActiveRuns      map[string]activeHistoryRun
}

type AgentSession struct {
	AgentID      string
	AgentVersion string
	SessionID    string
	ConnectedAt  time.Time
	LastPing     time.Time

	toAgent chan *gatewayv1.GatewayEnvelope
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
	Done            bool
}

type ActiveChatRunSummary struct {
	ConversationID string
	Workdir        string
	UpdatedAt      int64
}

type chatRun struct {
	requestID       string
	conversationID  string
	clientRequestID string
	workdir         string
	sessionEpoch    uint64
	events          []*ChatBroadcastEvent
	nextSeq         int64
	done            bool
	updatedAt       time.Time
	expiresAt       time.Time
	subscribers     map[int]*chatRunSubscriber
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
	Online         bool   `json:"online"`
	AgentID        string `json:"agent_id"`
	AgentVersion   string `json:"agent_version"`
	SessionID      string `json:"session_id,omitempty"`
	ConnectedSince int64  `json:"connected_since"`
	LastHeartbeat  int64  `json:"last_heartbeat"`
}

func NewManager() *Manager {
	return &Manager{
		historySubscribers:     make(map[int]chan *gatewayv1.HistorySyncEvent),
		settingsSubscribers:    make(map[int]chan *gatewayv1.SettingsSyncEvent),
		chatSubscribers:        make(map[int]chan *ChatBroadcastEvent),
		chatRuns:               make(map[string]*chatRun),
		chatRunByConversation:  make(map[string]string),
		chatRunByClientRequest: make(map[string]string),
		historyActiveRuns:      make(map[string]activeHistoryRun),
	}
}

func NewAgentSession(auth AuthSnapshot) *AgentSession {
	return &AgentSession{
		AgentID:      auth.AgentID,
		AgentVersion: auth.AgentVersion,
		SessionID:    auth.SessionID,
		ConnectedAt:  time.Now(),
		LastPing:     time.Now(),
		toAgent:      make(chan *gatewayv1.GatewayEnvelope, 64),
		done:         make(chan struct{}),
		streams:      make(map[string]*agentStream),
	}
}

func (s *AgentSession) Outbound() <-chan *gatewayv1.GatewayEnvelope {
	return s.toAgent
}

func (s *AgentSession) Done() <-chan struct{} {
	return s.done
}

func (s *AgentSession) Close() {
	s.closeOnce.Do(func() {
		s.streamsMu.Lock()
		s.closed = true
		close(s.done)
		for requestID, stream := range s.streams {
			delete(s.streams, requestID)
			stream.close()
		}
		s.streamsMu.Unlock()
	})
}

func (s *AgentSession) SendToAgent(env *gatewayv1.GatewayEnvelope) error {
	s.streamsMu.Lock()
	closed := s.closed
	s.streamsMu.Unlock()
	if closed {
		return ErrAgentOffline
	}

	select {
	case <-s.done:
		return ErrAgentOffline
	case s.toAgent <- env:
		return nil
	}
}

func (s *AgentSession) TrySendToAgent(env *gatewayv1.GatewayEnvelope) (bool, error) {
	s.streamsMu.Lock()
	closed := s.closed
	s.streamsMu.Unlock()
	if closed {
		return false, ErrAgentOffline
	}

	select {
	case <-s.done:
		return false, ErrAgentOffline
	default:
	}

	select {
	case <-s.done:
		return false, ErrAgentOffline
	case s.toAgent <- env:
		return true, nil
	default:
		return false, nil
	}
}

func (s *AgentSession) registerStream(requestID string) (*agentStream, error) {
	stream := &agentStream{
		ch:   make(chan *gatewayv1.AgentEnvelope, 64),
		done: make(chan struct{}),
	}

	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if s.closed {
		stream.close()
		return nil, ErrAgentOffline
	}
	if existing, ok := s.streams[requestID]; ok {
		existing.close()
	}
	s.streams[requestID] = stream
	return stream, nil
}

func (s *AgentSession) unregisterStream(requestID string, stream *agentStream) {
	s.streamsMu.Lock()
	if existing, ok := s.streams[requestID]; ok && existing == stream {
		delete(s.streams, requestID)
		existing.close()
	}
	s.streamsMu.Unlock()
}

func (s *AgentSession) dispatch(env *gatewayv1.AgentEnvelope) {
	s.streamsMu.Lock()
	stream := s.streams[env.GetRequestId()]
	s.streamsMu.Unlock()
	if stream == nil {
		return
	}
	stream.send(env)
}

func (s *agentStream) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (s *agentStream) send(env *gatewayv1.AgentEnvelope) bool {
	select {
	case <-s.done:
		return false
	case s.ch <- env:
		return true
	}
}

func (m *Manager) RecordAuthentication(agentID, agentVersion, sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastAuth = AuthSnapshot{
		AgentID:      agentID,
		AgentVersion: agentVersion,
		SessionID:    sessionID,
	}
	m.authValid = true
}

func (m *Manager) LatestAuthSnapshot() AuthSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.lastAuth
}

func (m *Manager) IsOnline() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.session != nil
}

func (m *Manager) SetSession(s *AgentSession) {
	m.mu.Lock()
	previous := m.session
	previousEpoch := m.sessionEpoch
	if m.authValid {
		s.AgentID = m.lastAuth.AgentID
		s.AgentVersion = m.lastAuth.AgentVersion
		s.SessionID = m.lastAuth.SessionID
	}
	if previous != s {
		m.sessionEpoch += 1
	}
	m.session = s
	m.mu.Unlock()

	if previous != nil && previous != s {
		previous.Close()
		m.failOpenChatRunsForSessionEpoch(previousEpoch, agentDisconnectedChatRunMessage)
	}
}

func (m *Manager) ClearSession(session *AgentSession) {
	m.mu.Lock()
	if m.session != session {
		m.mu.Unlock()
		return
	}
	clearedEpoch := m.sessionEpoch
	m.session = nil
	m.mu.Unlock()

	if session == nil {
		return
	}

	session.Close()
	m.failOpenChatRunsForSessionEpoch(clearedEpoch, agentDisconnectedChatRunMessage)
}

func (m *Manager) Status() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()

	status := Status{}
	if m.authValid {
		status.AgentID = m.lastAuth.AgentID
		status.AgentVersion = m.lastAuth.AgentVersion
		status.SessionID = m.lastAuth.SessionID
	}
	if m.session == nil {
		return status
	}
	status.Online = true
	status.AgentID = m.session.AgentID
	status.AgentVersion = m.session.AgentVersion
	status.SessionID = m.session.SessionID
	status.ConnectedSince = m.session.ConnectedAt.Unix()
	status.LastHeartbeat = m.session.LastPing.Unix()
	return status
}

func (m *Manager) TouchHeartbeat(session *AgentSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.session == session {
		m.session.LastPing = time.Now()
	}
}

func (m *Manager) SendToAgent(env *gatewayv1.GatewayEnvelope) error {
	m.mu.RLock()
	session := m.session
	m.mu.RUnlock()
	if session == nil {
		return ErrAgentOffline
	}

	return session.SendToAgent(env)
}

func (m *Manager) currentSessionEpoch() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessionEpoch
}

func (m *Manager) RegisterStream(requestID string) (<-chan *gatewayv1.AgentEnvelope, <-chan struct{}, func(), error) {
	m.mu.RLock()
	session := m.session
	m.mu.RUnlock()
	if session == nil {
		return nil, nil, nil, ErrAgentOffline
	}

	stream, err := session.registerStream(requestID)
	if err != nil {
		return nil, nil, nil, err
	}

	cleanup := func() {
		session.unregisterStream(requestID, stream)
	}

	return stream.ch, stream.done, cleanup, nil
}

func (m *Manager) SubscribeHistorySync() (<-chan *gatewayv1.HistorySyncEvent, func()) {
	ch := make(chan *gatewayv1.HistorySyncEvent, 32)

	m.historyMu.Lock()
	subID := m.nextHistorySubID
	m.nextHistorySubID += 1
	m.historySubscribers[subID] = ch
	m.historyMu.Unlock()

	cleanup := func() {
		m.historyMu.Lock()
		existing, ok := m.historySubscribers[subID]
		if ok {
			delete(m.historySubscribers, subID)
			close(existing)
		}
		m.historyMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastHistorySync(event *gatewayv1.HistorySyncEvent) {
	if event == nil {
		return
	}

	m.updateActiveHistoryRun(event)
	m.releaseCompletedChatRunAfterHistoryUpsert(event)

	m.historyMu.Lock()
	subscribers := make([]chan *gatewayv1.HistorySyncEvent, 0, len(m.historySubscribers))
	for _, ch := range m.historySubscribers {
		subscribers = append(subscribers, ch)
	}
	m.historyMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func historySyncConversationID(event *gatewayv1.HistorySyncEvent) string {
	conversationID := strings.TrimSpace(event.GetConversationId())
	if conversationID == "" && event.GetConversation() != nil {
		conversationID = strings.TrimSpace(event.GetConversation().GetId())
	}
	return conversationID
}

func historySyncWorkdir(event *gatewayv1.HistorySyncEvent) string {
	if event == nil || event.GetConversation() == nil {
		return ""
	}
	return strings.TrimSpace(event.GetConversation().GetCwd())
}

func (m *Manager) updateActiveHistoryRun(event *gatewayv1.HistorySyncEvent) {
	kind := strings.TrimSpace(event.GetKind())
	conversationID := historySyncConversationID(event)
	if conversationID == "" {
		return
	}

	workdir := historySyncWorkdir(event)
	now := time.Now()

	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)

	switch kind {
	case "running":
		existing := m.historyActiveRuns[conversationID]
		if workdir == "" {
			workdir = existing.workdir
		}
		m.historyActiveRuns[conversationID] = activeHistoryRun{
			conversationID: conversationID,
			workdir:        workdir,
			updatedAt:      now,
		}
		if requestID := m.chatRunByConversation[conversationID]; requestID != "" {
			if run := m.chatRuns[requestID]; run != nil && workdir != "" {
				run.workdir = workdir
			}
		}
	case "idle", "delete":
		delete(m.historyActiveRuns, conversationID)
	case "upsert":
		if workdir == "" {
			return
		}
		if existing, ok := m.historyActiveRuns[conversationID]; ok {
			existing.workdir = workdir
			existing.updatedAt = now
			m.historyActiveRuns[conversationID] = existing
		}
		if requestID := m.chatRunByConversation[conversationID]; requestID != "" {
			if run := m.chatRuns[requestID]; run != nil {
				run.workdir = workdir
			}
		}
	}
}

func (m *Manager) releaseCompletedChatRunAfterHistoryUpsert(event *gatewayv1.HistorySyncEvent) {
	if strings.TrimSpace(event.GetKind()) != "upsert" {
		return
	}

	conversationID := historySyncConversationID(event)
	if conversationID == "" {
		return
	}

	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	requestID := m.chatRunByConversation[conversationID]
	run := m.chatRuns[requestID]
	if run == nil || !run.done {
		return
	}
	m.releaseCompletedChatRunLocked(requestID, run)
}

func (m *Manager) SubscribeSettingsSync() (<-chan *gatewayv1.SettingsSyncEvent, func()) {
	ch := make(chan *gatewayv1.SettingsSyncEvent, 32)

	m.settingsMu.Lock()
	subID := m.nextSettingsSubID
	m.nextSettingsSubID += 1
	m.settingsSubscribers[subID] = ch
	m.settingsMu.Unlock()

	cleanup := func() {
		m.settingsMu.Lock()
		existing, ok := m.settingsSubscribers[subID]
		if ok {
			delete(m.settingsSubscribers, subID)
			close(existing)
		}
		m.settingsMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) broadcastSettingsSync(event *gatewayv1.SettingsSyncEvent) {
	if event == nil {
		return
	}

	m.settingsMu.Lock()
	subscribers := make([]chan *gatewayv1.SettingsSyncEvent, 0, len(m.settingsSubscribers))
	for _, ch := range m.settingsSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.settingsMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func (m *Manager) SubscribeChatEvents() (<-chan *ChatBroadcastEvent, func()) {
	ch := make(chan *ChatBroadcastEvent, 128)

	m.chatMu.Lock()
	subID := m.nextChatSubID
	m.nextChatSubID += 1
	m.chatSubscribers[subID] = ch
	m.chatMu.Unlock()

	cleanup := func() {
		m.chatMu.Lock()
		existing, ok := m.chatSubscribers[subID]
		if ok {
			delete(m.chatSubscribers, subID)
			close(existing)
		}
		m.chatMu.Unlock()
	}

	return ch, cleanup
}

func (m *Manager) StartChatRun(requestID string, conversationID string) (ChatRunSnapshot, error) {
	snapshot, _, err := m.StartChatRunWithClientRequest(requestID, conversationID, "", "")
	return snapshot, err
}

func (m *Manager) StartChatRunWithClientRequest(
	requestID string,
	conversationID string,
	clientRequestID string,
	workdirInput ...string,
) (ChatRunSnapshot, bool, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return ChatRunSnapshot{}, false, ErrChatRunNotFound
	}

	now := time.Now()
	conversationID = strings.TrimSpace(conversationID)
	clientRequestID = strings.TrimSpace(clientRequestID)
	workdir := ""
	if len(workdirInput) > 0 {
		workdir = strings.TrimSpace(workdirInput[0])
	}
	sessionEpoch := m.currentSessionEpoch()

	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(now)

	if clientRequestID != "" {
		if existingRequestID := m.chatRunByClientRequest[clientRequestID]; existingRequestID != "" {
			if existing := m.chatRuns[existingRequestID]; existing != nil {
				if !existing.done {
					if workdir != "" && existing.workdir == "" {
						existing.workdir = workdir
					}
					return existing.snapshot(), false, nil
				}
				m.releaseCompletedChatRunLocked(existingRequestID, existing)
			}
			delete(m.chatRunByClientRequest, clientRequestID)
		}
	}

	if existing := m.chatRuns[requestID]; existing != nil {
		m.removeChatRunLocked(requestID, existing)
	}

	run := &chatRun{
		requestID:       requestID,
		conversationID:  conversationID,
		clientRequestID: clientRequestID,
		workdir:         workdir,
		sessionEpoch:    sessionEpoch,
		updatedAt:       now,
		subscribers:     make(map[int]*chatRunSubscriber),
	}
	m.chatRuns[requestID] = run
	if conversationID != "" {
		m.chatRunByConversation[conversationID] = requestID
	}
	if clientRequestID != "" {
		m.chatRunByClientRequest[clientRequestID] = requestID
	}

	return run.snapshot(), true, nil
}

func (m *Manager) RemoveChatRun(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return
	}

	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	run := m.chatRuns[requestID]
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) RemoveChatRunByConversation(conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		return
	}

	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	requestID := m.chatRunByConversation[conversationID]
	run := m.chatRuns[requestID]
	if run == nil {
		for candidateRequestID, candidateRun := range m.chatRuns {
			if strings.TrimSpace(candidateRun.conversationID) == conversationID {
				requestID = candidateRequestID
				run = candidateRun
				break
			}
		}
	}
	if run == nil {
		return
	}
	m.removeChatRunLocked(requestID, run)
}

func (m *Manager) ActiveChatRunSummaries() []ActiveChatRunSummary {
	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	now := time.Now()
	m.pruneExpiredChatRunsLocked(now)

	seen := make(map[string]int, len(m.chatRuns)+len(m.historyActiveRuns))
	summaries := make([]ActiveChatRunSummary, 0, len(m.chatRuns)+len(m.historyActiveRuns))
	for _, run := range m.chatRuns {
		if run == nil || run.done {
			continue
		}
		conversationID := strings.TrimSpace(run.conversationID)
		if conversationID == "" {
			continue
		}
		summary := ActiveChatRunSummary{
			ConversationID: conversationID,
			Workdir:        strings.TrimSpace(run.workdir),
			UpdatedAt:      run.updatedAt.UnixMilli(),
		}
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = summary.Workdir
			}
			if summary.UpdatedAt > summaries[index].UpdatedAt {
				summaries[index].UpdatedAt = summary.UpdatedAt
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, summary)
	}

	for conversationID, run := range m.historyActiveRuns {
		conversationID = strings.TrimSpace(conversationID)
		if conversationID == "" {
			continue
		}
		if now.Sub(run.updatedAt) > chatRunStaleRetention {
			delete(m.historyActiveRuns, conversationID)
			continue
		}
		workdir := strings.TrimSpace(run.workdir)
		updatedAt := run.updatedAt.UnixMilli()
		if index, ok := seen[conversationID]; ok {
			if summaries[index].Workdir == "" {
				summaries[index].Workdir = workdir
			}
			if updatedAt > summaries[index].UpdatedAt {
				summaries[index].UpdatedAt = updatedAt
			}
			continue
		}
		seen[conversationID] = len(summaries)
		summaries = append(summaries, ActiveChatRunSummary{
			ConversationID: conversationID,
			Workdir:        workdir,
			UpdatedAt:      updatedAt,
		})
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].ConversationID < summaries[j].ConversationID
	})
	return summaries
}

func (m *Manager) ActiveChatRunConversationIDs() []string {
	summaries := m.ActiveChatRunSummaries()
	ids := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		if conversationID := strings.TrimSpace(summary.ConversationID); conversationID != "" {
			ids = append(ids, conversationID)
		}
	}
	return ids
}

func (m *Manager) failOpenChatRunsForSessionEpoch(sessionEpoch uint64, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = agentDisconnectedChatRunMessage
	}

	data, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		data = []byte(`{"message":"Desktop agent disconnected. Please retry."}`)
	}
	now := time.Now()

	type broadcastTarget struct {
		event       *ChatBroadcastEvent
		subscribers []*chatRunSubscriber
	}
	targets := make([]broadcastTarget, 0)
	globalSubscribers := make([]chan *ChatBroadcastEvent, 0)

	m.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	for requestID, run := range m.chatRuns {
		if run == nil || run.done || run.sessionEpoch != sessionEpoch {
			continue
		}

		run.nextSeq += 1
		run.updatedAt = now
		run.done = true
		run.expiresAt = now.Add(chatRunDoneRetention)

		chatEvent := &gatewayv1.ChatEvent{
			Type:           gatewayv1.ChatEvent_ERROR,
			ConversationId: strings.TrimSpace(run.conversationID),
			Data:           string(data),
		}
		broadcast := &ChatBroadcastEvent{
			RequestID: requestID,
			Event:     chatEvent,
			Seq:       run.nextSeq,
			Workdir:   strings.TrimSpace(run.workdir),
		}
		run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
		if len(run.events) > maxBufferedChatRunEvents {
			copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
			run.events = run.events[:maxBufferedChatRunEvents]
		}

		subscribers := make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			subscribers = append(subscribers, subscriber)
		}
		targets = append(targets, broadcastTarget{
			event:       broadcast,
			subscribers: subscribers,
		})
	}
	for _, ch := range m.chatSubscribers {
		globalSubscribers = append(globalSubscribers, ch)
	}
	m.chatMu.Unlock()

	for _, target := range targets {
		for _, subscriber := range target.subscribers {
			select {
			case <-subscriber.done:
			case subscriber.ch <- cloneChatBroadcastEvent(target.event):
			}
		}
		for _, ch := range globalSubscribers {
			select {
			case ch <- cloneChatBroadcastEvent(target.event):
			default:
			}
		}
	}
}

func (m *Manager) SubscribeChatRun(
	requestID string,
	conversationID string,
	afterSeq int64,
) (<-chan *ChatBroadcastEvent, <-chan struct{}, func(), ChatRunSnapshot, error) {
	requestID = strings.TrimSpace(requestID)
	conversationID = strings.TrimSpace(conversationID)
	if afterSeq < 0 {
		afterSeq = 0
	}

	m.chatMu.Lock()
	defer m.chatMu.Unlock()
	m.pruneExpiredChatRunsLocked(time.Now())

	if requestID == "" && conversationID != "" {
		requestID = m.chatRunByConversation[conversationID]
	}
	run := m.chatRuns[requestID]
	if run == nil {
		done := make(chan struct{})
		close(done)
		return nil, done, func() {}, ChatRunSnapshot{}, ErrChatRunNotFound
	}

	replay := make([]*ChatBroadcastEvent, 0)
	for _, event := range run.events {
		if event.Seq > afterSeq {
			replay = append(replay, cloneChatBroadcastEvent(event))
		}
	}

	bufferSize := len(replay) + 128
	if bufferSize < 128 {
		bufferSize = 128
	}
	ch := make(chan *ChatBroadcastEvent, bufferSize)
	done := make(chan struct{})
	for _, event := range replay {
		ch <- event
	}

	subID := -1
	var subscriber *chatRunSubscriber
	if !run.done {
		subID = m.nextChatRunSubID
		m.nextChatRunSubID += 1
		subscriber = &chatRunSubscriber{
			ch:   ch,
			done: done,
		}
		run.subscribers[subID] = subscriber
	}

	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			m.chatMu.Lock()
			if subID >= 0 {
				if current := m.chatRuns[requestID]; current != nil {
					delete(current.subscribers, subID)
				}
			}
			m.chatMu.Unlock()
			if subscriber != nil {
				subscriber.close()
			} else {
				close(done)
			}
		})
	}

	return ch, done, cleanup, run.snapshot(), nil
}

func (m *Manager) broadcastChatEvent(requestID string, event *gatewayv1.ChatEvent) {
	if event == nil {
		return
	}

	requestID = strings.TrimSpace(requestID)
	conversationID := strings.TrimSpace(event.GetConversationId())
	now := time.Now()
	sessionEpoch := m.currentSessionEpoch()

	m.chatMu.Lock()
	m.pruneExpiredChatRunsLocked(now)
	broadcast := &ChatBroadcastEvent{
		RequestID: requestID,
		Event:     event,
	}
	var runSubscribers []*chatRunSubscriber
	run := m.chatRuns[requestID]
	if run == nil && requestID != "" {
		run = &chatRun{
			requestID:      requestID,
			conversationID: conversationID,
			sessionEpoch:   sessionEpoch,
			updatedAt:      now,
			subscribers:    make(map[int]*chatRunSubscriber),
		}
		m.chatRuns[requestID] = run
		if conversationID != "" {
			m.chatRunByConversation[conversationID] = requestID
		}
	}
	if run != nil {
		run.nextSeq += 1
		run.updatedAt = now
		if conversationID != "" {
			if run.conversationID != "" && run.conversationID != conversationID {
				if m.chatRunByConversation[run.conversationID] == requestID {
					delete(m.chatRunByConversation, run.conversationID)
				}
			}
			run.conversationID = conversationID
			m.chatRunByConversation[conversationID] = requestID
			if run.workdir == "" {
				if activeRun, ok := m.historyActiveRuns[conversationID]; ok {
					run.workdir = strings.TrimSpace(activeRun.workdir)
				}
			}
		}
		broadcast.Seq = run.nextSeq
		broadcast.Workdir = strings.TrimSpace(run.workdir)
		run.events = append(run.events, cloneChatBroadcastEvent(broadcast))
		if len(run.events) > maxBufferedChatRunEvents {
			copy(run.events, run.events[len(run.events)-maxBufferedChatRunEvents:])
			run.events = run.events[:maxBufferedChatRunEvents]
		}
		if isTerminalChatEvent(event) {
			run.done = true
			run.expiresAt = now.Add(chatRunDoneRetention)
		}
		runSubscribers = make([]*chatRunSubscriber, 0, len(run.subscribers))
		for _, subscriber := range run.subscribers {
			runSubscribers = append(runSubscribers, subscriber)
		}
	}
	subscribers := make([]chan *ChatBroadcastEvent, 0, len(m.chatSubscribers))
	for _, ch := range m.chatSubscribers {
		subscribers = append(subscribers, ch)
	}
	m.chatMu.Unlock()

	for _, subscriber := range runSubscribers {
		select {
		case <-subscriber.done:
		case subscriber.ch <- cloneChatBroadcastEvent(broadcast):
		}
	}
	for _, ch := range subscribers {
		select {
		case ch <- broadcast:
		default:
		}
	}
}

func (m *Manager) DispatchFromAgent(env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(nil, env)
}

func (m *Manager) DispatchFromAgentForSession(session *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.dispatchFromAgent(session, env)
}

func (m *Manager) dispatchFromAgent(expected *AgentSession, env *gatewayv1.AgentEnvelope) {
	m.mu.RLock()
	session := m.session
	m.mu.RUnlock()
	if session == nil || (expected != nil && session != expected) {
		return
	}

	if chatEvent := env.GetChatEvent(); chatEvent != nil {
		m.broadcastChatEvent(env.GetRequestId(), chatEvent)
	}

	if historySync := env.GetHistorySync(); historySync != nil {
		m.broadcastHistorySync(historySync)
		return
	}

	if settingsSync := env.GetSettingsSync(); settingsSync != nil {
		m.broadcastSettingsSync(settingsSync)
		return
	}

	session.dispatch(env)
}

func (r *chatRun) snapshot() ChatRunSnapshot {
	firstSeq := int64(0)
	if len(r.events) > 0 {
		firstSeq = r.events[0].Seq
	}
	return ChatRunSnapshot{
		RequestID:       r.requestID,
		ConversationID:  r.conversationID,
		ClientRequestID: r.clientRequestID,
		Workdir:         r.workdir,
		FirstSeq:        firstSeq,
		LatestSeq:       r.nextSeq,
		Done:            r.done,
	}
}

func (s *chatRunSubscriber) close() {
	s.closeOnce.Do(func() {
		close(s.done)
	})
}

func (m *Manager) pruneExpiredChatRunsLocked(now time.Time) {
	for requestID, run := range m.chatRuns {
		if run == nil {
			delete(m.chatRuns, requestID)
			continue
		}
		if run.done {
			if !run.expiresAt.IsZero() && now.After(run.expiresAt) {
				m.removeChatRunLocked(requestID, run)
			}
			continue
		}
		if !run.updatedAt.IsZero() && now.Sub(run.updatedAt) > chatRunStaleRetention {
			m.removeChatRunLocked(requestID, run)
		}
	}
}

func (m *Manager) removeChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatRunByConversation, run.conversationID)
	}
	if run.clientRequestID != "" && m.chatRunByClientRequest[run.clientRequestID] == requestID {
		delete(m.chatRunByClientRequest, run.clientRequestID)
	}
	delete(m.chatRuns, requestID)
	for _, subscriber := range run.subscribers {
		subscriber.close()
	}
}

func (m *Manager) releaseCompletedChatRunLocked(requestID string, run *chatRun) {
	if run.conversationID != "" && m.chatRunByConversation[run.conversationID] == requestID {
		delete(m.chatRunByConversation, run.conversationID)
	}
	if run.clientRequestID != "" && m.chatRunByClientRequest[run.clientRequestID] == requestID {
		delete(m.chatRunByClientRequest, run.clientRequestID)
	}
	delete(m.chatRuns, requestID)
}

func cloneChatBroadcastEvent(event *ChatBroadcastEvent) *ChatBroadcastEvent {
	if event == nil {
		return nil
	}
	return &ChatBroadcastEvent{
		RequestID: event.RequestID,
		Event:     event.Event,
		Seq:       event.Seq,
		Workdir:   event.Workdir,
	}
}

func isTerminalChatEvent(event *gatewayv1.ChatEvent) bool {
	if event == nil {
		return false
	}
	return event.GetType() == gatewayv1.ChatEvent_DONE || event.GetType() == gatewayv1.ChatEvent_ERROR
}
