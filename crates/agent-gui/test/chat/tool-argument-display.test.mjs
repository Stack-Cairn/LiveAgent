import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const baseLoader = createTsModuleLoader({ rootDir });
const uiMessages = baseLoader.loadModule("@liveagent/ui/lib/chat/uiMessages.ts");
const toolPreview = baseLoader.loadModule("@liveagent/ui/lib/chat/toolPreview.ts");
const toolApprovalArgs = baseLoader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
const askUserQuestion = baseLoader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts");

function createReactRenderer() {
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  return {
    jsxRuntime: requireFromRoot("react/jsx-runtime"),
    renderToStaticMarkup: requireFromRoot("react-dom/server").renderToStaticMarkup,
  };
}

function NullComponent() {
  return null;
}

const realAdapterFunctions = {
  deriveFileToolPreview() {
    return null;
  },
  isDynamicMcpToolName: uiMessages.isDynamicMcpToolName,
  previewText: uiMessages.previewText,
  safeStringify: uiMessages.safeStringify,
  summarizeToolCall: uiMessages.summarizeToolCall,
  toolCallArgsForDisplay: uiMessages.toolCallArgsForDisplay,
  toolResultMessageToText: uiMessages.toolResultMessageToText,
};

function createToolArgsRenderer() {
  const { jsxRuntime, renderToStaticMarkup } = createReactRenderer();
  const loader = createTsModuleLoader({
    rootDir,
    mocks: {
      "react/jsx-runtime": jsxRuntime,
      "@liveagent/ui/components/chat/EditDiffView": {
        EditDiffView: NullComponent,
      },
      "@liveagent/ui/components/chat/FileToolArgs": {
        FileToolArgsDisplay: NullComponent,
      },
      "@liveagent/ui/components/chat/ToolSurfaces": {
        MetaTags({ tags }) {
          return jsxRuntime.jsx("div", {
            children: tags.map((tag) => `${tag.label}=${tag.value}`).join(" "),
          });
        },
        PathDisplay({ path: filePath }) {
          return jsxRuntime.jsx("span", { children: filePath });
        },
        ToolFactGrid({ tags }) {
          return jsxRuntime.jsx("div", {
            "data-kind": "fact-grid",
            children: tags.map((tag) => `${tag.label}=${tag.value}`).join(" "),
          });
        },
        ToolScrollablePre({ className, children }) {
          return jsxRuntime.jsx("pre", { "data-kind": "raw-args", className, children });
        },
        ToolSurface({ children }) {
          return jsxRuntime.jsx("section", { children });
        },
        ToolSurfaceLabel({ label }) {
          return jsxRuntime.jsx("span", { children: label });
        },
      },
      "@liveagent/ui/components/Markdown": {
        Markdown: NullComponent,
      },
      "@liveagent/ui/lib/chat/assistantBubbleAdapter": realAdapterFunctions,
      "../../IconSet": {
        Search: NullComponent,
      },
      "./assistantBubbleUtils": {
        displayString(value) {
          return typeof value === "string" ? value.trim() : "";
        },
        getBuiltinResultKind() {
          return null;
        },
        getStableValueSignature(value) {
          return JSON.stringify(value);
        },
        getSubagentTask() {
          return "";
        },
        isSubagentCardToolCall() {
          return false;
        },
        shouldShowSubagentApplyStatus() {
          return false;
        },
        shouldShowSubagentCleanupStatus() {
          return false;
        },
        shouldShowSubagentWorktreeLocation() {
          return false;
        },
      },
      "./ToolImages": {
        getToolResultImages() {
          return [];
        },
        ToolResultImagePreview: NullComponent,
      },
    },
  });

  const { ShellToolDisplay, ToolArgsDisplay, ToolResultDisplay } = loader.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolResultDisplay.tsx",
  );

  const renderToolArgs = (toolCall) =>
    renderToStaticMarkup(jsxRuntime.jsx(ToolArgsDisplay, { item: { toolCall } }));
  renderToolArgs.renderResult = (toolCall, details) =>
    renderToStaticMarkup(
      jsxRuntime.jsx(ToolResultDisplay, {
        item: { toolCall },
        result: {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [],
          details,
          isError: false,
        },
      }),
    );
  renderToolArgs.renderShell = (toolCall, result) =>
    renderToStaticMarkup(
      jsxRuntime.jsx(ShellToolDisplay, {
        item: { toolCall, toolResult: result },
        result,
      }),
    );
  return renderToolArgs;
}

