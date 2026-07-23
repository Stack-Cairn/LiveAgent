package session

import (
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// newWorkspaceTestManager builds a manager with a live session. SetSession
// replays the watch set only when it is non-empty, so no async push races the
// assertions below: every push comes from a synchronous subscribe/unsubscribe
// call.
func newWorkspaceTestManager(t *testing.T) (*Manager, *AgentSession) {
	t.Helper()
	m := NewManager()
	session := NewAgentSession(AuthSnapshot{AgentID: "test-agent"})
	m.SetSession(session)
	assertNoWorkspaceWatchPush(t, session)
	return m, session
}

// awaitWorkspaceWatchSet blocks until the next WorkspaceWatchRequest reaches
// the agent outbound queue and returns its workdir set.
func awaitWorkspaceWatchSet(t *testing.T, session *AgentSession) []string {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case env := <-session.Outbound():
			if watch := env.GetWorkspaceWatch(); watch != nil {
				return watch.GetWorkdirs()
			}
		case <-deadline:
			t.Fatal("timed out waiting for a workspace watch push")
			return nil
		}
	}
}

// assertNoWorkspaceWatchPush fails when a WorkspaceWatchRequest is already
// queued on the agent outbound channel.
func assertNoWorkspaceWatchPush(t *testing.T, session *AgentSession) {
	t.Helper()
	for {
		select {
		case env := <-session.Outbound():
			if watch := env.GetWorkspaceWatch(); watch != nil {
				t.Fatalf("unexpected workspace watch push: %v", watch.GetWorkdirs())
			}
		default:
			return
		}
	}
}

func workspaceActivityEvent(workdir string, revision uint64) *gatewayv2.WorkspaceActivityEvent {
	return &gatewayv2.WorkspaceActivityEvent{
		Workdir:  workdir,
		Revision: revision,
		Fs:       true,
		Git:      true,
	}
}

func TestSubscribeWorkspaceActivityPushesWatchSetWithRefcount(t *testing.T) {
	m, session := newWorkspaceTestManager(t)

	_, cleanupA1 := m.SubscribeWorkspaceActivity("test-agent", "/repo/a")
	if set := awaitWorkspaceWatchSet(t, session); len(set) != 1 || set[0] != "/repo/a" {
		t.Fatalf("watch set after first subscribe = %v, want [/repo/a]", set)
	}

	// Second subscriber on the same workdir must not re-push the set.
	_, cleanupA2 := m.SubscribeWorkspaceActivity("test-agent", "/repo/a")
	assertNoWorkspaceWatchPush(t, session)

	_, cleanupB := m.SubscribeWorkspaceActivity("test-agent", "/repo/b")
	set := awaitWorkspaceWatchSet(t, session)
	if len(set) != 2 || set[0] != "/repo/a" || set[1] != "/repo/b" {
		t.Fatalf("watch set after second workdir = %v, want [/repo/a /repo/b]", set)
	}

	// Dropping one of two /repo/a subscribers keeps the workdir watched.
	cleanupA1()
	assertNoWorkspaceWatchPush(t, session)

	// Cleanup is idempotent: replaying it must not decrement again.
	cleanupA1()
	assertNoWorkspaceWatchPush(t, session)

	// The last /repo/a subscriber leaving removes the key.
	cleanupA2()
	if set := awaitWorkspaceWatchSet(t, session); len(set) != 1 || set[0] != "/repo/b" {
		t.Fatalf("watch set after refcount reached zero = %v, want [/repo/b]", set)
	}

	cleanupB()
	if set := awaitWorkspaceWatchSet(t, session); len(set) != 0 {
		t.Fatalf("watch set after last unsubscribe = %v, want []", set)
	}
}

func TestSetSessionReplaysNonEmptyWorkspaceActivityWatchSet(t *testing.T) {
	m, session := newWorkspaceTestManager(t)

	_, cleanup := m.SubscribeWorkspaceActivity("test-agent", "/repo/a")
	defer cleanup()
	if set := awaitWorkspaceWatchSet(t, session); len(set) != 1 || set[0] != "/repo/a" {
		t.Fatalf("watch set after subscribe = %v, want [/repo/a]", set)
	}

	// A reconnected agent starts blank and must learn the watch set again.
	replacement := NewAgentSession(AuthSnapshot{AgentID: "test-agent"})
	m.SetSession(replacement)
	if set := awaitWorkspaceWatchSet(t, replacement); len(set) != 1 || set[0] != "/repo/a" {
		t.Fatalf("replayed watch set = %v, want [/repo/a]", set)
	}
}

func TestBroadcastWorkspaceActivityFiltersByWorkdir(t *testing.T) {
	m, _ := newWorkspaceTestManager(t)

	eventsA, cleanupA := m.SubscribeWorkspaceActivity("test-agent", "/repo/a")
	defer cleanupA()
	eventsB, cleanupB := m.SubscribeWorkspaceActivity("test-agent", "/repo/b")
	defer cleanupB()

	m.broadcastWorkspaceActivity("test-agent", workspaceActivityEvent("/repo/a", 1))
	m.broadcastWorkspaceActivity("test-agent", workspaceActivityEvent("/repo/missing", 2))

	select {
	case event := <-eventsA:
		if event.GetWorkdir() != "/repo/a" || event.GetRevision() != 1 {
			t.Fatalf("unexpected event on /repo/a subscriber: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber for /repo/a did not receive its event")
	}

	select {
	case event := <-eventsA:
		t.Fatalf("subscriber for /repo/a received foreign event: %#v", event)
	case event := <-eventsB:
		t.Fatalf("subscriber for /repo/b received foreign event: %#v", event)
	default:
	}
}

func TestBroadcastWorkspaceActivityDoesNotBlockOnSlowSubscriber(t *testing.T) {
	m, _ := newWorkspaceTestManager(t)

	// Never read from the channel: once its buffer is full, broadcasts must
	// drop instead of blocking.
	_, cleanup := m.SubscribeWorkspaceActivity("test-agent", "/repo/a")
	defer cleanup()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < workspaceActivityChannelDepth*3; i++ {
			m.broadcastWorkspaceActivity("test-agent", workspaceActivityEvent("/repo/a", uint64(i+1)))
		}
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcastWorkspaceActivity blocked on a slow subscriber")
	}
}

func TestBroadcastWorkspaceActivityIgnoresNilAndEmptyWorkdir(t *testing.T) {
	m, _ := newWorkspaceTestManager(t)

	events, cleanup := m.SubscribeWorkspaceActivity("test-agent", "/repo/a")
	defer cleanup()

	m.broadcastWorkspaceActivity("test-agent", nil)
	m.broadcastWorkspaceActivity("test-agent", workspaceActivityEvent("   ", 1))

	select {
	case event := <-events:
		t.Fatalf("unexpected event delivered: %#v", event)
	default:
	}
}
