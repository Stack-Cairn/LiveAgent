// With aiApproval.perRun the backend reviews auto-review runs with the session's own model
// when no reviewer model is configured, so the composer must not warn that auto review
// needs a model. Without perRun (older backend) the reviewer pair must still be routable.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { isAIApprovalReviewerConfigured } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/settings/aiApprovalReadiness.ts",
);

test("a per-run backend needs no reviewer model; an older one needs a routable pair", () => {
  assert.equal(isAIApprovalReviewerConfigured({ aiApproval: { mode: "off", perRun: true }, models: [] }), true);
  assert.equal(isAIApprovalReviewerConfigured({ aiApproval: { mode: "off" }, models: [] }), false);
  assert.equal(
    isAIApprovalReviewerConfigured({
      aiApproval: { mode: "off", provider: "p", model: "m" },
      models: [{ provider: "p", id: "m" }],
    }),
    true,
  );
});
