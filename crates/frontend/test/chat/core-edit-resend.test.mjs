import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

process.env.LIVEAGENT_BACKEND_PORT ??= "0";

// Battle 6: edit-resend truncation moved from the desktop frontend into
// crates/core. This suite drives applyEditResendTruncation with the history
// IPC and subagent prune stubbed, asserting the two ordering invariants:
// keep-set from the truncated state, and store invalidate before prune.
const frontendRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const rootDir = path.resolve(frontendRootDir, "../core");
const backendClientModulePath = path.join(rootDir, "src/backendClient.ts");

function loadEditResendModule() {
  const loader = createTsModuleLoader({
    rootDir,
    mocks: {
      [backendClientModulePath]: {
        callBackend: async (command) => {
          throw new Error(`Unexpected backend command in test: ${command}`);
        },
      },
    },
  });
  return loader.loadModule("src/chat/conversation/editResend.ts");
}

const NOW = 1_700_000_000_000;

function userMessage(id, content) {
  return { role: "user", id, content, timestamp: NOW };
}

function agentToolResult(toolCallId) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "Agent",
    content: [{ type: "text", text: "done" }],
    timestamp: NOW,
  };
}

function windowRecord({ messages, segmentIndex = 0, revision }) {
  const segment = {
    segmentIndex,
    segmentId: `segment-${segmentIndex}`,
    messages,
    messageCount: messages.length,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    conversation: { id: "conv-1", title: "t", updatedAt: NOW },
    meta: {
      schemaVersion: 3,
      systemPrompt: "",
      activeSegmentIndex: segmentIndex,
      totalSegmentCount: segmentIndex + 1,
      totalMessageCount: messages.length,
    },
    segments: [
      {
        segmentIndex,
        segmentId: `segment-${segmentIndex}`,
        messages,
        startMessageIndex: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    activeSegment: segment,
    returnedMessageCount: messages.length,
    oldestOffset: 0,
    hasMoreBefore: false,
    revision,
    updatedAt: NOW,
  };
}

const baseMessageRef = {
  segmentIndex: 0,
  messageIndex: 3,
  segmentId: "segment-0",
  messageId: "user-old",
  role: "user",
  contentHash: "fnv1a32:12345678",
};

test("edit-resend truncates via backend replace and prunes with post-truncation keep set", async () => {
  const { applyEditResendTruncation } = loadEditResendModule();
  const order = [];
  const pruneCalls = [];
  const replaceCalls = [];

  // Pre-truncation history has two Agent tool results; only "tc-keep"
  // survives the cut. The keep set must therefore contain exactly "tc-keep".
  const truncatedMessages = [
    userMessage("user-1", "first"),
    agentToolResult("tc-keep"),
    userMessage("user-new", "edited prompt"),
  ];

  const result = await applyEditResendTruncation({
    conversationId: "conv-1",
    baseMessageRef,
    replacementMessage: userMessage("user-new", "edited prompt"),
    invalidateSubagentStore: (id) => order.push(`invalidate:${id}`),
    deps: {
      getWindow: async () => windowRecord({ messages: [], revision: "rev-live" }),
      replaceFromMessage: async (params) => {
        replaceCalls.push(params);
        order.push("replace");
        return windowRecord({ messages: truncatedMessages, revision: "rev-after" });
      },
      pruneRuns: async (input) => {
        order.push("prune");
        pruneCalls.push(input);
        return {};
      },
    },
  });

  // The replace call must anchor at the edited message and carry the fresh
  // revision from the just-fetched window, not any cached one.
  assert.equal(replaceCalls.length, 1);
  assert.deepEqual(replaceCalls[0].baseMessageRef, baseMessageRef);
  assert.equal(replaceCalls[0].expectedRevision, "rev-live");
  assert.equal(replaceCalls[0].replacementMessage.id, "user-new");

  // Ordering invariant: invalidate the in-memory roster before pruning the
  // persisted runs, and both only after the truncation is durable.
  assert.deepEqual(order, ["replace", "invalidate:conv-1", "prune"]);

  // Keep set computed from the truncated state.
  assert.deepEqual(pruneCalls, [
    { parentConversationId: "conv-1", keepParentToolCallIds: ["tc-keep"] },
  ]);

  // The engine adopts the truncated state and persistence cursor.
  assert.equal(result.state.meta.totalMessageCount, 3);
  assert.deepEqual(result.cursor, { activeSegmentIndex: 0, activeSegmentId: "segment-0" });
});

test("edit-resend surfaces replace failures and never prunes", async () => {
  const { applyEditResendTruncation } = loadEditResendModule();
  let pruned = false;
  let invalidated = false;

  await assert.rejects(
    applyEditResendTruncation({
      conversationId: "conv-1",
      baseMessageRef,
      replacementMessage: userMessage("user-new", "edited prompt"),
      invalidateSubagentStore: () => {
        invalidated = true;
      },
      deps: {
        getWindow: async () => windowRecord({ messages: [], revision: "rev-live" }),
        replaceFromMessage: async () => {
          throw new Error("revision mismatch");
        },
        pruneRuns: async () => {
          pruned = true;
          return {};
        },
      },
    }),
    /revision mismatch/,
  );
  assert.equal(invalidated, false);
  assert.equal(pruned, false);
});

test("edit-resend tolerates prune failure after a durable truncation", async () => {
  const { applyEditResendTruncation } = loadEditResendModule();
  const truncatedMessages = [userMessage("user-new", "edited prompt")];

  const result = await applyEditResendTruncation({
    conversationId: "conv-1",
    baseMessageRef,
    replacementMessage: userMessage("user-new", "edited prompt"),
    invalidateSubagentStore: () => {},
    deps: {
      getWindow: async () => windowRecord({ messages: [], revision: "rev-live" }),
      replaceFromMessage: async () =>
        windowRecord({ messages: truncatedMessages, revision: "rev-after" }),
      pruneRuns: async () => {
        throw new Error("prune backend down");
      },
    },
  });

  assert.equal(result.state.meta.totalMessageCount, 1);
});
