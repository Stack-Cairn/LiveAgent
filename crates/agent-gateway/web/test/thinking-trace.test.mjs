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
const liveTurnStatusSource = readSource("../../../agent-ui/src/components/chat/LiveTurnStatus.tsx");
const toolTraceSource = readSource(
  "../../../agent-ui/src/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);

test("WebUI transcript renders reasoning as expandable disclosures", () => {
  assert.match(roundContentSource, /<ThinkingDisclosure/);
  assert.doesNotMatch(roundContentSource, /ThinkingActivity/);
  assert.match(disclosureSource, /data-thinking-disclosure/);
  assert.match(disclosureSource, /aria-expanded=\{open\}/);
  // Reasoning stays out of redacted share views entirely, also when it is
  // folded into a tool group.
  assert.match(roundContentSource, /redactToolContent \? null : \(\s*<ThinkingDisclosure/);
  assert.match(toolTraceSource, /const visibleReasoning = redactToolContent \? EMPTY_REASONING : reasoning;/);
});

test("the live reply shows one status row that freezes on a user decision", () => {
  assert.match(roundContentSource, /<LiveAssistantStatus\s/);
  assert.match(roundContentSource, /awaitingDecision=\{attentionRequired\}/);
  assert.doesNotMatch(roundContentSource, /LiveSparkle/);
  assert.match(liveTurnStatusSource, /role="status"/);
  assert.match(liveTurnStatusSource, /data-live-turn-status/);
  // The pixel grid stops and the label stops shimmering while the turn is
  // parked on a user decision, where nothing is running.
  assert.match(liveTurnStatusSource, /<WorkPixelGrid active=\{!awaitingDecision\} \/>/);
  assert.match(liveTurnStatusSource, /!awaitingDecision && "shimmer"/);
});

test("a collapsed processing trace keeps the active block visible outside it", () => {
  assert.match(workTraceSource, /data-chat-work-collapsed-tail/);
  assert.match(roundContentSource, /collapsedTail=\{collapsedTail\}/);
});
