import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const remoteInput = loader.loadModule("src/pages/settings/remoteInput.ts");

test("web remote integer drafts stay editable while preserving valid values", () => {
  assert.equal(remoteInput.normalizeIntegerDraftInput(":50051"), "50051");
  assert.equal(remoteInput.normalizeIntegerDraftInput(" 12abc34 "), "1234");

  assert.equal(remoteInput.parseIntegerDraftValue("", { min: 1, max: 65_535 }), null);
  assert.equal(remoteInput.parseIntegerDraftValue("0", { min: 1, max: 65_535 }), null);
  assert.equal(remoteInput.parseIntegerDraftValue("443", { min: 1, max: 65_535 }), 443);
  assert.equal(remoteInput.parseIntegerDraftValue("65536", { min: 1, max: 65_535 }), 65_535);
});
