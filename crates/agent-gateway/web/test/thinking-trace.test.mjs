import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readSource = (relativePath) =>
  fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");

const roundContentSource = readSource(
  "../../../agent-ui/src/components/chat/assistant-bubble/RoundContent.tsx",
);
const disclosureSource = readSource(
  "../../../agent-ui/src/components/chat/assistant-bubble/ThinkingDisclosure.tsx",
);
const workTraceSource = readSource("../../../agent-ui/src/components/chat/AssistantWorkTrace.tsx");
const statusSource = readSource("../../../agent-ui/src/components/chat/AssistantStatus.tsx");
const sparkleSource = readSource("../../../agent-ui/src/components/chat/LiveSparkle.tsx");

test("WebUI transcript renders reasoning as expandable disclosures", () => {
  assert.match(roundContentSource, /<ThinkingDisclosure/);
  assert.doesNotMatch(roundContentSource, /ThinkingActivity/);
  assert.match(disclosureSource, /data-thinking-disclosure/);
  assert.match(disclosureSource, /aria-expanded=\{open\}/);
  // Reasoning stays out of redacted share views entirely.
  assert.match(roundContentSource, /redactToolContent \? null : \(\s*<ThinkingDisclosure/);
});

test("the live reply carries one persistent sparkle beacon", () => {
  assert.match(
    roundContentSource,
    /\{running \? <LiveSparkle paused=\{attentionRequired\} \/> : null\}/,
  );
  assert.match(sparkleSource, /data-live-sparkle/);
  // The cluster twinkles via SMIL animations baked into the SVG itself.
  assert.match(sparkleSource, /<animate/);
  assert.match(sparkleSource, /repeatCount="indefinite"/);
  // …unless the turn is parked on a user decision, where nothing is running.
  assert.match(sparkleSource, /\{paused \? null : \(/);
  // The pending-bubble status line falls back to the sparkle instead of the
  // "Vibing..." filler phrase when there is no concrete activity to report.
  assert.match(statusSource, /return <LiveSparkle className=\{className\} \/>/);
});

test("a collapsed processing trace keeps the active block visible outside it", () => {
  assert.match(workTraceSource, /data-chat-work-collapsed-tail/);
  assert.match(
    roundContentSource,
    /collapsedTail=\{collapsedTailEntry \? renderEntry\(collapsedTailEntry, true\) : null\}/,
  );
});
