import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The WebUI only sees approvals through the Gateway: the desktop overlays markers on the
// synced tool call arguments and the WebUI collectors rebuild the bar items from them.
const loader = createTsModuleLoader();
const { buildGatewayToolCallPreviewArguments, summarizeToolCallForApproval } = loader.loadModule(
  "src/pages/chat/turns/gatewayToolPreview.ts",
);
const { requestToolApproval, answerToolApproval } = loader.loadModule("src/lib/tools/toolApproval.ts");
const { pendingToolApprovalFromToolCall } = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");

const computerCall = { id: "call-1", name: "computer_exec", arguments: { action: "call", tool: "click" } };

async function remoteItem(approval, call = computerCall) {
  const settled = requestToolApproval({ toolCallId: call.id, toolName: call.name, conversationId: "remote", ...approval });
  const item = pendingToolApprovalFromToolCall({ ...call, arguments: buildGatewayToolCallPreviewArguments(call) });
  answerToolApproval(call.id, "approve");
  await settled;
  return item;
}

test("Gateway sync carries the approval scope the desktop bar uses", async () => {
  const wide = await remoteItem({ summary: "click", sessionScope: "call:click", sessionWide: true });
  assert.equal(typeof wide.deadlineAt, "number");
  assert.deepEqual({ ...wide, deadlineAt: 0 }, {
    toolCallId: "call-1",
    toolName: "computer_exec",
    summary: "click",
    deadlineAt: 0,
    allowSession: false,
    sessionScope: "call:click",
    sessionWide: true,
  });

  const remembered = await remoteItem({ allowSession: true, sessionScope: "call:click" });
  assert.equal(remembered.allowSession, true);
  assert.equal(remembered.sessionWide, false);

  // Without a registered summary the overlay falls back to the call's own approval summary.
  const unsummarized = await remoteItem({ sessionWide: true });
  assert.equal(unsummarized.summary, summarizeToolCallForApproval(computerCall));

  const settledArgs = buildGatewayToolCallPreviewArguments(computerCall);
  assert.equal(pendingToolApprovalFromToolCall({ ...computerCall, arguments: settledArgs }), null, "settled approvals drop the markers");
});

test("both WebUI collectors rebuild bar items with the shared reader", () => {
  for (const file of [
    "../../../agent-gateway/web/src/app/hooks/useGatewayChatPresentation.tsx",
    "../../../agent-gateway/web/src/app/workbench/GatewayConversationPaneHost.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /pendingToolApprovalFromToolCall\(toolCall\)/, file);
    assert.doesNotMatch(source, /readToolApprovalSummary\(toolCall\.arguments\)/, file);
  }
});

test("a remote session-wide Computer Use prompt renders the scope wording, not a session menu", async () => {
  const item = await remoteItem({ summary: "click", sessionScope: "call:click", sessionWide: true });
  const legacy = pendingToolApprovalFromToolCall({
    id: "old",
    name: "Bash",
    arguments: { command: "ls", __toolApprovalPending: true, __toolApprovalSummary: "ls" },
  });
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/components/ui/button": { Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children) },
    "@liveagent/ui/components/ui/dropdown-menu": {
      DropdownMenu: ({ children }) => env.React.createElement("div", null, children),
      DropdownMenuTrigger: ({ render, children, ...props }) => env.React.cloneElement(render, props, children),
      DropdownMenuContent: ({ children }) => env.React.createElement("div", { role: "menu" }, children),
      DropdownMenuItem: ({ children, onSelect }) => env.React.createElement("button", { role: "menuitem", onClick: onSelect }, children),
    },
  } });
  const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const render = (pending) => env.act(async () => root.render(env.React.createElement(ToolApprovalBar, { pending, onDecide: async () => ({ ok: true }), onDecideAll: async () => {} })));
  try {
    await render([item]);
    assert.match(host.textContent, /允许后，本对话里的 Computer Use 操作不再询问/);
    assert.equal(host.querySelectorAll('[role="menuitem"]').length, 0);
    // Older desktops sync no allowSession marker: the bar must not offer a session option either.
    await render([legacy]);
    assert.match(host.textContent, /允许本次/);
    assert.equal(host.querySelectorAll('[role="menuitem"]').length, 0);
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
