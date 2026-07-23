package session

import (
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func newTunnelTestManager(t *testing.T) *Manager {
	t.Helper()
	m := NewManager()
	m.SetSession(NewAgentSession(AuthSnapshot{AgentID: "test-agent"}))
	return m
}

func desiredState(specs ...*gatewayv2.TunnelSpec) *gatewayv2.TunnelDesiredState {
	return &gatewayv2.TunnelDesiredState{Tunnels: specs}
}

func findTunnelStatus(snapshot *gatewayv2.TunnelStateSnapshot, id string) *gatewayv2.TunnelStatus {
	for _, tunnel := range snapshot.GetTunnels() {
		if tunnel.GetId() == id {
			return tunnel
		}
	}
	return nil
}

func TestApplyDesiredStateAddUpdateRemove(t *testing.T) {
	m := newTunnelTestManager(t)

	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000", Name: "a"},
		&gatewayv2.TunnelSpec{Id: "tun-b", TargetUrl: "http://localhost:4000"},
	))
	snapshot := m.TunnelStateSnapshot("test-agent")
	if len(snapshot.GetTunnels()) != 2 {
		t.Fatalf("tunnels = %d, want 2", len(snapshot.GetTunnels()))
	}
	statusA := findTunnelStatus(snapshot, "tun-a")
	if statusA == nil || statusA.GetSlug() == "" {
		t.Fatalf("tun-a missing or has no slug: %#v", statusA)
	}
	if statusA.GetPublicPath() != "/t/"+statusA.GetSlug()+"/" {
		t.Fatalf("public path = %q", statusA.GetPublicPath())
	}
	slugA := statusA.GetSlug()

	// Update keeps the allocated slug; removal drops the record.
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3001", Name: "renamed"},
	))
	snapshot = m.TunnelStateSnapshot("test-agent")
	if len(snapshot.GetTunnels()) != 1 {
		t.Fatalf("tunnels after removal = %d, want 1", len(snapshot.GetTunnels()))
	}
	statusA = findTunnelStatus(snapshot, "tun-a")
	if statusA.GetSlug() != slugA {
		t.Fatalf("slug changed across update: %q -> %q", slugA, statusA.GetSlug())
	}
	if statusA.GetTargetUrl() != "http://localhost:3001" || statusA.GetName() != "renamed" {
		t.Fatalf("update not applied: %#v", statusA)
	}
}

func TestApplyDesiredStateHonorsSlugHintAndCollision(t *testing.T) {
	m := newTunnelTestManager(t)
	hint := strings.Repeat("a", 32)

	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000", SlugHint: hint},
		&gatewayv2.TunnelSpec{Id: "tun-b", TargetUrl: "http://localhost:4000", SlugHint: hint},
	))
	snapshot := m.TunnelStateSnapshot("test-agent")
	statusA := findTunnelStatus(snapshot, "tun-a")
	statusB := findTunnelStatus(snapshot, "tun-b")
	if statusA.GetSlug() != hint {
		t.Fatalf("tun-a slug = %q, want hint %q", statusA.GetSlug(), hint)
	}
	if statusB.GetSlug() == hint || statusB.GetSlug() == "" {
		t.Fatalf("tun-b slug should be freshly allocated, got %q", statusB.GetSlug())
	}

	// Invalid hints are ignored.
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-c", TargetUrl: "http://localhost:5000", SlugHint: "short"},
	))
	statusC := findTunnelStatus(m.TunnelStateSnapshot("test-agent"), "tun-c")
	if statusC.GetSlug() == "short" {
		t.Fatal("invalid slug hint must not be honored")
	}
}

func TestApplyDesiredStateEnforcesTunnelCap(t *testing.T) {
	m := newTunnelTestManager(t)
	specs := make([]*gatewayv2.TunnelSpec, 0, maxTunnelsPerAgent+2)
	for i := 0; i < maxTunnelsPerAgent+2; i++ {
		specs = append(specs, &gatewayv2.TunnelSpec{
			Id:        "tun-" + string(rune('a'+i)),
			TargetUrl: "http://localhost:3000",
		})
	}
	m.ApplyDesiredState("test-agent", desiredState(specs...))
	if got := len(m.TunnelStateSnapshot("test-agent").GetTunnels()); got != maxTunnelsPerAgent {
		t.Fatalf("tunnels = %d, want cap %d", got, maxTunnelsPerAgent)
	}
}

