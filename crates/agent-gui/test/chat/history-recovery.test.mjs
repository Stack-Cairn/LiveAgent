import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function summary(id) {
  return {
    id,
    title: id,
    providerId: "provider",
    model: "model",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("listAllChatHistory reads every page and de-duplicates summaries", async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => summary(`conversation-${index}`));
  const calls = [];
  const parserPath = fileURLToPath(
    new URL("../../src/lib/chat/history/chatHistoryParser.ts", import.meta.url),
  );
  const loader = createTsModuleLoader({
    mocks: {
      [parserPath]: {
        parseHistorySegments: async () => [],
      },
      "@tauri-apps/api/core": {
        invoke(_command, args) {
          calls.push(args);
          if (args.page === 1) {
            return Promise.resolve({ items: firstPage, totalCount: 201 });
          }
          return Promise.resolve({
            items: [summary("conversation-199"), summary("conversation-200")],
            totalCount: 201,
          });
        },
      },
    },
  });
  const { listAllChatHistory } = loader.loadModule("src/lib/chat/history/chatHistory.ts");

  const items = await listAllChatHistory({ cwd: "C:/workspace" });

  assert.equal(items.length, 201);
  assert.equal(new Set(items.map((item) => item.id)).size, 201);
  assert.deepEqual(
    calls.map((args) => [args.page, args.pageSize, args.cwd]),
    [
      [1, 200, "C:/workspace"],
      [2, 200, "C:/workspace"],
    ],
  );
});
