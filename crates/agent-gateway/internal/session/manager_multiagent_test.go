package session

import (
	"context"
	"errors"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func newTestSession(m *Manager, agentID, sessionID string) *AgentSession {
	auth := m.RecordAuthentication(agentID, "v-test", sessionID)
	return NewAgentSession(auth)
}

func TestMultiAgentSessionsCoexist(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })

	if !m.IsOnline("agent-a") || !m.IsOnline("agent-b") {
		t.Fatalf("both agents should be online: a=%v b=%v", m.IsOnline("agent-a"), m.IsOnline("agent-b"))
	}
	if ids := m.ConnectedAgentIDs(); len(ids) != 2 || ids[0] != "agent-a" || ids[1] != "agent-b" {
		t.Fatalf("connected ids = %v, want [agent-a agent-b]", ids)
	}

	// 定向发送只命中目标 Agent 的出站队列。
	env := &gatewayv2.GatewayEnvelope{RequestId: "to-b"}
	go func() { _ = m.SendToAgentContext(context.Background(), "agent-b", env) }()
	select {
	case outbound := <-b.Outbound():
		if outbound.GetRequestId() != "to-b" {
			t.Fatalf("agent-b outbound = %q", outbound.GetRequestId())
		}
		outbound.Ack(nil)
	case <-a.Outbound():
		t.Fatal("request targeted at agent-b was delivered to agent-a")
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for targeted delivery")
	}
}

func TestSetSessionDisplacesOnlySameAgentID(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a1")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b1")
	m.SetSession(b)

	// 同 id 重连：顶掉 agent-a 的旧会话，agent-b 不受影响。
	a2 := newTestSession(m, "agent-a", "session-a2")
	m.SetSession(a2)
	t.Cleanup(func() { m.ClearSession(a2); m.ClearSession(b) })

	select {
	case <-a.Done():
	case <-time.After(time.Second):
		t.Fatal("displaced agent-a session was not closed")
	}
	select {
	case <-b.Done():
		t.Fatal("agent-b session must survive agent-a displacement")
	default:
	}
	if status := m.Status("agent-a"); !status.Online || status.SessionID != "session-a2" {
		t.Fatalf("agent-a status = %#v, want online session-a2", status)
	}
}

func TestHeartbeatEvictionIsScopedToSession(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	b.LastPing = time.Now().Add(-time.Hour)
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a) })

	if !m.ClearSessionIfHeartbeatStale(b, time.Minute) {
		t.Fatal("stale agent-b session should be evicted")
	}
	if m.ClearSessionIfHeartbeatStale(a, time.Minute) {
		t.Fatal("fresh agent-a session must not be evicted")
	}
	if !m.IsOnline("agent-a") || m.IsOnline("agent-b") {
		t.Fatalf("after eviction: a=%v b=%v, want a online, b offline", m.IsOnline("agent-a"), m.IsOnline("agent-b"))
	}
}

func TestEmptyAgentIDIsAlwaysRejected(t *testing.T) {
	m := NewManager()
	assertRequired := func(stage string) {
		t.Helper()
		if err := m.SendToAgentContext(context.Background(), "", &gatewayv2.GatewayEnvelope{}); !errors.Is(err, ErrAgentIDRequired) {
			t.Fatalf("%s: err = %v, want ErrAgentIDRequired", stage, err)
		}
	}

	assertRequired("no agents")
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	assertRequired("one agent")
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	t.Cleanup(func() { m.ClearSession(a); m.ClearSession(b) })
	assertRequired("two agents")

	go func() {
		outbound := <-b.Outbound()
		outbound.Ack(nil)
	}()
	if err := m.SendToAgentContext(context.Background(), "agent-b", &gatewayv2.GatewayEnvelope{RequestId: "explicit"}); err != nil {
		t.Fatalf("explicit target: err = %v", err)
	}
}

func TestGlobalOnlineCheckDoesNotActAsAgentAddressing(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)

	if !m.AnyAgentOnline() {
		t.Fatal("AnyAgentOnline should report the connected Agent")
	}
	if m.IsOnline("") {
		t.Fatal("IsOnline with an empty id must not act as a global query")
	}
	if status := m.Status(""); status != (Status{}) {
		t.Fatalf("empty-id status = %#v, want zero value", status)
	}

	m.ClearSession(a)
	if m.AnyAgentOnline() {
		t.Fatal("AnyAgentOnline should be false after disconnect")
	}
}

func TestDisconnectAgentKicksLiveSession(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)

	if !m.DisconnectAgent("agent-a") {
		t.Fatal("DisconnectAgent should report a kicked session")
	}
	select {
	case <-a.Done():
	case <-time.After(time.Second):
		t.Fatal("disconnected session was not closed")
	}
	if m.IsOnline("agent-a") {
		t.Fatal("agent-a should be offline after DisconnectAgent")
	}
	if m.DisconnectAgent("agent-a") {
		t.Fatal("second DisconnectAgent should be a no-op")
	}
}

func TestSetAuthenticatedSessionRejectsStaleCredentialWithoutDirectoryEntry(t *testing.T) {
	m := NewManager()
	sess := NewAgentSession(AuthSnapshot{
		AgentID:      "agent-a",
		AgentVersion: "v-test",
		SessionID:    "stale-session",
	})

	if m.SetAuthenticatedSessionIfCurrent(sess, func() bool { return false }) {
		t.Fatal("stale authentication must not register a session")
	}
	select {
	case <-sess.Done():
	default:
		t.Fatal("rejected session must be closed")
	}
	if m.IsOnline("agent-a") || len(m.AgentStatuses()) != 0 {
		t.Fatalf("stale authentication left a directory entry: %#v", m.AgentStatuses())
	}
}

