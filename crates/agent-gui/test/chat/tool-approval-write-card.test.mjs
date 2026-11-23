import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// A Write approval: the card names the file once, relative to the workspace, shows the
// diff across the card, announces itself as an alert dialog titled by its question, and
// counts the same lines as the activity row. A denied write then reads as denied, not
// as a failed edit.
// Assertions compare strings and booleans only: a failing assert on a DOM node would
// try to print the whole jsdom tree.

const loader = createTsModuleLoader();
const { countTextLines } = loader.loadModule("../agent-ui/src/lib/chat/toolPreview.ts");
const { deriveFileChangeStats } = loader.loadModule("../agent-ui/src/lib/chat/fileChangeStats.ts");

const WORKDIR = "/work/ws";
const sixtyLines = `${Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

test("a trailing newline ends the last line instead of starting another", () => {
  assert.equal(countTextLines(""), 0);
  assert.equal(countTextLines("a"), 1);
  assert.equal(countTextLines("a\n"), 1);
  assert.equal(countTextLines("a\r\n"), 1);
  assert.equal(countTextLines("a\nb"), 2);
  assert.equal(countTextLines("a\n\n"), 2);
  assert.equal(countTextLines("\n"), 1);
  // The activity row's +N agrees with the approval diff's +60 for the same content.
  assert.deepEqual(
    deriveFileChangeStats({ name: "Write", arguments: { path: "notes/hello.txt", content: sixtyLines } }),
    { added: 60 },
  );
});

async function renderBar(pending, workdir) {
  const diffs = [];
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
  await env.act(async () => root.render(env.React.createElement(ToolApprovalBar, {
    pending, workdir, onDecide: async () => ({ ok: true }), onDecideAll: async () => {},
  })));
  const cleanup = async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  };
  return { host, diffs, cleanup };
}

const write = {
  toolCallId: "w1",
  toolName: "Write",
  summary: `${WORKDIR}/notes/hello.txt`,
  preview: { path: `${WORKDIR}/notes/hello.txt`, diff: "@@ -0,0 +1 @@\n+line 1\n", newFile: true },
};

test("the Write card names the file once, relative to the workspace, with a full-width diff", async () => {
  const { host, diffs, cleanup } = await renderBar([write], WORKDIR);
  try {
    assert.equal(host.querySelector("pre[data-approval-command]") === null, true, "no second copy of the path");
    assert.equal(diffs.at(-1)?.filePath, "notes/hello.txt");
    assert.equal(diffs.at(-1)?.fullWidth, true);
    assert.equal(host.textContent.includes(WORKDIR), false);
  } finally {
    await cleanup();
  }
});

test("a command summary stays, and paths outside the workspace stay absolute", async () => {
  const outside = { ...write, summary: "/etc/hosts", preview: { ...write.preview, path: "/etc/hosts" } };
  const bash = { toolCallId: "b1", toolName: "Bash", summary: "npm test" };
  const { host, diffs, cleanup } = await renderBar([outside], WORKDIR);
  try {
    assert.equal(diffs.at(-1)?.filePath, "/etc/hosts");
    assert.equal(host.querySelector("pre[data-approval-command]") === null, true);
  } finally {
    await cleanup();
  }
  const second = await renderBar([bash], WORKDIR);
  try {
    assert.equal(second.host.querySelector("pre[data-approval-command]").textContent, "npm test");
  } finally {
    await second.cleanup();
  }
});

test("the card is an alert dialog titled by its question", async () => {
  const { host, cleanup } = await renderBar([write], WORKDIR);
  try {
    const panel = host.querySelector("section");
    assert.equal(panel.getAttribute("role"), "alertdialog");
    const titleId = panel.getAttribute("aria-labelledby");
    assert.ok(titleId, "aria-labelledby is set");
    const title = host.querySelector(`[id="${titleId}"]`);
    assert.match(title?.textContent ?? "", /Write/, "the label points at the question in the card");
    assert.equal(panel.hasAttribute("aria-label"), false);
  } finally {
    await cleanup();
  }
});

test("only a K-brain permission denial counts as denied", () => {
  const { isPermissionDeniedToolResult } = loader.loadModule(
    "../agent-ui/src/lib/chat/toolPermissionDenied.ts",
  );
  const result = (text, isError = true) => ({ isError, content: [{ type: "text", text }] });
  assert.equal(isPermissionDeniedToolResult(result("Permission denied: the user rejected this action")), true);
  assert.equal(isPermissionDeniedToolResult(result("Error: Permission denied: use a smaller file")), true);
  assert.equal(isPermissionDeniedToolResult(result("open notes: permission denied")), false);
  assert.equal(isPermissionDeniedToolResult(result("Permission denied: x", false)), false);
  assert.equal(isPermissionDeniedToolResult(undefined), false);
});
