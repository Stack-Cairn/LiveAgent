import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { mergeTransientSidebarRunningActivity } = loader.loadModule(
  "@liveagent/ui/lib/sidebar/transientActivity.ts",
);
const gatewayAppSource = [
  "../src/app/GatewayApp.tsx",
  "../src/app/hooks/useGatewayChatPresentation.tsx",
  "../src/app/hooks/useGatewayConversationRuntime.ts",
]
  .map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"))
  .join("\n");

test("manual compaction keeps its conversation and workspace running until terminal cleanup", () => {
  const runningConversationIds = new Set(["other-conversation"]);
  const runningProjectPathKeys = new Set(["/other/workspace"]);
  // 向后兼容：单对象入参仍被接受。
  const merged = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    {
      conversationId: "conversation-1",
      workdir: "/workspace/project/",
    },
  );

  assert.deepEqual([...merged.runningConversationIds], ["other-conversation", "conversation-1"]);
  assert.deepEqual([...merged.runningProjectPathKeys], ["/other/workspace", "/workspace/project"]);

  const cleared = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    null,
  );
  assert.equal(cleared.runningConversationIds, runningConversationIds);
  assert.equal(cleared.runningProjectPathKeys, runningProjectPathKeys);

  const clearedEmptyArray = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    [],
  );
  assert.equal(clearedEmptyArray.runningConversationIds, runningConversationIds);
  assert.equal(clearedEmptyArray.runningProjectPathKeys, runningProjectPathKeys);
});

test("multiple manual compactions keep every pending conversation and workspace running (defect #3)", () => {
  const runningConversationIds = new Set(["other-conversation"]);
  const runningProjectPathKeys = new Set(["/other/workspace"]);
  const merged = mergeTransientSidebarRunningActivity(
    runningConversationIds,
    runningProjectPathKeys,
    [
      { conversationId: "conversation-1", workdir: "/workspace/one/" },
      { conversationId: "conversation-2", workdir: "/workspace/two/" },
      // null/undefined 条目被跳过。
      null,
      undefined,
      // 重复会话/工作区不重复计入。
      { conversationId: "conversation-1", workdir: "/workspace/one/" },
    ],
  );

  assert.deepEqual(
    [...merged.runningConversationIds],
    ["other-conversation", "conversation-1", "conversation-2"],
  );
  assert.deepEqual(
    [...merged.runningProjectPathKeys],
    ["/other/workspace", "/workspace/one", "/workspace/two"],
  );
});

test("manual compaction pending is keyed per conversation, never a global singleton (defect #3)", () => {
  // pending 按会话 id 键化：state + ref 经唯一 setter/clearer 同步写。
  assert.match(
    gatewayAppSource,
    /useState<\s*ReadonlyMap<string, ManualCompactPendingRequest>\s*>/,
  );
  assert.match(
    gatewayAppSource,
    /const clearManualCompactPendingRequest = useCallback\(\s*\(conversationId: string, operationId: string\) => \{[\s\S]*?next\.delete\(conversationId\);/,
  );
  // handleManualCompact 只在“同会话”已有 pending 时拒绝。
  assert.match(
    gatewayAppSource,
    /manualCompactPendingRef\.current\.has\(conversationId\)/,
  );
  // 受理拒绝（!accepted）按 (conversationId, operationId) 清 pending。
  assert.match(
    gatewayAppSource,
    /!response\.accepted &&\s*clearManualCompactPendingRequest\(conversationId, operationId\) &&\s*isDisplayedConversation\(conversationId\)/,
  );
});

test("manual compaction terminal settlement surfaces the result even for background conversations (defect #4)", () => {
  // settle 无条件 setChatError（不再以 isDisplayedConversation 门控），使切走的
  // 会话压缩失败/跳过也能提示。
  assert.match(
    gatewayAppSource,
    /if \(!clearManualCompactPendingRequest\(targetConversationId, result\.operationId\)\) return;[\s\S]*?setChatError\(result\.message \|\| translate\(fallbackKey, locale\)\);/,
  );
  assert.doesNotMatch(
    gatewayAppSource,
    /if \(isDisplayedConversation\(targetConversationId\)\) \{\s*setChatError\(result\.message/,
  );
});
