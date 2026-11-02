import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

async function renderBar(pending) {
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
  const onDecide = async (toolCallId, decision) => { decisions.push([toolCallId, decision]); return { ok: true }; };
  await env.act(async () => root.render(env.React.createElement(ToolApprovalBar, { pending, onDecide, onDecideAll: async () => {} })));
  const cleanup = async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); };
  return { env, host, decisions, cleanup };
}

test("a session-wide Computer Use prompt says approving covers the chat", async () => {
  const { env, host, decisions, cleanup } = await renderBar([
    { toolCallId: "p1", toolName: "computer_exec", summary: '{"action":"call","tool":"click"}', sessionScope: "call:click", sessionWide: true, allowSession: false },
  ]);
  try {
    assert.match(host.textContent, /允许后，本对话里的 Computer Use 操作不再询问（批量执行和安装类操作除外）。/);
    assert.doesNotMatch(host.textContent, /是否允许执行此/);
    // On phones the explanation must wrap and the bar grow, not cut the sentence off.
    const body = [...host.querySelectorAll("p")].find((p) => p.textContent.includes("Computer Use"));
    assert.match(body.className, /\bbreak-words\b/);
    assert.doesNotMatch(body.className, /\btruncate\b/);
    const bar = host.querySelector("section");
    assert.match(bar.className, /\bmin-h-32\b/);
    assert.doesNotMatch(bar.className, /(^|\s)h-32\b/);
    const approve = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-keyshortcuts") === "Enter");
    assert.equal(approve.textContent.replace("↵", ""), "允许");
    assert.equal(host.querySelector('[aria-label="更多审批选项"]'), null, "no separate session option to choose");
    await env.act(async () => { approve.click(); await Promise.resolve(); });
    assert.deepEqual(decisions, [["p1", "approve"]]);
  } finally {
    await cleanup();
  }
});

test("other prompts keep the one-time wording", async () => {
  const { host, cleanup } = await renderBar([
    { toolCallId: "p2", toolName: "Bash", summary: "echo hi", allowSession: false },
  ]);
  try {
    assert.match(host.textContent, /是否允许执行此 终端 操作？/);
    assert.doesNotMatch(host.textContent, /本对话里的 Computer Use/);
    const approve = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-keyshortcuts") === "Enter");
    assert.equal(approve.textContent.replace("↵", ""), "允许本次");
  } finally {
    await cleanup();
  }
});
