import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({ rootDir: fileURLToPath(new URL("../", import.meta.url)) });
const { rebuildTurnFromSnapshot } = loader.loadModule("src/lib/chat/transcript/turnReducer.ts");
const { groupHistoryEntriesIntoTurns, alignHistory } = loader.loadModule("src/lib/chat/transcript/historyAlignment.ts");
const user = { id: "u1", messageId: "u1", kind: "user", text: "same prompt", attachments: [] };
const notice = { id: "n1", messageId: "n1", kind: "user", text: "cancelled report", attachments: [], backgroundNotice: true };
const before = { id: "a1", kind: "assistant", text: "before", round: 1 };
const after = { id: "a2", kind: "assistant", text: "after", round: 2 };
const { parseHistoryMessagesJson } = loader.loadModule("src/lib/chatUi.ts");
const { trimLeadingHeadlessEntries } = loader.loadModule("src/lib/chat/historyWindow.ts");
const wireUser = (id, text, backgroundNotice = false) => ({
  id, role: "user", content: text,
  ...(backgroundNotice ? { liveAgentBackgroundNotice: true } : {}),
});
const wireReply = (id, text) => ({ id, role: "assistant", content: [{ type: "text", text }] });
const shownEntries = (result) => [
  ...result.historyEntries,
  ...result.turns.flatMap((turn) => [...(turn.user ? [turn.user] : []), ...turn.entries]),
];

test("lagged history preserves notice provenance confirmed by a final snapshot", () => {
  const seed = rebuildTurnFromSnapshot(
    { key: "run:origin", runId: "origin", phase: "settled", user, entries: [] },
    [user, before, notice, after],
  );
  const incoming = parseHistoryMessagesJson(JSON.stringify([
    wireUser("u1", "same prompt"), wireReply("a1", "before"),
    wireUser("n1", "cancelled report"), wireReply("a2", "after"),
  ]));
  const shown = shownEntries(alignHistory({ historyEntries: [], turns: [seed], entries: incoming, mode: "enrich" }));
  assert.equal(shown.find((entry) => entry.kind === "user" && entry.messageId === "n1")?.backgroundNotice, true);
  assert.equal(groupHistoryEntriesIntoTurns(shown).filter((turn) => turn.user !== null).length, 1);
});

test("a headless window merges new continuation through a known notice identity", () => {
  const original = [wireUser("u1", "same prompt"), wireReply("a1", "before"),
    wireUser("n1", "cancelled report", true), wireReply("a2", "after")];
  const seed = rebuildTurnFromSnapshot(
    { key: "run:window", runId: "window", phase: "settled", user: null, entries: [] },
    parseHistoryMessagesJson(JSON.stringify(original)),
  );
  const incoming = trimLeadingHeadlessEntries(parseHistoryMessagesJson(JSON.stringify([
    ...original.slice(2), wireUser("n2", "second report", true), wireReply("a3", "latest"),
  ])));
  const first = alignHistory({ historyEntries: [], turns: [seed], entries: incoming, mode: "enrich" });
  const repeated = alignHistory({ historyEntries: first.historyEntries, turns: first.turns, entries: incoming, mode: "enrich" });
  const shown = shownEntries(repeated);
  assert.deepEqual(shown.map((entry) => entry.text), ["same prompt", "before", "cancelled report", "after", "second report", "latest"]);
  assert.equal(groupHistoryEntriesIntoTurns(shown).filter((turn) => turn.user !== null).length, 1);
  assert.deepEqual(shownEntries(first).map((entry) => entry.id), shown.map((entry) => entry.id));
});

