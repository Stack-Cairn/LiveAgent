import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { parseSystemProxyPortDraft } = createTsModuleLoader().loadModule(
  "@liveagent/ui/pages/settings/systemProxyInput.ts",
);

test("proxy port drafts preserve the full numeric value instead of truncating it", () => {
  for (const [draft, expected] of [["7890", 7890], ["1", 1], ["65535", 65535], ["1e3", 1000]]) {
    assert.equal(parseSystemProxyPortDraft(draft), expected, draft);
  }
  for (const draft of ["", " ", "0", "-1", "65536", "7890.5", "1e-3", "7890abc", "NaN", "Infinity"]) {
    assert.equal(parseSystemProxyPortDraft(draft), 0, draft);
  }
});
