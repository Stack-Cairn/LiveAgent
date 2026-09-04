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
const sharedStatusSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/AssistantStatus.tsx", import.meta.url),
  "utf8",
);
const workTraceSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/AssistantWorkTrace.tsx", import.meta.url),
  "utf8",
);
const sparkleSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/LiveSparkle.tsx", import.meta.url),
  "utf8",
);
const toolTraceSource = fs.readFileSync(
  new URL(
    "../../../agent-ui/src/components/chat/assistant-bubble/ToolTraceGroup.tsx",
    import.meta.url,
  ),
  "utf8",
);
const toolCallItemSource = fs.readFileSync(
  new URL(
    "../../../agent-ui/src/components/chat/assistant-bubble/ToolCallItem.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("desktop live status cannot widen the transcript", () => {
  assert.match(activitySource, /min-w-0 w-full max-w-full/);
  assert.match(bubbleSource, /<LiveAssistantStatus[\s\S]*?className="w-full py-1\.5"/);
  // Without a concrete status the shared component falls back to the
  // liveness sparkle instead of the "Vibing..." filler phrase.
  assert.match(sharedStatusSource, /return <LiveSparkle className=\{className\} \/>/);
  assert.match(sharedStatusSource, /return <AssistantStatus className=\{className\}/);
});

test("desktop retry details render on the mutable live tail", () => {
  assert.match(activitySource, /retryAttempts=\{unit\.mutable \? retryAttempts : undefined\}/);
  assert.match(
    bubbleSource,
    /@liveagent\/ui\/components\/chat\/RetryDetailsBlock/,
  );
});

test("the processing trace, its rows and the sparkle share one 12px icon column", () => {
  // The pixel grid (15px) and the sparkle (20px) are wider than the 12px icons
  // used by the reasoning/tool rows, so they are centred on the column axis
  // rather than left-aligned to it.
  assert.match(workTraceSource, /className="flex w-3 shrink-0 items-center justify-center"/);
  assert.match(sparkleSource, /className="flex h-5 w-3 shrink-0 items-center justify-center"/);
  // A tool group's body carries the same horizontal inset as its header button,
  // and the hover-swap box around each row icon is exactly one column wide.
  assert.match(toolTraceSource, /className="-mx-1\.5 overflow-hidden px-1\.5 pt-0\.5"/);
  assert.match(toolCallItemSource, /flex h-3\.5 w-3 shrink-0 items-center justify-center/);
});

test("standalone work trace aligns its header with the assistant avatar", () => {
  assert.match(workTraceSource, /className=\{cn\("my-0 text-foreground\/60", className\)\}/);
  assert.match(
    bubbleSource,
    /<AssistantWorkTrace[\s\S]*?className="mt-0"[\s\S]*?hasDetails=/,
  );
});
