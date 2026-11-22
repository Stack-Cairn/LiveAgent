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
const liveTurnStatusSource = fs.readFileSync(
  new URL("../../../agent-ui/src/components/chat/LiveTurnStatus.tsx", import.meta.url),
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
  // The single live status row truncates its label instead of growing.
  assert.match(sharedStatusSource, /<LiveTurnStatus \{\.\.\.rest\} compacting=\{isCompaction\} \/>/);
  assert.match(liveTurnStatusSource, /"flex min-w-0 max-w-full flex-col py-1 text-sm/);
  assert.match(liveTurnStatusSource, /className=\{cn\("min-w-0 truncate"/);
});

test("desktop retry details render on the mutable live tail", () => {
  assert.match(activitySource, /retryAttempts=\{unit\.mutable \? retryAttempts : undefined\}/);
  assert.match(
    bubbleSource,
    /@liveagent\/ui\/components\/chat\/RetryDetailsBlock/,
  );
});

test("the live status row and the trace rows share one 12px icon column", () => {
  // The pixel grid (15px) is wider than the 12px icons used by the
  // reasoning/tool rows, so it is centred on the column axis rather than
  // left-aligned to it.
  assert.match(liveTurnStatusSource, /className="flex w-3 shrink-0 items-center justify-center"/);
  // 工具组正文的外扩量必须大于行内元素的外扩量（行是 -mx-1.5 = 6px），
  // 否则 overflow-hidden 的裁剪线正好落在行的悬停底色与圆角上。
  assert.match(toolTraceSource, /className="-mx-3 overflow-hidden px-3 pt-0\.5"/);
  assert.match(toolCallItemSource, /flex h-3\.5 w-3 shrink-0 items-center justify-center/);
});

test("standalone work trace aligns its header with the assistant avatar", () => {
  assert.match(workTraceSource, /className=\{cn\("my-0 text-foreground\/60", className\)\}/);
  assert.match(
    bubbleSource,
    /<AssistantWorkTrace[\s\S]*?className="mt-0"[\s\S]*?hasDetails=/,
  );
});
