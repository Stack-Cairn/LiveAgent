import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createGatewayBridgeEventController } = loader.loadModule(
  "src/lib/chat/conversation/run/gatewayBridgeEvents.ts",
);

function createController(options = {}) {
  const sent = [];
  const controller = createGatewayBridgeEventController({
    conversationId: options.conversationId ?? "conversation-1",
    requestId: options.requestId ?? "request-1",
    workerId: options.workerId,
    enabled: options.enabled ?? true,
    sendEvent: (requestId, event, sendOptions) => {
      const item = { requestId, event };
      if (sendOptions?.workerId) {
        item.options = sendOptions;
      }
      sent.push(item);
    },
    resolveErrorConversationId: options.resolveErrorConversationId,
  });
  return { controller, sent };
}

test("gateway bridge event controller emits nothing when disabled", () => {
  const { controller, sent } = createController({ enabled: false });

  controller.queueToken("hello", { round: 1 });
  controller.queueTitle("New title", true);
  controller.queueToolStatus("Running");
  controller.queueEvent({ type: "done", conversation_id: "conversation-1" });
  controller.emitError("failed");

  assert.deepEqual(sent, []);
  assert.equal(controller.hasForwardedText(), true);
});

test("gateway bridge token forwarding tracks non-empty text only", () => {
  const { controller, sent } = createController();

  controller.queueToken("");
  assert.deepEqual(sent, []);
  assert.equal(controller.hasForwardedText(), false);

  controller.queueToken("", { round: 1, usage: { totalTokens: 3 } });
  assert.equal(controller.hasForwardedText(), false);
  assert.deepEqual(sent, [
    {
      requestId: "request-1",
      event: {
        type: "token",
        text: "",
        conversation_id: "conversation-1",
        round: 1,
        usage: { totalTokens: 3 },
      },
    },
  ]);

  controller.queueToken("hello", { round: 1 });
  assert.equal(controller.hasForwardedText(), true);
  assert.deepEqual(sent[1], {
    requestId: "request-1",
    event: {
      type: "token",
      text: "hello",
      conversation_id: "conversation-1",
      round: 1,
    },
  });
});

test("gateway bridge started control is explicit and does not mark text forwarded", () => {
  const { controller, sent } = createController();

  controller.queueEvent({
    type: "started",
    conversation_id: "conversation-1",
  });

  assert.equal(controller.hasForwardedText(), false);
  assert.deepEqual(sent, [
    {
      requestId: "request-1",
      event: {
        type: "started",
        conversation_id: "conversation-1",
      },
    },
  ]);
});

test("gateway bridge events carry the remote worker lease owner", () => {
  const { controller, sent } = createController({ workerId: "worker-1" });

  controller.queueEvent({
    type: "started",
    conversation_id: "conversation-1",
  });

  assert.deepEqual(sent, [
    {
      requestId: "request-1",
      event: {
        type: "started",
        conversation_id: "conversation-1",
      },
      options: {
        workerId: "worker-1",
      },
    },
  ]);
});

test("gateway bridge tool status is normalized and de-duplicated", () => {
  const { controller, sent } = createController();

  controller.queueToolStatus(" Running ");
  controller.queueToolStatus("Running");
  controller.queueToolStatus("Running", true);
  controller.queueToolStatus("  ");

  assert.deepEqual(
    sent.map((item) => item.event),
    [
      {
        type: "tool_status",
        status: "Running",
        isCompaction: false,
        conversation_id: "conversation-1",
      },
      {
        type: "tool_status",
        status: "Running",
        isCompaction: true,
        conversation_id: "conversation-1",
      },
      {
        type: "tool_status",
        status: null,
        isCompaction: false,
        conversation_id: "conversation-1",
      },
    ],
  );
});

test("gateway bridge retry attempts ride tool_status with the current status and de-duplicate", () => {
  const { controller, sent } = createController();

  // The initial clear (fresh round, nothing to clear remotely) is suppressed.
  controller.queueRetryAttempts([]);
  assert.deepEqual(sent, []);

  controller.queueToolStatus("第 1 轮：模型生成中...");
  controller.queueRetryAttempts([
    { attempt: 1, maxAttempts: 5, errorMessage: "503 service unavailable" },
  ]);
  // Same list again: de-duplicated.
  controller.queueRetryAttempts([
    { attempt: 1, maxAttempts: 5, errorMessage: "503 service unavailable" },
  ]);
  // Explicit clear after a non-empty list is forwarded.
  controller.queueRetryAttempts([]);

  assert.deepEqual(
    sent.map((item) => item.event),
    [
      {
        type: "tool_status",
        status: "第 1 轮：模型生成中...",
        isCompaction: false,
        conversation_id: "conversation-1",
      },
      {
        type: "tool_status",
        status: "第 1 轮：模型生成中...",
        isCompaction: false,
        retryAttempts: [{ attempt: 1, maxAttempts: 5, errorMessage: "503 service unavailable" }],
        conversation_id: "conversation-1",
      },
      {
        type: "tool_status",
        status: "第 1 轮：模型生成中...",
        isCompaction: false,
        retryAttempts: [],
        conversation_id: "conversation-1",
      },
    ],
  );
});

