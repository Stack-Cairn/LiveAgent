import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// 用 web 自己的模块加载器：CI 的 webui job 只装本包依赖，
// 借 agent-gui 的 helper 会在 runner 上找不到它的 node_modules。
const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const {
  absorbTrajectoryChatEvent,
  clearLiveTrajectory,
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  resetLiveTrajectoryForRebase,
} = loader.loadModule("src/lib/trajectory/liveTrajectory.ts");

test("rebase clears live events and invalidates the authoritative window", () => {
  const conversationId = "trajectory-rebase-test";
  clearLiveTrajectory(conversationId);
  const before = liveTrajectoryAuthoritativeRevision(conversationId);

  assert.equal(
    absorbTrajectoryChatEvent({
      type: "trajectory",
      conversation_id: conversationId,
      event: { k: "user", t: 1, at: 100, mi: 0 },
    }),
    true,
  );
  assert.equal(liveTrajectoryEvents(conversationId).length, 1);

  assert.equal(
    absorbTrajectoryChatEvent({ type: "rebased", conversation_id: conversationId }),
    false,
  );
  resetLiveTrajectoryForRebase(conversationId);
  assert.deepEqual(liveTrajectoryEvents(conversationId), []);
  assert.equal(liveTrajectoryAuthoritativeRevision(conversationId), before + 1);
});
