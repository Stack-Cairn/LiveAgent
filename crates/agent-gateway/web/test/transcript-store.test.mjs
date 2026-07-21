import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { createTranscriptStore } = loader.loadModule(
  "src/lib/chat/transcript/transcriptStore.ts",
);

function runStarted(runId, seq, extra = {}) {
  return { type: "run_started", conversation_id: "conv-1", run_id: runId, seq, ...extra };
}

function runFinished(runId, seq, status = "completed", extra = {}) {
  return { type: "run_finished", conversation_id: "conv-1", run_id: runId, seq, status, ...extra };
}

function token(runId, seq, text) {
  return { type: "token", conversation_id: "conv-1", run_id: runId, seq, text };
}

function userMessage(runId, seq, message, extra = {}) {
  return { type: "user_message", conversation_id: "conv-1", run_id: runId, seq, message, ...extra };
}

function foldedRows(snapshot) {
  return snapshot.liveStartIndex >= 0
    ? snapshot.rows.slice(0, snapshot.liveStartIndex)
    : snapshot.rows;
}

function liveRows(snapshot) {
  return snapshot.liveStartIndex >= 0 ? snapshot.rows.slice(snapshot.liveStartIndex) : [];
}

function allRows(snapshot) {
  return snapshot.rows;
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

function assertUniqueKeys(snapshot) {
  const keys = allRows(snapshot).map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(", ")}`);
  assert.equal(
    keys.some((key) => key.includes("#")),
    false,
    `keys needed a collision suffix: ${keys.join(", ")}`,
  );
}

function messageRef(messageId, messageIndex = 0) {
  return {
    segmentIndex: 0,
    messageIndex,
    segmentId: "segment-1",
    messageId,
    role: "user",
    contentHash: `hash-${messageId}`,
  };
}

test("run lifecycle: reply renders in the live flow and folds at the next run_started", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "hello"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "answer "));
  store.applyEvent(token("run-1", 4, "text"));
  store.flush();

  let snapshot = store.getSnapshot();
  assert.equal(foldedRows(snapshot).length, 0);
  assert.deepEqual(
    liveRows(snapshot).map((row) => row.kind),
    ["user", "assistant"],
  );
  assert.equal(snapshot.activeRun?.runId, "run-1");
  const assistantKey = liveRows(snapshot)[1].key;
  assert.equal(rowText(liveRows(snapshot)[1]), "answer text");

  // Reply end: rows stay in the live flow (zero DOM movement), busy clears.
  store.applyEvent(runFinished("run-1", 5));
  store.flush();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null);
  assert.equal(foldedRows(snapshot).length, 0);
  assert.equal(liveRows(snapshot)[1].key, assistantKey, "settled row keeps its key");
  const foldRevisionBefore = snapshot.foldRevision;

  // Queue auto-send handoff: the next run folds the settled turn into the
  // virtualized region and streams into a fresh turn.
  store.applyEvent(userMessage("run-2", 6, "queued prompt"));
  store.applyEvent(runStarted("run-2", 7));
  store.applyEvent(token("run-2", 8, "second"));
  store.flush();
  snapshot = store.getSnapshot();
  assert.deepEqual(
    foldedRows(snapshot).map((row) => row.kind),
    ["user", "assistant"],
    "previous exchange folded",
  );
  assert.equal(foldedRows(snapshot)[1].key, assistantKey, "fold preserves keys");
  assert.ok(snapshot.foldRevision > foldRevisionBefore);
  assert.equal(snapshot.activeRun?.runId, "run-2");
  assert.deepEqual(
    liveRows(snapshot).map((row) => row.kind),
    ["user", "assistant"],
  );
  assert.equal(liveRows(snapshot)[0].text, "queued prompt");
  assert.equal(rowText(liveRows(snapshot)[1]), "second");
  assertUniqueKeys(snapshot);
});

test("cross-run rows never collide on key", () => {
  const store = createTranscriptStore();
  for (const runId of ["run-1", "run-2"]) {
    store.applyEvent(runStarted(runId, runId === "run-1" ? 1 : 4));
    store.applyEvent(token(runId, runId === "run-1" ? 2 : 5, "same text"));
    store.applyEvent(runFinished(runId, runId === "run-1" ? 3 : 6));
  }
  store.applyEvent(runStarted("run-3", 7));
  store.flush();
  assertUniqueKeys(store.getSnapshot());
});

test("optimistic user bubble binds to its run keeping its key", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "hi there" });
  store.flush();
  const optimisticKey = liveRows(store.getSnapshot())[0].key;

  store.applyEvent(userMessage("run-1", 1, "hi there", { client_request_id: "client-1" }));
  store.flush();
  const snapshot = store.getSnapshot();
  const users = allRows(snapshot).filter((row) => row.kind === "user");
  assert.equal(users.length, 1, "seeded echo must not duplicate the bubble");
  assert.equal(users[0].key, optimisticKey, "user bubble keeps its identity");
});

test("failed run appends an error entry and clears busy", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent(runFinished("run-1", 2, "failed", { message: "model exploded" }));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null);
  const text = allRows(snapshot).map((row) => rowText(row)).join("\n");
  assert.match(text, /model exploded/);
});

test("run_queued removes the turn entirely", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "park me" });
  store.applyEvent(userMessage("run-1", 1, "park me", { client_request_id: "client-1" }));
  store.flush();
  assert.equal(allRows(store.getSnapshot()).length, 1);

  store.applyEvent({
    type: "run_queued",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 2,
    client_request_id: "client-1",
  });
  store.flush();
  assert.equal(allRows(store.getSnapshot()).length, 0, "queued prompt leaves the transcript");
});

test("first prompt: rows are exactly [user, assistant] with a stable user key", () => {
  // The reported bug: after the first prompt of a fresh conversation, an
  // avatar-only assistant row appeared above the user bubble (or the bubble
  // duplicated). The full first-prompt sequence must produce exactly one
  // user row followed by one assistant row, with the optimistic bubble's
  // identity stable throughout.
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "什么是磁重联放电" });
  store.flush();
  const userKey = allRows(store.getSnapshot())[0].key;

  store.applyEvent(
    userMessage("run-1", 1, "什么是磁重联放电", { client_request_id: "client-1" }),
  );
  store.applyEvent(runStarted("run-1", 2, { client_request_id: "client-1" }));
  // DeepSeek-style thinking-first reply with a leading meta-only token.
  store.applyEvent({
    type: "token",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 3,
    text: "",
    provider: "deepseek",
    model: "deepseek-v4",
  });
  store.applyEvent({
    type: "thinking",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 4,
    text: "思考中……",
  });
  store.applyEvent(token("run-1", 5, "磁重联是…"));
  store.applyEvent(runFinished("run-1", 6));
  store.flush();

  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => row.kind),
    ["user", "assistant"],
    "exactly one user row followed by one assistant row",
  );
  assert.equal(allRows(snapshot)[0].key, userKey, "user bubble never re-keyed");
  assertUniqueKeys(snapshot);
});

test("meta-only token never produces an assistant row", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "hi"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent({
    type: "token",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 3,
    text: "",
    provider: "openai",
    model: "gpt",
    usage: { totalTokens: 12 },
  });
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => row.kind),
    ["user"],
    "no avatar row for a content-less reply",
  );
});

test("enrich upgrades the settled turn in place (messageRef arrives)", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "edit me" });
  store.applyEvent(userMessage("run-1", 1, "edit me", { client_request_id: "client-1" }));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  const before = store.getSnapshot();
  const userRow = allRows(before).find((row) => row.kind === "user");
  assert.ok(userRow);
  assert.equal(userRow.messageRef, undefined);

  const ref = messageRef("message-1");
  store.applyHistorySnapshot(
    [
      { id: "hu:message-1", kind: "user", text: "edit me (persisted shape)", attachments: [], messageRef: ref },
      { id: "ht:hu:message-1>0", kind: "assistant", text: "reply", round: 1 },
    ],
    { mode: "enrich" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  const upgraded = allRows(snapshot).find((row) => row.kind === "user");
  assert.equal(upgraded?.key, userRow.key, "row keeps its rendered key");
  assert.deepEqual(upgraded?.messageRef, ref, "messageRef attached in place");
  assert.equal(upgraded?.text, "edit me", "streamed display text is never replaced");
  assert.equal(
    allRows(snapshot).filter((row) => row.kind === "user").length,
    1,
    "text-shape mismatch cannot duplicate the bubble",
  );
});

test("enrich with a thinking-first persisted reply adds no avatar row above the user bubble", () => {
  // The screenshot scenario: the persisted assistant message starts with a
  // thinking block, so the parser emits a meta-carrier assistant entry with
  // empty text. The alignment keeps the streamed turn authoritative and the
  // row builder drops content-less rounds — the meta carrier can never
  // become a floating avatar row above the first user bubble.
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "查询磁重联" });
  store.applyEvent(userMessage("run-1", 1, "查询磁重联", { client_request_id: "client-1" }));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent({
    type: "thinking",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 3,
    text: "推理…",
  });
  store.applyEvent(token("run-1", 4, "结论"));
  store.applyEvent(runFinished("run-1", 5));
  store.flush();

  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "查询磁重联", attachments: [], messageRef: messageRef("m1") },
      // Meta-only carrier the parser emits before a leading thinking block.
      { id: "ht:hu:m1>0", kind: "assistant", text: "", round: 1, meta: { provider: "deepseek" } },
      { id: "ht:hu:m1>1", kind: "thinking", text: "推理…", round: 1 },
      { id: "ht:hu:m1>2", kind: "assistant", text: "结论", round: 1 },
    ],
    { mode: "enrich" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => row.kind),
    ["user", "assistant"],
    "no assistant row above the user bubble",
  );
  assert.equal(allRows(snapshot)[0].kind, "user");
  assertUniqueKeys(snapshot);
});

test("enrich with exchanges this client never streamed repaints instead of duplicating", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "question"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();

  // History knows a second exchange (another client) that never streamed
  // here: the window is ahead of the store — replace wholesale.
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "question", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "reply", round: 1 },
      { id: "hu:m2", kind: "user", text: "next", attachments: [], messageRef: messageRef("m2", 2) },
      { id: "ht:hu:m2>0", kind: "assistant", text: "other reply", round: 1 },
    ],
    { mode: "enrich" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => [row.kind, rowText(row)]),
    [
      ["user", "question"],
      ["assistant", "reply"],
      ["user", "next"],
      ["assistant", "other reply"],
    ],
    "every exchange renders exactly once",
  );
  assertUniqueKeys(snapshot);
});

test("replace keeps the active exchange and trims its persisted echo", () => {
  const store = createTranscriptStore();
  // A prior exchange lives in history; a new prompt is in flight.
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
    ],
    { mode: "replace" },
  );
  store.addOptimisticUserEntry({ clientRequestId: "client-2", text: "new prompt" });
  store.applyEvent(userMessage("run-2", 1, "new prompt", { client_request_id: "client-2" }));
  store.applyEvent(runStarted("run-2", 2, { client_request_id: "client-2" }));
  store.flush();
  const userKey = allRows(store.getSnapshot()).find((row) => row.kind === "user" && row.text === "new prompt")?.key;
  assert.ok(userKey);

  // A mid-run reload returns the persisted state: the agent already stored
  // the new prompt (user-only trailing turn). It must render once — from
  // its streaming turn — with the persisted ref adopted.
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      { id: "hu:m2", kind: "user", text: "new prompt", attachments: [], messageRef: messageRef("m2", 2) },
    ],
    { mode: "replace" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  const prompts = allRows(snapshot).filter(
    (row) => row.kind === "user" && row.text === "new prompt",
  );
  assert.equal(prompts.length, 1, "active prompt renders once");
  assert.equal(prompts[0].key, userKey, "streaming turn's bubble keeps its key");
  assert.equal(prompts[0].messageRef?.messageId, "m2", "persisted ref adopted");
  assert.equal(snapshot.activeRun?.runId, "run-2");
  assertUniqueKeys(snapshot);
});

test("rebased truncates at the edited user message in the history region", () => {
  const store = createTranscriptStore();
  store.applyHistorySnapshot(
    [
      { id: "hu:message-1", kind: "user", text: "first", attachments: [], messageRef: messageRef("message-1") },
      { id: "ht:hu:message-1>0", kind: "assistant", text: "answer", round: 1 },
      { id: "hu:message-3", kind: "user", text: "second", attachments: [], messageRef: messageRef("message-3", 2) },
    ],
    { mode: "replace" },
  );
  store.applyEvent({
    type: "rebased",
    conversation_id: "conv-1",
    run_id: "run-9",
    seq: 1,
    base_message_ref: {
      segment_index: 0,
      message_index: 2,
      segment_id: "segment-1",
      message_id: "message-3",
      role: "user",
      content_hash: "hash-message-3",
    },
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => [row.kind, rowText(row)]),
    [
      ["user", "first"],
      ["assistant", "answer"],
    ],
    "transcript truncated at the edited message",
  );
});

test("rebased truncates at the edited user message in an enriched turn", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "prompt"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  store.applyHistorySnapshot(
    [{ id: "hu:m9", kind: "user", text: "prompt", attachments: [], messageRef: messageRef("m9") }],
    { mode: "enrich" },
  );
  store.flush();

  store.applyEvent({
    type: "rebased",
    conversation_id: "conv-1",
    run_id: "run-2",
    seq: 5,
    base_message_ref: { message_id: "m9", content_hash: "hash-m9" },
  });
  store.flush();
  assert.equal(allRows(store.getSnapshot()).length, 0, "edited turn removed for its re-send");
});

test("reset sync rebuilds the active turn from a runtime snapshot", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent(token("run-1", 2, "will be lost"));
  store.flush();

  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 3,
    reset: true,
    activity: {
      runId: "run-2",
      state: "running",
      startedSeq: 1,
      toolStatus: "Vibing",
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: {
      runId: "run-2",
      revision: 5,
      entriesJson: JSON.stringify([
        { id: "snap-1", kind: "assistant", text: "rebuilt from snapshot", round: 0 },
      ]),
      toolStatus: "Vibing",
      toolStatusIsCompaction: false,
      asOfSeq: 0,
    },
    events: [{ type: "token", conversation_id: "conv-1", run_id: "run-2", seq: 3, text: "!" }],
  });
  store.flush();

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun?.runId, "run-2");
  assert.equal(snapshot.toolStatus, "Vibing");
  const text = allRows(snapshot).map((row) => rowText(row)).join("");
  assert.match(text, /rebuilt from snapshot/);
  assert.doesNotMatch(text, /will be lost/);
});

test("reset keeps the optimistic pending bubble and binds it on replay", () => {
  // The old pipeline wiped the live segment on reset while leaving its
  // adoption bookkeeping behind, so the replayed seed re-appended a second
  // bubble. The turn model keeps the pending turn itself.
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "hold on" });
  store.flush();
  const userKey = allRows(store.getSnapshot())[0].key;

  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 2,
    reset: true,
    activity: null,
    snapshot: null,
    events: [
      userMessage("run-1", 1, "hold on", { client_request_id: "client-1" }),
      runStarted("run-1", 2, { client_request_id: "client-1" }),
    ],
  });
  store.flush();
  const snapshot = store.getSnapshot();
  const users = allRows(snapshot).filter((row) => row.kind === "user");
  assert.equal(users.length, 1, "optimistic bubble survives the reset without duplicating");
  assert.equal(users[0].key, userKey, "bubble identity survives the reset");
  assert.equal(snapshot.activeRun?.runId, "run-1");
});

test("tool status mirrors into the snapshot and clears on run end", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 2,
    status: "Vibing",
  });
  store.flush();
  assert.equal(store.getSnapshot().toolStatus, "Vibing");

  store.applyEvent(runFinished("run-1", 3));
  store.flush();
  assert.equal(store.getSnapshot().toolStatus, null);
});

test("retry attempts mirror into the snapshot, survive plain status updates and clear on run end", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 2,
    status: "连接已断开，正在重试 (1/5)...",
    retryAttempts: [{ attempt: 1, maxAttempts: 5, errorMessage: "503 service unavailable" }],
  });
  store.flush();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.retryAttempts.length, 1);
  assert.equal(snapshot.retryAttempts[0].attempt, 1);
  assert.equal(snapshot.retryAttempts[0].maxAttempts, 5);
  assert.equal(snapshot.retryAttempts[0].errorMessage, "503 service unavailable");

  // A status-only update (retryAttempts null) leaves the list untouched.
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 3,
    status: "模型生成中...",
    retryAttempts: null,
  });
  store.flush();
  snapshot = store.getSnapshot();
  assert.equal(snapshot.toolStatus, "模型生成中...");
  assert.equal(snapshot.retryAttempts.length, 1, "plain status update keeps retry history");

  // An explicit empty array clears the list (fresh network attempt).
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 4,
    status: "模型生成中...",
    retryAttempts: [],
  });
  store.flush();
  assert.equal(store.getSnapshot().retryAttempts.length, 0);

  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 5,
    status: "连接已断开，正在重试 (1/5)...",
    retryAttempts: [{ attempt: 1, maxAttempts: 5, errorMessage: "rate limited" }],
  });
  store.applyEvent(runFinished("run-1", 6));
  store.flush();
  assert.equal(store.getSnapshot().retryAttempts.length, 0, "run end clears retry history");
});

test("retry attempts reset at the next run_started", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-1",
    seq: 2,
    status: "连接已断开，正在重试 (2/5)...",
    retryAttempts: [
      { attempt: 1, maxAttempts: 5, errorMessage: "503" },
      { attempt: 2, maxAttempts: 5, errorMessage: "timeout" },
    ],
  });
  store.flush();
  assert.equal(store.getSnapshot().retryAttempts.length, 2);

  store.applyEvent(runStarted("run-2", 3));
  store.flush();
  assert.equal(store.getSnapshot().retryAttempts.length, 0);
});

test("replay idempotency: a resubscribe replaying applied events changes nothing", () => {
  const store = createTranscriptStore();
  const events = [
    userMessage("run-1", 1, "hello", { client_request_id: "client-1" }),
    runStarted("run-1", 2),
    token("run-1", 3, "answer "),
    token("run-1", 4, "text"),
  ];
  for (const event of events) {
    store.applyEvent(event);
  }
  store.flush();
  const before = store.getSnapshot();
  assert.equal(allRows(before).length, 2);
  assert.equal(rowText(allRows(before)[1]), "answer text");

  // Conversation switch-back: the transport re-subscribes from after_seq=0
  // and the gateway replays the whole buffered log plus one new event.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-1",
    latestSeq: 5,
    reset: false,
    activity: {
      runId: "run-1",
      state: "running",
      startedSeq: 2,
      toolStatus: null,
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: null,
    events: [...events, token("run-1", 5, "!")],
  });
  store.flush();

  const snapshot = store.getSnapshot();
  const users = allRows(snapshot).filter((row) => row.kind === "user");
  const assistants = allRows(snapshot).filter((row) => row.kind === "assistant");
  assert.equal(users.length, 1, "exactly one user bubble after replay");
  assert.equal(assistants.length, 1, "exactly one assistant row after replay");
  assert.equal(rowText(assistants[0]), "answer text!", "only the new token applied");
  assertUniqueKeys(snapshot);
});

test("snapshot as_of_seq is a replay barrier: overlapping events are dropped", () => {
  const store = createTranscriptStore();
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-1",
    latestSeq: 5,
    reset: false,
    activity: {
      runId: "run-1",
      state: "running",
      startedSeq: 2,
      toolStatus: null,
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: {
      runId: "run-1",
      revision: 3,
      entriesJson: JSON.stringify([
        { id: "snap-assistant", kind: "assistant", text: "answer text", round: 0 },
      ]),
      toolStatus: null,
      toolStatusIsCompaction: false,
      asOfSeq: 4,
    },
    events: [token("run-1", 3, "answer "), token("run-1", 4, "text"), token("run-1", 5, "!")],
  });
  store.flush();
  const snapshot = store.getSnapshot();
  const text = allRows(snapshot).map((row) => rowText(row)).join("");
  assert.equal(text, "answer text!", "snapshot content is not double-applied");
});

test("inline snapshot events carry as_of_seq and drop the overlapping tail", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent({
    type: "snapshot",
    conversation_id: "conv-1",
    run_id: "run-1",
    revision: 7,
    entries_json: JSON.stringify([
      { id: "snap-assistant", kind: "assistant", text: "full text so far", round: 0 },
    ]),
    as_of_seq: 6,
  });
  store.applyEvent(token("run-1", 5, "stale "));
  store.applyEvent(token("run-1", 6, "stale"));
  store.applyEvent(token("run-1", 7, " and more"));
  store.flush();
  const text = allRows(store.getSnapshot()).map((row) => rowText(row))
    .join("");
  assert.equal(text, "full text so far and more");
});

test("stray run_finished for a non-active run never settles the streaming turn", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-b", 1));
  store.applyEvent(token("run-b", 2, "streaming"));
  store.applyEvent({
    type: "tool_status",
    conversation_id: "conv-1",
    run_id: "run-b",
    seq: 3,
    status: "Vibing",
  });
  store.flush();

  store.applyEvent(runFinished("run-a", 4, "failed", { message: "queued run failed" }));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun?.runId, "run-b", "active run unchanged");
  assert.equal(snapshot.toolStatus, "Vibing", "tool status unchanged");
  assert.equal(
    allRows(snapshot).some((row) => rowText(row).includes("streaming")),
    true,
    "streaming row still live",
  );

  store.applyEvent(runFinished("run-b", 5));
  store.flush();
  assert.equal(store.getSnapshot().activeRun, null);
});

test("run_finished settles only its own turn; foreign turns stay live", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-a", 1));
  store.applyEvent(token("run-a", 2, "reply a"));
  // A queued command's seeded user message (run-b) plus a not-yet-bound
  // optimistic echo arrive while run-a is still streaming.
  store.applyEvent(userMessage("run-b", 3, "queued prompt"));
  store.addOptimisticUserEntry({ clientRequestId: "client-c", text: "pending echo" });
  store.applyEvent(runFinished("run-a", 4));
  store.flush();

  assert.equal(store.getSnapshot().activeRun, null);
  store.applyEvent(runStarted("run-b", 5));
  store.applyEvent(token("run-b", 6, "reply b"));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    foldedRows(snapshot).map((row) => rowText(row)),
    ["reply a"],
    "fold took only run-a's turn",
  );
  assert.deepEqual(
    liveRows(snapshot).map((row) => rowText(row)),
    ["queued prompt", "reply b", "pending echo"],
    "run-b's reply renders with its own prompt; the pending echo stays live",
  );
  assertUniqueKeys(snapshot);
});

test("interleaved run_queued compensation still removes the bound bubble", () => {
  const store = createTranscriptStore();
  store.applyEvent(runStarted("run-a", 1));
  store.addOptimisticUserEntry({ clientRequestId: "client-b", text: "park me" });
  store.applyEvent(userMessage("run-b", 2, "park me", { client_request_id: "client-b" }));
  store.applyEvent(runFinished("run-a", 3));
  store.applyEvent(runStarted("run-x", 4));
  store.applyEvent({
    type: "run_queued",
    conversation_id: "conv-1",
    run_id: "run-b",
    seq: 5,
    client_request_id: "client-b",
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(
    allRows(snapshot).some((row) => rowText(row) === "park me"),
    false,
    "queued prompt left the transcript entirely",
  );
});

test("reset folds the settled turn instead of dropping the last reply", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "question"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "the reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  const keysBefore = allRows(store.getSnapshot()).map((row) => row.key);
  assert.equal(keysBefore.length, 2);

  // Gateway restart while idle: epoch reset with nothing to replay.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 0,
    reset: true,
    activity: null,
    snapshot: null,
    events: [],
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    foldedRows(snapshot).map((row) => row.key),
    keysBefore,
    "settled exchange folded with stable keys",
  );
  assert.equal(liveRows(snapshot).length, 0);
});

test("identical prompts across exchanges keep distinct keys through enrich", () => {
  const store = createTranscriptStore();
  for (const [runId, base] of [
    ["run-1", 0],
    ["run-2", 4],
  ]) {
    store.applyEvent(userMessage(runId, base + 1, "继续"));
    store.applyEvent(runStarted(runId, base + 2));
    store.applyEvent(token(runId, base + 3, runId === "run-1" ? "第一次回复" : "第二次回复"));
    store.applyEvent(runFinished(runId, base + 4));
  }
  store.flush();
  const before = store.getSnapshot();
  assertUniqueKeys(before);
  const keysBefore = allRows(before).map((row) => row.key);

  store.applyHistorySnapshot(
    [
      { id: "hu:ma", kind: "user", text: "继续", attachments: [], messageRef: messageRef("ma") },
      { id: "ht:hu:ma>0", kind: "assistant", text: "第一次回复", round: 1 },
      { id: "hu:mb", kind: "user", text: "继续", attachments: [], messageRef: messageRef("mb", 2) },
      { id: "ht:hu:mb>0", kind: "assistant", text: "第二次回复", round: 1 },
    ],
    { mode: "enrich" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => row.key),
    keysBefore,
    "identical texts keep their own row identities",
  );
  const refs = allRows(snapshot)
    .filter((row) => row.kind === "user")
    .map((row) => row.messageRef?.messageId);
  assert.deepEqual(refs, ["ma", "mb"], "each occurrence adopts its own ref, in order");
  assertUniqueKeys(snapshot);
});

test("multi-viewer: seeded events alone render one exchange, replays are no-ops", () => {
  const store = createTranscriptStore();
  const events = [
    userMessage("run-1", 1, "their prompt", { client_request_id: "someone-else" }),
    runStarted("run-1", 2),
    token("run-1", 3, "their reply"),
    runFinished("run-1", 4),
  ];
  for (const event of events) {
    store.applyEvent(event);
  }
  for (const event of events) {
    store.applyEvent(event);
  }
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => [row.kind, rowText(row)]),
    [
      ["user", "their prompt"],
      ["assistant", "their reply"],
    ],
  );
  assertUniqueKeys(snapshot);
});

test("entryCount tracks history entries plus turn content", () => {
  const store = createTranscriptStore();
  assert.equal(store.getSnapshot().entryCount, 0);
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [] },
      { id: "ht:hu:m1>0", kind: "assistant", text: "reply", round: 1 },
    ],
    { mode: "replace" },
  );
  store.applyEvent(userMessage("run-1", 1, "new"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "streaming"));
  store.flush();
  assert.equal(store.getSnapshot().entryCount, 4);
});

test("a turn folding behind an earlier pending turn still enters the folded region", () => {
  const store = createTranscriptStore();
  // This client's prompt waits (pending) while a foreign run completes.
  store.addOptimisticUserEntry({ clientRequestId: "client-a", text: "waiting prompt" });
  store.applyEvent(userMessage("run-b", 1, "foreign prompt"));
  store.applyEvent(runStarted("run-b", 2));
  store.applyEvent(token("run-b", 3, "foreign reply"));
  store.applyEvent(runFinished("run-b", 4));
  // This client's run starts: the foreign exchange folds even though the
  // pending turn precedes it in creation order.
  store.applyEvent(userMessage("run-a", 5, "waiting prompt", { client_request_id: "client-a" }));
  store.applyEvent(runStarted("run-a", 6, { client_request_id: "client-a" }));
  store.applyEvent(token("run-a", 7, "own reply"));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    foldedRows(snapshot).map((row) => rowText(row)),
    ["foreign prompt", "foreign reply"],
    "the completed foreign exchange is virtualized",
  );
  assert.deepEqual(
    liveRows(snapshot).map((row) => rowText(row)),
    ["waiting prompt", "own reply"],
  );
  assertUniqueKeys(snapshot);
});

test("reset with the run gone settles the turn and enrich adopts the persisted reply", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "prompt" });
  store.applyEvent(userMessage("run-1", 1, "prompt", { client_request_id: "client-1" }));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "partial"));
  store.flush();

  // Gateway restarted; the run finished during the gap and the replay no
  // longer covers it.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 0,
    reset: true,
    activity: null,
    snapshot: null,
    events: [],
  });
  store.flush();
  let snapshot = store.getSnapshot();
  const userKey = allRows(snapshot).find((row) => row.kind === "user")?.key;
  assert.ok(userKey, "the prompt bubble survives the reset");
  assert.equal(snapshot.activeRun, null);

  // The idle enrich (triggered by the history upsert) adopts the persisted
  // reply into the settled turn — no zombie pending turn blocks it.
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "prompt", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "the full persisted reply", round: 1 },
    ],
    { mode: "enrich" },
  );
  store.flush();
  snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => [row.kind, rowText(row)]),
    [
      ["user", "prompt"],
      ["assistant", "the full persisted reply"],
    ],
    "the persisted reply appears exactly once",
  );
  assert.equal(
    allRows(snapshot).find((row) => row.kind === "user")?.key,
    userKey,
    "the bubble never re-keyed",
  );
});

test("reset with the run gone and no replay keeps the streamed reply until history catches up", () => {
  const store = createTranscriptStore();
  store.addOptimisticUserEntry({ clientRequestId: "client-1", text: "prompt" });
  store.applyEvent(userMessage("run-1", 1, "prompt", { client_request_id: "client-1" }));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "full streamed reply"));
  store.flush();

  // The client saw the whole reply; only run_finished was lost. Gateway
  // restarted → epoch reset with an empty replay: the streamed entries are
  // the reply's only copy and must survive.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-2",
    latestSeq: 0,
    reset: true,
    activity: null,
    snapshot: null,
    events: [],
  });
  store.flush();
  let snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null);
  assert.equal(
    allRows(snapshot).some((row) => rowText(row) === "full streamed reply"),
    true,
    "the reply's only copy survives the reset",
  );

  // An enrich racing the desktop's post-run flush (user-only twin) must not
  // blank it either.
  store.applyHistorySnapshot(
    [{ id: "hu:m1", kind: "user", text: "prompt", attachments: [], messageRef: messageRef("m1") }],
    { mode: "enrich" },
  );
  store.flush();
  snapshot = store.getSnapshot();
  assert.equal(
    allRows(snapshot).some((row) => rowText(row) === "full streamed reply"),
    true,
    "a reply-less history window never blanks the kept content",
  );

  // Once the flush lands, the persisted reply is authoritative for the
  // stale-marked turn (the kept content may have been incomplete).
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "prompt", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "full persisted reply", round: 1 },
    ],
    { mode: "enrich" },
  );
  store.flush();
  snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => rowText(row)),
    ["prompt", "full persisted reply"],
    "the persisted reply replaces the stale copy exactly once",
  );
  assertUniqueKeys(snapshot);
});

test("rebased with duplicate prompt texts truncates at the edited message, not the first hash match", () => {
  const store = createTranscriptStore();
  store.applyHistorySnapshot(
    [
      {
        id: "hu:m1",
        kind: "user",
        text: "hello",
        attachments: [],
        messageRef: { ...messageRef("m1"), contentHash: "same-hash" },
      },
      { id: "ht:hu:m1>0", kind: "assistant", text: "reply one", round: 1 },
      {
        id: "hu:m2",
        kind: "user",
        text: "hello",
        attachments: [],
        messageRef: { ...messageRef("m2", 2), contentHash: "same-hash" },
      },
      { id: "ht:hu:m2>0", kind: "assistant", text: "reply two", round: 1 },
    ],
    { mode: "replace" },
  );
  store.applyEvent({
    type: "rebased",
    conversation_id: "conv-1",
    run_id: "run-9",
    seq: 1,
    base_message_ref: { message_id: "m2", content_hash: "same-hash" },
  });
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => rowText(row)),
    ["hello", "reply one"],
    "the first exchange survives",
  );
});

test("streaming commits keep the folded prefix rows identity-stable", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "one"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "first reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.applyEvent(userMessage("run-2", 5, "two"));
  store.applyEvent(runStarted("run-2", 6));
  store.flush();
  const before = store.getSnapshot();
  assert.equal(before.liveStartIndex, 2);

  store.applyEvent(token("run-2", 7, "streaming "));
  store.flush();
  store.applyEvent(token("run-2", 8, "more"));
  store.flush();
  const after = store.getSnapshot();
  assert.equal(after.liveStartIndex, 2);
  for (let index = 0; index < after.liveStartIndex; index += 1) {
    assert.equal(
      after.rows[index],
      before.rows[index],
      "token deltas must not re-derive the folded prefix's row objects",
    );
  }
  assert.equal(rowText(liveRows(after)[1]), "streaming more");
});

test("fold is a pure data transition: keys carry over and the boundary moves", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "prompt"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "the reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  const settled = store.getSnapshot();
  assert.equal(settled.liveStartIndex, 0, "settled turn still lives in the unfolded suffix");
  const settledKeys = settled.rows.map((row) => row.key);

  // The next run_started folds the settled turn: its rows keep their keys in
  // the same single list, so React reconciles them in place (no remount) and
  // the key-addressed virtualizer measurements survive.
  store.applyEvent(userMessage("run-2", 5, "next prompt"));
  store.applyEvent(runStarted("run-2", 6));
  store.flush();
  const folded = store.getSnapshot();
  assert.equal(folded.liveStartIndex, settledKeys.length, "boundary moved past the folded turn");
  assert.deepEqual(
    folded.rows.slice(0, settledKeys.length).map((row) => row.key),
    settledKeys,
    "keys are unchanged across the fold",
  );

  // After the fold, streaming commits reuse the folded prefix identically.
  const foldedPrefix = folded.rows.slice(0, folded.liveStartIndex);
  store.applyEvent(token("run-2", 7, "next reply"));
  store.flush();
  const streaming = store.getSnapshot();
  for (const [index, row] of foldedPrefix.entries()) {
    assert.equal(streaming.rows[index], row, "folded prefix rows stay identity-stable");
  }
});

test("replace keeps a settled exchange whose persistence lags the fetched window", () => {
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "old prompt"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "old reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  // Enrich attaches the persisted ref to the settled exchange.
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old prompt", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
    ],
    { mode: "enrich" },
  );
  // A second exchange settles…
  store.applyEvent(userMessage("run-2", 5, "new prompt"));
  store.applyEvent(runStarted("run-2", 6));
  store.applyEvent(token("run-2", 7, "new reply"));
  store.applyEvent(runFinished("run-2", 8));
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old prompt", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      { id: "hu:m2", kind: "user", text: "new prompt", attachments: [], messageRef: messageRef("m2", 2) },
      { id: "ht:hu:m2>0", kind: "assistant", text: "new reply", round: 1 },
    ],
    { mode: "enrich" },
  );
  // …and a third finishes but is NOT yet in the refetched window when the
  // user clicks load-more.
  store.applyEvent(userMessage("run-3", 9, "fresh prompt"));
  store.applyEvent(runStarted("run-3", 10));
  store.applyEvent(token("run-3", 11, "fresh reply"));
  store.applyEvent(runFinished("run-3", 12));
  store.flush();

  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old prompt", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      { id: "hu:m2", kind: "user", text: "new prompt", attachments: [], messageRef: messageRef("m2", 2) },
      { id: "ht:hu:m2>0", kind: "assistant", text: "new reply", round: 1 },
    ],
    { mode: "replace" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  const texts = allRows(snapshot).map((row) => rowText(row));
  assert.deepEqual(
    texts,
    ["old prompt", "old reply", "new prompt", "new reply", "fresh prompt", "fresh reply"],
    "the just-finished exchange survives a lagging reload",
  );
  assertUniqueKeys(snapshot);
});

test("replace keeps the settled reply when only its user message reached the fetched window", () => {
  // The desktop reports run_finished before its post-run history flush lands,
  // so a re-open racing that flush fetches a window whose last turn is the
  // persisted prompt WITHOUT its reply. The settled turn holds the only copy
  // of the reply and must survive, with the echo trimmed and its ref adopted.
  const store = createTranscriptStore();
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
    ],
    { mode: "replace" },
  );
  store.applyEvent(userMessage("run-2", 1, "new prompt"));
  store.applyEvent(runStarted("run-2", 2));
  store.applyEvent(token("run-2", 3, "new reply"));
  store.applyEvent(runFinished("run-2", 4));
  // Switching away folds the settled turn; switching back replace-loads.
  store.foldSettledTurns();
  store.flush();

  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      {
        id: "hu:m2",
        kind: "user",
        text: "new prompt",
        attachments: [],
        messageRef: messageRef("m2", 2),
      },
    ],
    { mode: "replace" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => rowText(row)),
    ["old", "old reply", "new prompt", "new reply"],
    "the streamed reply survives the user-only echo",
  );
  const prompts = allRows(snapshot).filter(
    (row) => row.kind === "user" && row.text === "new prompt",
  );
  assert.equal(prompts.length, 1, "prompt renders once");
  assert.equal(prompts[0].messageRef?.messageId, "m2", "persisted ref adopted");
  assertUniqueKeys(snapshot);
});

test("replace keeps a ref-matched settled reply whose window twin is still user-only", () => {
  // Same race, but the idle enrich already attached the persisted ref to the
  // settled turn before the reload (its twin was user-only then too) — the
  // ref match must not count a reply-less twin as coverage.
  const store = createTranscriptStore();
  store.applyEvent(userMessage("run-1", 1, "prompt"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();
  store.applyHistorySnapshot(
    [
      {
        id: "hu:m1",
        kind: "user",
        text: "prompt",
        attachments: [],
        messageRef: messageRef("m1"),
      },
    ],
    { mode: "enrich" },
  );
  store.flush();

  store.applyHistorySnapshot(
    [
      {
        id: "hu:m1",
        kind: "user",
        text: "prompt",
        attachments: [],
        messageRef: messageRef("m1"),
      },
    ],
    { mode: "replace" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  assert.deepEqual(
    allRows(snapshot).map((row) => rowText(row)),
    ["prompt", "reply"],
    "the streamed reply survives across enrich + replace",
  );
  const prompts = allRows(snapshot).filter((row) => row.kind === "user");
  assert.equal(prompts.length, 1, "prompt renders once");
  assertUniqueKeys(snapshot);
});

test("enrich repaint keeps a settled reply whose window twin is still user-only", () => {
  // The guarded full repaint (history ahead of the store) must not drop a
  // settled turn whose persisted twin carries no reply yet.
  const store = createTranscriptStore();
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
    ],
    { mode: "replace" },
  );
  store.applyEvent(userMessage("run-2", 1, "our prompt"));
  store.applyEvent(runStarted("run-2", 2));
  store.applyEvent(token("run-2", 3, "our reply"));
  store.applyEvent(runFinished("run-2", 4));
  store.flush();

  // History knows a foreign exchange this client never streamed (forcing the
  // repaint path) while our exchange's reply flush is still in flight.
  store.applyHistorySnapshot(
    [
      { id: "hu:m1", kind: "user", text: "old", attachments: [], messageRef: messageRef("m1") },
      { id: "ht:hu:m1>0", kind: "assistant", text: "old reply", round: 1 },
      { id: "hu:m2", kind: "user", text: "foreign", attachments: [], messageRef: messageRef("m2", 2) },
      { id: "ht:hu:m2>0", kind: "assistant", text: "foreign reply", round: 1 },
      {
        id: "hu:m3",
        kind: "user",
        text: "our prompt",
        attachments: [],
        messageRef: messageRef("m3", 4),
      },
    ],
    { mode: "enrich" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  const texts = allRows(snapshot).map((row) => rowText(row));
  assert.deepEqual(
    texts,
    ["old", "old reply", "foreign", "foreign reply", "our prompt", "our reply"],
    "the streamed reply survives the repaint",
  );
  assert.equal(
    allRows(snapshot).filter((row) => row.kind === "user" && row.text === "our prompt").length,
    1,
    "prompt renders once",
  );
  assertUniqueKeys(snapshot);
});

test("enrich repaint skips a queued prompt's echo when pairing the lagged reply", () => {
  const store = createTranscriptStore();
  // First exchange of a fresh conversation streams and settles.
  store.applyEvent(userMessage("run-1", 1, "first prompt"));
  store.applyEvent(runStarted("run-1", 2));
  store.applyEvent(token("run-1", 3, "first reply"));
  store.applyEvent(runFinished("run-1", 4));
  store.flush();

  // A queued next prompt's persist overtook the lagging reply flush (the
  // first exchange's write waits on the title lookahead): the fetched window
  // carries both prompts and no replies, forcing the guarded repaint. The
  // queued echo must be skipped — not treated as a pairing stop — so the
  // reply's turn right behind it stays protected.
  store.applyHistorySnapshot(
    [
      {
        id: "hu:m1",
        kind: "user",
        text: "first prompt",
        attachments: [],
        messageRef: messageRef("m1"),
      },
      {
        id: "hu:m2",
        kind: "user",
        text: "queued prompt",
        attachments: [],
        messageRef: messageRef("m2", 1),
      },
    ],
    { mode: "enrich" },
  );
  store.flush();
  const snapshot = store.getSnapshot();
  const texts = allRows(snapshot).map((row) => rowText(row));
  assert.equal(texts.includes("first reply"), true, "the lagged reply survives");
  assert.equal(
    allRows(snapshot).filter((row) => row.kind === "user" && row.text === "first prompt").length,
    1,
    "the paired prompt renders once",
  );
  assert.equal(
    allRows(snapshot).filter((row) => row.kind === "user" && row.text === "queued prompt").length,
    1,
    "the queued prompt's echo still renders from history",
  );
  assertUniqueKeys(snapshot);
});

test("a stray run_finished drops the stray turn, keeps activeRun, and fires onDivergence once", () => {
  let divergences = 0;
  const store = createTranscriptStore({
    onDivergence: () => {
      divergences += 1;
    },
  });
  store.applyEvent(runStarted("run-a", 1));
  store.applyEvent(token("run-a", 2, "reply a"));
  store.applyEvent(userMessage("run-b", 3, "queued prompt"));
  store.flush();
  assert.equal(
    allRows(store.getSnapshot()).some((row) => rowText(row) === "queued prompt"),
    true,
  );

  store.applyEvent(
    runFinished("run-b", 4, "failed", { message: "superseded", reason: "superseded" }),
  );
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun?.runId, "run-a", "active run untouched");
  assert.equal(
    allRows(snapshot).some((row) => rowText(row) === "queued prompt"),
    false,
    "stray turn dropped",
  );
  assert.equal(
    allRows(snapshot).some((row) => rowText(row) === "reply a"),
    true,
    "streaming turn untouched",
  );
  assert.equal(divergences, 1);

  // A second stray in the same burst is debounced.
  store.applyEvent(runFinished("run-c", 5, "failed", { message: "also stray" }));
  store.flush();
  assert.equal(store.getSnapshot().activeRun?.runId, "run-a");
  assert.equal(divergences, 1, "one signal per applied sync");

  // The resulting resync re-arms the signal for a later divergence.
  store.applySync({
    conversationId: "conv-1",
    streamEpoch: "epoch-1",
    latestSeq: 5,
    reset: false,
    activity: {
      runId: "run-a",
      state: "running",
      startedSeq: 1,
      toolStatus: null,
      toolStatusIsCompaction: false,
      updatedAt: 1,
    },
    snapshot: null,
    events: [],
  });
  store.applyEvent(runFinished("run-d", 6, "failed", { message: "stray again" }));
  store.flush();
  assert.equal(divergences, 2, "signal re-armed after the sync");
});

test("a matching run_finished settles the run without firing onDivergence", () => {
  let divergences = 0;
  const store = createTranscriptStore({
    onDivergence: () => {
      divergences += 1;
    },
  });
  store.applyEvent(runStarted("run-1", 1));
  store.applyEvent(token("run-1", 2, "answer"));
  store.applyEvent(runFinished("run-1", 3));
  store.flush();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeRun, null, "matching terminal settles the run");
  assert.equal(
    allRows(snapshot).some((row) => rowText(row) === "answer"),
    true,
  );
  assert.equal(divergences, 0);
});

function installHiddenTab() {
  const rafCalls = { count: 0 };
  globalThis.document = { visibilityState: "hidden" };
  globalThis.requestAnimationFrame = () => {
    rafCalls.count += 1;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  const uninstall = () => {
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  };
  return { rafCalls, uninstall };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("hidden tab: streamed deltas coalesce into one timer-driven commit instead of rAF", async () => {
  const { rafCalls, uninstall } = installHiddenTab();
  try {
    const store = createTranscriptStore();
    store.applyEvent(userMessage("run-h", 1, "hello"));
    store.applyEvent(runStarted("run-h", 2));

    let emits = 0;
    store.subscribe(() => {
      emits += 1;
    });
    const revisionBefore = store.getSnapshot().revision;

    for (let i = 0; i < 5; i++) {
      store.applyEvent(token("run-h", 3 + i, `chunk-${i} `));
    }
    assert.equal(rafCalls.count, 0, "hidden tab must not schedule via rAF");
    assert.equal(emits, 0, "deltas coalesce; nothing commits synchronously");
    assert.equal(store.getSnapshot().revision, revisionBefore);

    await sleep(400);
    assert.equal(emits, 1, "one timer-driven commit for the whole burst");
    const text = allRows(store.getSnapshot())
      .map((row) => rowText(row))
      .join("\n");
    for (let i = 0; i < 5; i++) {
      assert.ok(text.includes(`chunk-${i}`), `chunk-${i} committed`);
    }
  } finally {
    uninstall();
  }
});

test("hidden tab: flush() commits immediately and cancels the pending timer", async () => {
  const { uninstall } = installHiddenTab();
  try {
    const store = createTranscriptStore();
    store.applyEvent(userMessage("run-f", 1, "hello"));
    store.applyEvent(runStarted("run-f", 2));

    let emits = 0;
    store.subscribe(() => {
      emits += 1;
    });

    store.applyEvent(token("run-f", 3, "tail text"));
    assert.equal(emits, 0);

    store.flush();
    assert.equal(emits, 1, "flush commits synchronously");
    const text = allRows(store.getSnapshot())
      .map((row) => rowText(row))
      .join("\n");
    assert.ok(text.includes("tail text"));

    await sleep(400);
    assert.equal(emits, 1, "the canceled hidden timer must not double-commit");
  } finally {
    uninstall();
  }
});
