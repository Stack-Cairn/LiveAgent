import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createConversationRuntimeRegistry } = loader.loadModule(
  "src/pages/chat/conversations/createConversationRuntimeRegistry.ts",
);
const { createConversationSurfaceController } = loader.loadModule(
  "src/pages/chat/conversations/createConversationSurfaceController.ts",
);
const { setConversationRuntimeCacheEntry } = loader.loadModule(
  "src/pages/chat/runtime/chatPageRuntime.ts",
);
const { createLiveTranscriptStore } = loader.loadModule(
  "src/lib/chat/conversation/liveTranscriptStore.ts",
);
const { createTextComposerDraft } = loader.loadModule("@liveagent/ui/lib/chat/composerDraft.ts");

function runtimeEntry(conversationId, overrides = {}) {
  return {
    state: { id: conversationId },
    compactionStatus: { phase: "idle" },
    isSending: false,
    errorMessage: null,
    hookWarning: null,
    sessionId: `${conversationId}-session`,
    createdAt: 1,
    ...overrides,
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
    actions: {
      async hydrate(input) {
        events.push(["hydrate", input.conversationId]);
      },
      async send(input) {
        events.push(["send", input.conversationId]);
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
    },
  });
}

/**
 * Two panes streaming at once. Mirrors useLiveTranscriptController's
 * per-conversation store map plus the runtime registry that drives each
 * surface controller, so delta interleaving is exercised end to end at the
 * model layer.
 */
function twoStreamingPanes() {
  const registry = createConversationRuntimeRegistry([
    ["conversation-a", runtimeEntry("conversation-a", { isSending: true })],
    ["conversation-b", runtimeEntry("conversation-b", { isSending: true })],
  ]);
  const notifications = [];
  const controllerA = surfaceController(registry, "conversation-a");
  const controllerB = surfaceController(registry, "conversation-b");
  controllerA.subscribe(() => notifications.push("a"));
  controllerB.subscribe(() => notifications.push("b"));

  const transcripts = new Map([
    ["conversation-a", createLiveTranscriptStore()],
    ["conversation-b", createLiveTranscriptStore()],
  ]);
  const transcriptNotifications = [];
  for (const [conversationId, store] of transcripts) {
    store.subscribe(() => transcriptNotifications.push(conversationId));
  }

  return {
    registry,
    controllers: { "conversation-a": controllerA, "conversation-b": controllerB },
    notifications,
    transcripts,
    transcriptNotifications,
    pushDelta(conversationId, delta) {
      transcripts.get(conversationId).appendDraftAssistantText(delta);
    },
    draftText(conversationId) {
      return transcripts.get(conversationId).getSnapshot().draftAssistantText;
    },
  };
}

test("a streaming delta notifies only its own pane's transcript subscribers", () => {
  const panes = twoStreamingPanes();
  const snapshotBefore = panes.transcripts.get("conversation-b").getSnapshot();

  panes.pushDelta("conversation-a", "hello from A");

  assert.deepEqual(panes.transcriptNotifications, ["conversation-a"]);
  assert.equal(panes.draftText("conversation-a"), "hello from A");
  assert.equal(panes.draftText("conversation-b"), "");
  assert.equal(
    panes.transcripts.get("conversation-b").getSnapshot(),
    snapshotBefore,
    "an untouched pane must keep its exact snapshot reference",
  );
});

test("twelve interleaved deltas never cross between the two panes", () => {
  const panes = twoStreamingPanes();
  const expected = { "conversation-a": "", "conversation-b": "" };

  for (let index = 0; index < 12; index += 1) {
    const conversationId = index % 2 === 0 ? "conversation-a" : "conversation-b";
    const delta = `${conversationId === "conversation-a" ? "A" : "B"}${index};`;
    panes.pushDelta(conversationId, delta);
    expected[conversationId] += delta;

    // Checked after every single delta, so a leak is caught at the step it
    // happens rather than only in the final aggregate.
    assert.equal(panes.draftText("conversation-a"), expected["conversation-a"]);
    assert.equal(panes.draftText("conversation-b"), expected["conversation-b"]);
  }

  assert.equal(panes.transcriptNotifications.length, 12);
  assert.equal(panes.draftText("conversation-a").includes("B"), false);
  assert.equal(panes.draftText("conversation-b").includes("A"), false);
  assert.deepEqual(
    panes.transcriptNotifications.filter((id) => id === "conversation-a").length,
    6,
  );
});

