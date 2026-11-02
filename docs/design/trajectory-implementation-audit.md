# LiveAgent Trajectory Integration Audit

## Scope

This audit covers only the current LiveAgent worktree changes that integrate the trajectory
experience inspired by `deepseek-harness/packages/client/ui-trajectory`. The reference project is
used for information architecture and interaction design; LiveAgent owns a different runtime,
persistence, history-pagination, edit-resend, subagent, desktop and Gateway architecture, so its
implementation is intentionally native rather than a source copy.

## Reference-to-LiveAgent mapping

| DeepSeek Harness concern | LiveAgent implementation |
|---|---|
| trajectory rows and record kinds | `crates/agent-ui/src/lib/trajectory/types.ts`, `layout.ts` |
| event convergence | `crates/agent-ui/src/lib/trajectory/eventLog.ts` |
| system prompt snapshots and diffs | `sections.ts`, trajectory detail tabs |
| timeline / lanes / zoom | `timeline.ts`, `timelineViewport.ts`, `TrajectoryTimeline.tsx`, `useTimelineGestures.ts` |
| search and collapse | `searchIndex.ts`, `displayItems.ts`, `TrajectoryToolbar.tsx` |
| detail drawer | `components/trajectory/details/` |
| current-run instrumentation | `agent-gui/src/lib/trajectory/`, `runAgentConversationTurn.ts` |
| durable storage | `chat_history/trajectory.rs`, `trajectory_window.rs` |
| edit-resend and branch lifecycle | `trajectory_lifecycle.rs`, history `replace.rs` / `branch.rs` |
| subagent expansion | `trajectory_subagents.rs`, `subagentRuns.ts` |
| desktop live view | `agent-gui/src/lib/trajectory/liveTrajectory.ts`, `ChatPage.tsx` |
| Gateway live view and reconnect | Gateway ChatEvent split, Web live store, `TrajectoryHost.subscribeRefresh` |
| shared GUI/WebUI presentation | `@liveagent/ui` trajectory components and host contract |

## Resolved correctness gaps

### Database migration

The history database now has an explicit schema v3 migration. A pre-existing v2 database receives
`trajectory_json`, `trajectory_truncated`, and `chatTrajectorySection`; this is covered by a real
v2-to-v3 migration test rather than only fresh-database tests.

### Absolute turn and content alignment

Persisted trajectory events carry stable user message identity and the absolute message index.
Transcript conversion preserves `HistoryMessageRef.messageId/messageIndex`. Content indexing first
anchors turns by stable message id, then uses absolute message index, and only falls back to local
walk order for legacy data. Loading a tail window therefore no longer maps a real high-numbered
turn to local Turn 1.

### Event identity and ordering

The ledger is idempotent across persisted/live replay, independent of arrival order, and pairs tool
end events with starts. Visual record IDs include semantic event identity, preventing same-millisecond
CONTEXT or USER rows from sharing React/business keys. Selection is stored by stable `recordId`, not
by the index that shifts when earlier pages are prepended.

### Desktop and Gateway live convergence

Desktop recorder events enter a bounded per-conversation live store. The shared view combines them
with the durable window and deduplicates at the ledger. Web trajectory events split from the chat
stream before the transcript cursor can discard replayed frames. Reconnect triggers a durable-window
reconciliation. Edit-resend/rebase clears invalid live suffixes and increments an authoritative
revision so both desktop and WebUI replace their tail from SQLite.

### Compaction lifecycle

All successful, failed and aborted compactions close their trajectory interval. Abort cleanup clears
observer token state, so a later compaction cannot inherit stale `tokensBefore/tokensAfter` values.
Manual, pre-send, mid-stream and post-tool paths all use the controller observer.

### Exact request prompt and CONTEXT diagnostics

Prompt storage keeps the six legacy wire slots stable and appends the `runtime` slot. New header
events declare format v2. The System Prompt detail tab renders the actual composition order:
`base -> agent -> skills -> memory -> runtime -> toolsSuffix`; tool catalog remains a separate slot.
Runtime roster, parent bus and task-state fragments are captured only for the context actually sent
to a provider, not for pre-compaction budget estimation. Those fragments also emit bounded CONTEXT
rows.

### Timing and model attribution

The first assistant-side output can be text, thinking, hosted search or a tool call; all paths close
TTFT exactly once. Step completion uses the winning assistant message's provider/model/API metadata,
so a failover round is attributed to the provider that actually completed it.

### Subagents, file links and resource bounds

The view gathers referenced subagent run IDs and requests only missing runs instead of loading the
latest arbitrary 64 runs. Subtool rows are derived from those durable runs. Attachment source blocks
carry an openable path and use the host file-link callback. Desktop and Web live stores enforce
per-conversation, global-event and conversation-count bounds.

### Failure isolation

Trajectory instrumentation is diagnostic and cannot break chat generation. Persistence batches are
serialized per conversation, retry failed writes, keep the segment captured at emission time, and
preserve corrupt stored JSON while setting the truncated marker. Oversized event/section payloads
fail closed and surface an incomplete-data banner.

## Compatibility behavior

- Existing conversations without trajectory events are reconstructed structurally from messages.
- Degraded conversations never invent duration, TTFT or throughput.
- Legacy six-slot headers are padded with a trailing runtime slot; existing tools suffix and catalog
  indexes are not reinterpreted.
- Missing or corrupt individual segments/runs degrade locally and mark the view incomplete.
- Branch and edit-resend copy/retain only the trajectory prefix that belongs to retained messages,
  then prune unreferenced prompt sections.

## Verification

The machine-readable result is `docs/design/trajectory-release-gate.json`; the readable table is
`docs/design/trajectory-release-gate.md`; raw logs are under
`/tmp/liveagent-trajectory-final-gate/`. The gate distinguishes code failures from unavailable
external tooling or dependency-network failures.

## Residual non-blocking constraints

The trajectory remains a diagnostics view, not the source of truth for conversation content. Large
assistant/tool bodies stay in the existing transcript storage and are joined at render time. A
headless build/start smoke can validate generated Web assets, but interactive desktop rendering,
pointer gestures and OS file opening still require a graphical manual session on a supported host.
