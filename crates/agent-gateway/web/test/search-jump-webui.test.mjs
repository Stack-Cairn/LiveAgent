import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { parseHistoryMessagesJson } = loader.loadModule("src/lib/chatUi.ts");
const { buildRowsFromEntries } = loader.loadModule("src/lib/chat/transcript/rows.ts");
const { transcriptRowsToJumpCandidates } = loader.loadModule(
  "src/lib/chat/transcript/searchJumpCandidates.ts",
);
const { resolveSearchJumpRowKey } = loader.loadModule(
  "../../agent-ui/src/lib/chat/searchJumpTarget.ts",
);

// A K-brain Gateway history window m100..m109 (user/assistant alternating),
// as historyMessagesJSON emits it: each entry carries its canonical offset.
function windowRows(first = 100, count = 10) {
  const messages = Array.from({ length: count }, (_, i) => {
    const index = first + i;
    const role = index % 2 === 0 ? "user" : "assistant";
    return {
      id: `m${index}`,
      role,
      content: [{ type: "text", text: `${role} ${index}` }],
      messageIndex: index,
      timestamp: 1_000 + index,
    };
  });
  return buildRowsFromEntries(parseHistoryMessagesJson(JSON.stringify(messages)), "history");
}

function resolve(rows, messageId, messageIndex) {
  return resolveSearchJumpRowKey(transcriptRowsToJumpCandidates(rows), {
    conversationId: "c",
    messageId,
    messageIndex,
  });
}

function userKeyFor(rows, messageId) {
  return rows.find((row) => row.kind === "user" && row.messageRef?.messageId === messageId)?.key;
}

test("WebUI search jump maps a loaded assistant hit to its preceding user row", () => {
  const rows = windowRows();
  assert.equal(resolve(rows, "m101", 101), userKeyFor(rows, "m100"));
  assert.equal(resolve(rows, "m107", 107), userKeyFor(rows, "m106"));
});

test("WebUI search jump keeps paging when the hit precedes the loaded window", () => {
  const rows = windowRows();
  assert.equal(resolve(rows, "m51", 51), null);
});

test("WebUI search jump matches user hits by message id", () => {
  const rows = windowRows();
  assert.equal(resolve(rows, "m104", 104), userKeyFor(rows, "m104"));
});
