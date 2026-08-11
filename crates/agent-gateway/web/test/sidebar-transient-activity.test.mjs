import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { mergeTransientSidebarRunningActivity } = loader.loadModule(
  "@liveagent/ui/lib/sidebar/transientActivity.ts",
);
const gatewayAppSource = readFileSync(new URL("../src/app/GatewayApp.tsx", import.meta.url), "utf8");

test("manual compaction keeps its conversation and workspace running until terminal cleanup", () => {
  const runningConversationIds = new Set(["other-conversation"]);
  const runningProjectPathKeys = new Set(["/other/workspace"]);
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
});

test("manual compaction terminal settlement prevents stale timeout and acceptance errors", () => {
  assert.match(
    gatewayAppSource,
    /const clearManualCompactPendingRequest = useCallback\(\(operationId: string\) => \{[\s\S]*?manualCompactPendingRequestRef\.current = null;/,
  );
  assert.match(
    gatewayAppSource,
    /clearManualCompactPendingRequest\(pending\.operationId\) &&\s*isDisplayedConversation\(pending\.conversationId\)/,
  );
  assert.match(
    gatewayAppSource,
    /!response\.accepted &&\s*clearManualCompactPendingRequest\(operationId\) &&\s*isDisplayedConversation\(conversationIdValue\)/,
  );
  assert.match(
    gatewayAppSource,
    /if \(isDisplayedConversation\(targetConversationId\)\) \{\s*setChatError\(result\.message/,
  );
});
