import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("conversation mention search uses complete indexed history, deduplicates, and ranks cwd", async () => {
  const calls = [];
  const { searchMentionConversations } = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/lib/chat/historySearch": {
        async searchChatHistory() {
          throw new Error("mention search must not use global navigation search");
        },
      },
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
      "@liveagent/ui/lib/chat/historySearch": {
        async searchChatHistory() {
          throw new Error("empty mention search must not use global navigation search");
        },
      },
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

test("sidebar conversation search uses the global history API and ranks without filtering workdirs", async () => {
  const { searchPersistedConversations } = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/lib/chat/historySearch": {
        async searchChatHistory(args) {
          assert.deepEqual(args, { query: "release notes", limit: 80 });
          return {
            matches: [
              {
                conversationId: "other-workspace",
                title: "Remote release notes",
                cwd: "/repo/b",
                snippet: "assistant: [release notes] from another workspace",
                score: 12,
                updatedAt: 60,
              },
              {
                conversationId: "current-workspace",
                title: "Release planning",
                cwd: "/repo/a",
                snippet: "assistant: [release notes] are ready",
                score: 4,
                updatedAt: 50,
              },
              {
                conversationId: "global-chat",
                title: "Chat without a workspace",
                cwd: null,
                snippet: "user: [release notes]",
                score: 8,
                updatedAt: 55,
              },
            ],
          };
        },
      },
      "@liveagent/ui/lib/memory/api": {
        async memorySearch() {
          throw new Error("sidebar navigation search must not use memory_search");
        },
      },
    },
  }).loadModule("@liveagent/ui/lib/chat/conversationSearch");

  const results = await searchPersistedConversations({
    query: "release notes",
    currentWorkdir: "/repo/a",
  });

  assert.deepEqual(
    results.map((result) => result.id),
    ["current-workspace", "other-workspace", "global-chat"],
  );
  assert.equal(results[0].searchPreview, "assistant: [release notes] are ready");
});

test("global history API invokes the dedicated chat history command", async () => {
  const calls = [];
  const { searchChatHistory } = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": {
        async invoke(command, args) {
          calls.push({ command, args });
          return { matches: [] };
        },
      },
    },
  }).loadModule("@liveagent/ui/lib/chat/historySearch");

  assert.deepEqual(await searchChatHistory({ query: "global", limit: 12 }), { matches: [] });
  assert.deepEqual(calls, [
    {
      command: "chat_history_search",
      args: { args: { query: "global", limit: 12 } },
    },
  ]);
});

test("Gateway shim forwards global history search without a workdir scope", async () => {
  const calls = [];
  const gatewayRoot = new URL("../../../agent-gateway/web", import.meta.url).pathname;
  const { invoke } = createTsModuleLoader({
    rootDir: gatewayRoot,
    mocks: {
      "../lib/gatewaySocket": {
        getGatewayWebSocketClient(token) {
          assert.equal(token, "gateway-token");
          return {
            async memoryManage(payload) {
              calls.push(payload);
              return { matches: [] };
            },
          };
        },
      },
      "../lib/storage": {
        loadToken() {
          return "gateway-token";
        },
      },
      "./browserPathPrompt": {
        async promptPathInBrowser() {
          throw new Error("path prompt must not be used by history search");
        },
      },
    },
  }).loadModule("src/shims/tauriCore");

  assert.deepEqual(
    await invoke("chat_history_search", { args: { query: "global", limit: 12 } }),
    { matches: [] },
  );
  assert.deepEqual(calls, [
    {
      command: "chat_history_search",
      args: { query: "global", limit: 12 },
    },
  ]);
});