function createToolCallItemRenderer() {
  const { jsxRuntime, renderToStaticMarkup } = createReactRenderer();
  const loader = createTsModuleLoader({
    rootDir,
    mocks: {
      "react/jsx-runtime": jsxRuntime,
      "@liveagent/adapters/assistantBubble": {
        readAskUserQuestionDeadline() {
          return undefined;
        },
        usePlanDecisionState() {
          return { pending: false, approved: false };
        },
        retainRunningToolContent: false,
        submitAskUserQuestionAnswers() {},
        submitPlanDecision() {},
        usePendingToolApproval() {
          return null;
        },
      },
      "@liveagent/ui/components/chat/AskUserQuestionCard": {
        AskUserQuestionCard: NullComponent,
      },
      "@liveagent/ui/components/chat/PlanModeCard": {
        PlanModeCard: NullComponent,
      },
      "@liveagent/ui/components/chat/AssistantStatus": {
        AssistantStatus({ children }) {
          return jsxRuntime.jsx("span", { "data-running": "true", children });
        },
      },
      "@liveagent/ui/components/chat/FileChangeBadge": {
        FileChangeBadge: NullComponent,
      },
      "@liveagent/ui/components/chat/LazyCollapse": {
        LazyCollapse({ open, children }) {
          return open ? children() : null;
        },
      },
      "@liveagent/ui/components/chat/ToolSurfaces": {
        ToolScrollablePre({ children }) {
          return jsxRuntime.jsx("pre", { children });
        },
        ToolSection({ children }) {
          return jsxRuntime.jsx("section", { children });
        },
      },
      "@liveagent/ui/i18n/index": {
        useLocale() {
          return {
            t(key) {
              return key;
            },
          };
        },
      },
      "@liveagent/ui/lib/chat/askUserQuestion": {
        ASK_USER_QUESTION_TOOL_NAME: "AskUserQuestion",
        parseAskUserQuestionResultDetails() {
          return null;
        },
        sanitizeAskUserQuestionItems() {
          return [];
        },
      },
      "@liveagent/ui/lib/chat/planMode": {
        EXIT_PLAN_MODE_TOOL_NAME: "ExitPlanMode",
        parseExitPlanModeResultDetails() {
          return null;
        },
        sanitizePlanMarkdown() {
          return "";
        },
      },
      "@liveagent/ui/lib/chat/assistantBubbleAdapter": {
        ...realAdapterFunctions,
        deriveFileChangeStats() {
          return undefined;
        },
        FILE_TOOL_TEXT_FIELDS: toolPreview.FILE_TOOL_TEXT_FIELDS,
      },
      "@liveagent/ui/lib/shared/utils": {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
      "../../IconSet": {
        ChevronRight: NullComponent,
      },
      "./assistantBubbleUtils": {
        areStableValuesEqual(left, right) {
          return JSON.stringify(left) === JSON.stringify(right);
        },
        getToolActivityCategory(name) {
          if (["Bash", "ManagedProcess", "ProcessWait", "ProcessStop"].includes(name)) {
            return "command";
          }
          return "other";
        },
        getBuiltinResultKind() {
          return null;
        },
        getFileOperationDisplay(item) {
          if (!["Read", "Write", "Edit", "Delete"].includes(item.toolCall.name)) return null;
          const details = item.toolResult?.details ?? {};
          const filePath =
            details.displayPath ||
            details.relativePath ||
            details.path ||
            item.toolCall.arguments?.path;
          if (typeof filePath !== "string" || !filePath.trim()) return null;
          const normalized = filePath.replaceAll("\\", "/");
          const kind =
            item.toolCall.name === "Read"
              ? "read"
              : item.toolCall.name === "Delete"
                ? "delete"
                : item.toolCall.name === "Write" && details.existedBefore !== true
                  ? "create"
                  : "edit";
          return {
            kind,
            path: filePath,
            fileName: normalized.slice(normalized.lastIndexOf("/") + 1),
            link: {
              path: details.absolutePath || filePath,
              source: details.absolutePath ? "absolute" : "relative",
            },
          };
        },
        getShellSessionDisplayDetails(result) {
          const details = result?.details;
          if (!details || typeof details !== "object") return null;
          if (typeof details.session_id !== "string" || typeof details.status !== "string") {
            return null;
          }
          return { sessionId: details.session_id, status: details.status };
        },
        getSubagentInlineSummary() {
          return "";
        },
        getToolDisplayName(name) {
          return name;
        },
        getToolDisplayTitle(toolCall) {
          return { name: toolCall.name, action: "" };
        },
        getToolMeta() {
          return { Icon: NullComponent };
        },
        isBuiltinShareToolName() {
          return false;
        },
        isSubagentCardToolCall() {
          return false;
        },
      },
      "./ToolResultDisplay": {
        ShellToolDisplay: NullComponent,
        ToolArgsDisplay: NullComponent,
        ToolResultDisplay: NullComponent,
      },
    },
  });

  const { MemoToolCallItem } = loader.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
  );

  return (toolCall, options = {}) =>
    renderToStaticMarkup(
      jsxRuntime.jsx(MemoToolCallItem, {
        item: options.result ? { toolCall, toolResult: options.result } : { toolCall },
        isRunning: options.isRunning,
        onOpenFileLink: options.onOpenFileLink,
      }),
    );
}

