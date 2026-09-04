import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const transcriptSource = fs.readFileSync(
  new URL("../src/components/GatewayTranscript.tsx", import.meta.url),
  "utf8",
);
const sharedAssistantStatusSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/AssistantStatus.tsx", import.meta.url),
  "utf8",
);

test("the streaming assistant keeps live status inside its stable work trace", () => {
  assert.doesNotMatch(transcriptSource, /function shouldShowLiveStatusForRounds/);
  assert.doesNotMatch(transcriptSource, /function LiveStatusFooter/);
  assert.match(
    transcriptSource,
    /<AssistantBubble[\s\S]*?toolStatus=\{isLatestLiveStreaming \? displayedToolStatus : null\}/,
  );
  assert.match(transcriptSource, /data-row-key=\{row\.key\}/);
  assert.match(
    transcriptSource,
    /toolStatusVariant=\{displayedToolStatusIsCompaction \? "compaction" : "default"\}/,
  );
  assert.match(sharedAssistantStatusSource, /export function LiveAssistantStatus/);
  assert.match(sharedAssistantStatusSource, /if \(isCompaction\) return <CompactingText/);
  assert.match(sharedAssistantStatusSource, /return <LiveSparkle/);
  assert.match(sharedAssistantStatusSource, /return <AssistantStatus/);
});

test("compaction does not add a second pending bubble after assistant output", () => {
  const pendingBubbleSource = transcriptSource.match(
    /const shouldShowPendingLiveBubble = useMemo\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/,
  )?.[0];
  assert.ok(pendingBubbleSource);
  assert.match(pendingBubbleSource, /liveAssistantIndex >= 0[\s\S]*?return false/);
  assert.match(pendingBubbleSource, /displayedToolStatusIsCompaction[\s\S]*?return true/);
  assert.match(pendingBubbleSource, /lastRowKind === "user" \|\| lastRowKind === "checkpoint"/);
});
