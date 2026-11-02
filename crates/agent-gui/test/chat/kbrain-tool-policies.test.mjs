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