test("isDynamicMcpToolName classifies dynamic MCP tool names", () => {
  assert.equal(typeof uiMessages.isDynamicMcpToolName, "function");
  assert.equal(uiMessages.isDynamicMcpToolName("mcp_ssh_execute_command"), true);
  assert.equal(uiMessages.isDynamicMcpToolName(" mcp_fs_read"), true);
  assert.equal(uiMessages.isDynamicMcpToolName("McpManager"), false);
  assert.equal(uiMessages.isDynamicMcpToolName("Bash"), false);
});

test("display args keep long values intact and strip synthetic keys", () => {
  const cmdString = `command-${"x".repeat(1200)}-command-tail`;
  const options = {
    cwd: "/workspace",
    env: ["A=1", "B=2"],
    nested: { token: `nested-${"y".repeat(900)}-nested-tail`, retries: 3 },
  };

  const display = uiMessages.toolCallArgsForDisplay({
    type: "toolCall",
    id: "mcp-long-args",
    name: "mcp_ssh_execute_command",
    arguments: {
      cmdString,
      options,
      __custom: "legitimate-mcp-value",
      __toolApprovalPending: true,
      __toolApprovalSummary: "secret-approval-summary",
      [toolPreview.LIVE_TOOL_PREVIEW_META_KEY]: { v: 2, progress: 1, fields: {} },
    },
  });

  assert.equal(display.cmdString, cmdString);
  assert.deepEqual(display.options, options);
  assert.equal(display.__custom, "legitimate-mcp-value");
  assert.equal(Object.hasOwn(display, "__toolApprovalPending"), false);
  assert.equal(Object.hasOwn(display, "__toolApprovalSummary"), false);
  assert.equal(Object.hasOwn(display, toolPreview.LIVE_TOOL_PREVIEW_META_KEY), false);
});

test("display args filter only known synthetic keys and preserve unknown double-underscore keys", () => {
  const display = uiMessages.toolCallArgsForDisplay({
    type: "toolCall",
    id: "mcp-synthetic-args",
    name: "mcp_custom_tool",
    arguments: {
      __custom: "business-value",
      [toolApprovalArgs.TOOL_APPROVAL_PENDING_ARG]: true,
      [toolApprovalArgs.TOOL_APPROVAL_DEADLINE_ARG]: Date.now(),
      [toolApprovalArgs.TOOL_APPROVAL_SUMMARY_ARG]: "approval-summary",
      [askUserQuestion.ASK_USER_QUESTION_DEADLINE_ARG]: Date.now(),
      [toolPreview.LIVE_TOOL_PREVIEW_META_KEY]: { v: 2, progress: 1, fields: {} },
    },
  });

  assert.equal(display.__custom, "business-value");
  assert.equal(Object.hasOwn(display, toolApprovalArgs.TOOL_APPROVAL_PENDING_ARG), false);
  assert.equal(Object.hasOwn(display, toolApprovalArgs.TOOL_APPROVAL_DEADLINE_ARG), false);
  assert.equal(Object.hasOwn(display, toolApprovalArgs.TOOL_APPROVAL_SUMMARY_ARG), false);
  assert.equal(Object.hasOwn(display, askUserQuestion.ASK_USER_QUESTION_DEADLINE_ARG), false);
  assert.equal(Object.hasOwn(display, toolPreview.LIVE_TOOL_PREVIEW_META_KEY), false);
});

