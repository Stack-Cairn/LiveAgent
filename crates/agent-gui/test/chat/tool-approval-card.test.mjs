import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2b: the approval card answers with 1/2/3, lets the user pick where "allow and
// remember" stores the rules, explains a denial to the model, shows the whole command
// and the edit it approves, and says why a remembered rule could not be stored.
// Assertions compare strings and booleans only: a failing assert on a DOM node would
// try to print the whole jsdom tree.

const diffs = [];
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
    "@liveagent/ui/components/chat/EditDiffView": {
      EditDiffView: (props) => {
        diffs.push(props);
        return env.React.createElement("div", { "data-diff": props.filePath ?? "" });
      },
    },
  } });
  const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const onDecide = async (toolCallId, decision, options) => {
    decisions.push(options ? [toolCallId, decision, options] : [toolCallId, decision]);
    return { ok: true };
  };
  await env.act(async () => root.render(env.React.createElement(ToolApprovalBar, { pending, onDecide, onDecideAll: async () => {} })));
  const panel = host.querySelector("section");
  const key = async (name, target = panel) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    await env.act(async () => {
      target.dispatchEvent(event);
      await Promise.resolve();
    });
  };
  const cleanup = async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  };
  return { env, host, panel, decisions, key, cleanup };
}

const remembering = {
  toolCallId: "c1",
  toolName: "Bash",
  summary: "npm test",
  allowSession: true,
  sessionScope: "Bash(npm test:*)",
  rememberRules: ["Bash(npm test:*)"],
  defaultScope: "project",
};

test("1 allows once and 2 remembers in the default scope", async () => {
  const { decisions, key, cleanup } = await renderBar([remembering]);
  try {
    await key("1");
    await key("2");
    assert.deepEqual(decisions, [["c1", "approve"], ["c1", "approve_session", { scope: "project" }]]);
  } finally {
    await cleanup();
  }
});

// Like Claude Code: 2 remembers in the scope the backend suggests (no scope picker; Settings
// → 权限 changes or deletes a rule), and there is one deny (Esc or 3) with no reason field —
// the user tells the model what to do next in the composer.
test("the remember option names the rules and the scope they go to, without a picker", async () => {
  const { host, decisions, key, cleanup } = await renderBar([remembering]);
  try {
    assert.match(host.textContent, /Bash\(npm test:\*\)/);
    assert.match(host.textContent, /本项目/);
    assert.equal(Boolean(host.querySelector("select")), false, "no scope picker");
    await key("2");
    assert.deepEqual(decisions, [["c1", "approve_session", { scope: "project" }]]);
  } finally {
    await cleanup();
  }
});

test("the backend's default scope decides where 2 remembers", async () => {
  const { host, decisions, key, cleanup } = await renderBar([{ ...remembering, defaultScope: "user" }]);
  try {
    assert.match(host.textContent, /所有项目/);
    await key("2");
    assert.deepEqual(decisions, [["c1", "approve_session", { scope: "user" }]]);
  } finally {
    await cleanup();
  }
});

test("3 denies like Esc, and there is no reason field", async () => {
  const { host, decisions, key, cleanup } = await renderBar([remembering]);
  try {
    assert.equal(Boolean(host.querySelector("input")), false, "no reason field");
    assert.equal(/拒绝并说明/.test(host.textContent), false, "one deny only");
    await key("3");
    assert.deepEqual(decisions, [["c1", "deny"]]);
  } finally {
    await cleanup();
  }
});

test("Esc on the card denies", async () => {
  const { decisions, key, cleanup } = await renderBar([remembering]);
  try {
    await key("Escape");
    assert.deepEqual(decisions, [["c1", "deny"]]);
  } finally {
    await cleanup();
  }
});

test("without rules the old session item stays and 2 sends it without a scope", async () => {
  const legacy = { toolCallId: "c2", toolName: "computer_exec", summary: "click", allowSession: true, sessionScope: "call:click" };
  const { host, decisions, key, cleanup } = await renderBar([legacy]);
  try {
    assert.equal(Boolean(host.querySelector("select[data-remember-scope]")), false);
    assert.match(host.textContent, /本会话始终允许 computer_exec · call:click/);
    await key("2");
    assert.deepEqual(decisions, [["c2", "approve_session"]]);
  } finally {
    await cleanup();
  }
});