test("snapshot preserves notice order and the real input identity across repeated rebuilds", () => {
  const seed = { key: "run:r1", runId: "r1", phase: "settled", user, entries: [] };
  const parsed = [user, before, notice, after];
  const first = rebuildTurnFromSnapshot(seed, parsed);
  const second = rebuildTurnFromSnapshot(first, parsed);
  for (const turn of [first, second]) {
    assert.equal(turn.user.messageId, "u1");
    assert.deepEqual(turn.entries.map((e) => e.text), ["before", "cancelled report", "after"]);
    assert.equal(turn.entries[1].backgroundNotice, true);
  }
  assert.deepEqual(first.entries.map((e) => e.id), second.entries.map((e) => e.id));
});

test("idle enrichment adopts late notices and later continuation without replacing streamed prose", () => {
  const seed = { key: "run:r1", runId: "r1", phase: "settled", user, entries: [{ ...before, text: "full streamed answer" }] };
  const noticeOnly = alignHistory({ historyEntries: [], turns: [seed], entries: [user, before, notice], mode: "enrich" });
  assert.deepEqual(noticeOnly.turns[0].entries.map((e) => e.text), ["full streamed answer", "cancelled report"]);
  const complete = alignHistory({ historyEntries: [], turns: noticeOnly.turns, entries: [user, before, notice, after], mode: "enrich" });
  assert.deepEqual(complete.turns[0].entries.map((e) => e.text), ["full streamed answer", "cancelled report", "after"]);
  const repeated = alignHistory({ historyEntries: [], turns: complete.turns, entries: [user, before, notice, after], mode: "enrich" });
  assert.deepEqual(repeated.turns[0].entries.map((e) => e.text), ["full streamed answer", "cancelled report", "after"]);
  const lagged = alignHistory({ historyEntries: [], turns: repeated.turns, entries: [user, before, notice], mode: "enrich" });
  assert.deepEqual(lagged.turns[0].entries.map((e) => e.text), ["full streamed answer", "cancelled report", "after"]);
});

test("idle enrichment counts real inputs, so a second late notice is visible", () => {
  const previous = [user, before, notice, after];
  const second = { ...notice, id: "n2", messageId: "n2", text: "second report" };
  const entries = [...previous, second, { ...after, id: "a3", text: "third answer" }];
  const result = alignHistory({ historyEntries: previous, turns: [], entries, mode: "enrich" });
  assert.equal(result.changed, true);
  assert.deepEqual(result.historyEntries, entries);
});

test("equal-sized stale notice snapshots cannot shorten prose or tool results", () => {
  const tool = {
    id: "t1", kind: "tool_result", round: 2, text: "complete output",
    summary: "Bash result",
    toolResult: { toolCallId: "call-1", toolName: "Bash", content: [{ type: "text", text: "complete output" }], isError: false },
  };
  const seed = { key: "run:r1", runId: "r1", phase: "settled", user, entries: [before, notice, { ...after, text: "complete answer" }, tool] };
  const staleTool = { ...tool, text: "complete", toolResult: { ...tool.toolResult, content: [{ type: "text", text: "complete" }] } };
  const result = alignHistory({ historyEntries: [], turns: [seed], entries: [user, before, notice, { ...after, text: "complete" }, staleTool], mode: "enrich" });
  assert.deepEqual(result.turns[0].entries.map((e) => e.text), ["before", "cancelled report", "complete answer", "complete output"]);
  assert.deepEqual(result.turns[0].entries[3].toolResult, tool.toolResult);
});

test("notice continuation extends known content and inserts new identities once", () => {
  const seed = { key: "run:r1", runId: "r1", phase: "settled", user, entries: [before, notice, { ...after, text: "complete" }] };
  const second = { ...notice, id: "n2", messageId: "n2", text: "second report" };
  const entries = [user, before, notice, { ...after, text: "complete answer" }, second, { ...after, id: "a3", text: "last answer" }];
  const first = alignHistory({ historyEntries: [], turns: [seed], entries, mode: "enrich" });
  const repeated = alignHistory({ historyEntries: first.historyEntries, turns: first.turns, entries, mode: "enrich" });
  assert.deepEqual(repeated.turns[0].entries.map((e) => e.text), ["before", "cancelled report", "complete answer", "second report", "last answer"]);
  assert.deepEqual(first.turns[0].entries.map((e) => e.id), repeated.turns[0].entries.map((e) => e.id));
});