test("display args cap pathological strings, including nested ones, with an explicit marker", () => {
  const display = uiMessages.toolCallArgsForDisplay({
    type: "toolCall",
    id: "mcp-huge-args",
    name: "mcp_fs_write_file",
    arguments: {
      content: "x".repeat(120_000),
      options: { inner: "y".repeat(30_000) },
    },
  });

  assert.ok(display.content.startsWith("x".repeat(20_000)));
  assert.ok(display.content.endsWith("（已截断，len=120000）"));
  assert.ok(display.content.length < 121_000);
  assert.ok(display.options.inner.startsWith("y".repeat(20_000)));
  assert.ok(display.options.inner.endsWith("（已截断，len=30000）"));
});

test("display args enforce a cumulative budget across medium-sized fields", () => {
  const argumentsForDisplay = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [`field_${index}`, "x".repeat(19_999)]),
  );
  const display = uiMessages.toolCallArgsForDisplay({
    type: "toolCall",
    id: "mcp-cumulative-budget",
    name: "mcp_batch_write",
    arguments: argumentsForDisplay,
  });
  const text = uiMessages.safeStringify(display);

  assert.ok(text.length < 60_000);
  assert.match(text, /展示已截断/);
});

test("expanded MCP arguments render complete long and nested values as wrapped scrollable JSON", () => {
  const renderToolArgs = createToolArgsRenderer();
  const cmdString = `command-${"x".repeat(1200)}-command-tail`;
  const nestedValue = `nested-${"y".repeat(900)}-nested-tail`;
  const html = renderToolArgs({
    type: "toolCall",
    id: "mcp-long-args",
    name: "mcp_ssh_execute_command",
    arguments: {
      cmdString,
      options: { nested: nestedValue, retries: 3 },
      __toolApprovalSummary: "secret-approval-summary",
    },
  });

  assert.ok(html.includes('data-kind="raw-args"'));
  assert.ok(!html.includes('data-kind="fact-grid"'));
  assert.ok(html.includes("whitespace-pre-wrap"));
  assert.ok(html.includes(cmdString));
  assert.ok(html.includes(nestedValue));
  assert.ok(!html.includes("secret-approval-summary"));
});

test("generic arguments above the grid limit fall through to complete JSON", () => {
  const renderToolArgs = createToolArgsRenderer();
  const note = `note-${"n".repeat(1000)}-note-tail`;
  const html = renderToolArgs({
    type: "toolCall",
    id: "generic-long-args",
    name: "CustomAudit",
    arguments: { note, retries: 2 },
  });

  assert.ok(html.includes('data-kind="raw-args"'));
  assert.ok(!html.includes('data-kind="fact-grid"'));
  assert.ok(html.includes(note));
  assert.ok(!html.includes("…"));
});

test("generic arguments with nested objects fall through to complete JSON instead of dropping them", () => {
  const renderToolArgs = createToolArgsRenderer();
  const html = renderToolArgs({
    type: "toolCall",
    id: "generic-nested-args",
    name: "CustomAudit",
    arguments: { config: { region: "eu-central-1" }, note: "short-note" },
  });

  assert.ok(html.includes('data-kind="raw-args"'));
  assert.ok(html.includes("eu-central-1"));
  assert.ok(html.includes("short-note"));
});

test("short generic arguments keep the compact grid, complete and without synthetic keys", () => {
  const renderToolArgs = createToolArgsRenderer();
  const note = `note-${"n".repeat(150)}-note-tail`;
  const html = renderToolArgs({
    type: "toolCall",
    id: "generic-short-args",
    name: "CustomAudit",
    arguments: {
      note,
      enabled: true,
      __toolApprovalSummary: "secret-approval-summary",
    },
  });

  assert.ok(html.includes('data-kind="fact-grid"'));
  assert.ok(!html.includes('data-kind="raw-args"'));
  assert.ok(html.includes(note));
  assert.ok(html.includes("enabled=true"));
  assert.ok(!html.includes("secret-approval-summary"));
  assert.ok(!html.includes("…"));
});

test("ProcessWait and ProcessStop summaries expose their session cursor", () => {
  assert.equal(
    uiMessages.summarizeToolCall(
      {
        type: "toolCall",
        id: "wait-1",
        name: "ProcessWait",
        arguments: { session_id: "session-1", cursor: 64, yield_time_ms: 30_000 },
      },
      { includeName: false },
    ),
    "session=session-1 cursor=64 yield_ms=30000",
  );
  assert.equal(
    uiMessages.summarizeToolCall(
      {
        type: "toolCall",
        id: "stop-1",
        name: "ProcessStop",
        arguments: { session_id: "session-1", cursor: 128 },
      },
      { includeName: false },
    ),
    "session=session-1 cursor=128",
  );
});

