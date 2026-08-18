import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const { createConversationRuntimeRegistry } = loader.loadModule(
  "src/pages/chat/conversations/createConversationRuntimeRegistry.ts",
);
const { createConversationSurfaceController } = loader.loadModule(
  "src/pages/chat/conversations/createConversationSurfaceController.ts",
);
const { setConversationRuntimeCacheEntry } = loader.loadModule(
  "src/pages/chat/runtime/chatPageRuntime.ts",
);
const { createTextComposerDraft } = loader.loadModule("@liveagent/ui/lib/chat/composerDraft.ts");
const { answerToolApproval, requestToolApproval } = loader.loadModule(
  "src/lib/tools/toolApproval.ts",
);
const { assertConversationPaneHarnessSpecs } = loader.loadModule(
  "src/pages/chat/workbench/conversationPaneHarnessModel.ts",
);

function conversationPane(paneId, conversationId, projectId = "project-main") {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: {
        projectId,
        projectPathKey: `/workspace/${projectId}`,
      },
    },
    view: {},
  };
}

function conversationPaneHarnessSpec(paneId, conversationId) {
  return {
    paneId,
    conversationId,
    project: {
      projectId: `project-${conversationId}`,
      projectPathKey: `/workspace/${conversationId}`,
    },
  };
}

function twoPaneLayout() {
  const first = conversationPane("pane-a", "conversation-a");
  const second = conversationPane("pane-b", "conversation-b");
  return {
    schemaVersion: workbench.WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 3,
    root: {
      type: "split",
      splitId: "split-root",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: first.paneId },
      second: { type: "leaf", paneId: second.paneId },
    },
    panes: {
      [first.paneId]: first,
      [second.paneId]: second,
    },
    focusedPaneId: first.paneId,
  };
}

function issueCodes(layout) {
  return workbench.collectWorkbenchLayoutIssues(layout).map((item) => item.code);
}

function runtimeEntry(conversationId, isSending = false) {
  return {
    state: { id: conversationId },
    compactionStatus: { phase: "idle" },
    isSending,
    errorMessage: null,
    hookWarning: null,
    sessionId: `${conversationId}-session`,
    createdAt: 1,
  };
}

function uploadedFile(fileName) {
  return {
    relativePath: `uploads/${fileName}`,
    fileName,
    kind: "text",
    sizeBytes: 12,
  };
}

function queuedTurn(conversationId, id) {
  return {
    id,
    conversationId,
    draft: createTextComposerDraft(`queued-${id}`),
    uploadedFiles: [],
    executionMode: "tools",
    workdir: `/workspace/${conversationId}`,
    runtimeControls: {},
    createdAt: 1,
  };
}

function controllerActions(events) {
  return {
    async hydrate(input) {
      events.push(["hydrate", input.conversationId]);
    },
    async send(input) {
      events.push(["send", input.conversationId, input.draft.text]);
    },
    stop(input) {
      events.push(["stop", input.conversationId]);
    },
    async compact(input) {
      events.push(["compact", input.conversationId]);
    },
    async retry(input) {
      events.push(["retry", input.conversationId]);
    },
  };
}

function surfaceController(registry, conversationId, events = []) {
  return createConversationSurfaceController({
    conversationId,
    project: {
      projectId: `project-${conversationId}`,
      projectPathKey: `/workspace/${conversationId}`,
    },
    registry,
    actions: controllerActions(events),
  });
}

test("session workbench feature flag defaults to enabled with env opt-out", () => {
  // GA 默认开启:未设置 / 空串走默认。
  assert.deepEqual(workbench.createSessionWorkbenchFeature(undefined), { enabled: true });
  assert.deepEqual(workbench.createSessionWorkbenchFeature(""), { enabled: true });
  // 显式关闭是回退旧单 Pane 路径的逃生开关。
  assert.deepEqual(workbench.createSessionWorkbenchFeature("0"), { enabled: false });
  assert.deepEqual(workbench.createSessionWorkbenchFeature("false"), { enabled: false });
  assert.deepEqual(workbench.createSessionWorkbenchFeature(" true "), { enabled: true });
  assert.deepEqual(workbench.createSessionWorkbenchFeature("1"), { enabled: true });
});

