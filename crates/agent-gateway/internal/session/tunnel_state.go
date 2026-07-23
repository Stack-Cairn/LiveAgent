package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const (
	maxTunnelsPerAgent       = 5
	maxTunnelConnections     = 20
	tunnelSlugEntropyBytes   = 24
	tunnelStreamChannelDepth = 256
	tunnelAgentSendTimeout   = 10 * time.Second
	tunnelRelayProbeTimeout  = 5 * time.Second
	tunnelExpirySweepPeriod  = 30 * time.Second
)

var tunnelSlugPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22,64}$`)

// tunnelRuntime is the gateway-side runtime view of the agent's desired
// tunnel set: slug allocation, live streams, connection counts, and health.
// The desired specs themselves are owned and persisted by the agent.
type tunnelRuntime struct {
	mu        sync.Mutex
	records   map[string]*tunnelRecord
	slugToID  map[string]string
	streams   map[string]*tunnelStream
	revisions map[string]uint64
	relays    map[string]*gatewayv2.TunnelHealth

	subMu       sync.Mutex
	nextSubID   int
	subscribers map[int]chan Tagged[*gatewayv2.TunnelStateSnapshot]

	pingMu       sync.Mutex
	pendingPings map[string]pendingTunnelPing
}

type tunnelRecord struct {
	id                string
	agentID           string
	slug              string
	name              string
	targetURL         string
	projectPathKey    string
	createdAt         time.Time
	expiresAt         time.Time
	activeConnections int
	local             *gatewayv2.TunnelHealth
}

type pendingTunnelPing struct {
	agentID string
	ch      chan int64
}

type tunnelStream struct {
	streamID string
	tunnelID string
	// agentID 是流所属 record 的归属 Agent；入站帧按它校验，防止 Agent A
	// 伪造 stream_id 向 Agent B 的访问者注入数据。
	agentID string
	ch      chan *gatewayv2.TunnelFrame
	done    chan struct{}
	once    sync.Once
}

// TunnelStreamLease is one visitor connection's claim on a tunnel.
type TunnelStreamLease struct {
	manager   *Manager
	stream    *tunnelStream
	slug      string
	targetURL string
	agentID   string
	once      sync.Once
}

func newTunnelRuntime() *tunnelRuntime {
	return &tunnelRuntime{
		records:      make(map[string]*tunnelRecord),
		slugToID:     make(map[string]string),
		streams:      make(map[string]*tunnelStream),
		revisions:    make(map[string]uint64),
		relays:       make(map[string]*gatewayv2.TunnelHealth),
		subscribers:  make(map[int]chan Tagged[*gatewayv2.TunnelStateSnapshot]),
		pendingPings: make(map[string]pendingTunnelPing),
	}
}

func (s *tunnelStream) close() {
	if s == nil {
		return
	}
	s.once.Do(func() {
		close(s.done)
	})
}

func (l *TunnelStreamLease) TunnelID() string {
	if l == nil || l.stream == nil {
		return ""
	}
	return l.stream.tunnelID
}

func (l *TunnelStreamLease) Slug() string {
	if l == nil {
		return ""
	}
	return l.slug
}

func (l *TunnelStreamLease) TargetURL() string {
	if l == nil {
		return ""
	}
	return l.targetURL
}

func (l *TunnelStreamLease) StreamID() string {
	if l == nil || l.stream == nil {
		return ""
	}
	return l.stream.streamID
}

func (l *TunnelStreamLease) Frames() <-chan *gatewayv2.TunnelFrame {
	if l == nil || l.stream == nil {
		return nil
	}
	return l.stream.ch
}

func (l *TunnelStreamLease) Done() <-chan struct{} {
	if l == nil || l.stream == nil {
		return nil
	}
	return l.stream.done
}

// AgentID 返回租约所属隧道的归属 Agent（访问者帧的路由目标）。
func (l *TunnelStreamLease) AgentID() string {
	if l == nil {
		return ""
	}
	return l.agentID
}

func (l *TunnelStreamLease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.manager.releaseTunnelStream(l.stream)
	})
}

func (m *Manager) WebTunnelsEnabled(agentID string) bool {
	return m.settingsRemoteBool(agentID, "enableWebTunnels")
}

// ApplyDesiredState reconciles agentID's runtime records against that agent's
// full desired tunnel set: allocates slugs for new tunnels (honoring valid
// unused hints), updates changed ones, and drops removed ones (canceling
// their streams). Records of other agents are untouched; the per-agent cap
// applies to each agent's own set.
func (m *Manager) ApplyDesiredState(agentID string, desired *gatewayv2.TunnelDesiredState) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || desired == nil {
		return
	}
	now := time.Now()
	specs := desired.GetTunnels()
	if len(specs) > maxTunnelsPerAgent {
		specs = specs[:maxTunnelsPerAgent]
	}

	var canceled []*tunnelStream
	m.tunnels.mu.Lock()
	seen := make(map[string]bool, len(specs))
	for _, spec := range specs {
		id := strings.TrimSpace(spec.GetId())
		targetURL := strings.TrimSpace(spec.GetTargetUrl())
		if id == "" || targetURL == "" || seen[id] {
			continue
		}
		expiresAt := time.Time{}
		if spec.GetExpiresAt() > 0 {
			expiresAt = time.Unix(spec.GetExpiresAt(), 0)
			if !expiresAt.After(now) {
				continue
			}
		}
		seen[id] = true
		record := m.tunnels.records[id]
		if record != nil && record.agentID != agentID {
			// 隧道 id 撞上他人的 record：拒绝接管（id 是 Agent 本地生成的，
			// 跨 Agent 撞车只能来自伪造或配置复制），保持原归属不变。
			continue
		}
		if record == nil {
			record = &tunnelRecord{
				id:        id,
				agentID:   agentID,
				slug:      m.allocateTunnelSlugLocked(spec.GetSlugHint()),
				createdAt: now,
			}
			m.tunnels.records[id] = record
			m.tunnels.slugToID[record.slug] = id
		}
		record.name = strings.TrimSpace(spec.GetName())
		record.targetURL = targetURL
		record.projectPathKey = strings.TrimSpace(spec.GetProjectPathKey())
		record.expiresAt = expiresAt
	}
	for id, record := range m.tunnels.records {
		if seen[id] || record.agentID != agentID {
			continue
		}
		canceled = append(canceled, m.dropTunnelRecordLocked(record)...)
	}
	m.tunnels.mu.Unlock()

	m.cancelTunnelStreams(canceled)
	m.broadcastTunnelState(agentID)
	go m.probeRelay(agentID)
}

// ApplyProbeReport merges one authenticated Agent report into only that Agent records.
func (m *Manager) ApplyProbeReport(agentID string, report *gatewayv2.TunnelProbeReport) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || report == nil || len(report.GetResults()) == 0 {
		return
	}
	changed := false
	m.tunnels.mu.Lock()
	for _, result := range report.GetResults() {
		record := m.tunnels.records[strings.TrimSpace(result.GetTunnelId())]
		if record == nil || record.agentID != agentID || result.GetLocal() == nil {
			continue
		}
		record.local = cloneTunnelHealth(result.GetLocal())
		changed = true
	}
	m.tunnels.mu.Unlock()
	if changed {
		m.broadcastTunnelState(agentID)
	}
}

// dropTunnelRecordLocked removes a record and returns its now-closed streams
// so CANCEL frames can be sent to the agent outside the lock.
func (m *Manager) dropTunnelRecordLocked(record *tunnelRecord) []*tunnelStream {
	if record == nil {
		return nil
	}
	delete(m.tunnels.records, record.id)
	delete(m.tunnels.slugToID, record.slug)
	var dropped []*tunnelStream
	for streamID, stream := range m.tunnels.streams {
		if stream == nil || stream.tunnelID != record.id {
			continue
		}
		delete(m.tunnels.streams, streamID)
		stream.close()
		dropped = append(dropped, stream)
	}
	return dropped
}

// cancelTunnelStreams 向各流的归属 Agent 发送 CANCEL（过期清扫可能跨多个 Agent）。
func (m *Manager) cancelTunnelStreams(streams []*tunnelStream) {
	for _, stream := range streams {
		_ = m.SendTunnelFrameToAgent(stream.agentID, &gatewayv2.TunnelFrame{
			StreamId: stream.streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
		})
	}
}

func (m *Manager) allocateTunnelSlugLocked(hint string) string {
	hint = strings.TrimSpace(hint)
	if tunnelSlugPattern.MatchString(hint) {
		if _, taken := m.tunnels.slugToID[hint]; !taken {
			return hint
		}
	}
	for {
		slug := randomURLToken(tunnelSlugEntropyBytes)
		if slug == "" {
			// crypto/rand failure; fall back to a UUID-derived token.
			slug = strings.ReplaceAll(uuid.NewString(), "-", "")
		}
		if _, taken := m.tunnels.slugToID[slug]; !taken {
			return slug
		}
	}
}

func randomURLToken(byteCount int) string {
	if byteCount <= 0 {
		return ""
	}
	buf := make([]byte, byteCount)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

// TunnelStateSnapshot builds the authoritative state for one named Agent.
func (m *Manager) TunnelStateSnapshot(agentID string) *gatewayv2.TunnelStateSnapshot {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return &gatewayv2.TunnelStateSnapshot{}
	}
	online := m.IsOnline(agentID)
	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()
	return m.tunnelStateSnapshotLocked(agentID, online)
}

func (m *Manager) tunnelStateSnapshotLocked(agentID string, online bool) *gatewayv2.TunnelStateSnapshot {
	tunnels := make([]*gatewayv2.TunnelStatus, 0, len(m.tunnels.records))
	for _, record := range m.tunnels.records {
		if record.agentID != agentID {
			continue
		}
		tunnels = append(tunnels, &gatewayv2.TunnelStatus{
			Id:                record.id,
			Slug:              record.slug,
			Name:              record.name,
			TargetUrl:         record.targetURL,
			PublicPath:        "/t/" + record.slug + "/",
			CreatedAt:         record.createdAt.Unix(),
			ExpiresAt:         unixOrZero(record.expiresAt),
			ActiveConnections: uint32(max(record.activeConnections, 0)),
			ProjectPathKey:    record.projectPathKey,
			Local:             cloneTunnelHealth(record.local),
		})
	}
	sort.Slice(tunnels, func(i, j int) bool {
		if tunnels[i].GetCreatedAt() != tunnels[j].GetCreatedAt() {
			return tunnels[i].GetCreatedAt() < tunnels[j].GetCreatedAt()
		}
		return tunnels[i].GetId() < tunnels[j].GetId()
	})
	m.tunnels.revisions[agentID] += 1
	return &gatewayv2.TunnelStateSnapshot{
		Tunnels:     tunnels,
		Revision:    m.tunnels.revisions[agentID],
		AgentOnline: online,
		Relay:       cloneTunnelHealth(m.tunnels.relays[agentID]),
	}
}

func (m *Manager) SubscribeTunnelState() (<-chan Tagged[*gatewayv2.TunnelStateSnapshot], func()) {
	ch := make(chan Tagged[*gatewayv2.TunnelStateSnapshot], 16)

	m.tunnels.subMu.Lock()
	subID := m.tunnels.nextSubID
	m.tunnels.nextSubID += 1
	m.tunnels.subscribers[subID] = ch
	m.tunnels.subMu.Unlock()

	cleanup := func() {
		m.tunnels.subMu.Lock()
		// Do not close the channel: broadcastTunnelState sends after copying
		// subscribers, so closing can race with an in-flight send.
		delete(m.tunnels.subscribers, subID)
		m.tunnels.subMu.Unlock()
	}
	return ch, cleanup
}

// broadcastTunnelState pushes one Agent snapshot to /ws subscribers and back
// to the same Agent, which persists allocated slugs and re-emits it to the GUI.
func (m *Manager) broadcastTunnelState(agentID string) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	snapshot := m.TunnelStateSnapshot(agentID)
	tagged := Tagged[*gatewayv2.TunnelStateSnapshot]{AgentID: agentID, Event: snapshot}

	m.tunnels.subMu.Lock()
	subscribers := make([]chan Tagged[*gatewayv2.TunnelStateSnapshot], 0, len(m.tunnels.subscribers))
	for _, ch := range m.tunnels.subscribers {
		subscribers = append(subscribers, ch)
	}
	m.tunnels.subMu.Unlock()

	for _, ch := range subscribers {
		select {
		case ch <- tagged:
		default:
		}
	}

	// Best-effort and non-blocking. A fresher snapshot follows every state change.
	if session, err := m.resolveSession(agentID); err == nil {
		_, _ = session.TrySendToAgent(&gatewayv2.GatewayEnvelope{
			RequestId: "tunnel-state-" + uuid.NewString(),
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_TunnelState{
				TunnelState: snapshot,
			},
		})
	}
}

// AcquireTunnel claims a visitor stream slot on the tunnel behind slug.
// The lease is bound to the tunnel's owning agent; visitor frames route there.
func (m *Manager) AcquireTunnel(slug string, streamID string) (*TunnelStreamLease, error) {
	slug = strings.TrimSpace(slug)
	streamID = strings.TrimSpace(streamID)
	if slug == "" || streamID == "" {
		return nil, ErrTunnelNotFound
	}
	now := time.Now()

	m.tunnels.mu.Lock()
	defer m.tunnels.mu.Unlock()

	record := m.tunnels.records[m.tunnels.slugToID[slug]]
	if record == nil {
		return nil, ErrTunnelNotFound
	}
	// 在线判定按 record 归属 Agent，与其他 Agent 的状态无关。
	if !m.IsOnline(record.agentID) {
		return nil, ErrAgentOffline
	}
	if !record.expiresAt.IsZero() && !record.expiresAt.After(now) {
		return nil, ErrTunnelExpired
	}
	if record.activeConnections >= maxTunnelConnections {
		return nil, ErrTunnelOverLimit
	}
	stream := &tunnelStream{
		streamID: streamID,
		tunnelID: record.id,
		agentID:  record.agentID,
		ch:       make(chan *gatewayv2.TunnelFrame, tunnelStreamChannelDepth),
		done:     make(chan struct{}),
	}
	if existing := m.tunnels.streams[streamID]; existing != nil {
		existing.close()
	}
	m.tunnels.streams[streamID] = stream
	record.activeConnections += 1

	return &TunnelStreamLease{
		manager:   m,
		stream:    stream,
		slug:      record.slug,
		targetURL: record.targetURL,
		agentID:   record.agentID,
	}, nil
}

func (m *Manager) releaseTunnelStream(stream *tunnelStream) {
	if stream == nil {
		return
	}
	m.tunnels.mu.Lock()
	if existing := m.tunnels.streams[stream.streamID]; existing == stream {
		delete(m.tunnels.streams, stream.streamID)
	}
	if record := m.tunnels.records[stream.tunnelID]; record != nil && record.activeConnections > 0 {
		record.activeConnections -= 1
	}
	stream.close()
	m.tunnels.mu.Unlock()
}

// SendTunnelFrameToAgent 把访问者帧送往目标 Agent。
func (m *Manager) SendTunnelFrameToAgent(agentID string, frame *gatewayv2.TunnelFrame) error {
	if frame == nil {
		return fmt.Errorf("tunnel frame is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), tunnelAgentSendTimeout)
	defer cancel()
	return m.SendToAgentContext(ctx, agentID, &gatewayv2.GatewayEnvelope{
		RequestId: "tunnel-frame-" + uuid.NewString(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_TunnelFrame{
			TunnelFrame: frame,
		},
	})
}

// dispatchTunnelFrame routes an agent frame to its visitor stream. It runs on
// the agent read loop, so it must never block: a full stream channel closes
// the stream (the visitor handler cancels) instead of waiting. Frames whose
// stream belongs to a different agent are rejected — an agent can only feed
// its own visitors.
func (m *Manager) dispatchTunnelFrame(agentID string, frame *gatewayv2.TunnelFrame) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" || frame == nil {
		return
	}
	if frame.GetKind() == gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_PONG {
		m.resolveRelayPong(agentID, frame.GetStreamId())
		return
	}
	streamID := strings.TrimSpace(frame.GetStreamId())
	if streamID == "" {
		return
	}
	m.tunnels.mu.Lock()
	stream := m.tunnels.streams[streamID]
	m.tunnels.mu.Unlock()
	if stream == nil {
		return
	}
	if stream.agentID != agentID {
		// 跨 Agent 伪造 stream_id：直接丢弃，不给探测反馈。
		return
	}
	select {
	case <-stream.done:
	case stream.ch <- frame:
	default:
		m.releaseTunnelStream(stream)
		go func() {
			_ = m.SendTunnelFrameToAgent(agentID, &gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				Error:    "tunnel stream backlog exceeded",
			})
		}()
	}
}

// probeRelay measures the gateway<->agent frame path with a PING/PONG round
// trip and folds the result into the broadcast snapshot.
func (m *Manager) probeRelay(agentID string) {
	checkedAt := time.Now()
	health := &gatewayv2.TunnelHealth{Status: "failed", CheckedAt: checkedAt.Unix()}

	if !m.IsOnline(agentID) {
		health.Error = "agent offline"
		m.setRelayHealth(agentID, health)
		return
	}

	pingID := "ping-" + uuid.NewString()
	pongCh := make(chan int64, 1)
	m.tunnels.pingMu.Lock()
	m.tunnels.pendingPings[pingID] = pendingTunnelPing{agentID: agentID, ch: pongCh}
	m.tunnels.pingMu.Unlock()
	defer func() {
		m.tunnels.pingMu.Lock()
		delete(m.tunnels.pendingPings, pingID)
		m.tunnels.pingMu.Unlock()
	}()

	if err := m.SendTunnelFrameToAgent(agentID, &gatewayv2.TunnelFrame{
		StreamId: pingID,
		Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_PING,
	}); err != nil {
		health.Error = err.Error()
		m.setRelayHealth(agentID, health)
		return
	}

	timer := time.NewTimer(tunnelRelayProbeTimeout)
	defer timer.Stop()
	select {
	case <-pongCh:
		health.Status = "ok"
		health.RttMs = uint32(min(time.Since(checkedAt).Milliseconds(), int64(^uint32(0))))
	case <-timer.C:
		health.Error = "relay probe timed out"
	}
	m.setRelayHealth(agentID, health)
}

func (m *Manager) resolveRelayPong(agentID, streamID string) {
	streamID = strings.TrimSpace(streamID)
	m.tunnels.pingMu.Lock()
	pending, ok := m.tunnels.pendingPings[streamID]
	if ok && pending.agentID == strings.TrimSpace(agentID) {
		delete(m.tunnels.pendingPings, streamID)
	} else {
		ok = false
	}
	m.tunnels.pingMu.Unlock()
	if ok {
		select {
		case pending.ch <- time.Now().UnixMilli():
		default:
		}
	}
}

func (m *Manager) setRelayHealth(agentID string, health *gatewayv2.TunnelHealth) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	// 永久删除后，删除前已发出的异步探测可能迟到；不存在的登记项不得重新
	// 写回 relay 状态。普通离线仍保留 registry entry，因此不受影响。
	m.registry.mu.RLock()
	_, registered := m.registry.agents[agentID]
	m.registry.mu.RUnlock()
	if !registered {
		return
	}
	m.tunnels.mu.Lock()
	m.tunnels.relays[agentID] = health
	m.tunnels.mu.Unlock()
	m.broadcastTunnelState(agentID)
}

// onAgentSessionCleared drops agentID's live visitor streams (their frames can
// no longer be relayed) and pushes an offline snapshot; the specs stay so
// `/t/*` answers 503 instead of 404 and clients keep rendering the tunnels as
// offline. Streams and tunnels of other agents are untouched.
func (m *Manager) onAgentSessionCleared(agentID string) {
	agentID = strings.TrimSpace(agentID)
	m.tunnels.mu.Lock()
	for streamID, stream := range m.tunnels.streams {
		if stream.agentID != agentID {
			continue
		}
		delete(m.tunnels.streams, streamID)
		if record := m.tunnels.records[stream.tunnelID]; record != nil && record.activeConnections > 0 {
			record.activeConnections -= 1
		}
		stream.close()
	}
	delete(m.tunnels.relays, agentID)
	m.tunnels.mu.Unlock()
	m.broadcastTunnelState(agentID)
	// Managed-process subscribers re-render with agent_online=false.
	m.rebroadcastManagedProcessState(agentID)
	// /ws clients learn the agent went offline by push, not by poll.
	m.broadcastStatus(agentID)
}

// purgeAgentTunnels 仅用于永久删除 Agent：普通断线继续保留 specs，删除则同步
// 移除公开 slug、记录、访问流、探测状态和 relay 状态，使旧 /t/* 立即变为 404。
func (m *Manager) purgeAgentTunnels(agentID string) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return
	}
	var canceled []*tunnelStream
	m.tunnels.mu.Lock()
	for _, record := range m.tunnels.records {
		if record.agentID == agentID {
			canceled = append(canceled, m.dropTunnelRecordLocked(record)...)
		}
	}
	delete(m.tunnels.relays, agentID)
	m.tunnels.mu.Unlock()

	m.tunnels.pingMu.Lock()
	for pingID, pending := range m.tunnels.pendingPings {
		if pending.agentID != agentID {
			continue
		}
		delete(m.tunnels.pendingPings, pingID)
		select {
		case pending.ch <- 0:
		default:
		}
	}
	m.tunnels.pingMu.Unlock()

	m.cancelTunnelStreams(canceled)
	m.broadcastTunnelState(agentID)
}

func (m *Manager) tunnelExpirySweepLoop() {
	ticker := time.NewTicker(tunnelExpirySweepPeriod)
	defer ticker.Stop()
	for range ticker.C {
		m.sweepExpiredTunnels(time.Now())
	}
}

func (m *Manager) sweepExpiredTunnels(now time.Time) {
	var canceled []*tunnelStream
	affectedAgentIDs := make(map[string]struct{})
	m.tunnels.mu.Lock()
	for _, record := range m.tunnels.records {
		if record.expiresAt.IsZero() || record.expiresAt.After(now) {
			continue
		}
		affectedAgentIDs[record.agentID] = struct{}{}
		canceled = append(canceled, m.dropTunnelRecordLocked(record)...)
	}
	m.tunnels.mu.Unlock()

	if len(affectedAgentIDs) == 0 {
		return
	}
	m.cancelTunnelStreams(canceled)
	for agentID := range affectedAgentIDs {
		m.broadcastTunnelState(agentID)
	}
}

func cloneTunnelHealth(health *gatewayv2.TunnelHealth) *gatewayv2.TunnelHealth {
	if health == nil {
		return nil
	}
	return &gatewayv2.TunnelHealth{
		Status:     health.GetStatus(),
		HttpStatus: health.GetHttpStatus(),
		Error:      health.GetError(),
		CheckedAt:  health.GetCheckedAt(),
		RttMs:      health.GetRttMs(),
	}
}

func unixOrZero(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.Unix()
}