test("shell session metadata is omitted from generic tool result details", () => {
  const renderToolDisplay = createToolArgsRenderer();
  const details = {
    session_id: "session-1",
    status: "running",
    cursor: 128,
    has_more: true,
    exit_code: null,
    duration_ms: 30_000,
    shell: "bash",
    output_truncated: true,
  };

  for (const name of ["Bash", "ProcessWait", "ProcessStop"]) {
    const html = renderToolDisplay.renderResult(
      { type: "toolCall", id: `call-${name}`, name, arguments: {} },
      details,
    );
    assert.equal(html, "", name);
  }
});

test("shell display combines command and output without runtime session metadata", () => {
  const renderToolDisplay = createToolArgsRenderer();
  const toolCall = {
    type: "toolCall",
    id: "bash-clean-shell",
    name: "Bash",
    arguments: { command: "git diff --stat" },
  };
  const result = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: "# Shell Session\nstatus: completed\nsession_id: bash-private\ncursor: 1125\nshell: zsh\n\nstdout:\nM src/App.tsx",
      },
    ],
    details: {
      session_id: "bash-private",
      status: "completed",
      cursor: 1125,
      exit_code: 0,
      duration_ms: 2600,
      shell: "zsh",
      output: [{ stream: "stdout", text: "M src/App.tsx\n" }],
    },
    isError: false,
  };
  const html = renderToolDisplay.renderShell(toolCall, result);

  assert.match(html, /data-shell-tool-display=""/);
  assert.match(html, />Shell</);
  assert.match(html, /\$ /);
  assert.match(html, /git diff --stat/);
  assert.match(html, /M src\/App\.tsx/);
  assert.doesNotMatch(html, /bash-private|session_id|status:|cursor:|duration_ms|shell: zsh/);
});

test("historical shell envelopes fall back to clean stdout and stderr only", () => {
  const renderToolDisplay = createToolArgsRenderer();
  const toolCall = {
    type: "toolCall",
    id: "bash-history-shell",
    name: "ProcessWait",
    arguments: { session_id: "private-session", cursor: 10 },
  };
  const result = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      {
        type: "text",
        text: [
          "# Shell Session",
          "status: completed",
          "session_id: private-session",
          "cursor: 22",
          "shell: zsh",
          "",
          "stdout:",
          "line one",
          "stderr:",
          "line two",
        ].join("\n"),
      },
    ],
    details: {},
    isError: false,
  };
  const html = renderToolDisplay.renderShell(toolCall, result);

  assert.match(html, /line one\nline two/);
  assert.doesNotMatch(html, /private-session|session_id|status:|cursor:|shell: zsh/);
});

test("shell session snapshots show status without a permanent spinner", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const running = renderToolCallItem(
    {
      type: "toolCall",
      id: "wait-running",
      name: "ProcessWait",
      arguments: { session_id: "session-1", cursor: 64 },
    },
    {
      result: {
        role: "toolResult",
        toolCallId: "wait-running",
        toolName: "ProcessWait",
        content: [],
        details: { session_id: "session-1", status: "running", duration_ms: 30_000 },
        isError: false,
      },
    },
  );
  const stopped = renderToolCallItem(
    {
      type: "toolCall",
      id: "stop-cancelled",
      name: "ProcessStop",
      arguments: { session_id: "session-1", cursor: 64 },
    },
    {
      result: {
        role: "toolResult",
        toolCallId: "stop-cancelled",
        toolName: "ProcessStop",
        content: [],
        details: { session_id: "session-1", status: "cancelled", duration_ms: 31_000 },
        isError: false,
      },
    },
  );
  const pending = renderToolCallItem(
    {
      type: "toolCall",
      id: "wait-pending",
      name: "ProcessWait",
      arguments: { session_id: "session-1", cursor: 64 },
    },
    { isRunning: true },
  );

  assert.match(running, /chat\.tool\.running/);
  assert.doesNotMatch(running, /data-running="true"/);
  assert.doesNotMatch(running, /session-1|cursor=|session=/);
  assert.match(stopped, /chat\.tool\.stopped/);
  assert.doesNotMatch(stopped, /data-running="true"/);
  assert.doesNotMatch(stopped, /session-1|cursor=|session=/);
  assert.match(pending, /data-running="true"/);
  assert.doesNotMatch(pending, /session-1|cursor=|session=/);
});

