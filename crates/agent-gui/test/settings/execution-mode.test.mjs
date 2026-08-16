import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

function withExecutionMode(executionMode) {
  return settings.updateSystem(settings.getDefaultSettings(), { executionMode });
}

test("chat execution mode selection preserves agent-dev", () => {
  const agentDev = withExecutionMode("agent-dev");

  assert.equal(settings.updateExecutionModeFromChatSelection(agentDev, "tools"), agentDev);
  assert.equal(
    settings.updateExecutionModeFromChatSelection(agentDev, "text").system.executionMode,
    "text",
  );
});

test("chat execution mode selection only promotes text to tools", () => {
  const text = withExecutionMode("text");
  const tools = withExecutionMode("tools");

  assert.equal(settings.updateExecutionModeFromChatSelection(text, "text"), text);
  assert.equal(
    settings.updateExecutionModeFromChatSelection(text, "tools").system.executionMode,
    "tools",
  );
  assert.equal(settings.updateExecutionModeFromChatSelection(tools, "tools"), tools);
});