test("empty and two-conversation workbench layouts satisfy the frozen contract", () => {
  const empty = workbench.createEmptyWorkbenchLayout();
  const split = twoPaneLayout();

  assert.equal(workbench.isWorkbenchLayoutValid(empty), true);
  assert.equal(workbench.isWorkbenchLayoutValid(split), true);
  assert.doesNotThrow(() => workbench.assertWorkbenchLayout(split));
  assert.equal(workbench.findPaneIdByConversationId(split, "conversation-b"), "pane-b");
});

test("the same conversation cannot own two editable panes", () => {
  const layout = twoPaneLayout();
  layout.panes["pane-b"].surface.conversationId = "conversation-a";

  assert.deepEqual(issueCodes(layout), ["duplicate-conversation"]);
  assert.throws(
    () => workbench.assertWorkbenchLayout(layout),
    (error) =>
      error.name === "WorkbenchLayoutInvariantError" &&
      error.issues.some((item) => item.code === "duplicate-conversation"),
  );
});

test("pane records and tree leaves must have a one-to-one relationship", () => {
  const layout = twoPaneLayout();
  layout.root.second.paneId = "pane-missing";

  assert.deepEqual(issueCodes(layout), ["missing-pane-record", "orphan-pane-record"]);
});

test("non-empty layouts require a valid focused pane", () => {
  const missingFocus = twoPaneLayout();
  missingFocus.focusedPaneId = null;
  const unknownFocus = twoPaneLayout();
  unknownFocus.focusedPaneId = "pane-missing";

  assert.deepEqual(issueCodes(missingFocus), ["invalid-focus"]);
  assert.deepEqual(issueCodes(unknownFocus), ["invalid-focus"]);
});

test("empty layouts cannot retain panes or focus", () => {
  const layout = workbench.createEmptyWorkbenchLayout();
  layout.panes["pane-a"] = conversationPane("pane-a", "conversation-a");
  layout.focusedPaneId = "pane-a";

  assert.deepEqual(issueCodes(layout), ["invalid-empty-layout"]);
});

test("split ids, ratios, schema versions, and revisions are validated", () => {
  const layout = twoPaneLayout();
  layout.schemaVersion += 1;
  layout.revision = -1;
  layout.root.splitId = "";
  layout.root.ratio = 1;

  assert.deepEqual(issueCodes(layout), [
    "invalid-schema-version",
    "invalid-revision",
    "duplicate-split-id",
    "invalid-ratio",
  ]);
});

test("revision guard rejects stale drag transactions before mutation", () => {
  const layout = twoPaneLayout();

  assert.equal(workbench.getWorkbenchRevisionError(layout, 3), null);
  assert.deepEqual(workbench.getWorkbenchRevisionError(layout, 2), {
    code: "stale-revision",
    message: "Workbench revision changed from 2 to 3.",
    currentRevision: 3,
  });
});

test("two-pane harness requires distinct stable pane and conversation identities", () => {
  const first = conversationPaneHarnessSpec("pane-a", "conversation-a");
  const second = conversationPaneHarnessSpec("pane-b", "conversation-b");

  assert.doesNotThrow(() => assertConversationPaneHarnessSpecs([first, second]));
  assert.throws(
    () =>
      assertConversationPaneHarnessSpecs([
        first,
        conversationPaneHarnessSpec("pane-a", "conversation-b"),
      ]),
    /duplicate pane id/,
  );
  assert.throws(
    () =>
      assertConversationPaneHarnessSpecs([
        first,
        conversationPaneHarnessSpec("pane-b", "conversation-a"),
      ]),
    /cannot mount one editable conversation twice/,
  );
});

