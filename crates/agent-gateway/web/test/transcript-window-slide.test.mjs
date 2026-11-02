// The WebUI transcript pairs settled turns from the newest end, so a sliding
// newest-N history window must not duplicate a reply that just persisted.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { buildRowsFromEntries, buildTurnRows } = loader.loadModule(
  "src/lib/chat/transcript/rows.ts",
);
const { createTurn, applyEventToTurn } = loader.loadModule(
  "src/lib/chat/transcript/turnReducer.ts",
);
const { alignHistory } = loader.loadModule("src/lib/chat/transcript/historyAlignment.ts");

function ref(messageId, messageIndex) {
  return {
    segmentIndex: 0,
    messageIndex,
    segmentId: "kbrain:s",
    messageId,
    role: "user",
    contentHash: `hash-${messageId}`,
  };
}

function exchange(tag, index, reply, tools = 0) {
  const user = { id: `hu:${tag}`, kind: "user", text: `prompt ${tag}`, attachments: [], messageRef: ref(tag, index) };
  const entries = [user];
  for (let call = 0; call < tools; call += 1) {
    entries.push({
      id: `ht:hu:${tag}>${call}`,
      kind: "tool_call",
      round: call + 1,
      toolCall: { type: "toolCall", id: `${tag}-call-${call}`, name: "Read", arguments: {} },
      summary: "Read",
      text: "{}",
    });
  }
  entries.push({ id: `ht:hu:${tag}>final`, kind: "assistant", text: reply, round: tools + 1 });
  return entries;
}

function settledTurn(userText, replyText) {
  let turn = createTurn({ key: "req:new", runId: "run-new", phase: "settled" });
  turn = {
    ...turn,
    user: { id: "ou:req:new", kind: "user", text: userText, attachments: [] },
  };
  turn = applyEventToTurn(turn, { type: "token", text: replyText, round: 1 });
  return { ...turn, phase: "settled" };
}

function countReplyRows(result, text) {
  const rows = [
    ...buildRowsFromEntries(result.historyEntries, "history"),
    ...result.turns.flatMap((turn) => buildTurnRows(turn)),
  ];
  return rows.filter(
    (row) =>
      row.kind === "assistant" &&
      row.rounds.some((round) => round.blocks.some((block) => block.kind === "text" && block.text === text)),
  ).length;
}

test("WebUI enrich: a sliding window that drops the oldest exchange keeps one reply", () => {
  const region = [...exchange("m0", 0, "reply 0", 1), ...exchange("m1", 3, "reply 1", 1)];
  const turn = settledTurn("prompt m2", "new reply");
  // Newest-N window after the tool-heavy reply persisted: m0 slid out.
  const entries = [...exchange("m1", 3, "reply 1", 1), ...exchange("m2", 6, "new reply", 4)];
  const result = alignHistory({ historyEntries: region, turns: [turn], entries, mode: "enrich" });
  assert.equal(countReplyRows(result, "new reply"), 1);
  assert.equal(countReplyRows(result, "reply 1"), 1);
});

test("WebUI enrich: a reply longer than the window (prompt slid out) keeps one reply", () => {
  const region = [...exchange("m0", 0, "reply 0", 1), ...exchange("m1", 3, "reply 1", 1)];
  const turn = settledTurn("prompt m2", "new reply");
  const headless = exchange("m2", 6, "new reply", 8).slice(4);
  const result = alignHistory({ historyEntries: region, turns: [turn], entries: headless, mode: "enrich" });
  assert.equal(countReplyRows(result, "new reply"), 1);
});

test("WebUI replace: reopening after the slide keeps one reply", () => {
  const turn = settledTurn("prompt m2", "new reply");
  const entries = [...exchange("m1", 3, "reply 1", 1), ...exchange("m2", 6, "new reply", 4)];
  const result = alignHistory({ historyEntries: [], turns: [turn], entries, mode: "replace" });
  assert.equal(countReplyRows(result, "new reply"), 1);
});
