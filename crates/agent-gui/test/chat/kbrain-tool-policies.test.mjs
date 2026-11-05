import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { canonicalKBrainToolPolicies, KBRAIN_POLICY_TOOL_NAMES } = loader.loadModule(
  "src/lib/kbrain/toolPolicies.ts",
);

test("frontend-only tool policies never reach K-brain run options", () => {
  // Regression: a stored `Browser: allow` from the legacy runtime made K-brain reject every run with
  // `options.tools references unavailable tool "Browser"`.
  assert.deepEqual(
    canonicalKBrainToolPolicies({
      Browser: "allow",
      McpManager: "deny",
      Agent: "ask",
      TaskCreate: "allow",
      "group:browser": "ask",
      "server:cua-driver": "allow",
      Write: "ask",
      Bash: "deny",
      Read: "allow",
    }),
    { Bash: "deny", Read: "allow", Write: "ask" },
  );
});

test("K-brain tool policies keep valid values only and are sorted", () => {
  const policies = canonicalKBrainToolPolicies({
    Grep: "allow",
    Edit: "sometimes",
    TerminalSession: "ask",
    AskUserQuestion: "deny",
    ExitPlanMode: "allow",
  });
  assert.deepEqual(Object.keys(policies), [
    "AskUserQuestion",
    "ExitPlanMode",
    "Grep",
    "TerminalSession",
  ]);
  assert.equal(policies.Edit, undefined);
});

test("missing tool settings produce no policies", () => {
  assert.deepEqual(canonicalKBrainToolPolicies(undefined), {});
  assert.deepEqual(canonicalKBrainToolPolicies(null), {});
});

test("allowed K-brain tool names exclude frontend-only tools", () => {
  for (const name of ["Browser", "McpManager", "TunnelManager", "SSHManager", "ToolSearch"]) {
    assert.equal(KBRAIN_POLICY_TOOL_NAMES.has(name), false, name);
  }
});

test("tools K-brain registers on every session accept policies", () => {
  // internal/backend/planning.go and internal/agent/agent.go New register these unconditionally.
  const policies = canonicalKBrainToolPolicies({
    PlanningQuery: "allow",
    PlanningMutate: "ask",
    wait: "deny",
    new_context: "ask",
    remember: "ask",
    forget: "deny",
  });
  assert.deepEqual(policies, {
    forget: "deny",
    new_context: "ask",
    PlanningMutate: "ask",
    PlanningQuery: "allow",
    remember: "ask",
    wait: "deny",
  });
});

test("conditionally registered K-brain tools and subagent tools are never forwarded", () => {
  for (const name of [
    "lsp",
    "browser_exec",
    "computer_exec",
    "workflow",
    "web_fetch",
    "ToolSearch",
    "subagent",
    "subagent_steer",
    "mcp__docs__search",
  ]) {
    assert.equal(KBRAIN_POLICY_TOOL_NAMES.has(name), false, name);
  }
});

test("the Memory Manager setting governs K-brain's memory_manager tool", () => {
  assert.deepEqual(canonicalKBrainToolPolicies({ MemoryManager: "deny" }), {
    memory_manager: "deny",
  });
  // An explicit policy under K-brain's own name wins over the settings alias.
  assert.deepEqual(
    canonicalKBrainToolPolicies({ MemoryManager: "deny", memory_manager: "ask" }),
    { memory_manager: "ask" },
  );
  assert.deepEqual(canonicalKBrainToolPolicies({ MemoryManager: "sometimes" }), {});
});

test("every configurable settings catalog tool reaches K-brain unless K-brain lacks it", () => {
  const { BUILTIN_TOOL_CATALOG } = loader.loadModule(
    "@liveagent/ui/lib/tools/builtinToolCatalog.ts",
  );
  // Frontend-runtime tools K-brain does not register under these names.
  const notInKBrain = new Set([
    "Browser",
    "McpManager",
    "TunnelManager",
    "SSHManager",
    "ReadConversation",
    "ToolSearch",
    "Agent",
    "SendMessage",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
  ]);
  for (const entry of BUILTIN_TOOL_CATALOG) {
    if (notInKBrain.has(entry.toolName)) continue;
    const forwarded = Object.keys(canonicalKBrainToolPolicies({ [entry.toolName]: "deny" }));
    assert.equal(forwarded.length, 1, `${entry.toolName} policy is dropped`);
  }
});

test("trailing newline anchor uses a real CSS zero-width escape, not a literal backslash", () => {
  // Check the rendered class: JSX attributes and JavaScript strings escape backslashes differently.
  const renderLoader = createTsModuleLoader({ mocks: { "react/jsx-runtime": jsxRuntime } });
  const { UserMessageContent } = renderLoader.loadModule(
    "@liveagent/ui/lib/chat/userMessageContent.tsx",
  );
  const html = renderToStaticMarkup(jsxRuntime.jsx(UserMessageContent, { text: "alpha\n" }));
  const anchorClass = /class="(before:content-[^"]+)"/.exec(html);
  assert.ok(anchorClass, "a trailing newline must render its visual anchor");
  assert.equal(anchorClass[1].replaceAll("&#x27;", "'"), "before:content-['\\200b']");
});
