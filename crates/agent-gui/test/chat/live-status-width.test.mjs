import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const activitySource = fs.readFileSync(
  new URL("../../src/pages/chat/transcript/AssistantActivityRow.tsx", import.meta.url),
  "utf8",
);
const bubbleSource = fs.readFileSync(
  new URL("../../src/pages/chat/components/AssistantBubble.tsx", import.meta.url),
  "utf8",
);

test("desktop live status cannot widen the transcript", () => {
  assert.match(activitySource, /min-w-0 w-full max-w-full/);
  assert.match(bubbleSource, /min-w-0 max-w-full overflow-hidden py-1\.5/);
  assert.match(bubbleSource, /<VibingText className="w-full"/);
  assert.match(bubbleSource, /<AssistantStatus className="w-full"/);
});

test("desktop retry details render only in the stable live-status unit", () => {
  assert.match(
    activitySource,
    /retryAttempts=\{\s*unit\.mutable && unit\.unit\.kind === "status"\s*\? retryAttempts\s*: undefined\s*\}/,
  );
  assert.doesNotMatch(activitySource, /retryAttempts=\{unit\.mutable \? retryAttempts/);
});