func TestRegisterTerminalStreamRejectsStaleCredentialWithoutDirectoryEntry(t *testing.T) {
	m := NewManager()
	toAgent := make(chan *gatewayv2.TerminalStreamFrame, 1)
	revoked := make(chan struct{})
	cleanup, ok := m.RegisterTerminalStreamToAgentIfCurrent(
		"agent-a",
		toAgent,
		func() { close(revoked) },
		func() bool { return false },
	)
	defer cleanup()
	if ok {
		t.Fatal("stale authentication must not register a terminal stream")
	}
	if len(m.AgentStatuses()) != 0 {
		t.Fatalf("stale terminal authentication left a directory entry: %#v", m.AgentStatuses())
	}
	select {
	case <-revoked:
		t.Fatal("a connection that was never registered must not be revoked by the manager")
	default:
	}
}

func TestDisconnectAgentRevokesControlAndTerminalTransports(t *testing.T) {
	m := NewManager()
	sess := newTestSession(m, "agent-a", "session-a")
	m.SetSession(sess)
	terminalRevoked := make(chan struct{})
	cleanup, ok := m.RegisterTerminalStreamToAgentIfCurrent(
		"agent-a",
		make(chan *gatewayv2.TerminalStreamFrame, 1),
		func() { close(terminalRevoked) },
		func() bool { return true },
	)
	defer cleanup()
	if !ok {
		t.Fatal("terminal stream registration failed")
	}

	if !m.DisconnectAgent("agent-a") {
		t.Fatal("disconnect must report the revoked transports")
	}
	select {
	case <-sess.Done():
	case <-time.After(time.Second):
		t.Fatal("control session was not closed")
	}
	select {
	case <-terminalRevoked:
	case <-time.After(time.Second):
		t.Fatal("terminal transport was not revoked")
	}
	if m.DisconnectAgent("agent-a") {
		t.Fatal("second disconnect must be a no-op")
	}
}

func TestTerminalReconnectCleanupDoesNotClearReplacement(t *testing.T) {
	m := NewManager()
	firstRevoked := make(chan struct{})
	first := make(chan *gatewayv2.TerminalStreamFrame, 1)
	firstCleanup, ok := m.RegisterTerminalStreamToAgentIfCurrent(
		"agent-a", first, func() { close(firstRevoked) }, func() bool { return true },
	)
	if !ok {
		t.Fatal("first terminal registration failed")
	}
	second := make(chan *gatewayv2.TerminalStreamFrame, 1)
	secondCleanup, ok := m.RegisterTerminalStreamToAgentIfCurrent(
		"agent-a", second, func() {}, func() bool { return true },
	)
	defer secondCleanup()
	if !ok {
		t.Fatal("replacement terminal registration failed")
	}
	select {
	case <-firstRevoked:
	case <-time.After(time.Second):
		t.Fatal("replacement did not revoke the old terminal transport")
	}

	firstCleanup()
	frame := &gatewayv2.TerminalStreamFrame{Kind: "attach"}
	if err := m.SendTerminalFrameToAgent(context.Background(), "agent-a", frame); err != nil {
		t.Fatalf("send to replacement terminal: %v", err)
	}
	select {
	case got := <-second:
		if got != frame {
			t.Fatalf("replacement received %#v, want original frame", got)
		}
	case <-time.After(time.Second):
		t.Fatal("old cleanup cleared the replacement terminal stream")
	}
}

func TestAgentStatusesIncludesOfflineEntries(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	m.ClearSession(b)
	t.Cleanup(func() { m.ClearSession(a) })

	statuses := m.AgentStatuses()
	if len(statuses) != 2 {
		t.Fatalf("statuses = %d entries, want 2", len(statuses))
	}
	// 断线 entry 保留（目录渲染离线 Agent），按 id 排序。
	if statuses[0].AgentID != "agent-a" || !statuses[0].Online {
		t.Fatalf("statuses[0] = %#v, want online agent-a", statuses[0])
	}
	if statuses[1].AgentID != "agent-b" || statuses[1].Online {
		t.Fatalf("statuses[1] = %#v, want offline agent-b", statuses[1])
	}
}

func TestAgentDirectoryStatusSnapshotIndexesWithoutDroppingOfflineAgents(t *testing.T) {
	m := NewManager()
	a := newTestSession(m, "agent-a", "session-a")
	m.SetSession(a)
	b := newTestSession(m, "agent-b", "session-b")
	m.SetSession(b)
	m.ClearSession(b)
	t.Cleanup(func() { m.ClearSession(a) })

	statuses, onlineAgentIDs := m.AgentDirectoryStatusSnapshot()
	if len(statuses) != 2 || !statuses["agent-a"].Online || statuses["agent-b"].Online {
		t.Fatalf("status snapshot = %#v", statuses)
	}
	if len(onlineAgentIDs) != 1 || onlineAgentIDs[0] != "agent-a" {
		t.Fatalf("online ids = %#v", onlineAgentIDs)
	}
}
