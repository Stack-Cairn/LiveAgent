import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  absorbTrajectoryChatEvent,
  clearLiveTrajectory,
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
} = loader.loadModule(
  fileURLToPath(new URL("../src/lib/trajectory/liveTrajectory.ts", import.meta.url)),
);

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
  assert.deepEqual(liveTrajectoryEvents(conversationId), []);
  assert.equal(liveTrajectoryAuthoritativeRevision(conversationId), before + 1);
});
