import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("assistant timestamp shares the action-button hover chrome", () => {
  const source = read("../../../agent-ui/src/components/chat/TranscriptMessageActions.tsx");
  const assistantFn = source.slice(source.indexOf("export function TranscriptAssistantMessageActions"));
  const chromeOpen = assistantFn.indexOf(
    "pointer-events-none flex items-center gap-0.5 opacity-100 transition-opacity",
  );
  const chromeClose = assistantFn.indexOf("</div>", chromeOpen);
  const timestamp = assistantFn.indexOf("<TranscriptTimestampLabel");

  assert.ok(chromeOpen > -1, "assistant action chrome container not found");
  assert.ok(timestamp > chromeOpen && timestamp < chromeClose, "timestamp must live inside the action chrome");
  assert.equal(
    assistantFn.includes("text-muted-foreground/70"),
    false,
    "timestamp must not use a color/opacity modifier that can fight hover hide",
  );
  assert.equal(
    (assistantFn.match(/has-hover:\[\[data-assistant-row\]:hover_&\]:opacity-100/g) ?? []).length,
    1,
    "assistant reply should have one hover-chrome container, not a sibling clock",
  );
});
