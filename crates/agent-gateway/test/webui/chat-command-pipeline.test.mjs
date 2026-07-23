import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { ChatCommandPipeline } = loader.loadModule("src/lib/chat/stream/chatCommandPipeline.ts");
const { createTranscriptStore } = loader.loadModule("src/lib/chat/transcript/transcriptStore.ts");

function createHarness() {
  const stores = new Map();
  const outcomes = { bound: [], queued: [], failed: [] };
  const pipeline = new ChatCommandPipeline({
    getTranscriptStore(conversationId) {
      let store = stores.get(conversationId);
      if (!store) {
        store = createTranscriptStore();
        stores.set(conversationId, store);
      }
      return store;
    },
    onBound(update, pending) {
      outcomes.bound.push({ update, pending });
    },
    onQueuedInGui(update, pending) {
      outcomes.queued.push({ update, pending });
    },
    onFailed(pending, errorCode, message) {
      outcomes.failed.push({ pending, errorCode, message });
    },
  });
  return { pipeline, stores, outcomes };
}

function rowText(row) {
  if (row.kind === "assistant") {
    return row.rounds
      .map((round) =>
        round.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join(""),
      )
      .join("\n");
  }
  return row.text ?? "";
}

function liveRows(snapshot) {
  return snapshot.liveStartIndex >= 0 ? snapshot.rows.slice(snapshot.liveStartIndex) : [];
}

// Live-flow texts (the region the old snapshot exposed as `tail`).
function tailTexts(store) {
  store.flush();
  return liveRows(store.getSnapshot()).map((row) => rowText(row));
}

function transcriptTexts(store) {
  store.flush();
  return store.getSnapshot().rows.map((row) => rowText(row));
}

test("submit inserts the optimistic bubble and resolves the accepted run", async () => {
  const { pipeline, stores } = createHarness();
  const outcome = await pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: async () => ({ runId: "run-1", conversationId: "conv-1", acceptedSeq: 2 }),
  });

  assert.equal(outcome.kind, "accepted");
  assert.equal(outcome.accepted.runId, "run-1");
  assert.deepEqual(tailTexts(stores.get("conv-1")), ["hello"]);
  assert.equal(pipeline.hasPending("conv-1"), true);

  // The stream's run signal settles the pending spinner.
  pipeline.handleRunSignal("conv-1", "run-1");
  assert.equal(pipeline.hasPending("conv-1"), false);
});

test("edit-resend truncates at the edited message before command acknowledgement", async () => {
  const { pipeline, stores } = createHarness();
  const store = createTranscriptStore();
  stores.set("conv-1", store);
  const baseMessageRef = {
    segmentIndex: 0,
    messageIndex: 2,
    segmentId: "segment-0",
    messageId: "message-2",
    role: "user",
    contentHash: "hash-2",
  };
  store.applyHistorySnapshot(
    [
      {
        id: "user-1",
        kind: "user",
        text: "first question",
        attachments: [],
        messageRef: {
          segmentIndex: 0,
          messageIndex: 0,
          segmentId: "segment-0",
          messageId: "message-0",
          role: "user",
          contentHash: "hash-0",
        },
      },
      { id: "assistant-1", kind: "assistant", text: "first answer", round: 1 },
      {
        id: "user-2",
        kind: "user",
        text: "old second question",
        attachments: [],
        messageRef: baseMessageRef,
      },
      { id: "assistant-2", kind: "assistant", text: "old second answer", round: 1 },
      {
        id: "user-3",
        kind: "user",
        text: "later question",
        attachments: [],
        messageRef: {
          segmentIndex: 0,
          messageIndex: 4,
          segmentId: "segment-0",
          messageId: "message-4",
          role: "user",
          contentHash: "hash-4",
        },
      },
      { id: "assistant-3", kind: "assistant", text: "later answer", round: 1 },
    ],
    { mode: "replace" },
  );

  let acceptCommand;
  const acceptGate = new Promise((resolve) => {
    acceptCommand = resolve;
  });
  const submitPromise = pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-edit",
    message: "edited second question",
    isEditResend: true,
    baseMessageRef,
    submit: () => acceptGate,
  });

  assert.deepEqual(
    transcriptTexts(store),
    ["first question", "first answer", "edited second question"],
    "the stale suffix is gone in the same optimistic update as the replacement bubble",
  );

  // The gateway's authoritative rebase arrives later and must be a no-op,
  // while user_message binds the existing optimistic bubble instead of
  // appending another one.
  store.applyEvent({
    type: "rebased",
    conversation_id: "conv-1",
    run_id: "run-edit",
    seq: 1,
    base_message_ref: {
      segment_index: 0,
      message_index: 2,
      segment_id: "segment-0",
      message_id: "message-2",
      role: "user",
      content_hash: "hash-2",
    },
  });
  store.applyEvent({
    type: "user_message",
    conversation_id: "conv-1",
    run_id: "run-edit",
    client_request_id: "client-edit",
    seq: 2,
    message: "edited second question",
  });
  assert.deepEqual(transcriptTexts(store), [
    "first question",
    "first answer",
    "edited second question",
  ]);

  acceptCommand({ runId: "run-edit", conversationId: "conv-1", acceptedSeq: 2 });
  const outcome = await submitPromise;
  assert.equal(outcome.kind, "accepted");
  pipeline.handleRunSignal("conv-1", "run-edit");
  assert.equal(pipeline.hasPending("conv-1"), false);
});

