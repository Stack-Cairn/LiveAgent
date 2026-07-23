package session

import (
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func runReport(runID string, conversationID string, state string) *gatewayv2.ChatRunReport {
	return &gatewayv2.ChatRunReport{
		RunId:          runID,
		ConversationId: conversationID,
		State:          state,
	}
}

func runsReport(
	active []*gatewayv2.ChatRunReport,
	finished []*gatewayv2.ChatRunReport,
) *gatewayv2.RuntimeStatusEvent {
	return &gatewayv2.RuntimeStatusEvent{
		ActiveRunCount: uint32(len(active)),
		ActiveRuns:     active,
		FinishedRuns:   finished,
	}
}

func lastEvent(t *testing.T, m *Manager, conversationID string) *ConversationEvent {
	t.Helper()
	sub := m.SubscribeConversationStream(conversationTestAgentID, conversationID, 0, "")
	sub.Cleanup()
	if len(sub.Events) == 0 {
		t.Fatalf("no events for %s", conversationID)
	}
	return sub.Events[len(sub.Events)-1]
}

// A terminal the gateway never received (lost desktop signal) is adopted from
// the desktop's finished_runs report with its real final state.
func TestRunReportAdoptsMissedTerminal(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))

	m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, []*gatewayv2.ChatRunReport{
		runReport("run-1", "conv-1", "completed"),
	}), time.Now())

	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished || last.Payload["status"] != "completed" {
		t.Fatalf("adopted terminal = %s %#v, want run_finished/completed", last.Type, last.Payload)
	}
	if last.Payload["reason"] != "desktop_reported" {
		t.Fatalf("adopted terminal reason = %#v, want desktop_reported", last.Payload["reason"])
	}
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("activity not cleared after adopted terminal, activities=%d", len(activities))
	}

	// A finished report with an unknown state is not trusted verbatim: the
	// run fails with desktop_run_lost instead.
	m2 := NewManager()
	m2.ingestChatControl(conversationTestAgentID, "run-2", startedControl("run-2", "conv-2"))
	m2.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, []*gatewayv2.ChatRunReport{
		runReport("run-2", "conv-2", "exploded"),
	}), time.Now())
	last2 := lastEvent(t, m2, "conv-2")
	if last2.Type != StreamEventRunFinished ||
		last2.Payload["status"] != "failed" ||
		last2.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("invalid-state terminal = %s %#v, want failed/desktop_run_lost", last2.Type, last2.Payload)
	}
}

// A run absent from the desktop's reports survives the grace window (measured
// from the last vouch/transition), then is finalized as lost; a vouch before
// expiry restarts the window.
func TestRunReportFinalizesLostRunAfterGrace(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	t0 := time.Now()
	empty := runsReport(nil, nil)

	m.convStreams.onRuntimeStatus(conversationTestAgentID, empty, t0.Add(8*time.Second))
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("run finalized below grace, activities=%d", len(activities))
	}

	m.convStreams.onRuntimeStatus(conversationTestAgentID, empty, t0.Add(16*time.Second))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("lost run not finalized after grace, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished ||
		last.Payload["status"] != "failed" ||
		last.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("lost finish tail = %s %#v, want failed/desktop_run_lost", last.Type, last.Payload)
	}

	// Reported active again before grace expiry: the run survives and the
	// absence window restarts from the vouch.
	m2 := NewManager()
	m2.ingestChatControl(conversationTestAgentID, "run-2", startedControl("run-2", "conv-2"))
	t1 := time.Now()
	m2.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport([]*gatewayv2.ChatRunReport{
		runReport("run-2", "conv-2", "running"),
	}, nil), t1.Add(8*time.Second))
	m2.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, nil), t1.Add(20*time.Second))
	if activities := m2.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("grace window must restart after a vouch, activities=%d", len(activities))
	}
}

// A loss the desktop merely inferred (ledger sweep starved while the webview
// was throttled) must not kill a run whose events still flow through the
// relay; once the events go quiet past the grace window it is adopted.
func TestInferredLossNotAdoptedWhileEventsFlow(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "hello"))

	lost := runReport("run-1", "conv-1", "failed")
	lost.ErrorCode = "desktop_run_lost"
	lost.Message = "The desktop runtime stopped reporting this run."
	report := runsReport(nil, []*gatewayv2.ChatRunReport{lost})

	m.convStreams.onRuntimeStatus(conversationTestAgentID, report, time.Now())
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("inferred loss adopted despite fresh events, activities=%d", len(activities))
	}

	m.convStreams.onRuntimeStatus(conversationTestAgentID, report, time.Now().Add(16*time.Second))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("inferred loss not adopted after events went quiet, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished || last.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("quiet-adopted tail = %s %#v, want failed/desktop_run_lost", last.Type, last.Payload)
	}
}

