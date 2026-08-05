import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentToolCall,
  createRecordingContext,
  createSubagentHarness,
  sleep,
} from "./harness.mjs";

function contextMessageText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

test("readonly happy path: identity prompts, filtered child tools, SendMessage attached", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        {
          id: "reviewer-a",
          prompt: "Inspect the implementation for obvious issues.",
          name: "Code Reviewer",
          role: "Review code paths",
          identity: "Prefer concrete defects over style nits.",
        },
      ],
    }),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "subagent_batch");
  assert.equal(result.details.status, "ok");
  assert.equal(result.details.agentCount, 1);
  assert.equal(result.details.mode, "readonly");
  const report = result.details.agents[0];
  assert.equal(report.id, "reviewer-a");
  assert.equal(report.name, "Code Reviewer");
  assert.equal(report.status, "completed");
  assert.match(report.runId, /^call-agent:agent:1:reviewer-a:/);
  assert.match(report.summary, /report:1/);
  assert.match(result.content[0].text, /Subagent results: 1 agent\(s\)/);

  assert.equal(harness.runnerCalls.length, 1);
  const call = harness.runnerCalls[0];
  assert.deepEqual(
    call.tools.map((tool) => tool.name),
    ["Read", "Grep", "mcp_docs_search", "SendMessage"],
  );
  assert.equal(call.sessionId, "parent-session:subagent:reviewer-a");
  assert.equal(call.workdir, "/tmp/liveagent-subagent-test");
  assert.match(call.context.systemPrompt, /You are Code Reviewer, a named delegated LiveAgent subagent/);
  assert.match(call.context.systemPrompt, /- Stable id: reviewer-a/);
  assert.match(call.context.systemPrompt, /- Role: Review code paths/);
  assert.match(call.context.systemPrompt, /- Team position: 1 of 1/);
  assert.match(call.context.systemPrompt, /- Execution mode: readonly/);
  assert.match(call.context.systemPrompt, /isolated read-only context/);
  assert.match(call.context.systemPrompt, /Identity instructions:\nPrefer concrete defects over style nits\./);
  assert.match(call.context.systemPrompt, /Use SendMessage for cross-agent messages/);
  const userText = contextMessageText(call.context.messages[0]);
  assert.match(userText, /Delegated agent name: Code Reviewer/);
  assert.match(userText, /Delegated agent id: reviewer-a/);
  assert.match(userText, /Current task:\nInspect the implementation for obvious issues\./);

  // Identity persisted through the injected ipc port.
  const identity = harness.storeIpc.identities.get("conversation-1:reviewer-a");
  assert.equal(identity.name, "Code Reviewer");
  assert.equal(identity.lastMode, "readonly");
  // Final run persisted as completed.
  const finalSave = harness.storeIpc.appliedSaves.at(-1);
  assert.equal(finalSave.run.status, "completed");
  assert.equal(finalSave.run.parentToolCallId, "call-agent");
});

test("Agent tool never appears in child tool selections", async () => {
  const harness = await createSubagentHarness();
  await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "r", prompt: "read stuff" },
        { id: "w", prompt: "write stuff", mode: "worktree" },
      ],
    }),
  );
  assert.equal(harness.runnerCalls.length, 2);
  for (const call of harness.runnerCalls) {
    assert.ok(!call.tools.some((tool) => tool.name === "Agent"));
  }
});

test("SendMessage is not attached and persistence is skipped without a conversation id", async () => {
  const harness = await createSubagentHarness({ conversationId: "" });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "solo", prompt: "just answer" }] }),
  );
  assert.equal(result.isError, false);
  const call = harness.runnerCalls[0];
  assert.ok(!call.tools.some((tool) => tool.name === "SendMessage"));
  assert.match(call.context.systemPrompt, /Use your final report as the communication channel/);
  assert.equal(harness.storeIpc.issuedSaves.length, 0);
  assert.equal(harness.storeIpc.upsertIdentityCount, 0);
});

