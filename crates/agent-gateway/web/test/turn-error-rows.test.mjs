import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// A failed turn's error is the round's (rendered as the shared error row), never
// assistant markdown: from K-brain history and from a live failure alike.

const loader = createWebModuleLoader({ rootDir: fileURLToPath(new URL("../", import.meta.url)) });
const { parseHistoryMessagesJson } = loader.loadModule("src/lib/chatUi.ts");
const { buildRowsFromEntries } = loader.loadModule("src/lib/chat/transcript/rows.ts");
const { applyEventToTurn, createTurn } = loader.loadModule("src/lib/chat/transcript/turnReducer.ts");
const { isInterruptedByShutdown, isStoppedReply, turnErrorDetailOf, turnErrorOf } = loader.loadModule(
  "@liveagent/ui/lib/chat/assistantStatus.ts",
);

const AUTH_ERROR =
  '401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-fake***.","code":"invalid_api_key"}}';

const replyText = (row) =>
  row.rounds.flatMap((round) => round.blocks).filter((block) => block.kind === "text").map((block) => block.text).join("");

test("K-brain's synthetic error message becomes the round's error, not reply text", () => {
  const entries = parseHistoryMessagesJson(
    JSON.stringify([
      { id: "u1", role: "user", content: "hello" },
      {
        id: "assistant-error-run-1",
        role: "assistant",
        content: [{ type: "text", text: AUTH_ERROR }],
        stopReason: "error",
      },
    ]),
  );
  const rows = buildRowsFromEntries(entries, "history");
  const reply = rows.at(-1);
  assert.equal(reply.kind, "assistant");
  assert.equal(replyText(reply), "");
  assert.equal(turnErrorOf(reply.rounds), AUTH_ERROR);
});

test("an ordinary failed reply keeps its text", () => {
  const entries = parseHistoryMessagesJson(
    JSON.stringify([
      { id: "u1", role: "user", content: "hello" },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error" },
    ]),
  );
  assert.equal(replyText(buildRowsFromEntries(entries, "history").at(-1)), "partial");
});

test("a live failure keeps the streamed text and adds the error once", () => {
  let turn = createTurn({ key: "run:r1", runId: "r1", phase: "streaming" });
  turn = applyEventToTurn(turn, { type: "token", text: "Here is the first part " });
  turn = applyEventToTurn(turn, { type: "error", message: "unexpected EOF" });
  turn = applyEventToTurn(turn, { type: "error", message: "unexpected EOF" });
  const rows = buildRowsFromEntries(turn.entries, "live");
  const reply = rows.at(-1);
  assert.equal(replyText(reply), "Here is the first part ");
  assert.equal(turnErrorOf(reply.rounds), "unexpected EOF");
  assert.equal(turn.entries.filter((entry) => entry.meta?.errorMessage).length, 1);
});

test("a reply cut off by a failure reopens with its text and its error", () => {
  const entries = parseHistoryMessagesJson(
    JSON.stringify([
      { id: "u1", role: "user", content: "tell me a story" },
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Here is the first part" }],
        stopReason: "error",
        errorMessage: "unexpected EOF",
        errorDetail: { kind: "connection_lost" },
      },
    ]),
  );
  const reply = buildRowsFromEntries(entries, "history").at(-1);
  assert.equal(replyText(reply), "Here is the first part");
  assert.equal(turnErrorOf(reply.rounds), "unexpected EOF");
  assert.deepEqual(turnErrorDetailOf(reply.rounds), { kind: "connection_lost" });
});

test("a failure's classification reaches the error row", () => {
  const entries = parseHistoryMessagesJson(
    JSON.stringify([
      { id: "u1", role: "user", content: "hello" },
      {
        id: "assistant-error-run-1",
        role: "assistant",
        content: [{ type: "text", text: AUTH_ERROR }],
        stopReason: "error",
        errorDetail: { kind: "invalid_api_key", upstreamStatus: 401, providerMessage: "Incorrect API key" },
      },
    ]),
  );
  const reply = buildRowsFromEntries(entries, "history").at(-1);
  assert.deepEqual(turnErrorDetailOf(reply.rounds), {
    kind: "invalid_api_key",
    upstreamStatus: 401,
    providerMessage: "Incorrect API key",
  });
});

test("a turn stopped before any output reopens as stopped, and a restart says so", () => {
  const entries = parseHistoryMessagesJson(
    JSON.stringify([
      { id: "u1", role: "user", content: "say something" },
      { id: "assistant-stopped-run-1", role: "assistant", content: [], stopReason: "aborted" },
      { id: "u2", role: "user", content: "and again" },
      {
        id: "assistant-stopped-run-2",
        role: "assistant",
        content: [],
        stopReason: "aborted",
        cancelReason: "shutdown",
      },
    ]),
  );
  const replies = buildRowsFromEntries(entries, "history").filter((row) => row.kind === "assistant");
  assert.equal(replies.length, 2);
  assert.ok(replies.every((row) => isStoppedReply(row.rounds)));
  assert.equal(isInterruptedByShutdown(replies[0].rounds), false);
  assert.equal(isInterruptedByShutdown(replies[1].rounds), true);
});
