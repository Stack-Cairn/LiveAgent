import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2a UI: a K-brain approval that waits shows no countdown, and a tool row the
// backend allowed without asking says why.

// Assertions compare strings and booleans, never DOM nodes: a failing assert would
// try to print a whole jsdom tree.
const icons = new Proxy({}, { get: () => () => null });

async function renderBar(pending) {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
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
  await env.act(async () => root.render(env.React.createElement(ToolApprovalBar, {
    pending,
    onDecide: async () => ({ ok: true }),
    onDecideAll: async () => {},
  })));
  return { host, cleanup: async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); } };
}

test("an approval without a deadline shows no countdown", async () => {
  const { host, cleanup } = await renderBar([{ toolCallId: "c1", toolName: "Bash", summary: "npm test", allowSession: true, sessionScope: "Bash(npm test:*)" }]);
  try {
    assert.equal(Boolean(host.querySelector('[role="timer"]')), false, "no countdown element");
    assert.doesNotMatch(host.textContent, /\d+:\d\d/);
  } finally {
    await cleanup();
  }
});

test("several waiting approvals still show the count without a countdown", async () => {
  const { host, cleanup } = await renderBar([
    { toolCallId: "c1", toolName: "Bash", summary: "npm test" },
    { toolCallId: "c2", toolName: "Bash", summary: "npm run lint" },
  ]);
  try {
    assert.equal(Boolean(host.querySelector('[role="timer"]')), false, "no countdown element");
    assert.match(host.textContent, /1 \/ 2/);
    assert.doesNotMatch(host.textContent, /\d+:\d\d/);
  } finally {
    await cleanup();
  }
});

test("an approval with a deadline still counts down", async () => {
  const { host, cleanup } = await renderBar([{ toolCallId: "c1", toolName: "Bash", summary: "ls", deadlineAt: Date.now() + 90_000 }]);
  try {
    assert.match(host.querySelector('[role="timer"]').textContent, /^1:(29|30)$/);
  } finally {
    await cleanup();
  }
});

async function renderMarker(marker, labels) {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "zh-CN", t: (key) => labels[key] ?? key }) },
  } });
  const { ToolPermissionMarker } = env.loadModule("@liveagent/ui/components/chat/assistant-bubble/ToolPermissionMarker.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(env.React.createElement(ToolPermissionMarker, { marker })));
  return { host, cleanup: async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); } };
}

test("a read-only call allowed without asking is marked", async () => {
  const { host, cleanup } = await renderMarker({ source: "read_only" }, { "chat.toolPermission.readOnly": "只读，自动允许" });
  try {
    const marker = host.querySelector("[data-permission-auto-resolved]");
    assert.equal(marker?.getAttribute("data-permission-auto-resolved"), "read_only");
    assert.equal(marker?.textContent, "只读，自动允许");
  } finally {
    await cleanup();
  }
});

test("a call allowed by a remembered rule names the rule", async () => {
  const { host, cleanup } = await renderMarker(
    { source: "rule", rule: "Bash(npm test:*)", scope: "project" },
    { "chat.toolPermission.rule": "按规则允许", "chat.toolPermission.ruleTitle": "已记住的规则：{rule}" },
  );
  try {
    const marker = host.querySelector("[data-permission-auto-resolved]");
    assert.equal(marker?.textContent, "按规则允许");
    assert.equal(marker?.getAttribute("title"), "已记住的规则：Bash(npm test:*)");
  } finally {
    await cleanup();
  }
});

test("calls the backend asked about carry no marker", async () => {
  const { host, cleanup } = await renderMarker(null, {});
  try {
    assert.equal(host.innerHTML, "");
  } finally {
    await cleanup();
  }
});

