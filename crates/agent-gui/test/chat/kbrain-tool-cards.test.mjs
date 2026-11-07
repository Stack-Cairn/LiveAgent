import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const loader = createTsModuleLoader({ rootDir });
const utils = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);
const IconSet = loader.loadModule("@liveagent/ui/components/IconSet.tsx");
const uiMessages = loader.loadModule("@liveagent/ui/lib/chat/uiMessages.ts");
const enUS = loader.loadModule("@liveagent/ui/i18n/translations/enUSCommon.ts");
const zhCN = loader.loadModule("@liveagent/ui/i18n/translations/zhCNCommon.ts");

const summarize = (name, args) =>
  uiMessages.summarizeToolCall(
    { type: "toolCall", id: `${name}-1`, name, arguments: args },
    { includeName: false, includeManagerAction: false },
  );

test("K-brain mcp__<server>__<tool> names parse into server and tool", () => {
  assert.deepEqual(utils.parseDynamicMcpToolName("mcp__cua-driver__get_desktop_state"), {
    serverId: "cua-driver",
    tool: "get_desktop_state",
  });
  // serverKey never contains "__"; a tool segment may, and stays whole.
  assert.deepEqual(utils.parseDynamicMcpToolName("mcp__docs__search__v2"), {
    serverId: "docs",
    tool: "search__v2",
  });
  // Hashed keys for server names with unsafe characters keep their suffix.
  assert.deepEqual(utils.parseDynamicMcpToolName("mcp__my-server_1a2b3c4d__run"), {
    serverId: "my-server_1a2b3c4d",
    tool: "run",
  });
  for (const malformed of ["mcp__", "mcp____tool", "mcp__srv", "mcp__srv__"]) {
    assert.equal(utils.parseDynamicMcpToolName(malformed), null, malformed);
  }
});

test("legacy mcp_<server>_<tool> names still parse", () => {
  assert.deepEqual(utils.parseDynamicMcpToolName("mcp_cua-driver_get_desktop_state"), {
    serverId: "cua-driver",
    tool: "get_desktop_state",
  });
  assert.equal(utils.parseDynamicMcpToolName("mcp_docs"), null);
  assert.equal(utils.parseDynamicMcpToolName("Read"), null);
});

test("K-brain MCP names get readable titles and cua-driver detection", () => {
  assert.equal(
    utils.getToolDisplayName("mcp__cua-driver__get_desktop_state"),
    "cua-driver · get_desktop_state",
  );
  assert.equal(utils.getToolDisplayName("mcp__docs__search"), "docs · search");
  assert.equal(utils.isCuaDriverToolName("mcp__cua-driver__click"), true);
  assert.equal(utils.isCuaDriverToolName("mcp__CUA-Driver__click"), true);
  assert.equal(utils.isCuaDriverToolName("mcp__docs__click"), false);
  assert.equal(utils.getToolMeta("mcp__cua-driver__click").Icon, IconSet.Hand);
  assert.equal(utils.getToolMeta("mcp__cua-driver__click").category, "cua");
  assert.equal(utils.getToolMeta("mcp__docs__search").Icon, IconSet.Plug);
  assert.equal(utils.isBuiltinShareToolName("mcp__docs__search"), true);
});

const KBRAIN_TOOLS = {
  TerminalSession: { category: "command", Icon: "Terminal" },
  ReadTerminal: { category: "read", Icon: "ScrollText" },
  PlanningQuery: { category: "planning", Icon: "CalendarDays" },
  PlanningMutate: { category: "planning", Icon: "CalendarDays" },
  wait: { category: "wait", Icon: "Timer" },
  workflow: { category: "workflow", Icon: "Waypoints" },
  structured_output: { category: "result", Icon: "Braces" },
  new_context: { category: "context", Icon: "RotateCcw" },
  browser_exec: { category: "browser", Icon: "AppWindow" },
  remember: { category: "memory", Icon: "Brain" },
  forget: { category: "memory", Icon: "Brain" },
  memory_manager: { category: "memory", Icon: "Brain" },
  computer_exec: { category: "computer", Icon: "Hand" },
  ToolSearch: { category: "search", Icon: "Search" },
  SkillsManager: { category: "read", Icon: "Eye" },
  CronTaskManager: { category: "other", Icon: "Clock3" },
};

test("every K-brain tool gets its own icon and activity category instead of the wrench", () => {
  for (const [name, expected] of Object.entries(KBRAIN_TOOLS)) {
    assert.equal(utils.getToolActivityCategory(name), expected.category, name);
    assert.equal(utils.getToolMeta(name).Icon, IconSet[expected.Icon], name);
    assert.notEqual(utils.getToolMeta(name).Icon, IconSet.Wrench, name);
  }
  // Unknown tools keep the generic fallback.
  assert.equal(utils.getToolMeta("Wait").Icon, IconSet.Wrench);
  assert.equal(utils.getToolActivityCategory("Remember"), "other");
});