// The desktop ledger flushes inferred losses as failed control events too; the
// conversation's active run ignores that verdict while its events are fresh. A
// genuine failure the run produced always terminates it.
func TestInferredFailedControlIgnoredWhileEventsFlow(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "hello"))

	m.ingestChatControl(conversationTestAgentID, "run-1", &gatewayv2.ChatControlEvent{
		RequestId:      "run-1",
		ConversationId: "conv-1",
		Type:           "failed",
		ErrorCode:      "desktop_run_lost",
		Message:        "The desktop runtime stopped reporting this run.",
	})
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("inferred failed control killed a streaming run, activities=%d", len(activities))
	}

	m.ingestChatControl(conversationTestAgentID, "run-1", &gatewayv2.ChatControlEvent{
		RequestId:      "run-1",
		ConversationId: "conv-1",
		Type:           "failed",
		ErrorCode:      "provider_error",
		Message:        "boom",
	})
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("genuine failure must terminate the run, activities=%d", len(activities))
	}
}

// A wrongly-lost run resurrects when its events resume: the finished set
// releases it, activity returns, the stream is marked snapshot-hungry so
// subscribers rebuild the tail, and repeats of the stale verdict are ignored
// until the genuine terminal arrives.
func TestChatEventResurrectsInferredLostRun(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, nil), time.Now().Add(16*time.Second))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("precondition: run not finalized as lost, activities=%d", len(activities))
	}

	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "still alive"))

	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-1" {
		t.Fatalf("run not resurrected by its own event, activities=%#v", activities)
	}
	stream := m.convStreams.streams[conversationStreamKey(conversationTestAgentID, "conv-1")]
	if stream == nil || !stream.snapshotDirty || !stream.runNeedsSnapshot {
		t.Fatalf("resurrection must mark the stream snapshot-hungry")
	}
	sub := m.SubscribeConversationStream(conversationTestAgentID, "conv-1", 0, "")
	sub.Cleanup()
	if len(sub.Events) < 2 {
		t.Fatalf("expected restart + token events, got %d", len(sub.Events))
	}
	tail := sub.Events[len(sub.Events)-2:]
	if tail[0].Type != StreamEventRunStarted || tail[1].Type != "token" {
		t.Fatalf("resurrection tail = %s,%s, want run_started,token", tail[0].Type, tail[1].Type)
	}

	// The desktop ledger may keep repeating the stale verdict; a revived run
	// ignores it (the reaper stays the backstop for a genuinely dead run).
	lost := runReport("run-1", "conv-1", "failed")
	lost.ErrorCode = "desktop_run_lost"
	m.convStreams.onRuntimeStatus(
		conversationTestAgentID,
		runsReport(nil, []*gatewayv2.ChatRunReport{lost}),
		time.Now().Add(time.Hour),
	)
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("revived run must ignore stale loss verdicts, activities=%d", len(activities))
	}

	// The genuine terminal still settles it.
	m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1"))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("genuine done must settle a revived run, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished || last.Payload["status"] != "completed" {
		t.Fatalf("final tail = %s %#v, want run_finished/completed", last.Type, last.Payload)
	}
}

func TestAuthoritativeTerminalCorrectsInferredLostRun(t *testing.T) {
	tests := []struct {
		name       string
		finish     func(*Manager)
		wantStatus string
	}{
		{
			name: "done event",
			finish: func(m *Manager) {
				m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1"))
			},
			wantStatus: "completed",
		},
		{
			name: "error event",
			finish: func(m *Manager) {
				m.ingestChatEvent(conversationTestAgentID, "run-1", &gatewayv2.ChatEvent{
					Type:           gatewayv2.ChatEvent_ERROR,
					ConversationId: "conv-1",
					Data:           `{"message":"provider failed"}`,
				})
			},
			wantStatus: "failed",
		},
		{
			name: "completed control",
			finish: func(m *Manager) {
				m.ingestChatControl(conversationTestAgentID, "run-1", completedControl("run-1", "conv-1"))
			},
			wantStatus: "completed",
		},
		{
			name: "terminal snapshot",
			finish: func(m *Manager) {
				m.ingestRuntimeSnapshot(conversationTestAgentID, &gatewayv2.ChatRuntimeSnapshot{
					RunId:          "run-1",
					ConversationId: "conv-1",
					State:          "completed",
				})
			},
			wantStatus: "completed",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			m := NewManager()
			m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
			m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, nil), time.Now().Add(16*time.Second))

			test.finish(m)

			last := lastEvent(t, m, "conv-1")
			if last.Type != StreamEventRunFinished || last.Payload["status"] != test.wantStatus {
				t.Fatalf("corrected terminal = %s %#v, want run_finished/%s", last.Type, last.Payload, test.wantStatus)
			}
			if last.Payload["error_code"] == "desktop_run_lost" {
				t.Fatalf("authoritative terminal retained inferred loss: %#v", last.Payload)
			}
			record := m.convStreams.runs[agentScopedKey(conversationTestAgentID, "run-1")]
			if record == nil || record.lostInferred || record.revived {
				t.Fatalf("terminal run flags not settled: %#v", record)
			}
			if activities := m.ActiveConversationActivities(); len(activities) != 0 {
				t.Fatalf("authoritative terminal left activity behind: %#v", activities)
			}
		})
	}
}