test("runtime registry subscriptions stay isolated by conversation id", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
    ["conversation-b", runtimeEntry("conversation-b")],
  ]);
  const events = [];
  const unsubscribeA = registry.subscribe("conversation-a", () => events.push("a"));
  const unsubscribeB = registry.subscribe("conversation-b", () => events.push("b"));

  setConversationRuntimeCacheEntry(
    registry,
    "conversation-a",
    runtimeEntry("conversation-a", true),
  );

  assert.deepEqual(events, ["a"]);
  assert.equal(registry.getSnapshot("conversation-a").isSending, true);
  assert.equal(registry.getSnapshot("conversation-b").isSending, false);
  unsubscribeA();
  unsubscribeB();
});

test("runtime registry preserves runtime state after the last view is released", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a", true)],
  ]);
  const releaseFirst = registry.retainView("conversation-a");
  const releaseSecond = registry.retainView("conversation-a");

  assert.equal(registry.getViewCount("conversation-a"), 2);
  releaseFirst();
  releaseFirst();
  releaseSecond();

  assert.equal(registry.getViewCount("conversation-a"), 0);
  assert.equal(registry.getSnapshot("conversation-a").isSending, true);
});

test("deleting one runtime notifies only its subscribers", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
    ["conversation-b", runtimeEntry("conversation-b")],
  ]);
  const events = [];
  registry.subscribe("conversation-a", () => events.push("a"));
  registry.subscribe("conversation-b", () => events.push("b"));

  registry.delete("conversation-b");

  assert.deepEqual(events, ["b"]);
  assert.equal(registry.getSnapshot("conversation-a").sessionId, "conversation-a-session");
  assert.equal(registry.getSnapshot("conversation-b"), null);
});

test("two surface controllers isolate runtime and composer draft snapshots", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
    ["conversation-b", runtimeEntry("conversation-b")],
  ]);
  const controllerA = surfaceController(registry, "conversation-a");
  const controllerB = surfaceController(registry, "conversation-b");
  const events = [];
  controllerA.subscribe(() => events.push("a"));
  controllerB.subscribe(() => events.push("b"));

  controllerB.setDraft(createTextComposerDraft("draft-b"));
  setConversationRuntimeCacheEntry(
    registry,
    "conversation-a",
    runtimeEntry("conversation-a", true),
  );

  assert.deepEqual(events, ["b", "a"]);
  assert.equal(controllerA.getSnapshot().runtime.isSending, true);
  assert.equal(controllerA.getSnapshot().draft, null);
  assert.equal(controllerB.getSnapshot().runtime.isSending, false);
  assert.equal(controllerB.getSnapshot().draft.text, "draft-b");
});

test("two surface controllers isolate upload and queue snapshots", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
    ["conversation-b", runtimeEntry("conversation-b")],
  ]);
  const controllerA = surfaceController(registry, "conversation-a");
  const controllerB = surfaceController(registry, "conversation-b");
  const events = [];
  controllerA.subscribe(() => events.push("a"));
  controllerB.subscribe(() => events.push("b"));

  registry.uploads.set("conversation-a", [uploadedFile("a.txt")]);
  registry.queue.set([queuedTurn("conversation-b", "queue-b")]);

  assert.deepEqual(events, ["a", "b"]);
  assert.deepEqual(
    controllerA.getSnapshot().uploads.map((item) => item.fileName),
    ["a.txt"],
  );
  assert.deepEqual(controllerA.getSnapshot().queue, []);
  assert.deepEqual(controllerB.getSnapshot().uploads, []);
  assert.deepEqual(
    controllerB.getSnapshot().queue.map((item) => item.id),
    ["queue-b"],
  );
});

test("conversation queue store preserves global order and emits only changed slices", () => {
  const registry = createConversationRuntimeRegistry();
  const events = [];
  registry.queue.subscribe("conversation-a", () => events.push("a"));
  registry.queue.subscribe("conversation-b", () => events.push("b"));
  const firstA = queuedTurn("conversation-a", "queue-a-1");
  const firstB = queuedTurn("conversation-b", "queue-b-1");
  const secondA = queuedTurn("conversation-a", "queue-a-2");

  registry.queue.set([firstA, firstB, secondA]);
  registry.queue.set([firstA, secondA, firstB]);
  registry.queue.set([secondA, firstA, firstB]);

  assert.deepEqual(events, ["a", "b", "a"]);
  assert.deepEqual(
    registry.queue.getAllSnapshot().map((item) => item.id),
    ["queue-a-2", "queue-a-1", "queue-b-1"],
  );
  assert.deepEqual(
    registry.queue.getSnapshot("conversation-a").map((item) => item.id),
    ["queue-a-2", "queue-a-1"],
  );
  assert.deepEqual(
    registry.queue.getSnapshot("conversation-b").map((item) => item.id),
    ["queue-b-1"],
  );
});