func TestApplyDesiredStateSkipsExpiredAndInvalidSpecs(t *testing.T) {
	m := newTunnelTestManager(t)
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "expired", TargetUrl: "http://localhost:3000", ExpiresAt: time.Now().Add(-time.Minute).Unix()},
		&gatewayv2.TunnelSpec{Id: "", TargetUrl: "http://localhost:3000"},
		&gatewayv2.TunnelSpec{Id: "no-target"},
		&gatewayv2.TunnelSpec{Id: "ok", TargetUrl: "http://localhost:3000"},
	))
	snapshot := m.TunnelStateSnapshot("test-agent")
	if len(snapshot.GetTunnels()) != 1 || findTunnelStatus(snapshot, "ok") == nil {
		t.Fatalf("snapshot = %#v, want only \"ok\"", snapshot.GetTunnels())
	}
}

func TestSnapshotRevisionIsMonotonic(t *testing.T) {
	m := newTunnelTestManager(t)
	first := m.TunnelStateSnapshot("test-agent").GetRevision()
	second := m.TunnelStateSnapshot("test-agent").GetRevision()
	if second <= first {
		t.Fatalf("revision not monotonic: %d then %d", first, second)
	}
}

func TestAcquireTunnelLifecycleAndLimits(t *testing.T) {
	m := newTunnelTestManager(t)
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000"},
	))
	slug := m.TunnelStateSnapshot("test-agent").GetTunnels()[0].GetSlug()

	if _, err := m.AcquireTunnel("missing", "s-1"); err != ErrTunnelNotFound {
		t.Fatalf("acquire missing = %v, want ErrTunnelNotFound", err)
	}

	leases := make([]*TunnelStreamLease, 0, maxTunnelConnections)
	for i := 0; i < maxTunnelConnections; i++ {
		lease, err := m.AcquireTunnel(slug, "s-"+string(rune('a'+i)))
		if err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
		leases = append(leases, lease)
	}
	if _, err := m.AcquireTunnel(slug, "s-over"); err != ErrTunnelOverLimit {
		t.Fatalf("over-limit acquire = %v, want ErrTunnelOverLimit", err)
	}
	if got := m.TunnelStateSnapshot("test-agent").GetTunnels()[0].GetActiveConnections(); got != maxTunnelConnections {
		t.Fatalf("active connections = %d, want %d", got, maxTunnelConnections)
	}
	for _, lease := range leases {
		lease.Release()
	}
	if got := m.TunnelStateSnapshot("test-agent").GetTunnels()[0].GetActiveConnections(); got != 0 {
		t.Fatalf("active connections after release = %d, want 0", got)
	}

	if lease, err := m.AcquireTunnel(slug, "s-again"); err != nil {
		t.Fatalf("re-acquire after release: %v", err)
	} else {
		if lease.TargetURL() != "http://localhost:3000" {
			t.Fatalf("lease target = %q", lease.TargetURL())
		}
		lease.Release()
	}

	m.ClearSession(mustCurrentSession(t, m))
	if _, err := m.AcquireTunnel(slug, "s-offline"); err != ErrAgentOffline {
		t.Fatalf("offline acquire = %v, want ErrAgentOffline", err)
	}
}

func mustCurrentSession(t *testing.T, m *Manager) *AgentSession {
	t.Helper()
	session, err := m.resolveSession("test-agent")
	if err != nil {
		t.Fatalf("resolve current agent session: %v", err)
	}
	return session
}

func TestDispatchTunnelFrameDropsStreamWhenBacklogged(t *testing.T) {
	m := newTunnelTestManager(t)
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000"},
	))
	slug := m.TunnelStateSnapshot("test-agent").GetTunnels()[0].GetSlug()
	lease, err := m.AcquireTunnel(slug, "s-backlog")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer lease.Release()

	for i := 0; i < tunnelStreamChannelDepth+1; i++ {
		m.dispatchTunnelFrame("test-agent", &gatewayv2.TunnelFrame{
			StreamId: "s-backlog",
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY,
		})
	}
	select {
	case <-lease.Done():
	case <-time.After(time.Second):
		t.Fatal("backlogged stream was not closed")
	}
}

