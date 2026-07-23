import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();

const { buildGatewayRuntimeSnapshotEntries } = loader.loadModule(
  "src/pages/chat/gateway/chatRuntimeSnapshot.ts",
);
const { buildGatewayToolCallPreviewArguments } = loader.loadModule(
  "src/pages/chat/turns/gatewayToolPreview.ts",
);
const toolPreview = loader.loadModule("src/lib/chat/messages/toolPreview.ts");

test("gateway runtime snapshot projects live rounds into chat entries", () => {
  const entries = buildGatewayRuntimeSnapshotEntries({
    userMessage: {
      role: "user",
      id: "user-1",
      content: "Run the checks",
    },
    liveTranscript: {
      draftAssistantText: "",
      toolStatus: "Running shell",
      liveRounds: [
        {
          key: "round-1",
          round: 1,
          runningToolCallIds: [],
          thinkingOpen: false,
          blocks: [
            { kind: "thinking", text: "I will inspect the repo." },
            { kind: "text", text: "I found the issue." },
            {
              kind: "tool",
              item: {
                toolCall: {
                  type: "toolCall",
                  id: "tool-1",
                  name: "Shell",
                  arguments: { cmd: "pnpm test" },
                },
                toolResult: {
                  role: "toolResult",
                  toolCallId: "tool-1",
                  toolName: "Shell",
                  content: [{ type: "text", text: "ok" }],
                },
              },
            },
            { kind: "text", text: " Next step is ready." },
          ],
        },
      ],
    },
  });

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["user", "thinking", "assistant", "tool_call", "tool_result", "assistant"],
  );
  assert.equal(entries[0].text, "Run the checks");
  assert.equal(entries[0].messageId, "user-1");
  assert.equal(entries[1].text, "I will inspect the repo.");
  assert.equal(entries[2].text, "I found the issue.");
  assert.equal(entries[3].toolCall.name, "Shell");
  assert.equal(entries[4].toolResult.toolCallId, "tool-1");
  assert.equal(entries[5].text, " Next step is ready.");
});

test("gateway runtime snapshot carries the same tool preview shape as bridge deltas", () => {
  const content = "z".repeat(9000);
  const toolCall = {
    type: "toolCall",
    id: "tool-write",
    name: "Write",
    arguments: { path: "big.txt", content },
  };
  const entries = buildGatewayRuntimeSnapshotEntries({
    userMessage: null,
    liveTranscript: {
      draftAssistantText: "",
      toolStatus: null,
      liveRounds: [
        {
          key: "round-1",
          round: 1,
          runningToolCallIds: ["tool-write"],
          thinkingOpen: false,
          blocks: [{ kind: "tool", item: { toolCall } }],
        },
      ],
    },
  });

  const entry = entries.find((candidate) => candidate.kind === "tool_call");
  assert.ok(entry, "expected a tool_call entry");
  assert.deepEqual(entry.toolCall.arguments, buildGatewayToolCallPreviewArguments(toolCall));
  assert.ok(entry.toolCall.arguments.content.length <= 4000);
  const metadata = entry.toolCall.arguments[toolPreview.LIVE_TOOL_PREVIEW_META_KEY];
  assert.equal(metadata.progress, content.length);
  assert.equal(metadata.fields.content.chars, content.length);
});

test("gateway runtime snapshot falls back to draft assistant text", () => {
  const entries = buildGatewayRuntimeSnapshotEntries({
    userMessage: {
      role: "user",
      id: "user-2",
      content: "Continue",
    },
    liveTranscript: {
      draftAssistantText: "streaming text",
      toolStatus: null,
      liveRounds: [],
    },
  });

  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["user", "assistant"],
  );
  assert.equal(entries[1].text, "streaming text");
  assert.equal(entries[0].messageId, "user-2");
});