test("idle enrichment repairs explicit notice provenance by message identity", () => {
  const oldNotice = { ...notice, backgroundNotice: undefined };
  const previous = [user, before, oldNotice, after];
  const result = alignHistory({ historyEntries: previous, turns: [], entries: [user, before, notice, after], mode: "enrich" });
  assert.equal(result.changed, true);
  assert.equal(result.historyEntries[2].backgroundNotice, true);
  assert.deepEqual(result.historyEntries.map((entry) => entry.id), previous.map((entry) => entry.id));
});

test("a suffix window can repair a matching notice without deleting older inputs", () => {
  const older = { ...user, id: "older", messageId: "older" };
  const oldNotice = { ...notice, backgroundNotice: undefined };
  const previous = [older, { ...before, id: "older-answer" }, user, before, oldNotice, after];
  const result = alignHistory({ historyEntries: previous, turns: [], entries: [user, before, notice, after], mode: "enrich" });
  assert.equal(result.changed, true);
  assert.equal(result.historyEntries[4].backgroundNotice, true);
  assert.deepEqual(result.historyEntries.map((entry) => entry.id), previous.map((entry) => entry.id));
});

test("a lagging snapshot cannot remove established notice provenance", () => {
  const previous = [user, before, notice, after];
  const result = alignHistory({ historyEntries: previous, turns: [], entries: [user, before, { ...notice, backgroundNotice: undefined }, after], mode: "enrich" });
  assert.equal(result.historyEntries[2].backgroundNotice, true);
  assert.equal(result.changed, false);
});

test("notice continuation upgrades only an extension of a known tool result", () => {
  const tool = {
    id: "t1", kind: "tool_result", round: 2, text: "complete",
    summary: "Bash result",
    toolResult: { toolCallId: "call-1", toolName: "Bash", content: [{ type: "text", text: "complete" }], isError: false },
  };
  const full = { ...tool, text: "complete output", toolResult: { ...tool.toolResult, content: [{ type: "text", text: "complete output" }] } };
  const seed = { key: "run:r1", runId: "r1", phase: "settled", user, entries: [before, notice, tool] };
  const result = alignHistory({ historyEntries: [], turns: [seed], entries: [user, before, notice, full], mode: "enrich" });
  assert.deepEqual(result.turns[0].entries[2].toolResult, full.toolResult);
  const lagged = alignHistory({ historyEntries: [], turns: result.turns, entries: [user, before, notice, tool], mode: "enrich" });
  assert.deepEqual(lagged.turns[0].entries[2].toolResult, full.toolResult);
});

test("new continuation entries keep order when a stale snapshot omits a known notice", () => {
  const second = { ...notice, id: "n2", messageId: "n2", text: "second report" };
  const third = { ...after, id: "a3", round: 3, text: "last answer" };
  const seed = { key: "run:r1", runId: "r1", phase: "settled", user, entries: [before, notice, after, second, third] };
  const result = alignHistory({ historyEntries: [], turns: [seed], entries: [user, before, notice, after], mode: "enrich" });
  assert.deepEqual(result.turns[0].entries.map((e) => e.text), seed.entries.map((e) => e.text));
});

test("history treats notices as content, keeping repeated real inputs separate", () => {
  const repeated = { ...user, id: "u2", messageId: "u2" };
  const turns = groupHistoryEntriesIntoTurns([user, before, notice, after, repeated]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user.messageId, "u1");
  assert.deepEqual(turns[0].entries.map((e) => e.text), ["before", "cancelled report", "after"]);
  assert.equal(turns[1].user.messageId, "u2");
  const headless = groupHistoryEntriesIntoTurns([notice, after]);
  assert.equal(headless[0].user, null);
  assert.equal(headless[0].entries[0].backgroundNotice, true);
});