// Stragglers after a genuine terminal stay dropped — resurrection applies only
// to inferred losses.
func TestGenuineTerminalStragglersStayDropped(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", doneEvent("conv-1"))
	m.ingestChatEvent(conversationTestAgentID, "run-1", tokenEvent("conv-1", "late"))

	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("straggler resurrected a completed run, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished {
		t.Fatalf("tail after straggler = %s, want run_finished", last.Type)
	}
}

// A reconnect republish of "started" re-anchors a run this store wrongly gave
// up on.
func TestStartedControlResurrectsInferredLostRun(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, nil), time.Now().Add(16*time.Second))

	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-1" {
		t.Fatalf("started republish must resurrect the lost run, activities=%#v", activities)
	}
}

// Queued runs belong to the accepted-command startup watchdog; the desktop may
// not know them yet, so reconcile never finalizes them.
func TestRunReportSkipsQueuedRuns(t *testing.T) {
	m := NewManager()
	m.StartChatCommand(conversationTestAgentID, "run-1", "conv-1", "/workspace", "client-1", []map[string]any{
		{"type": "user_message", "message": "hello"},
	})

	t0 := time.Now()
	m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, nil), t0)
	m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport(nil, nil), t0.Add(time.Hour))

	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].State != RunActivityQueued {
		t.Fatalf("queued run must survive reconcile, activities=%#v", activities)
	}
}

// Liveness is per run: a vouched run keeps streaming while an absent run in
// another conversation is finalized at grace.
func TestRunReportPerConversationLiveness(t *testing.T) {
	m := NewManager()
	m.ingestChatControl(conversationTestAgentID, "run-a", startedControl("run-a", "conv-a"))
	m.ingestChatControl(conversationTestAgentID, "run-b", startedControl("run-b", "conv-b"))
	t0 := time.Now()
	vouchA := runsReport([]*gatewayv2.ChatRunReport{
		runReport("run-a", "conv-a", "running"),
	}, nil)

	m.convStreams.onRuntimeStatus(conversationTestAgentID, vouchA, t0)
	m.convStreams.onRuntimeStatus(conversationTestAgentID, vouchA, t0.Add(16*time.Second))

	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-a" {
		t.Fatalf("vouched run must outlive the lost one, activities=%#v", activities)
	}
	last := lastEvent(t, m, "conv-b")
	if last.Type != StreamEventRunFinished || last.Payload["error_code"] != "desktop_run_lost" {
		t.Fatalf("conv-b tail = %s %#v, want failed/desktop_run_lost", last.Type, last.Payload)
	}
}

// The reaper is per run too: a report vouching only for another conversation
// must not shield a run the desktop stopped vouching for.
func TestReaperSparesOnlyVouchedRuns(t *testing.T) {
	m := NewManager()
	m.convStreams.staleRunTimeout = 10 * time.Millisecond
	m.SetSession(&AgentSession{
		AgentID: conversationTestAgentID,
		toAgent: make(chan *OutboundEnvelope, 1),
		done:    make(chan struct{}),
		streams: make(map[string]*agentStream),
	})

	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	time.Sleep(20 * time.Millisecond)

	m.ingestChatControl(conversationTestAgentID, "run-other", startedControl("run-other", "conv-other"))
	m.convStreams.onRuntimeStatus(conversationTestAgentID, runsReport([]*gatewayv2.ChatRunReport{
		runReport("run-other", "conv-other", "running"),
	}, nil), time.Now())

	m.convStreams.reap(time.Now())
	activities := m.ActiveConversationActivities()
	if len(activities) != 1 || activities[0].RunID != "run-other" {
		t.Fatalf("unvouched run must be reaped, activities=%#v", activities)
	}
}

// Offline runs are not immortal: past offlineRunTimeout they finalize as
// agent_offline; below it they are kept.
func TestReaperFinalizesRunsAfterOfflineTimeout(t *testing.T) {
	m := NewManager() // no session: isOnline() == false
	m.ingestChatControl(conversationTestAgentID, "run-1", startedControl("run-1", "conv-1"))
	t0 := time.Now()

	m.convStreams.reap(t0.Add(29 * time.Minute))
	if activities := m.ActiveConversationActivities(); len(activities) != 1 {
		t.Fatalf("run below offline timeout must be kept, activities=%d", len(activities))
	}

	m.convStreams.reap(t0.Add(31 * time.Minute))
	if activities := m.ActiveConversationActivities(); len(activities) != 0 {
		t.Fatalf("run beyond offline timeout must be finalized, activities=%d", len(activities))
	}
	last := lastEvent(t, m, "conv-1")
	if last.Type != StreamEventRunFinished ||
		last.Payload["status"] != "failed" ||
		last.Payload["error_code"] != "agent_offline" {
		t.Fatalf("offline finish tail = %s %#v, want failed/agent_offline", last.Type, last.Payload)
	}
}
