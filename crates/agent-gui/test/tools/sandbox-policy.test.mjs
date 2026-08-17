import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { resolveShellSandboxSettings } = createTsModuleLoader().loadModule(
  "src/lib/tools/sandboxPolicy.ts",
);

test("command safety modes resolve to one explicit shell sandbox contract", () => {
  assert.equal(resolveShellSandboxSettings("ask"), undefined);
  assert.equal(resolveShellSandboxSettings("auto"), undefined);
  assert.deepEqual(resolveShellSandboxSettings("sandbox"), {
    enabled: true,
    allowNetwork: true,
  });
  assert.deepEqual(resolveShellSandboxSettings("sandboxOffline"), {
    enabled: true,
    allowNetwork: false,
  });
});

test("missing safety modes preserve the existing unsandboxed default", () => {
  assert.equal(resolveShellSandboxSettings(undefined), undefined);
  assert.equal(resolveShellSandboxSettings(null), undefined);
});
