import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("conversation mention search uses complete indexed history, deduplicates, and ranks cwd", async () => {
  const calls = [];
  const { searchMentionConversations } = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/lib/memory/api": {
        async memorySearch(args) {
          calls.push(args);
          return {
            matches: [],
            historyMatches: [
              {
                conversationId: "other-project",
                title: "Remote match",
                cwd: "/repo/b",
                snippet: " remote   excerpt ",
                score: 10,
                updatedAt: 30,
              },
              {
                conversationId: "same-project",
                title: "Local match",
                cwd: "/repo/a",
                snippet: "older local excerpt",
                score: 5,
                updatedAt: 20,
              },
              {
                conversationId: "same-project",
                title: "Local match",
                cwd: "/repo/a",
                snippet: "better local excerpt",
                score: 7,
                updatedAt: 20,
              },
              {
                conversationId: "current",
                title: "Current conversation",
                cwd: "/repo/a",
                snippet: "must be excluded",
                score: 100,
                updatedAt: 40,
              },
            ],
          };
        },
      },
    },
  }).loadModule("@liveagent/ui/lib/chat/conversationSearch");

  const results = await searchMentionConversations({
    query: "login issue",
    currentConversationId: "current",
    currentWorkdir: "/repo/a",
  });

  assert.deepEqual(calls, [{ query: "login issue", includeHistory: true, limit: 80 }]);
  assert.deepEqual(
    results.map((result) => result.id),
    ["same-project", "other-project"],
  );
  assert.equal(results[0].searchPreview, "better local excerpt");
  assert.equal(results[1].searchPreview, "remote excerpt");
});

test("conversation mention search skips the backend for an empty query", async () => {
  let calls = 0;
  const { searchMentionConversations } = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/lib/memory/api": {
        async memorySearch() {
          calls += 1;
          return { matches: [], historyMatches: [] };
        },
      },
    },
  }).loadModule("@liveagent/ui/lib/chat/conversationSearch");

  assert.deepEqual(
    await searchMentionConversations({ query: "  ", currentConversationId: "current" }),
    [],
  );
  assert.equal(calls, 0);
});

test("sidebar conversation search includes the current conversation and returns content previews", async () => {
  const { searchPersistedConversations } = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/lib/memory/api": {
        async memorySearch(args) {
          assert.deepEqual(args, { query: "release notes", includeHistory: true, limit: 80 });
          return {
            matches: [],
            historyMatches: [
              {
                conversationId: "current",
                title: "Release planning",
                cwd: "/repo/a",
                snippet: "assistant: [release notes] are ready",
                score: 4,
                updatedAt: 50,
              },
            ],
          };
        },
      },
    },
  }).loadModule("@liveagent/ui/lib/chat/conversationSearch");

  const results = await searchPersistedConversations({
    query: "release notes",
    currentWorkdir: "/repo/a",
  });

  assert.deepEqual(results, [
    {
      id: "current",
      title: "Release planning",
      cwd: "/repo/a",
      updatedAt: 50,
      searchPreview: "assistant: [release notes] are ready",
    },
  ]);
});
