import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const thinking = loader.loadModule("@liveagent/ui/lib/models/modelThinking.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

test("modelThinking.ts 仅保留共享实现", () => {
  const webPath = fileURLToPath(new URL("../src/lib/models/modelThinking.ts", import.meta.url));
  const guiPath = fileURLToPath(
    new URL("../../../agent-gui/src/lib/models/modelThinking.ts", import.meta.url),
  );
  const sharedPath = fileURLToPath(
    new URL("../../../agent-ui/src/lib/models/modelThinking.ts", import.meta.url),
  );
  assert.equal(existsSync(webPath), false);
  assert.equal(existsSync(guiPath), false);
  assert.equal(existsSync(sharedPath), true);
});

test("web thinking wrappers delegate to the shared resolver", () => {
  assert.deepEqual(settings.getKnownModelThinkingLevels("claude_code", "claude-sonnet-4-6"), [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.equal(settings.isThinkingAlwaysOnForModel("claude_code", "claude-sonnet-4-6"), false);
  assert.equal(settings.isThinkingAlwaysOnForModel("xai", "grok-4.5"), true);
  assert.equal(settings.isThinkingAlwaysOnForModel("codex", "gpt-5"), true);
  assert.deepEqual(settings.getKnownModelThinkingLevels("codex", "gpt-4o"), []);
  // 恒开不可调（中转挂载）：无档位但思考恒开
  assert.deepEqual(settings.getKnownModelThinkingLevels("claude_code", "deepseek-reasoner"), []);
  assert.equal(settings.isThinkingAlwaysOnForModel("claude_code", "deepseek-reasoner"), true);
});

test("web resolver honors decorated ids and heuristics like the GUI", () => {
  assert.deepEqual(
    thinking.resolveModelThinking("claude_code", "claude-sonnet-4-6-20251114").levels,
    ["low", "medium", "high", "max"],
  );
  assert.deepEqual(thinking.resolveModelThinking("claude_code", "claude-4.7-opus").levels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});
