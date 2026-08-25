import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createStreamingTextReconciler, sanitizeAssistantMessage, stripProviderCitationMarkers } =
  loader.loadModule("src/lib/providers/runtime/messageUtils.ts");

const marker = "\uE200cite\uE202turn0search5\uE202turn0search15\uE201";

test("provider citation markers are removed from complete text", () => {
  assert.equal(
    stripProviderCitationMarkers(`before ${marker} after`),
    "before  after",
  );
});

test("streaming reconciler removes citation markers split across deltas", () => {
  const reconciler = createStreamingTextReconciler();
  const first = `before ${marker.slice(0, 9)}`;
  const second = `${marker.slice(9)} after`;

  assert.equal(reconciler.appendDelta("0", first), "before ");
  assert.equal(reconciler.appendDelta("0", second), " after");
  assert.equal(reconciler.reconcileFinalText("0", `before ${marker} after`), "");
});

test("assistant message sanitization preserves non-text blocks", () => {
  const toolCall = { type: "toolCall", id: "call-1", name: "Read", arguments: {} };
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: `answer ${marker}` },
      toolCall,
    ],
  };

  const sanitized = sanitizeAssistantMessage(message);
  assert.deepEqual(sanitized.content, [
    { type: "text", text: "answer " },
    toolCall,
  ]);
  assert.equal(sanitized.content[1], toolCall);
});