test("interleaved live rounds and tool status stay bound to their own pane", () => {
  const panes = twoStreamingPanes();
  const storeA = panes.transcripts.get("conversation-a");
  const storeB = panes.transcripts.get("conversation-b");

  for (let index = 0; index < 5; index += 1) {
    storeA.updateLiveRounds((prev) => [...prev, { blocks: [`a-${index}`] }]);
    storeB.setToolStatus(`b-running-${index}`);
    storeB.updateLiveRounds((prev) => [...prev, { blocks: [`b-${index}`] }]);
    storeA.setToolStatus(`a-running-${index}`);
  }

  const snapshotA = storeA.getSnapshot();
  const snapshotB = storeB.getSnapshot();
  assert.equal(snapshotA.toolStatus, "a-running-4");
  assert.equal(snapshotB.toolStatus, "b-running-4");
  assert.deepEqual(
    snapshotA.liveRounds.map((round) => round.blocks[0]),
    ["a-0", "a-1", "a-2", "a-3", "a-4"],
  );
  assert.deepEqual(
    snapshotB.liveRounds.map((round) => round.blocks[0]),
    ["b-0", "b-1", "b-2", "b-3", "b-4"],
  );
});

test("interleaved runtime updates notify each controller exactly once per change", () => {
  const panes = twoStreamingPanes();
  const order = [];

  for (let index = 0; index < 10; index += 1) {
    const conversationId = index % 2 === 0 ? "conversation-a" : "conversation-b";
    setConversationRuntimeCacheEntry(
      panes.registry,
      conversationId,
      runtimeEntry(conversationId, { isSending: true, errorMessage: `tick-${index}` }),
    );
    order.push(conversationId === "conversation-a" ? "a" : "b");
  }

  assert.deepEqual(panes.notifications, order);
  assert.equal(
    panes.controllers["conversation-a"].getSnapshot().runtime.errorMessage,
    "tick-8",
  );
  assert.equal(
    panes.controllers["conversation-b"].getSnapshot().runtime.errorMessage,
    "tick-9",
  );
});

test("stopping pane A leaves pane B streaming and untouched", () => {
  const panes = twoStreamingPanes();
  const stopEvents = [];
  const controllerA = surfaceController(panes.registry, "conversation-a", stopEvents);
  panes.pushDelta("conversation-a", "partial A");
  panes.pushDelta("conversation-b", "partial B");
  const snapshotBBefore = panes.transcripts.get("conversation-b").getSnapshot();

  controllerA.stop();
  // The stop lands as the runtime entry flipping isSending for A only.
  setConversationRuntimeCacheEntry(
    panes.registry,
    "conversation-a",
    runtimeEntry("conversation-a", { isSending: false }),
  );
  panes.transcripts.get("conversation-a").settle();

  assert.deepEqual(stopEvents, [["stop", "conversation-a"]]);
  assert.equal(panes.controllers["conversation-a"].getSnapshot().runtime.isSending, false);
  assert.equal(panes.controllers["conversation-b"].getSnapshot().runtime.isSending, true);
  // Settling clears A's live buffer (the round has moved to history).
  assert.equal(panes.transcripts.get("conversation-a").getSnapshot().isSettled, true);
  assert.equal(panes.draftText("conversation-a"), "");
  assert.equal(
    panes.transcripts.get("conversation-b").getSnapshot(),
    snapshotBBefore,
    "stopping A must not touch B's transcript at all",
  );
  assert.equal(panes.draftText("conversation-b"), "partial B");
  assert.equal(panes.transcripts.get("conversation-b").getSnapshot().isSettled, false);

  // B keeps streaming afterwards, unaffected by A's terminal state.
  panes.pushDelta("conversation-b", " and more");
  assert.equal(panes.draftText("conversation-b"), "partial B and more");
  assert.equal(panes.draftText("conversation-a"), "", "A stays settled while B streams");
  controllerA.dispose();
});

test("a disposed pane controller stops receiving its neighbour's traffic and its own", () => {
  const panes = twoStreamingPanes();
  const controllerA = panes.controllers["conversation-a"];

  controllerA.dispose();
  setConversationRuntimeCacheEntry(
    panes.registry,
    "conversation-a",
    runtimeEntry("conversation-a", { errorMessage: "after dispose" }),
  );
  setConversationRuntimeCacheEntry(
    panes.registry,
    "conversation-b",
    runtimeEntry("conversation-b", { errorMessage: "b lives on" }),
  );

  assert.deepEqual(panes.notifications, ["b"]);
  assert.equal(
    panes.controllers["conversation-b"].getSnapshot().runtime.errorMessage,
    "b lives on",
  );
});

test("interleaved drafts and stop keep each pane's composer slice private", () => {
  const panes = twoStreamingPanes();

  for (let index = 0; index < 6; index += 1) {
    const conversationId = index % 2 === 0 ? "conversation-a" : "conversation-b";
    panes.controllers[conversationId].setDraft(
      createTextComposerDraft(`${conversationId}-draft-${index}`),
    );
  }

  assert.equal(
    panes.controllers["conversation-a"].getSnapshot().draft.text,
    "conversation-a-draft-4",
  );
  assert.equal(
    panes.controllers["conversation-b"].getSnapshot().draft.text,
    "conversation-b-draft-5",
  );

  panes.controllers["conversation-a"].clearDraft();

  assert.equal(panes.controllers["conversation-a"].getSnapshot().draft, null);
  assert.equal(
    panes.controllers["conversation-b"].getSnapshot().draft.text,
    "conversation-b-draft-5",
  );
});
