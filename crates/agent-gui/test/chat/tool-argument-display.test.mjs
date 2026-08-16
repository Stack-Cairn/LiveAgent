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
  toolResultMessageToText() {
    return "";
  },
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

  const { ToolArgsDisplay } = loader.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolResultDisplay.tsx",
  );

  return (toolCall) =>
    renderToStaticMarkup(jsxRuntime.jsx(ToolArgsDisplay, { item: { toolCall } }));
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
        retainRunningToolContent: false,
        submitAskUserQuestionAnswers() {},
        usePendingToolApproval() {
          return null;
        },
      },
      "@liveagent/ui/components/chat/AskUserQuestionCard": {
        AskUserQuestionCard: NullComponent,
      },
      "@liveagent/ui/components/chat/AssistantStatus": {
        AssistantStatus({ children }) {
          return jsxRuntime.jsx("span", { children });
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
        getBuiltinResultKind() {
          return null;
        },
        getShellSessionDisplayDetails() {
          return null;
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
        ToolArgsDisplay: NullComponent,
        ToolResultDisplay: NullComponent,
      },
    },
  });

  const { MemoToolCallItem } = loader.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
  );

  return (toolCall) =>
    renderToStaticMarkup(jsxRuntime.jsx(MemoToolCallItem, { item: { toolCall } }));
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
