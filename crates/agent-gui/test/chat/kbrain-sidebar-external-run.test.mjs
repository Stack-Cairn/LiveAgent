import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { externalRunOf } = loader.loadModule("src/lib/kbrain/history.ts");
const reconcile = loader.loadModule("@liveagent/ui/lib/sidebar/reconcile.ts");
const types = loader.loadModule("@liveagent/ui/lib/sidebar/types.ts");

function conversation(id, overrides = {}) {
  return {
    id,
    title: id,
    providerId: "provider",
    model: "model",
    createdAt: 1,
    updatedAt: overrides.updatedAt ?? 1,
    ...("externalRun" in overrides ? { externalRun: overrides.externalRun } : {}),
  };
}

test("external_run from K-brain maps to a sidebar run owner", () => {
  assert.deepEqual(
    externalRunOf({ external_run: { client: "kn", pid: 42, started_at: "2026-11-09T01:02:03Z" } }),
    { client: "kn", startedAt: Date.parse("2026-11-09T01:02:03Z") },
  );
  assert.equal(externalRunOf({}), undefined);
  assert.equal(externalRunOf({ external_run: { client: " ", started_at: "" } }), undefined);
  assert.deepEqual(externalRunOf({ external_run: { client: "kn", started_at: "bogus" } }), {
    client: "kn",
    startedAt: 0,
  });
});

test("a backend summary without external_run clears the running marker", () => {
  const run = { client: "kn", startedAt: 5 };
  const running = reconcile.mergeSidebarConversation(
    conversation("s", { updatedAt: 1 }),
    conversation("s", { updatedAt: 2, externalRun: run }),
  );
  assert.deepEqual(running.externalRun, run);

  // Same run again keeps the object identity (no re-render).
  const same = reconcile.mergeSidebarConversation(
    running,
    conversation("s", { updatedAt: 2, externalRun: { client: "kn", startedAt: 5 } }),
  );
  assert.equal(same, running);

  // Partial local updates leave it alone; a summary with the key unset clears it.
  const partial = reconcile.mergeSidebarConversation(running, conversation("s", { updatedAt: 3 }));
  assert.deepEqual(partial.externalRun, run);
  const done = reconcile.mergeSidebarConversation(
    running,
    conversation("s", { updatedAt: 4, externalRun: undefined }),
  );
  assert.equal(done.externalRun, undefined);
});

test("sameExternalRun compares owner and start time", () => {
  assert.equal(types.sameExternalRun(undefined, undefined), true);
  assert.equal(types.sameExternalRun({ client: "kn", startedAt: 1 }, undefined), false);
  assert.equal(types.sameExternalRun({ client: "kn", startedAt: 1 }, { client: "kn", startedAt: 2 }), false);
  assert.equal(types.sameExternalRun({ client: "kn", startedAt: 1 }, { client: "kn", startedAt: 1 }), true);
});