test("with nothing to remember 2 does nothing", async () => {
  const { decisions, key, cleanup } = await renderBar([{ toolCallId: "c3", toolName: "Bash", summary: "rm x" }]);
  try {
    await key("2");
    assert.deepEqual(decisions, []);
  } finally {
    await cleanup();
  }
});

test("the whole command is shown, not one cut line", async () => {
  const command = "npm run build &&\nnpm test -- --watch=false &&\necho done";
  const { host, cleanup } = await renderBar([{ toolCallId: "c4", toolName: "Bash", summary: command }]);
  try {
    const pre = host.querySelector("pre[data-approval-command]");
    assert.equal(pre?.textContent, command);
    assert.match(pre?.className ?? "", /whitespace-pre-wrap/);
    assert.doesNotMatch(pre?.className ?? "", /whitespace-nowrap|text-ellipsis/);
  } finally {
    await cleanup();
  }
});

test("an edit shows its diff, and a cut preview says so", async () => {
  diffs.length = 0;
  const { host, cleanup } = await renderBar([{
    toolCallId: "c5",
    toolName: "Edit",
    summary: "src/a.ts",
    preview: { path: "src/a.ts", before: "const a = 1;", after: "const a = 2;", truncated: true },
  }]);
  try {
    assert.deepEqual(diffs.at(-1), { beforeText: "const a = 1;", afterText: "const a = 2;", filePath: "src/a.ts" });
    assert.match(host.textContent, /预览已截断/);
  } finally {
    await cleanup();
  }
});

test("a rule the backend could not store is explained on the card", async () => {
  const { host, cleanup } = await renderBar([{ ...remembering, notice: "project rules are not available on this backend" }]);
  try {
    const notice = host.querySelector("[data-approval-notice]");
    assert.match(notice?.textContent ?? "", /project rules are not available on this backend/);
  } finally {
    await cleanup();
  }
});

// The preview comes from the tool call: full arguments on the desktop, the Gateway's
// cut copy on WebUI.
test("approval previews are built from Edit and Write arguments", () => {
  const loader = createTsModuleLoader();
  const { approvalPreviewFromToolCall } = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  assert.deepEqual(approvalPreviewFromToolCall("Edit", { path: "a.ts", old_string: "x", new_string: "y" }), { path: "a.ts", before: "x", after: "y", truncated: false });
  assert.deepEqual(approvalPreviewFromToolCall("Write", { path: "b.md", content: "hello" }), { path: "b.md", before: "", after: "hello", truncated: false });
  assert.equal(approvalPreviewFromToolCall("Bash", { command: "ls" }), undefined);
  assert.equal(approvalPreviewFromToolCall("Edit", { path: "a.ts" }), undefined);
  const cut = approvalPreviewFromToolCall("Write", { path: "c.md", content: "head…tail", __liveagent_stream_preview: { v: 2, progress: 9000, fields: { content: { chars: 9000, lines: 1, truncated: true } } } });
  assert.equal(cut.truncated, true);
});

test("sides cut on their own are shown apart, not diffed", async () => {
  diffs.length = 0;
  const { host, cleanup } = await renderBar([{
    toolCallId: "c6",
    toolName: "Edit",
    summary: "src/big.ts",
    preview: { path: "src/big.ts", before: "old part", after: "new part", truncated: true, split: true },
  }]);
  try {
    assert.equal(diffs.length, 0, "no diff of two cut sides");
    const sides = [...host.querySelectorAll("[data-approval-preview-side]")].map((node) => node.getAttribute("data-approval-preview-side"));
    assert.deepEqual(sides, ["before", "after"]);
    assert.match(host.textContent, /old part/);
    assert.match(host.textContent, /new part/);
  } finally {
    await cleanup();
  }
});

test("a huge Edit that differs throughout is split; a cut Gateway copy of an Edit too", () => {
  const loader = createTsModuleLoader();
  const { approvalPreviewFromToolCall } = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  const huge = approvalPreviewFromToolCall("Edit", { path: "a.ts", old_string: "a".repeat(9000), new_string: "b".repeat(9000) });
  assert.equal(huge.split, true);
  assert.equal(huge.before.length <= 4000 && huge.after.length <= 4000, true);
  const meta = { v: 2, progress: 9000, fields: { old_string: { chars: 9000, lines: 1, truncated: true }, new_string: { chars: 3, lines: 1, truncated: false } } };
  const copy = approvalPreviewFromToolCall("Edit", { path: "a.ts", old_string: "head…tail", new_string: "abc", __liveagent_stream_preview: meta });
  assert.equal(copy.split, true);
  assert.equal(copy.truncated, true);
});