test("submit failure removes the bubble and surfaces an error entry", async () => {
  const { pipeline, stores, outcomes } = createHarness();
  const outcome = await pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: async () => {
      throw new Error("agent offline");
    },
  });

  assert.equal(outcome.kind, "failed");
  assert.equal(pipeline.hasPending("conv-1"), false);
  const texts = tailTexts(stores.get("conv-1"));
  assert.equal(texts.some((text) => text === "hello"), false, "optimistic bubble removed");
  assert.equal(texts.some((text) => /agent offline/.test(text)), true);
  assert.equal(outcomes.failed.length, 1);
});

test("bound update re-keys a draft conversation", async () => {
  const { pipeline, outcomes } = createHarness();
  await pipeline.submit({
    conversationId: "draft-1",
    clientRequestId: "client-1",
    message: "first message",
    submit: async () => ({ runId: "run-1", conversationId: "", acceptedSeq: 0 }),
  });

  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conv-real",
    phase: "bound",
    errorCode: null,
    message: null,
  });

  assert.equal(outcomes.bound.length, 1);
  assert.equal(outcomes.bound[0].pending.conversationId, "conv-real");
  assert.equal(pipeline.hasPending("draft-1"), false);
  assert.equal(pipeline.hasPending("conv-real"), true);
  pipeline.handleRunSignal("conv-real", "run-1");
  assert.equal(pipeline.hasPending("conv-real"), false);
});

test("queued_in_gui clears pending and removes the optimistic bubble", async () => {
  const { pipeline, stores, outcomes } = createHarness();
  await pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "park me",
    submit: async () => ({ runId: "run-1", conversationId: "conv-1", acceptedSeq: 1 }),
  });

  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conv-1",
    phase: "queued_in_gui",
    errorCode: null,
    message: null,
  });

  assert.equal(pipeline.hasPending("conv-1"), false);
  assert.equal(outcomes.queued.length, 1);
  assert.deepEqual(tailTexts(stores.get("conv-1")), [], "bubble removed; queue panel owns it");
});

test("failed update surfaces the gateway error", async () => {
  const { pipeline, stores, outcomes } = createHarness();
  await pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "doomed",
    submit: async () => ({ runId: "run-1", conversationId: "conv-1", acceptedSeq: 1 }),
  });

  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conv-1",
    phase: "failed",
    errorCode: "startup_timeout",
    message: "did not start",
  });

  assert.equal(pipeline.hasPending("conv-1"), false);
  assert.equal(outcomes.failed.length, 1);
  assert.equal(outcomes.failed[0].errorCode, "startup_timeout");
  const texts = tailTexts(stores.get("conv-1"));
  assert.equal(texts.some((text) => /did not start/.test(text)), true);
});

test("run signals settle only on strict identity (runId or own clientRequestId)", async () => {
  const { pipeline } = createHarness();
  let releaseAccept;
  const acceptGate = new Promise((resolve) => {
    releaseAccept = resolve;
  });
  const submitPromise = pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: async () => {
      await acceptGate;
      return { runId: "run-1", conversationId: "conv-1", acceptedSeq: 2 };
    },
  });

  // Accept response still in flight (pending.runId === null): a foreign run
  // signal without our client_request_id must NOT settle the pending —
  // otherwise a GUI queue auto-send would disarm the startup watchdog.
  pipeline.handleRunSignal("conv-1", "run-foreign");
  assert.equal(pipeline.hasPending("conv-1"), true, "foreign signal ignored");
  pipeline.handleRunSignal("conv-1", "run-foreign", "client-other");
  assert.equal(pipeline.hasPending("conv-1"), true, "foreign clientRequestId ignored");

  // Our own run signal, matched by client_request_id, settles before the
  // accept response lands.
  pipeline.handleRunSignal("conv-1", "run-1", "client-1");
  assert.equal(pipeline.hasPending("conv-1"), false, "own clientRequestId settles");

  releaseAccept();
  const outcome = await submitPromise;
  assert.equal(outcome.kind, "settled");
  // The late accept response must not resurrect a byRunId registration for
  // the already-settled pending: a later command_update for that run id is a
  // no-op instead of firing hooks against a dead pending.
  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conv-other",
    phase: "bound",
    errorCode: null,
    message: null,
  });
  assert.equal(pipeline.hasPending("conv-other"), false);
});

