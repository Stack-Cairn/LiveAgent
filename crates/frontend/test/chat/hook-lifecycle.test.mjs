import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createConversationHookLifecycle } = loader.loadModule(
  "src/lib/chat/conversation/run/hookLifecycle.ts",
);

test("conversation hook lifecycle closes message and turn after all tool results", () => {
  const events = [];
  const lifecycle = createConversationHookLifecycle((event) => events.push(event));

  lifecycle.startAgent();
  lifecycle.startTurn(1);
  lifecycle.assistantMessageCompleted(1, 2);
  lifecycle.toolExecutionStarted();
  lifecycle.toolResultReceived(1);
  lifecycle.toolExecutionStarted();
  lifecycle.toolResultReceived(1);
  lifecycle.endAgent();

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "tool_execution_start",
    "tool_execution_end",
    "turn_end",
    "agent_end",
  ]);
});

test("conversation hook lifecycle closes no-tool turns immediately", () => {
  const events = [];
  const lifecycle = createConversationHookLifecycle((event) => events.push(event));

  lifecycle.startAgent();
  lifecycle.startTurn(1);
  lifecycle.assistantMessageCompleted(1, 0);
  lifecycle.endAgent();

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
});

test("conversation hook lifecycle endAgent is idempotent and closes open turns", () => {
  const events = [];
  const lifecycle = createConversationHookLifecycle((event) => events.push(event));

  lifecycle.startAgent();
  lifecycle.startTurn(3);
  lifecycle.endAgent();
  lifecycle.endAgent();

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
});
