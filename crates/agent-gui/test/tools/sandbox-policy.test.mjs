import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveShellSandboxSettings } = loader.loadModule("src/lib/tools/sandboxPolicy.ts");
const { normalizeCommandSafetyMode, strictestCommandSafetyMode } = loader.loadModule(
  "src/lib/settings/index.ts",
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

// P2#6:未识别的模式值必须向严格侧收敛,不能静默降级成最宽松的非 ask 值。
test("unrecognized command safety modes fail closed to ask", () => {
  assert.equal(normalizeCommandSafetyMode(undefined), "auto");
  assert.equal(normalizeCommandSafetyMode(null), "auto");
  assert.equal(normalizeCommandSafetyMode("  "), "auto");
  for (const mode of ["ask", "auto", "sandbox", "sandboxOffline"]) {
    assert.equal(normalizeCommandSafetyMode(` ${mode} `), mode);
  }
  assert.equal(normalizeCommandSafetyMode("sandboxStrictest"), "ask");
  assert.equal(normalizeCommandSafetyMode("Auto"), "ask");
  assert.equal(normalizeCommandSafetyMode(1), "ask");
});

// P3#9:远端/排队快照只能收紧本地设置,绝不能放宽。
test("command safety mode clamping always keeps the stricter side", () => {
  assert.equal(strictestCommandSafetyMode("auto", "sandboxOffline"), "sandboxOffline");
  assert.equal(strictestCommandSafetyMode("sandboxOffline", "auto"), "sandboxOffline");
  assert.equal(strictestCommandSafetyMode("sandbox", "sandboxOffline"), "sandboxOffline");
  assert.equal(strictestCommandSafetyMode("auto", "sandbox"), "sandbox");
  assert.equal(strictestCommandSafetyMode("sandbox", "ask"), "ask");
  assert.equal(strictestCommandSafetyMode("auto", "auto"), "auto");
});