test("gateway bridge close blocks normal events but allows forced title updates", () => {
  const { controller, sent } = createController();

  controller.queueToken("before");
  controller.close();
  controller.queueToken("after");
  controller.queueTitle("Final title", true);
  controller.queueEvent({ type: "done", conversation_id: "conversation-1" });

  assert.equal(controller.isClosed(), true);
  assert.deepEqual(
    sent.map((item) => item.event),
    [
      {
        type: "token",
        text: "before",
        conversation_id: "conversation-1",
      },
      {
        type: "token",
        text: "",
        title: "Final title",
        titleFinal: true,
        conversation_id: "conversation-1",
      },
    ],
  );
});

test("gateway bridge checkpoint emits compaction summary payload", () => {
  const { controller, sent } = createController();
  const state = {
    activeSegmentIndex: 1,
    segments: [
      {
        segmentIndex: 0,
        segmentId: "segment-0",
        messages: [],
        messageCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        segmentIndex: 1,
        segmentId: "segment-1",
        messages: [],
        messageCount: 0,
        createdAt: 2,
        updatedAt: 2,
        summary: {
          role: "summary",
          id: "summary-1",
          timestamp: 3,
          content: "Compacted facts",
          summaryMeta: {
            format: "plain-text-v1",
            strategy: "cumulative-checkpoint",
            coversThroughMessageId: "message-9",
            coveredMessageCount: 9,
            generatedBy: {
              providerId: "codex",
              model: "gpt-test",
              promptVersion: "summary-v2",
            },
          },
        },
      },
    ],
    historyRenderItems: [],
    meta: {
      schemaVersion: 3,
      activeSegmentIndex: 1,
      totalSegmentCount: 2,
      totalMessageCount: 0,
    },
  };

  controller.queueCheckpoint(state);

  assert.deepEqual(sent, [
    {
      requestId: "request-1",
      event: {
        type: "token",
        text: "Compacted facts",
        provider: "liveagent",
        model: "summary",
        api: "liveagent-compaction",
        conversation_id: "conversation-1",
        checkpoint: {
          summaryId: "summary-1",
          segmentIndex: 1,
          coveredMessageCount: 9,
          coversThroughMessageId: "message-9",
          timestamp: 3,
          generatedBy: {
            providerId: "codex",
            model: "gpt-test",
            promptVersion: "summary-v2",
          },
        },
      },
    },
  ]);
});

test("gateway bridge user message carries the edit-resend truncation base", () => {
  const { controller, sent } = createController();

  controller.queueUserMessage("edited prompt", [], {
    baseMessageRef: {
      segmentIndex: 0,
      messageIndex: 2,
      segmentId: "segment-1",
      messageId: "message-2",
      role: "user",
      contentHash: "hash-2",
    },
  });

  assert.deepEqual(sent, [
    {
      requestId: "request-1",
      event: {
        type: "user_message",
        message: "edited prompt",
        uploaded_files: [],
        conversation_id: "conversation-1",
        base_message_ref: {
          segment_index: 0,
          message_index: 2,
          segment_id: "segment-1",
          message_id: "message-2",
          role: "user",
          content_hash: "hash-2",
        },
        reason: "edit_resend",
      },
    },
  ]);
});

test("gateway bridge user message omits the truncation base for plain sends", () => {
  const { controller, sent } = createController();

  controller.queueUserMessage("plain prompt");

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].event, {
    type: "user_message",
    message: "plain prompt",
    uploaded_files: [],
    conversation_id: "conversation-1",
  });
  assert.equal("base_message_ref" in sent[0].event, false);
  assert.equal("reason" in sent[0].event, false);
});

test("gateway bridge error can resolve the latest conversation id", () => {
  const { controller, sent } = createController({
    conversationId: "conversation-initial",
    resolveErrorConversationId: () => "conversation-current",
  });

  controller.emitError("failed");
  controller.emitError("failed again", "conversation-explicit");

  assert.deepEqual(
    sent.map((item) => item.event),
    [
      {
        type: "error",
        message: "failed",
        conversation_id: "conversation-current",
      },
      {
        type: "error",
        message: "failed again",
        conversation_id: "conversation-explicit",
      },
    ],
  );
});