func TestSweepExpiredTunnelsRemovesRecords(t *testing.T) {
	m := newTunnelTestManager(t)
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "short", TargetUrl: "http://localhost:3000", ExpiresAt: time.Now().Add(30 * time.Second).Unix()},
		&gatewayv2.TunnelSpec{Id: "forever", TargetUrl: "http://localhost:4000"},
	))
	if got := len(m.TunnelStateSnapshot("test-agent").GetTunnels()); got != 2 {
		t.Fatalf("tunnels = %d, want 2", got)
	}
	m.sweepExpiredTunnels(time.Now().Add(2 * time.Minute))
	snapshot := m.TunnelStateSnapshot("test-agent")
	if len(snapshot.GetTunnels()) != 1 || findTunnelStatus(snapshot, "forever") == nil {
		t.Fatalf("after sweep = %#v, want only \"forever\"", snapshot.GetTunnels())
	}
}

func TestOnAgentSessionClearedClosesStreamsAndMarksOffline(t *testing.T) {
	m := newTunnelTestManager(t)
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000"},
	))
	slug := m.TunnelStateSnapshot("test-agent").GetTunnels()[0].GetSlug()
	lease, err := m.AcquireTunnel(slug, "s-1")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}

	m.ClearSession(mustCurrentSession(t, m))
	select {
	case <-lease.Done():
	case <-time.After(time.Second):
		t.Fatal("stream not closed after agent session cleared")
	}
	snapshot := m.TunnelStateSnapshot("test-agent")
	if snapshot.GetAgentOnline() {
		t.Fatal("snapshot still reports agent online")
	}
	if len(snapshot.GetTunnels()) != 1 {
		t.Fatalf("specs must survive agent disconnect, got %d", len(snapshot.GetTunnels()))
	}
}

func TestForgetAgentPurgesOfflineTunnelRecordsAndRoutes(t *testing.T) {
	m := newTunnelTestManager(t)
	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000"},
	))
	slug := m.TunnelStateSnapshot("test-agent").GetTunnels()[0].GetSlug()

	// 普通断线保留 spec；随后永久删除即使 Agent 已离线，也必须删除公开路由。
	m.ClearSession(mustCurrentSession(t, m))
	if got := len(m.TunnelStateSnapshot("test-agent").GetTunnels()); got != 1 {
		t.Fatalf("offline tunnel count = %d, want preserved spec", got)
	}
	if disconnected := m.ForgetAgent("test-agent"); disconnected {
		t.Fatal("offline agent deletion must not report a disconnected live session")
	}
	if got := len(m.TunnelStateSnapshot("test-agent").GetTunnels()); got != 0 {
		t.Fatalf("deleted agent tunnel count = %d, want 0", got)
	}
	if _, err := m.AcquireTunnel(slug, "after-delete"); err != ErrTunnelNotFound {
		t.Fatalf("acquire deleted route = %v, want ErrTunnelNotFound", err)
	}
	m.setRelayHealth("test-agent", &gatewayv2.TunnelHealth{Status: "late"})
	m.tunnels.mu.Lock()
	_, relayRestored := m.tunnels.relays["test-agent"]
	m.tunnels.mu.Unlock()
	if relayRestored {
		t.Fatal("late relay probe must not restore deleted agent state")
	}
}

func TestSubscribeTunnelStateReceivesBroadcasts(t *testing.T) {
	m := newTunnelTestManager(t)
	ch, cleanup := m.SubscribeTunnelState()
	defer cleanup()

	m.ApplyDesiredState("test-agent", desiredState(
		&gatewayv2.TunnelSpec{Id: "tun-a", TargetUrl: "http://localhost:3000"},
	))

	select {
	case tagged := <-ch:
		if tagged.AgentID != "test-agent" || findTunnelStatus(tagged.Event, "tun-a") == nil {
			t.Fatalf("broadcast snapshot = %#v, want test-agent/tun-a", tagged)
		}
	case <-time.After(time.Second):
		t.Fatal("no tunnel.state broadcast received")
	}
}
