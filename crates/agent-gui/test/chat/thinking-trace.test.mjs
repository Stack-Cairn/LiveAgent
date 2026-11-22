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
const toolTraceSource = readSource(
  "../../../agent-ui/src/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);
const workTraceSource = readSource("../../../agent-ui/src/components/chat/AssistantWorkTrace.tsx");
const guiBubbleSource = readSource("../../src/pages/chat/components/AssistantBubble.tsx");
const activityRowSource = readSource("../../src/pages/chat/transcript/AssistantActivityRow.tsx");
const rowModelSource = readSource("../../src/pages/chat/transcript/rowModel.ts");

const liveTurnStatusSource = readSource(
  "../../../agent-ui/src/components/chat/LiveTurnStatus.tsx",
);

test("reasoning renders as expandable disclosures instead of vanishing status text", () => {
  assert.match(roundContentSource, /<ThinkingDisclosure/);
  assert.match(roundContentSource, /resolveActiveThinkingEntryKey/);
  assert.doesNotMatch(roundContentSource, /ThinkingActivity/);
  assert.doesNotMatch(guiBubbleSource, /ThinkingActivity/);

  assert.match(disclosureSource, /data-thinking-disclosure/);
  assert.match(disclosureSource, /<Markdown/);
  assert.match(disclosureSource, /resolveThinkingDurationMs/);
  assert.match(disclosureSource, /chat\.thoughtDuration/);
  assert.match(disclosureSource, /chat\.thinkingProcess/);
  // Reasoning between tool calls folds into the tool group instead of its own rows.
  assert.match(toolTraceSource, /<ThinkingDisclosure/);
});

test("collapsing the live work trace re-homes the active block below the header", () => {
  assert.match(workTraceSource, /collapsedTail\?: ReactNode/);
  assert.match(workTraceSource, /running && hasDetails && !expanded && collapsedTail/);
  assert.match(workTraceSource, /data-chat-work-collapsed-tail/);

  // Detailed view only: the quiet view leaves the status row to say what runs.
  assert.match(roundContentSource, /resolveActiveWorkItem/);
  assert.match(roundContentSource, /detailed && model\.activeItem/);
  assert.match(roundContentSource, /collapsedTail=\{collapsedTail\}/);
  assert.match(guiBubbleSource, /useWorkTraceRows/);
  assert.match(guiBubbleSource, /collapsedTail=\{collapsedTail\}/);
});

test("every live turn renders exactly one status row, at the bottom", () => {
  assert.match(roundContentSource, /<LiveAssistantStatus\s/);
  assert.doesNotMatch(roundContentSource, /LiveSparkle|CompactingText/);
  assert.match(activityRowSource, /<LiveAssistantStatus\s/);
  assert.doesNotMatch(activityRowSource, /LiveSparkle/);
  // The GUI trace no longer renders its own compaction status inside the trace.
  assert.doesNotMatch(guiBubbleSource, /LiveAssistantStatus/);
  // No row inside the trace spins or fakes a phase.
  assert.doesNotMatch(toolTraceSource, /t\("chat\.thinking"\)|AssistantStatus|Loader2/);
  assert.doesNotMatch(disclosureSource, /Loader2|shimmer/);
  assert.doesNotMatch(workTraceSource, /WorkPixelGrid|shimmer/);
});

test("a turn waiting on the user freezes its progress indicators", () => {
  assert.match(liveTurnStatusSource, /<WorkPixelGrid active=\{!awaitingDecision\} \/>/);
  assert.match(liveTurnStatusSource, /!awaitingDecision && "shimmer"/);
  assert.match(
    activityRowSource,
    /hasPendingToolApproval \|\| hasPendingInteractionCard\(row\.units\)/,
  );
  assert.match(activityRowSource, /awaitingDecision=\{awaitingDecision\}/);
  assert.match(roundContentSource, /awaitingDecision=\{attentionRequired\}/);
});

test("a settled turn with a final answer collapses its work trace on both surfaces", () => {
  // Shared AssistantTurnContent (WebUI path) and the GUI's own bubble unit
  // bypass each other, so the auto-collapse wiring must exist in both.
  assert.match(workTraceSource, /if \(!running && !attentionRequired && collapseAfterAnswer && !expandProcessByDefault\)/);
  assert.match(roundContentSource, /collapseAfterAnswer=\{layout\.answer\.length > 0\}/);
  assert.match(guiBubbleSource, /collapseAfterAnswer=\{unit\.hasAnswer\}/);
  assert.match(rowModelSource, /hasAnswer: layout\.answer\.length > 0/);
});

test("GUI transcript keeps live interaction content outside the work trace", () => {
  assert.match(roundContentSource, /layout\.interaction\.map\(\(entry\) => renderEntry\(entry, true\)\)/);
  assert.match(roundContentSource, /isLive=\{running && liveInteraction\}/);
  assert.match(roundContentSource, /attentionRequired=\{attentionRequired\}/);
  assert.match(
    roundContentSource,
    /hasInteractionRequiringAttention\(\[\.\.\.layout\.work, \.\.\.layout\.interaction\]\)/,
  );
  assert.match(roundContentSource, /showTurnStatus=\{running && item\.key === model\.latestActivityKey\}/);
});