test("the character cut never leaves half an emoji", () => {
  const loader = createTsModuleLoader();
  const { approvalPreviewFromToolCall } = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const preview = approvalPreviewFromToolCall("Edit", { path: "e.txt", old_string: `${"😀".repeat(3000)}😀${"😀".repeat(3000)}`, new_string: `${"😀".repeat(3000)}😁${"😀".repeat(3000)}` });
  assert.equal(lone.test(preview.before) || lone.test(preview.after), false);
  assert.equal(preview.after.includes("😁"), true);
});

test("the length cap never leaves half an emoji either", () => {
  const loader = createTsModuleLoader();
  const { approvalPreviewFromToolCall } = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const lead of ["", "b"]) {
    const preview = approvalPreviewFromToolCall("Write", { path: "w.txt", content: lead + "😀".repeat(3000) });
    assert.equal(preview.truncated, true);
    assert.equal(lone.test(preview.after), false, `lead=${JSON.stringify(lead)}`);
  }
});

// K-brain sends the change itself (permission.requested.preview): diff rows computed
// against the file on disk, a new-file flag, and truncated when cut or left out.
test("K-brain's preview of the change is shown as its own diff rows", async () => {
  const loader = createTsModuleLoader();
  const { approvalPreviewFromKBrain, pendingToolApprovalFromToolCall } = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  const preview = approvalPreviewFromKBrain("edit", { path: "/w/a.go", diff: "3 - a := 1\n3 + a := 2", truncated: false });
  assert.deepEqual(preview, { path: "/w/a.go", before: "", after: "", truncated: false, diff: "3 - a := 1\n3 + a := 2" });
  assert.deepEqual(approvalPreviewFromKBrain("Write", { path: "big.bin", new_file: true, truncated: true }), {
    path: "big.bin", before: "", after: "", truncated: true, diff: "", newFile: true,
  });
  assert.equal(approvalPreviewFromKBrain("Bash", { path: "x", diff: "1 + y" }), undefined);
  assert.equal(approvalPreviewFromKBrain("Edit", { path: "x", diff: "" }), undefined, "nothing to show falls back to the arguments");
  const long = approvalPreviewFromKBrain("Edit", { path: "x", diff: "1 + abcdefgh\n".repeat(5000) });
  assert.equal(long.truncated, true);
  assert.equal(long.diff.length <= 32 * 1024 && !long.diff.endsWith("\n"), true);

  // WebUI reads the copy the desktop or the Gateway syncs onto the call.
  const remote = pendingToolApprovalFromToolCall({
    id: "w1",
    name: "Write",
    arguments: {
      path: "notes.md",
      content: "ignored: the synced preview wins",
      __toolApprovalPending: true,
      __toolApprovalPreview: { path: "notes.md", before: "", after: "", diff: "1 + # Notes", newFile: true, truncated: false },
    },
  });
  assert.deepEqual(remote.preview, { path: "notes.md", before: "", after: "", truncated: false, diff: "1 + # Notes", newFile: true });
});

test("the approval card renders K-brain diff rows, a new file and a change too large to preview", async () => {
  diffs.length = 0;
  const { host, cleanup } = await renderBar([{
    toolCallId: "c7",
    toolName: "Write",
    summary: "notes.md",
    preview: { path: "notes.md", before: "", after: "", truncated: false, diff: "1 + # Notes\n2 + hi", newFile: true },
  }]);
  try {
    assert.deepEqual(diffs.at(-1), { beforeText: "", afterText: "", diffText: "1 + # Notes\n2 + hi", filePath: "notes.md" });
    assert.equal(host.querySelector("[data-approval-preview-new-file]") !== null, true);
    assert.doesNotMatch(host.textContent, /预览已截断/);
  } finally {
    await cleanup();
  }
  diffs.length = 0;
  const large = await renderBar([{
    toolCallId: "c8",
    toolName: "Edit",
    summary: "huge.json",
    preview: { path: "huge.json", before: "", after: "", truncated: true, diff: "" },
  }]);
  try {
    assert.equal(diffs.length, 0, "no diff when K-brain left it out");
    assert.match(large.host.textContent, /改动过大，无法预览/);
    assert.match(large.host.querySelector("[data-approval-preview]")?.textContent ?? "", /huge\.json/);
  } finally {
    await large.cleanup();
  }
});