// The real tool row, in each of its header layouts: a file link (Read, Write, Edit),
// a compact chip and the full row.
async function renderToolRow(item, props = {}) {
  const icons = new Proxy({}, { get: () => () => null });
  const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [iconPath]: icons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/ui/components/Markdown": { Markdown: () => null },
    "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
    "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
    "@liveagent/ui/components/chat/AskUserQuestionCard": { AskUserQuestionCard: () => null },
    "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
    "@liveagent/adapters/assistantBubble": {
      readAskUserQuestionDeadline: () => undefined,
      useAskUserQuestionPending: () => false,
      usePlanDecisionState: () => ({ pending: false, approved: false }),
      retainRunningToolContent: false,
      submitAskUserQuestionAnswers() {},
      submitPlanDecision() {},
      usePendingToolApproval: () => false,
      usePermissionAutoResolved: (id) => (id === "marked" ? { source: "read_only" } : null),
      deferLargeToolImages: false,
    },
  } });
  const { MemoToolCallItem } = env.loadModule("@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(env.React.createElement(MemoToolCallItem, { item, ...props })));
  const marker = host.querySelector("[data-permission-auto-resolved]")?.getAttribute("data-permission-auto-resolved") ?? null;
  await env.act(async () => root.unmount());
  host.remove();
  env.cleanup();
  return marker;
}

const toolItem = (id, name, args) => ({
  toolCall: { type: "toolCall", id, name, arguments: args },
  toolResult: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
});

for (const [layout, name, args, props] of [
  ["file link", "Read", { path: "README.md" }, {}],
  ["full row", "mcp__fs__list", { path: "." }, {}],
  ["compact chip", "mcp__fs__list", { path: "." }, { compactChip: true }],
]) {
  test(`the ${layout} row shows why the backend allowed it`, async () => {
    assert.equal(await renderToolRow(toolItem("marked", name, args), props), "read_only");
    assert.equal(await renderToolRow(toolItem("asked", name, args), props), null);
  });
}

test("both languages name the markers", () => {
  for (const key of ["chat.toolPermission.readOnly", "chat.toolPermission.rule", "chat.toolPermission.ruleTitle"]) {
    for (const file of ["zhCNCommon.ts", "enUSCommon.ts"]) {
      const text = readFileSync(new URL(`../../../agent-ui/src/i18n/translations/${file}`, import.meta.url), "utf8");
      assert.ok(text.includes(`"${key}"`), `${key} in ${file}`);
    }
  }
});

test("both hosts read the marker: the desktop from its store, WebUI from the synced arguments", () => {
  const react = { useSyncExternalStore: (_subscribe, get) => get() };
  const gui = createTsModuleLoader({ mocks: { react } });
  const store = gui.loadModule("src/lib/tools/permissionAutoResolved.ts");
  store.recordPermissionAutoResolved("gui-call", { source: "rule", rule: "Bash(ls:*)" });
  const guiAdapter = gui.loadModule("src/agent-ui-adapters/assistantBubble.ts");
  assert.deepEqual(guiAdapter.usePermissionAutoResolved("gui-call", {}), { source: "rule", rule: "Bash(ls:*)" });
  assert.equal(guiAdapter.usePermissionAutoResolved("other", {}), null);

  const web = createTsModuleLoader({ rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)), mocks: { react } });
  const webAdapter = web.loadModule("src/agent-ui-adapters/assistantBubble.ts");
  assert.deepEqual(webAdapter.usePermissionAutoResolved("x", { __toolPermissionAutoResolved: { source: "read_only" } }), { source: "read_only" });
  assert.equal(webAdapter.usePermissionAutoResolved("x", { command: "ls" }), null);
});

test("an edit approval renders K-brain's diff rows with line numbers and the cut note", async () => {
  const { host, cleanup } = await renderBar([{
    toolCallId: "e1",
    toolName: "Edit",
    summary: "src/app.ts",
    preview: {
      path: "src/app.ts",
      before: "",
      after: "",
      truncated: true,
      diff: "11   const keep = true;\n12 - const port = 3000;\n12 + const port = 8080;\n… +3 more lines",
    },
  }]);
  try {
    const figure = host.querySelector("[data-chat-code-diff]");
    assert.equal(Boolean(figure), true, "the diff view is shown");
    assert.match(figure.textContent, /src\/app\.ts/);
    assert.match(figure.textContent, /\+1-1/);
    assert.match(figure.textContent, /12const port = 8080;/);
    assert.equal(host.querySelector("[data-diff-note]")?.textContent, "… +3 more lines");
    assert.match(host.textContent, /预览已截断/);
  } finally {
    await cleanup();
  }
});
