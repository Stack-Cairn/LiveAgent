import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2b review, round 2. The desktop preview is now capped by deriveFileToolPreview,
// which keeps the first 4000 chars of each side independently. Diffing two independently
// head-cut sides hides or invents changes. Assertions compare strings, numbers and
// booleans only: a failing assert on a DOM node would print the whole jsdom tree.

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i));

async function createEnv() {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": {
        Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children),
      },
      "@liveagent/ui/components/ui/dropdown-menu": {
        DropdownMenu: ({ children }) => env.React.createElement("div", null, children),
        DropdownMenuTrigger: ({ render, children, ...props }) => env.React.cloneElement(render, props, children),
        DropdownMenuContent: ({ children }) => env.React.createElement("div", { role: "menu" }, children),
        DropdownMenuItem: ({ children, onSelect, disabled }) =>
          env.React.createElement("button", { role: "menuitem", disabled, onClick: onSelect }, children),
      },
    },
  });
  return env;
}

// Renders the real approval card (real EditDiffView) for a desktop Edit call and returns
// the changed rows the user sees.
async function renderDesktopEdit(editArgs) {
  const env = await createEnv();
  const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
  const args = env.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  // Exactly what runKBrainConversationTurn does with the call's full arguments.
  const preview = args.approvalPreviewFromToolCall("Edit", editArgs);
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(ToolApprovalBar, {
          pending: [{ toolCallId: "e1", toolName: "Edit", summary: editArgs.path, preview }],
          onDecide: async () => ({ ok: true }),
          onDecideAll: async () => {},
        }),
      ),
    );
    const changed = [...host.querySelectorAll("[data-chat-code-diff] .grid")]
      .map((row) => {
        const sign = row.className.includes("emerald") ? "+" : row.className.includes("red") ? "-" : " ";
        return [sign, row.querySelector("code")?.textContent ?? ""];
      })
      .filter(([sign]) => sign !== " ");
    const header = host.querySelector("[data-chat-code-diff] figcaption")?.textContent ?? "";
    return { changed, header, truncated: preview?.truncated ?? null };
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("a desktop Edit whose change lies past 4000 chars still shows the change", async () => {
  const body = lines(150, (i) => `  const item${i} = load(${i});`);
  const editArgs = {
    path: "src/items.ts",
    old_string: [...body, "  return 1;"].join("\n"),
    new_string: [...body, "  return 2;"].join("\n"),
  };
  // Baseline: WebUI's Gateway copy (head + tail) keeps the change.
  const loader = createTsModuleLoader();
  const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
  const { buildGatewayToolCallPreviewArguments } = loader.loadModule("src/pages/chat/turns/gatewayToolPreview.ts");
  const args = loader.loadModule("../agent-ui/src/lib/chat/toolApprovalArgs.ts");
  const call = { type: "toolCall", id: "review-r2-tail", name: "Edit", arguments: editArgs };
  approval.requestToolApproval({ toolCallId: call.id, toolName: "Edit", summary: "x", conversationId: "conv-r2", timeoutMs: null });
  const remote = args.pendingToolApprovalFromToolCall({ ...call, arguments: buildGatewayToolCallPreviewArguments(call) });
  approval.answerToolApproval(call.id, "deny", { conversationId: "conv-r2" });
  assert.equal(remote?.preview?.after.includes("return 2;"), true, "WebUI preview shows the change");

  const desktop = await renderDesktopEdit(editArgs);
  const facts = { oldLen: editArgs.old_string.length, ...desktop };
  assert.equal(
    desktop.changed.some(([sign, text]) => sign === "+" && text.includes("return 2;")),
    true,
    `desktop card hides the edit it approves: ${JSON.stringify(facts)}`,
  );
});

test("a desktop Edit cut on one side does not show kept lines as deleted", async () => {
  const kept = lines(140, (i) => `  const item${i} = load(${i});`);
  const oldText = kept.join("\n");
  const newText = [...lines(30, (i) => `  import${i}();`), ...kept].join("\n");
  assert.equal(oldText.length < 4000 && newText.length > 4000, true, "fixture: only new_string is over the cap");
  const desktop = await renderDesktopEdit({ path: "src/items.ts", old_string: oldText, new_string: newText });
  // Every old line survives in new_string, so a faithful preview deletes nothing.
  const falseDeletions = desktop.changed.filter(([sign, text]) => sign === "-" && newText.includes(text));
  assert.equal(
    falseDeletions.length,
    0,
    `kept lines shown as deleted: ${JSON.stringify({ header: desktop.header, falseDeletions: falseDeletions.slice(0, 4), count: falseDeletions.length })}`,
  );
});

// The "preview is cut" note sits at the end of the max-h-56 scroll box, after a diff that
// is always long when truncated (>= 4000 chars, ~100 rows), so it is below the fold.
test("the truncated-preview note is not hidden at the bottom of the scroll box", async () => {
  const env = await createEnv();
  const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
  const args = env.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  const content = lines(300, (i) => `const value${i} = compute(${i});`).join("\n");
  const preview = args.approvalPreviewFromToolCall("Write", { path: "src/big.ts", content });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(ToolApprovalBar, {
          pending: [{ toolCallId: "w1", toolName: "Write", summary: "src/big.ts", preview }],
          onDecide: async () => ({ ok: true }),
          onDecideAll: async () => {},
        }),
      ),
    );
    const note = [...host.querySelectorAll("p")].find((p) => /预览已截断/.test(p.textContent));
    const scroller = note?.closest(".overflow-auto");
    const diff = host.querySelector("[data-chat-code-diff]");
    const facts = {
      truncated: preview?.truncated ?? null,
      noteFound: Boolean(note),
      noteInScroller: Boolean(scroller),
      scrollerClass: scroller?.className ?? "",
      noteAfterDiff: Boolean(note && diff && diff.compareDocumentPosition(note) & 4),
      diffRows: host.querySelectorAll("[data-chat-code-diff] code").length,
    };
    assert.equal(facts.noteFound, true, JSON.stringify(facts));
    assert.equal(
      facts.noteInScroller && facts.noteAfterDiff,
      false,
      `note is below a ${facts.diffRows}-row diff inside the scroll box: ${JSON.stringify(facts)}`,
    );
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