test("worktree children get fs/shell/memory-ro/mcp tools plus SendMessage", async () => {
  const harness = await createSubagentHarness();
  await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "builder", prompt: "build", mode: "worktree" }] }),
  );
  const call = harness.runnerCalls[0];
  assert.deepEqual(
    call.tools.map((tool) => tool.name),
    ["Read", "Grep", "Write", "Bash", "MemoryManager", "mcp_docs_search", "SendMessage"],
  );
  assert.match(call.context.systemPrompt, /isolated git worktree/);
});

test("concurrency cap bounds parallel runs", async () => {
  const harness = await createSubagentHarness({ runnerDelayMs: 25 });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "a", prompt: "x" },
        { id: "b", prompt: "x" },
        { id: "c", prompt: "x" },
        { id: "d", prompt: "x" },
      ],
      concurrency: 2,
    }),
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.concurrency, 2);
  assert.equal(harness.runnerCalls.length, 4);
  assert.equal(harness.getMaxActiveRuns(), 2);
});

test("two concurrent batches serialize runs for the same stable agent id", async () => {
  const harness = await createSubagentHarness({ runnerDelayMs: 25 });
  const [first, second] = await Promise.all([
    harness.bundle.executeToolCall(
      createAgentToolCall({ agents: [{ id: "same-agent", prompt: "first" }] }, "call-1"),
    ),
    harness.bundle.executeToolCall(
      createAgentToolCall({ agents: [{ id: "same-agent", prompt: "second" }] }, "call-2"),
    ),
  ]);
  assert.equal(first.isError, false);
  assert.equal(second.isError, false);
  assert.equal(harness.runnerCalls.length, 2);
  assert.equal(harness.getMaxActiveRuns(), 1);
});

test("worktree lifecycle: create -> run -> status -> auto apply -> cleanup", async () => {
  const harness = await createSubagentHarness();
  const { context, emittedStatuses } = createRecordingContext(
    createAgentToolCall({
      agents: [{ id: "fixer", prompt: "fix it", mode: "worktree", apply_policy: "auto" }],
    }),
  );
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "fixer", prompt: "fix it", mode: "worktree", apply_policy: "auto" }],
    }),
    undefined,
    context,
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.mode, "worktree");
  assert.equal(harness.worktreeIpc.creates.length, 1);
  const createInput = harness.worktreeIpc.creates[0];
  assert.equal(createInput.workdir, "/tmp/liveagent-subagent-test");
  assert.match(createInput.label, /^parent-session-call-agent-1-fixer$/);

  const worktreeRoot = "/tmp/liveagent-worktrees/parent-session-call-agent-1-fixer";
  // Runner executed inside the worktree workdir with the child registry.
  assert.equal(harness.runnerCalls[0].workdir, worktreeRoot);
  // Status inspected, patch applied back to the parent workdir, then cleanup.
  assert.deepEqual(harness.worktreeIpc.statuses, [
    { worktreeRoot, maxDiffChars: 20000 },
  ]);
  assert.deepEqual(harness.worktreeIpc.applies, [
    { parentWorkdir: "/tmp/liveagent-subagent-test", worktreeRoot },
  ]);
  assert.equal(harness.worktreeIpc.cleanups.length, 1);
  assert.equal(harness.worktreeIpc.cleanups[0].worktreeRoot, worktreeRoot);

  const report = result.details.agents[0];
  assert.equal(report.status, "completed");
  assert.equal(report.changed, true);
  assert.equal(report.applyStatus, "applied");
  assert.equal(report.applyMethod, "git_apply");
  assert.equal(report.appliedToWorkdir, "/tmp/liveagent-subagent-test");
  assert.equal(report.worktreeCleanupStatus, "removed");
  assert.equal(report.worktreeCleanupReason, "applied");
  assert.equal(report.worktreeBranchDeleted, true);
  assert.deepEqual(report.changedPaths, ["src/app.ts", "src/new.ts"]);
  assert.ok(emittedStatuses.some((status) => /Applying worktree changes/.test(status ?? "")));

  const finalSave = harness.storeIpc.appliedSaves.at(-1);
  assert.equal(finalSave.run.worktreeRoot, worktreeRoot);
  assert.equal(finalSave.run.workdir, worktreeRoot);
});