test("two surface controllers isolate approval snapshots", async () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
    ["conversation-b", runtimeEntry("conversation-b")],
  ]);
  const controllerA = surfaceController(registry, "conversation-a");
  const controllerB = surfaceController(registry, "conversation-b");
  const events = [];
  controllerA.subscribe(() => events.push("a"));
  controllerB.subscribe(() => events.push("b"));

  const settlement = requestToolApproval({
    toolCallId: "approval-a",
    toolName: "Bash",
    summary: "pnpm test",
    conversationId: "conversation-a",
    timeoutMs: 10_000,
  });

  assert.deepEqual(events, ["a"]);
  assert.deepEqual(
    controllerA.getSnapshot().approvals.map((item) => item.toolCallId),
    ["approval-a"],
  );
  assert.deepEqual(controllerB.getSnapshot().approvals, []);

  assert.equal(
    answerToolApproval("approval-a", "deny", { conversationId: "conversation-a" }).ok,
    true,
  );
  assert.deepEqual(await settlement, { kind: "decided", decision: "deny" });
  assert.deepEqual(events, ["a", "a"]);
});

test("two surface controllers isolate model and compaction slices", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
    ["conversation-b", runtimeEntry("conversation-b")],
  ]);
  const controllerA = surfaceController(registry, "conversation-a");
  const controllerB = surfaceController(registry, "conversation-b");
  const events = [];
  controllerA.subscribe(() => events.push("a"));
  controllerB.subscribe(() => events.push("b"));
  const selectedModel = { customProviderId: "provider-a", model: "model-a" };
  const compaction = {
    phase: "running",
    trigger: "manual",
    startedAt: 2,
    sourceSegmentIndex: 1,
  };

  setConversationRuntimeCacheEntry(registry, "conversation-a", {
    ...runtimeEntry("conversation-a"),
    selectedModel,
    compactionStatus: compaction,
  });

  assert.deepEqual(events, ["a"]);
  assert.equal(controllerA.getSnapshot().model, selectedModel);
  assert.equal(controllerA.getSnapshot().compaction, compaction);
  assert.equal(controllerB.getSnapshot().model, null);
  assert.deepEqual(controllerB.getSnapshot().compaction, { phase: "idle" });
});

test("surface controller actions always route through their bound conversation id", async () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
  ]);
  const events = [];
  const controller = surfaceController(registry, "conversation-a", events);
  const draft = createTextComposerDraft("send-a");

  await controller.hydrate();
  await controller.send(draft);
  controller.stop();
  await controller.compact();
  await controller.retry();

  assert.deepEqual(events, [
    ["hydrate", "conversation-a"],
    ["send", "conversation-a", "send-a"],
    ["stop", "conversation-a"],
    ["compact", "conversation-a"],
    ["retry", "conversation-a"],
  ]);
});

test("deleting a conversation clears runtime and draft in one controller update", () => {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a")],
  ]);
  const controller = surfaceController(registry, "conversation-a");
  controller.setDraft(createTextComposerDraft("draft-a"));
  const snapshots = [];
  controller.subscribe(() => snapshots.push(controller.getSnapshot()));

  registry.delete("conversation-a");

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].runtime, null);
  assert.equal(snapshots[0].draft, null);
  assert.equal(registry.drafts.getSnapshot("conversation-a"), null);
});

test("deleting a draft-only conversation does not leave an orphaned composer slice", () => {
  const registry = createConversationRuntimeRegistry();
  registry.drafts.set("conversation-draft", createTextComposerDraft("draft-only"));

  assert.equal(registry.delete("conversation-draft"), true);
  assert.equal(registry.drafts.getSnapshot("conversation-draft"), null);
});