test("Bash collapsed summary keeps the full first line in DOM and title instead of a 48-char cut", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const command = `echo ${"a".repeat(140)}-command-tail`;
  const html = renderToolCallItem({
    type: "toolCall",
    id: "bash-long-command",
    name: "Bash",
    arguments: { command },
  });

  // Once in the hover title, once in the visible summary text.
  assert.equal(html.split(command).length - 1, 2);
  assert.ok(!html.includes(`$ ${command}`));
  assert.ok(!html.includes("…"));
});

test("Bash collapsed summary bounds pathological single-line commands in DOM and title", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const command = "b".repeat(5000);
  const html = renderToolCallItem({
    type: "toolCall",
    id: "bash-huge-command",
    name: "Bash",
    arguments: { command },
  });

  assert.ok(html.includes(`${"b".repeat(600)}…`));
  assert.ok(!html.includes("b".repeat(601)));
});

test("Bash collapsed title carries the full multi-line command while the summary shows the first line", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const html = renderToolCallItem({
    type: "toolCall",
    id: "bash-multiline-command",
    name: "Bash",
    arguments: { command: "line-one-alpha\nline-two-beta" },
  });

  assert.ok(html.includes("line-one-alpha"));
  // The second line is reachable only through the hover title.
  assert.ok(html.includes("line-two-beta"));
});

test("successful file operations render concise IDE links without disclosures", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const html = renderToolCallItem(
    {
      type: "toolCall",
      id: "read-file-link",
      name: "Read",
      arguments: { path: "src/pages/chat/ChatPage.tsx", start_line: 12 },
    },
    {
      result: {
        role: "toolResult",
        toolCallId: "read-file-link",
        toolName: "Read",
        content: [],
        details: {
          kind: "read_text",
          absolutePath: "/workspace/src/pages/chat/ChatPage.tsx",
          displayPath: "src/pages/chat/ChatPage.tsx",
        },
        isError: false,
      },
      onOpenFileLink() {},
    },
  );

  assert.match(html, /chat\.tool\.file\.read\.completed/);
  assert.match(html, /data-chat-file-link=""/);
  assert.match(html, />ChatPage\.tsx<\/button>/);
  assert.doesNotMatch(html, /aria-expanded=/);
  assert.doesNotMatch(html, /path=src\/pages\/chat\/ChatPage\.tsx/);
});

test("file action labels distinguish create, overwrite, edit, and delete", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const result = (id, name, details) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [],
    details,
    isError: false,
  });
  const created = renderToolCallItem(
    { type: "toolCall", id: "write-new", name: "Write", arguments: { path: "new.ts" } },
    { result: result("write-new", "Write", { displayPath: "new.ts", existedBefore: false }) },
  );
  const overwritten = renderToolCallItem(
    { type: "toolCall", id: "write-old", name: "Write", arguments: { path: "old.ts" } },
    { result: result("write-old", "Write", { displayPath: "old.ts", existedBefore: true }) },
  );
  const edited = renderToolCallItem(
    { type: "toolCall", id: "edit", name: "Edit", arguments: { path: "edit.ts" } },
    { result: result("edit", "Edit", { displayPath: "edit.ts" }) },
  );
  const deleted = renderToolCallItem(
    { type: "toolCall", id: "delete", name: "Delete", arguments: { path: "gone.ts" } },
    { result: result("delete", "Delete", { displayPath: "gone.ts" }), onOpenFileLink() {} },
  );

  assert.match(created, /chat\.tool\.file\.create\.completed/);
  assert.match(overwritten, /chat\.tool\.file\.edit\.completed/);
  assert.match(edited, /chat\.tool\.file\.edit\.completed/);
  assert.match(deleted, /chat\.tool\.file\.delete\.completed/);
  assert.doesNotMatch(deleted, /data-chat-file-link/);
});

test("failed file operations keep an expandable error disclosure", () => {
  const renderToolCallItem = createToolCallItemRenderer();
  const html = renderToolCallItem(
    { type: "toolCall", id: "edit-failed", name: "Edit", arguments: { path: "src/App.tsx" } },
    {
      result: {
        role: "toolResult",
        toolCallId: "edit-failed",
        toolName: "Edit",
        content: [{ type: "text", text: "replacement did not match" }],
        details: {},
        isError: true,
      },
      onOpenFileLink() {},
    },
  );

  assert.match(html, /chat\.tool\.file\.edit\.failed/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /data-chat-file-link/);
});