test("explicit apply policy applies when every changed path matches the globs", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        {
          id: "scoped",
          prompt: "edit only src",
          mode: "worktree",
          apply_policy: "explicit",
          allowed_output_paths: ["src/**"],
        },
      ],
    }),
  );
  const report = result.details.agents[0];
  assert.equal(report.applyStatus, "applied");
  assert.deepEqual(report.allowedOutputPaths, ["src/**"]);
  assert.deepEqual(report.candidateArtifacts, []);
  assert.equal(harness.worktreeIpc.applies.length, 1);
  assert.equal(report.worktreeCleanupStatus, "removed");
});

test("explicit apply policy mismatch keeps disallowed paths as candidate artifacts and retains the worktree", async () => {
  const harness = await createSubagentHarness({
    worktreeOptions: {
      status: {
        changed: true,
        status: " M src/app.ts\n M docs/notes.md",
        diffStat: "",
        diff: "",
        diffTruncated: false,
        untrackedFiles: [],
      },
    },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        {
          id: "scoped",
          prompt: "edit only docs",
          mode: "worktree",
          apply_policy: "explicit",
          allowed_output_paths: ["docs/**"],
        },
      ],
    }),
  );
  const report = result.details.agents[0];
  assert.equal(report.applyStatus, "skipped");
  assert.equal(report.applySkippedReason, "explicit_apply_paths_mismatch");
  assert.deepEqual(report.candidateArtifacts, ["src/app.ts"]);
  assert.deepEqual(report.changedPaths, ["docs/notes.md", "src/app.ts"]);
  assert.equal(harness.worktreeIpc.applies.length, 0);
  assert.equal(report.worktreeCleanupStatus, "retained");
  assert.equal(report.worktreeCleanupReason, "unapplied_changes");
  assert.equal(harness.worktreeIpc.cleanups.length, 0);
});

test("apply policy none keeps changes as candidate artifacts and retains the worktree", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "sketcher", prompt: "prototype", mode: "worktree" }],
    }),
  );
  const report = result.details.agents[0];
  assert.equal(report.applyStatus, "skipped");
  assert.equal(report.applySkippedReason, "apply_policy_none");
  assert.deepEqual(report.candidateArtifacts, ["src/app.ts", "src/new.ts"]);
  assert.equal(report.worktreeCleanupStatus, "retained");
  assert.equal(report.worktreeCleanupReason, "unapplied_changes");
  assert.equal(harness.worktreeIpc.applies.length, 0);
  assert.equal(harness.worktreeIpc.cleanups.length, 0);
});

test("apply policy none with a clean worktree cleans up", async () => {
  const harness = await createSubagentHarness({
    worktreeOptions: {
      status: {
        changed: false,
        status: "",
        diffStat: "",
        diff: "",
        diffTruncated: false,
        untrackedFiles: [],
      },
    },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "inspector", prompt: "look only", mode: "worktree" }],
    }),
  );
  const report = result.details.agents[0];
  assert.equal(report.applyStatus, "skipped");
  assert.equal(report.applySkippedReason, "no_changes");
  assert.equal(report.worktreeCleanupStatus, "removed");
  assert.equal(report.worktreeCleanupReason, "no_changes");
  assert.equal(harness.worktreeIpc.cleanups.length, 1);
});

test("retain_worktree keeps an otherwise cleanable worktree", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        {
          id: "keeper",
          prompt: "apply and keep",
          mode: "worktree",
          apply_policy: "auto",
          retain_worktree: true,
        },
      ],
    }),
  );
  const report = result.details.agents[0];
  assert.equal(report.applyStatus, "applied");
  assert.equal(report.worktreeCleanupStatus, "retained");
  assert.equal(report.worktreeCleanupReason, "retain_worktree");
  assert.equal(harness.worktreeIpc.cleanups.length, 0);
});

