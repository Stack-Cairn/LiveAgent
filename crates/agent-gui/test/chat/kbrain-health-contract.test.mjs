import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const health = loader.loadModule("@liveagent/ui/lib/kbrain/health.ts");
const vectors = JSON.parse(
  readFileSync(new URL("../../../agent-ui/src/lib/kbrain/health-contract-vectors.json", import.meta.url), "utf8"),
);

for (const vector of vectors.accept) {
  test(`health contract accepts: ${vector.name}`, () => {
    const parsed = health.parseKBrainHealth(vector.body);
    assert.equal(parsed.legacy, vector.legacy);
    assert.deepEqual(parsed.protocol, { name: "kbrain.agent", major: 1, minor: vector.minor });
    if (vector.buildVersion) assert.equal(parsed.build?.version, vector.buildVersion);
    if (vector.instanceId) assert.equal(parsed.instanceId, vector.instanceId);
    if (vector.capabilityRevision) assert.equal(parsed.capabilityRevision, vector.capabilityRevision);
  });
}

for (const vector of vectors.reject) {
  test(`health contract rejects: ${vector.name}`, () => {
    assert.throws(() => health.parseKBrainHealth(vector.body), (error) => error instanceof health.KBrainHealthContractError);
  });
}

test("capability helpers apply the registered comparison per capability", () => {
  const parsed = health.parseKBrainHealth(vectors.accept.find((v) => v.name === "K0 structured health").body);
  assert.equal(health.hasFrozenCapability(parsed, "session_queue"), true);
  assert.equal(health.hasFrozenCapability({ capabilities: { session_queue: 2 } }, "session_queue"), false);
  assert.equal(health.hasFrozenCapability({ capabilities: { session_queue: "1" } }, "session_queue"), false);
  assert.equal(health.capabilityAtLeast(parsed, "session_changes", 2), true);
  assert.equal(health.capabilityAtLeast({ capabilities: { session_changes: 3 } }, "session_changes", 2), true);
  assert.equal(health.capabilityAtLeast({ capabilities: { session_changes: 1 } }, "session_changes", 2), false);
  assert.equal(health.capabilityAtLeast({ capabilities: {} }, "session_changes", 2), false);
  assert.equal(health.supportsPermissionMode(parsed, "auto_review"), true);
  assert.equal(health.supportsPermissionMode({ capabilities: { permission_modes: ["normal"] } }, "auto_review"), false);
  assert.equal(health.supportsPermissionMode({ capabilities: { permission_modes: "auto_review" } }, "auto_review"), false);
});

test("version mismatch keeps the established error wording", () => {
  assert.throws(
    () => health.parseKBrainHealth({ status: "ok", version: "wrong" }),
    /K-brain backend protocol mismatch \(reported version wrong\)/,
  );
});
