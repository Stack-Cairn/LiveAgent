import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Review of feat-approval-card-cc (verification, expected to pass): shortcut guards and the
// remember-scope label on the real ToolApprovalBar. Strings and booleans only in asserts.

async function renderBar(pending, { holdDecisions = false } = {}) {
  const decisions = [];
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/components/ui/button": { Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children) },
    "@liveagent/ui/components/ui/dropdown-menu": {
      DropdownMenu: ({ children }) => env.React.createElement("div", null, children),
      DropdownMenuTrigger: ({ render, children, ...props }) => env.React.cloneElement(render, props, children),
      DropdownMenuContent: ({ children }) => env.React.createElement("div", { role: "menu" }, children),
      DropdownMenuItem: ({ children, onSelect, disabled }) => env.React.createElement("button", { role: "menuitem", disabled, onClick: onSelect }, children),
    },
  } });
  const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const onDecide = (toolCallId, decision, options) => {
    decisions.push(options ? `${toolCallId}:${decision}:${options.scope ?? ""}` : `${toolCallId}:${decision}`);
    return holdDecisions ? new Promise(() => {}) : Promise.resolve({ ok: true });
  };
  await env.act(async () => root.render(env.React.createElement(ToolApprovalBar, { pending, onDecide, onDecideAll: async () => {} })));
  const panel = host.querySelector("section");
  const key = async (name, init = {}, target = panel) => {
    await env.act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
      await Promise.resolve();
    });
  };
  const cleanup = async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  };
  return { host, panel, decisions, key, cleanup };
}

const base = { toolCallId: "c1", toolName: "Bash", summary: "npm test" };

test("2 does nothing without rules and without a session grant", async () => {
  const { decisions, key, cleanup } = await renderBar([base]);
  try {
    await key("2");
    assert.deepEqual(decisions, []);
  } finally {
    await cleanup();
  }
});

test("2 without rules but with a session grant is the old session approval, no scope", async () => {
  const { host, decisions, key, cleanup } = await renderBar([{ ...base, allowSession: true, sessionWide: true }]);
  try {
    assert.equal(host.querySelector("[data-remember-scope]") === null, true);
    await key("2");
    assert.deepEqual(decisions, ["c1:approve_session"]);
  } finally {
    await cleanup();
  }
});

test("rules without defaultScope remember for this session and say so", async () => {
  const { host, decisions, key, cleanup } = await renderBar([{ ...base, allowSession: true, rememberRules: ["Bash(npm test:*)"] }]);
  try {
    assert.equal(host.querySelector("[data-remember-scope]")?.textContent ?? "", "本会话");
    assert.equal(host.querySelector("[data-remember-scope]")?.closest(".truncate") ?? null, null);
    await key("2");
    assert.deepEqual(decisions, ["c1:approve_session:session"]);
  } finally {
    await cleanup();
  }
});

test("rules are not offered when the backend does not allow remembering", async () => {
  const { host, decisions, key, cleanup } = await renderBar([{ ...base, rememberRules: ["Bash(npm test:*)"] }]);
  try {
    assert.equal(host.querySelector("[data-remember-scope]") === null, true);
    await key("2");
    assert.deepEqual(decisions, []);
  } finally {
    await cleanup();
  }
});

test("3 with a modifier, while submitting, or on a button does not deny", async () => {
  const { host, decisions, key, cleanup } = await renderBar([{ ...base, allowSession: true, rememberRules: ["R"] }], { holdDecisions: true });
  try {
    for (const mod of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) await key("3", { [mod]: true });
    assert.deepEqual(decisions, []);
    const button = host.querySelector("[aria-keyshortcuts='2']");
    await key("3", {}, button);
    assert.deepEqual(decisions, [], "digits on a button are the button's own");
    await key("1");
    await key("3");
    await key("Escape");
    assert.deepEqual(decisions, ["c1:approve"], "nothing else while the first answer is in flight");
  } finally {
    await cleanup();
  }
});