test("a run signal that beats a lost acknowledgement prevents a false local failure", async () => {
  const { pipeline, stores, outcomes } = createHarness();
  let rejectAccept;
  const acceptGate = new Promise((_, reject) => {
    rejectAccept = reject;
  });
  const submitPromise = pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: () => acceptGate,
  });

  pipeline.handleRunSignal("conv-1", "run-1", "client-1");
  rejectAccept(new Error("chat command acknowledgement lost"));
  const outcome = await submitPromise;

  assert.equal(outcome.kind, "settled");
  assert.equal(pipeline.hasPending("conv-1"), false);
  assert.equal(outcomes.failed.length, 0, "no duplicate local failure hook");
  assert.deepEqual(tailTexts(stores.get("conv-1")), ["hello"]);
});

test("a queued update that beats a lost acknowledgement remains queued", async () => {
  const { pipeline, stores, outcomes } = createHarness();
  let rejectAccept;
  const acceptGate = new Promise((_, reject) => {
    rejectAccept = reject;
  });
  const submitPromise = pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "queue me",
    submit: () => acceptGate,
  });

  const update = {
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conv-1",
    phase: "queued_in_gui",
    errorCode: null,
    message: null,
  };
  pipeline.handleCommandUpdate(update);
  rejectAccept(new Error("chat command acknowledgement lost"));
  const outcome = await submitPromise;

  assert.equal(outcome.kind, "queued_in_gui");
  assert.equal(outcomes.queued.length, 1);
  assert.equal(outcomes.failed.length, 0);
  assert.deepEqual(tailTexts(stores.get("conv-1")), []);
});

test("run signals with a known runId settle regardless of clientRequestId", async () => {
  const { pipeline } = createHarness();
  await pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "hello",
    submit: async () => ({ runId: "run-1", conversationId: "conv-1", acceptedSeq: 2 }),
  });
  assert.equal(pipeline.hasPending("conv-1"), true);

  // Foreign run id: ignored even though the conversation matches.
  pipeline.handleRunSignal("conv-1", "run-9");
  assert.equal(pipeline.hasPending("conv-1"), true);

  // Matching run id (e.g. an activity event while the conversation is not
  // displayed) settles without any clientRequestId.
  pipeline.handleRunSignal("conv-1", "run-1");
  assert.equal(pipeline.hasPending("conv-1"), false);
});

test("reset clears pending commands and ignores their late acknowledgements", async () => {
  const { pipeline, stores, outcomes } = createHarness();
  let rejectAccept;
  const acceptGate = new Promise((_, reject) => {
    rejectAccept = reject;
  });
  const submitPromise = pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "old agent request",
    submit: () => acceptGate,
  });

  assert.equal(pipeline.hasPending("conv-1"), true);
  pipeline.reset();
  assert.equal(pipeline.hasPending("conv-1"), false);
  assert.deepEqual(tailTexts(stores.get("conv-1")), []);

  rejectAccept(new Error("old agent disconnected"));
  assert.equal((await submitPromise).kind, "settled");
  assert.equal(outcomes.failed.length, 0);
});


test("optimistic:false suppresses the transcript echo for queue-destined sends", async () => {
  const { pipeline, stores } = createHarness();
  await pipeline.submit({
    conversationId: "conv-1",
    clientRequestId: "client-1",
    message: "park me quietly",
    optimistic: false,
    submit: async () => ({ runId: "run-1", conversationId: "conv-1", acceptedSeq: 0 }),
  });
  // No store is touched at submit time — the transcript never sees the prompt.
  const storeAfterSubmit = stores.get("conv-1");
  if (storeAfterSubmit) {
    assert.deepEqual(tailTexts(storeAfterSubmit), [], "no bubble flash");
  }
  assert.equal(pipeline.hasPending("conv-1"), true, "watchdog still armed");

  // queued_in_gui settles it without ever having shown a bubble.
  pipeline.handleCommandUpdate({
    runId: "run-1",
    clientRequestId: "client-1",
    conversationId: "conv-1",
    phase: "queued_in_gui",
    errorCode: null,
    message: null,
  });
  assert.equal(pipeline.hasPending("conv-1"), false);
  assert.deepEqual(tailTexts(stores.get("conv-1")), []);
});
