import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2b independent review. Each test is a regression that fails on the reviewed tree.
// Assertions compare strings, numbers and booleans only: a failing assert on a DOM node
// would print the whole jsdom tree.

// ---------------------------------------------------------------------------------
// Desktop preview is unbounded: runKBrainConversationTurn passes the call's full
// arguments to approvalPreviewFromToolCall, which copies them as-is, while WebUI (the
// Gateway overlay) and the transcript (deriveFileToolPreview) both cap the same text at
// 4000 chars. The desktop card then diffs and renders every line.
// ---------------------------------------------------------------------------------

function bigWrite(lines) {
  const content = Array.from({ length: lines }, (_, i) => `const value${i} = compute(${i}, "row ${i}");`).join("\n");
  return { path: "src/generated.ts", content };
}

test("desktop approval preview is capped like the WebUI copy and the transcript", () => {
  const loader = createTsModuleLoader();
  const approval = loader.loadModule("src/lib/tools/toolApproval.ts");
  const { buildGatewayToolCallPreviewArguments } = loader.loadModule("src/pages/chat/turns/gatewayToolPreview.ts");
  const args = loader.loadModule("../agent-ui/src/lib/chat/toolApprovalArgs.ts");
  const { deriveFileToolPreview } = loader.loadModule("../agent-ui/src/lib/chat/toolPreview.ts");

  const call = { type: "toolCall", id: "review-write-1", name: "Write", arguments: bigWrite(3000) };
  const full = call.arguments.content.length;

  // Desktop: exactly what runKBrainConversationTurn.ts does with `call.arguments`.
  const desktop = args.approvalPreviewFromToolCall("Write", call.arguments);
  const pending = approval.requestToolApproval({
    toolCallId: call.id,
    toolName: "Write",
    summary: "src/generated.ts",
    conversationId: "conv-review-cap",
    preview: desktop,
    timeoutMs: null,
  });
  const listed = approval.listPendingToolApprovalsForConversation("conv-review-cap")[0];

  // WebUI: real Gateway overlay -> real WebUI collector.
  const remote = args.pendingToolApprovalFromToolCall({ ...call, arguments: buildGatewayToolCallPreviewArguments(call) });
  // Transcript: the same call rendered as tool arguments on the desktop.
  const transcript = deriveFileToolPreview(call);

  approval.answerToolApproval(call.id, "deny", { conversationId: "conv-review-cap" });
  void pending;

  const facts = {
    full,
    webuiChars: remote?.preview?.after.length ?? -1,
    webuiTruncated: remote?.preview?.truncated ?? null,
    transcriptChars: transcript?.content.text.length ?? -1,
    transcriptTruncated: transcript?.content.truncated ?? null,
    desktopChars: listed?.preview?.after.length ?? -1,
    desktopTruncated: listed?.preview?.truncated ?? null,
  };
  // Baseline facts that hold today (they show the other two surfaces are capped).
  assert.equal(facts.webuiTruncated, true, JSON.stringify(facts));
  assert.equal(facts.transcriptTruncated, true, JSON.stringify(facts));
  assert.equal(facts.webuiChars <= 4000, true, JSON.stringify(facts));
  // The defect: the desktop card gets the whole text, marked as not truncated.
  assert.equal(
    facts.desktopChars <= 4100 && facts.desktopTruncated === true,
    true,
    `desktop approval preview is not capped: ${JSON.stringify(facts)}`,
  );
});

test("the real approval card renders a bounded diff for a large desktop Write", async () => {
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
  const { ToolApprovalBar } = env.loadModule("@liveagent/ui/components/chat/ToolApprovalBar.tsx");
  const args = env.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  const writeArgs = bigWrite(3000);
  const preview = args.approvalPreviewFromToolCall("Write", writeArgs);
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    const started = performance.now();
    await env.act(async () =>
      root.render(
        env.React.createElement(ToolApprovalBar, {
          pending: [{ toolCallId: "w1", toolName: "Write", summary: "src/generated.ts", preview }],
          onDecide: async () => ({ ok: true }),
          onDecideAll: async () => {},
        }),
      ),
    );
    const elapsedMs = Math.round(performance.now() - started);
    const rows = host.querySelectorAll("[data-chat-code-diff] code").length;
    const textChars = host.querySelector("[data-chat-code-diff]")?.textContent.length ?? 0;
    const facts = { rows, textChars, elapsedMs, sourceChars: writeArgs.content.length };
    // The Gateway/transcript cap is 4000 chars, i.e. on the order of 100 rows of this text.
    assert.equal(rows <= 200, true, `card rendered every line of the edit: ${JSON.stringify(facts)}`);
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------------
// WebKit IME commit (Tauri on macOS = WKWebView, Safari WebUI): compositionend fires
// before the committing keydown, which arrives as Enter with keyCode 229 and
// isComposing=false. The reason field only checks isComposing, so committing a Chinese
// candidate with Enter submits the denial with a half-typed reason. The project's own
// inputs (MentionComposerInputUtils.isImeKeyboardEvent, ConversationSearchDialog,
// ChatHistorySidebar) treat keyCode 229 as an IME key.
// ---------------------------------------------------------------------------------