test("resume reuses the hydrated private context from the store cache", async () => {
  const harness = await createSubagentHarness();
  const first = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "historian", prompt: "study era one" }] }, "call-1"),
  );
  const firstRunId = first.details.agents[0].runId;

  const second = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "historian", prompt: "study era two" }] }, "call-2"),
  );
  assert.equal(second.isError, false);

  assert.equal(harness.runnerCalls.length, 2);
  const resumedContext = harness.runnerCalls[1].context;
  const texts = resumedContext.messages.map(contextMessageText);
  // Prior private context is present: run-1 user prompt and run-1 report.
  assert.ok(texts.some((text) => /study era one/.test(text)));
  assert.ok(texts.some((text) => /report:1/.test(text)));
  // Continuation message appended last.
  const continuation = texts.at(-1);
  assert.match(continuation, /Continue your existing delegated agent session\./);
  assert.match(continuation, new RegExp(`Previous run id: ${firstRunId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(continuation, /Current continuation task: study era two/);
  // Cache hit: resume never needed ipc.loadRun.
  assert.deepEqual(harness.storeIpc.loadRunIds, []);
  // Pre-compaction ran against the resumed context.
  assert.ok(harness.compactionCalls.some((call) => call.phase === "pre"));
  // Resumed session id sticks to the first run's session.
  assert.equal(harness.runnerCalls[1].sessionId, "parent-session:subagent:historian");
});

test("resume falls back to ipc.loadRun when the in-memory cache is cold", async () => {
  const storeIpcOptions = {};
  const first = await createSubagentHarness({ storeIpcOptions });
  await first.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "sage", prompt: "collect wisdom" }] }, "call-1"),
  );
  const runId = first.storeIpc.appliedSaves.at(-1).run.id;

  // Fresh store + bundle over the same durable ipc records (cold LRU).
  const second = await createSubagentHarness({ storeIpc: first.storeIpc });
  const result = await second.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "sage", prompt: "share wisdom" }] }, "call-2"),
  );
  assert.equal(result.isError, false);
  assert.ok(first.storeIpc.loadRunIds.includes(runId));
  const texts = second.runnerCalls[0].context.messages.map(contextMessageText);
  assert.ok(texts.some((text) => /collect wisdom/.test(text)));
  assert.match(texts.at(-1), /Continue your existing delegated agent session\./);
  assert.ok(second.compactionCalls.some((call) => call.phase === "pre"));
});

test("stored context schema version mismatch resumes with a fresh context", async () => {
  const harness = await createSubagentHarness();
  harness.storeIpc.seedIdentity({
    parentConversationId: "conversation-1",
    agentId: "old-timer",
    name: "Old Timer",
    role: "Legacy",
    identityPrompt: "",
    lastMode: "readonly",
    createdAt: 1,
    updatedAt: 2,
  });
  harness.storeIpc.seedRun({
    run: {
      id: "legacy-run",
      parentConversationId: "conversation-1",
      parentToolCallId: "call-old",
      agentId: "old-timer",
      agentIndex: 0,
      agentTotal: 1,
      prompt: "ancient task",
      mode: "readonly",
      status: "completed",
      providerId: "codex",
      model: "gpt-5",
      contextSchemaVersion: 1,
      activeSegmentIndex: 0,
      totalSegmentCount: 1,
      totalMessageCount: 2,
      roundCount: 1,
      toolCallCount: 0,
      compactionCount: 0,
      startedAt: 1,
      updatedAt: 2,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "legacy-segment",
        messagesJson: JSON.stringify([
          { role: "user", content: "ancient task", timestamp: 1 },
        ]),
        messageCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  harness.store.invalidate();
  await harness.store.ready();

  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "old-timer", prompt: "modern task" }] }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(harness.storeIpc.loadRunIds, ["legacy-run"]);
  const texts = harness.runnerCalls[0].context.messages.map(contextMessageText);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Current task:\nmodern task/);
  assert.doesNotMatch(texts[0], /Continue your existing delegated agent session/);
});

test("resume:false starts a fresh private context while reusing the stored identity", async () => {
  const harness = await createSubagentHarness();
  await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "phoenix", prompt: "first life" }] }, "call-1"),
  );
  const upsertsAfterFirst = harness.storeIpc.upsertIdentityCount;

  const result = await harness.bundle.executeToolCall(
    createAgentToolCall(
      { agents: [{ id: "phoenix", prompt: "second life", resume: false }] },
      "call-2",
    ),
  );
  assert.equal(result.isError, false);
  const texts = harness.runnerCalls[1].context.messages.map(contextMessageText);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Current task:\nsecond life/);
  assert.doesNotMatch(texts[0], /first life/);
  // Identity unchanged: same mode, no second upsert.
  assert.equal(harness.storeIpc.upsertIdentityCount, upsertsAfterFirst);
  // Fresh contexts get an isolated session id.
  assert.match(harness.runnerCalls[1].sessionId, /^parent-session:subagent:phoenix:fresh:/);
});

test("resume can upgrade a readonly agent to worktree mode", async () => {
  const harness = await createSubagentHarness();
  await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "learner", prompt: "research it" }] }, "call-1"),
  );
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall(
      { agents: [{ id: "learner", prompt: "now implement it", mode: "worktree" }] },
      "call-2",
    ),
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.agents[0].mode, "worktree");
  assert.equal(harness.worktreeIpc.creates.length, 1);
  const call = harness.runnerCalls[1];
  assert.ok(call.tools.some((tool) => tool.name === "Write"));
  const continuation = contextMessageText(call.context.messages.at(-1));
  assert.match(continuation, /Execution mode changed: readonly -> worktree/);
  // Mode change persists on the identity.
  assert.equal(
    harness.storeIpc.identities.get("conversation-1:learner").lastMode,
    "worktree",
  );
});

test("template prompt and metadata are injected into the system prompt", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "templated", prompt: "review the diff", template: "reviewer" }],
    }),
  );
  assert.equal(result.isError, false);
  const systemPrompt = harness.runnerCalls[0].context.systemPrompt;
  assert.match(systemPrompt, /- Configured template: Reviewer \(reviewer\)/);
  assert.match(systemPrompt, /Configured template instructions:\nFocus on concrete defects\./);
  // Name/role derived from the template when creation fields are omitted.
  assert.equal(result.details.agents[0].name, "Reviewer");
  assert.equal(result.details.agents[0].role, "Review code paths");
  assert.equal(result.details.agents[0].templateId, "reviewer");
});

test("unknown template rejects the batch before any agent starts", async () => {
  const harness = await createSubagentHarness();
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "a", prompt: "ok", template: "does-not-exist" }],
    }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.issues[0].code, "unknown_template");
  assert.match(result.content[0].text, /Enabled templates/);
  assert.equal(harness.runnerCalls.length, 0);
});

test("abort persists a cancelled run and retains the worktree", async () => {
  const harness = await createSubagentHarness({
    runner: (params) =>
      new Promise((_, reject) => {
        const onAbort = () => reject(new Error("Cancelled"));
        if (params.signal?.aborted) return onAbort();
        params.signal?.addEventListener("abort", onAbort, { once: true });
      }),
  });
  const controller = new AbortController();
  const pending = harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "doomed", prompt: "never finishes", mode: "worktree", apply_policy: "auto" }],
    }),
    controller.signal,
  );
  await sleep(20);
  controller.abort();
  const result = await pending;

  assert.equal(result.isError, true);
  const report = result.details.agents[0];
  assert.equal(report.status, "cancelled");
  assert.equal(report.error, "Cancelled");
  assert.equal(report.applyStatus, "skipped");
  assert.equal(report.applySkippedReason, "agent_cancelled");
  assert.equal(report.worktreeCleanupStatus, "retained");
  assert.equal(harness.worktreeIpc.applies.length, 0);
  assert.equal(harness.worktreeIpc.cleanups.length, 0);

  const finalSave = harness.storeIpc.appliedSaves.at(-1);
  assert.equal(finalSave.run.status, "cancelled");
  assert.equal(finalSave.run.error, "Cancelled");
});

test("failed runs keep their worktree", async () => {
  const harness = await createSubagentHarness({ runnerError: new Error("model exploded") });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [{ id: "unlucky", prompt: "try", mode: "worktree", apply_policy: "auto" }],
    }),
  );
  assert.equal(result.isError, true);
  const report = result.details.agents[0];
  assert.equal(report.status, "failed");
  assert.equal(report.error, "model exploded");
  assert.equal(report.applySkippedReason, "agent_failed");
  assert.equal(report.worktreeCleanupStatus, "retained");
  assert.equal(harness.worktreeIpc.cleanups.length, 0);
  assert.equal(harness.storeIpc.appliedSaves.at(-1).run.status, "failed");
});

test("child tool gating rejects tools outside the selected registry", async () => {
  const harness = await createSubagentHarness({
    runnerToolCalls: [
      { type: "toolCall", id: "call-read", name: "Read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "call-write", name: "Write", arguments: { path: "a.ts" } },
    ],
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "gated", prompt: "read only" }] }),
  );
  assert.equal(result.isError, false);
  // Read went through the base executor; Write was rejected before execution.
  assert.deepEqual(
    harness.executedBaseToolCalls.map((toolCall) => toolCall.name),
    ["Read"],
  );
  const call = harness.runnerCalls[0];
  const writeResult = await call.executeToolCall({
    type: "toolCall",
    id: "call-write-2",
    name: "Write",
    arguments: {},
  });
  assert.equal(writeResult.isError, true);
  assert.match(
    writeResult.content[0].text,
    /Tool Write is not available to delegated subagents in mode=readonly/,
  );
});

test("identity upsert failure yields a provision_failed report without running the agent", async () => {
  const harness = await createSubagentHarness({
    storeIpcOptions: { upsertIdentityError: new Error("sqlite locked") },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({ agents: [{ id: "ghost", prompt: "never provisioned" }] }),
  );
  assert.equal(result.isError, true);
  const report = result.details.agents[0];
  assert.equal(report.status, "failed");
  assert.match(report.error, /^provision_failed: sqlite locked/);
  assert.equal(harness.runnerCalls.length, 0);
  assert.equal(harness.worktreeIpc.creates.length, 0);
  assert.equal(harness.storeIpc.issuedSaves.length, 0);
});

test("per-agent cards stream through the execution context with stable synthetic ids", async () => {
  const harness = await createSubagentHarness();
  const parentToolCall = createAgentToolCall({
    agents: [
      { id: "alpha", prompt: "研究 A" },
      { id: "beta", prompt: "实现 B", mode: "worktree", apply_policy: "auto" },
    ],
    concurrency: 2,
  });
  const recording = createRecordingContext(parentToolCall);
  const result = await harness.bundle.executeToolCall(
    parentToolCall,
    undefined,
    recording.context,
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.mode, "mixed");

  assert.deepEqual(
    recording.emittedToolCalls.map((toolCall) => toolCall.id).sort(),
    ["call-agent:agent:1", "call-agent:agent:2"],
  );
  for (const toolCall of recording.emittedToolCalls) {
    assert.equal(toolCall.name, "Agent");
    assert.equal(toolCall.arguments.subagent_card, true);
    assert.equal(toolCall.arguments.parent_tool_call_id, "call-agent");
    assert.equal(toolCall.arguments.total, 2);
  }
  assert.equal(recording.emittedExecutionStarts.length, 2);
  assert.equal(recording.emittedToolResults.length, 2);
  for (const { toolCall, toolResult } of recording.emittedToolResults) {
    assert.equal(toolResult.toolCallId, toolCall.id);
    assert.equal(toolResult.details.kind, "subagent_card");
    assert.equal(toolResult.details.parentToolCallId, "call-agent");
    assert.equal(toolResult.details.agent.status, "completed");
    assert.equal(toolResult.isError, false);
  }
});

test("batch result is an error when any agent did not complete", async () => {
  let invocation = 0;
  const harness = await createSubagentHarness({
    runner: async (params) => {
      invocation += 1;
      if (contextMessageText(params.context.messages[0]).includes("will fail")) {
        throw new Error("half broken");
      }
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: `ok:${invocation}` }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        stopReason: "stop",
        timestamp: Date.now(),
      };
      params.onTurnStart?.(1);
      return { assistant, messages: [assistant], emittedMessages: [assistant] };
    },
  });
  const result = await harness.bundle.executeToolCall(
    createAgentToolCall({
      agents: [
        { id: "ok-agent", prompt: "will pass" },
        { id: "bad-agent", prompt: "will fail" },
      ],
    }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.status, "ok");
  const statuses = Object.fromEntries(
    result.details.agents.map((agent) => [agent.id, agent.status]),
  );
  assert.deepEqual(statuses, { "ok-agent": "completed", "bad-agent": "failed" });
});
