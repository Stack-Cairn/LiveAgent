import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the workspace sidebar tree is shown in agent mode on the K-brain backend too", async () => {
  const chatPage = await read("../../src/pages/ChatPage.tsx");
  assert.match(chatPage, /showProjects=\{isAgentMode\}/);
  assert.doesNotMatch(chatPage, /showProjects=\{[^}]*kBrainBackendEnabled/);
});

test("moving a conversation to another workspace is routed to K-brain instead of rejected", async () => {
  const history = await read("../../src/lib/chat/history/chatHistory.ts");
  assert.match(history, /if \(isKBrainHistory\(\)\) return setKBrainHistoryCwd\(id, cwd\);/);
  assert.doesNotMatch(history, /cannot be changed/);
});
