import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createStreamingTextReconciler, sanitizeAssistantMessage, stripProviderCitationMarkers } =
  loader.loadModule("src/lib/providers/runtime/messageUtils.ts");

const marker = "\uE200cite\uE202turn0search5\uE202turn0search15\uE201";
const lookalike = "\uE200cite hello \uE201";

test("provider citation markers are removed from complete text", () => {
  assert.equal(
    stripProviderCitationMarkers(`before ${marker} after`),
    "before  after",
  );
});

test("unterminated citation markers are dropped from complete text", () => {
  assert.equal(
    stripProviderCitationMarkers(`before \uE200cite\uE202turn0search5`),
    "before ",
  );
  assert.equal(stripProviderCitationMarkers("before \uE200cit"), "before ");
});

test("lookalike text without a delimiter is kept", () => {
  assert.equal(stripProviderCitationMarkers(`before ${lookalike} after`), `before ${lookalike} after`);
});

test("streaming reconciler removes citation markers split across deltas", () => {
  const reconciler = createStreamingTextReconciler();
  const splitAt = marker.indexOf("\uE202") + 3;
  const first = `before ${marker.slice(0, splitAt)}`;
  const second = `${marker.slice(splitAt)} after`;

  assert.equal(reconciler.appendDelta("0", first), "before ");
  assert.equal(reconciler.appendDelta("0", second), " after");
  assert.equal(reconciler.reconcileFinalText("0", `before ${marker} after`), "");
});

test("stream and strip share the same citation matching rules", () => {
  const reconciler = createStreamingTextReconciler();
  assert.equal(reconciler.appendDelta("lookalike", `before ${lookalike} after`), `before ${lookalike} after`);
  assert.equal(
    reconciler.reconcileFinalText("lookalike", `before ${lookalike} after`),
    "",
  );

  const split = createStreamingTextReconciler();
  let streamed = "";
  for (const chunk of `keep ${marker} going`) {
    streamed += split.appendDelta("chars", chunk);
  }
  streamed += split.reconcileFinalText("chars", `keep ${marker} going`);
  assert.equal(streamed, stripProviderCitationMarkers(`keep ${marker} going`));
  assert.equal(streamed, "keep  going");
});

test("unterminated streamed citations are not flushed back on text_end", () => {
  const reconciler = createStreamingTextReconciler();
  const truncated = `answer \uE200cite\uE202turn0search5`;
  assert.equal(reconciler.appendDelta("0", truncated), "answer ");
  assert.equal(reconciler.reconcileFinalText("0", truncated), "");
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