test("every activity category has localized titles in en-US and zh-CN", () => {
  for (const category of utils.TOOL_ACTIVITY_CATEGORIES) {
    const phases = category === "other" ? ["running"] : ["running", "completed", "failed"];
    const keys = [
      `chat.tool.batch.${category}`,
      `chat.tool.batch.${category}.running`,
      ...phases.map((phase) => `chat.tool.activity.${category}.${phase}`),
    ];
    for (const key of keys) {
      assert.ok(enUS.EN_US_COMMON_TRANSLATIONS[key], `en-US ${key}`);
      assert.ok(zhCN.ZH_CN_COMMON_TRANSLATIONS[key], `zh-CN ${key}`);
    }
  }
  assert.equal(enUS.EN_US_COMMON_TRANSLATIONS["chat.tool.activity.wait.running"], "Setting up wait");
  assert.equal(zhCN.ZH_CN_COMMON_TRANSLATIONS["chat.tool.activity.memory.completed"], "已使用记忆");
});

test("K-brain tool summaries show the argument that matters", () => {
  assert.equal(summarize("TerminalSession", { command: "npm run dev" }), "npm run dev");
  assert.equal(
    summarize("ReadTerminal", { session_id: "term-3", max_bytes: 4096 }),
    "session=term-3 maxBytes=4096",
  );
  assert.equal(
    summarize("wait", {
      command: "gh pr checks 55",
      until: "pass",
      interval: 30,
      timeout: 1800,
    }),
    "gh pr checks 55 match=/pass/ every=30s timeout=1800s",
  );
  assert.equal(summarize("wait", { command: "curl -sf localhost:8080/health" }), "curl -sf localhost:8080/health");
  const from = new Date(2026, 10, 1).getTime();
  const to = new Date(2026, 10, 30, 23, 59).getTime();
  assert.equal(summarize("PlanningQuery", { from, to }), "2026-11-01 → 2026-11-30");
  assert.equal(summarize("PlanningQuery", { from }), "from 2026-11-01");
  assert.equal(summarize("PlanningQuery", {}), "");
  assert.equal(
    summarize("PlanningMutate", {
      requestId: "r1",
      action: "todo.create",
      data: { title: "Water the plants" },
    }),
    "todo.create Water the plants",
  );
  assert.equal(
    summarize("PlanningMutate", { action: "calendar.update", id: "cal-1", data: { name: "Home" } }),
    "calendar.update Home id=cal-1",
  );
  assert.equal(
    summarize("workflow", {
      script: 'export const meta = { name: "audit-docs", description: "x" };\nagent("go");',
    }),
    "audit-docs",
  );
  assert.equal(
    summarize("workflow", { scriptPath: "/tmp/wf/audit.js", resumeFromRunId: "wf-9" }),
    "/tmp/wf/audit.js resume=wf-9",
  );
  assert.equal(summarize("structured_output", { verdict: "ok", files: [] }), "verdict, files");
  assert.equal(
    summarize("structured_output", { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }),
    "a, b, c, d, +2",
  );
  assert.equal(summarize("new_context", {}), "");
  assert.equal(
    summarize("remember", { text: "Prefers tabs over spaces", scope: "installation" }),
    "Prefers tabs over spaces scope=installation",
  );
  assert.equal(summarize("forget", { n: 3, scope: "session" }), "#3 scope=session");
  assert.equal(
    summarize("memory_manager", {
      operation: "search",
      args: { query: "reply language", scope: "global" },
    }),
    "search query=reply language scope=global",
  );
  assert.equal(
    summarize("memory_manager", { action: "read", args: { slug: "user-reply-language" } }),
    "read user-reply-language",
  );
  assert.equal(
    summarize("browser_exec", { code: 'goto("https://example.com")\nprint(info())' }),
    'goto("https://example.com")',
  );
  assert.equal(
    summarize("browser_exec", { code: "print(title())", session: "headless:scrape" }),
    "print(title()) session=headless:scrape",
  );
  assert.equal(summarize("browser_exec", { code: "x()", session: "default" }), "x()");
  assert.equal(summarize("computer_exec", { code: "screenshot(); click(10, 20)" }), "screenshot()");
  assert.equal(summarize("ToolSearch", { query: "calendar", max_results: 5 }), "calendar max=5");
});

test("shared-history redaction covers every K-brain built-in", () => {
  for (const name of Object.keys(KBRAIN_TOOLS)) {
    assert.equal(utils.isBuiltinShareToolName(name), true, name);
  }
  assert.equal(utils.isBuiltinShareToolName("CustomTool"), false);
});
