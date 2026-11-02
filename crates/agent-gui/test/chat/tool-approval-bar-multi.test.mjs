import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 审查回归:共享 ToolApprovalBar 在多条待审批、会话级提示与可记忆授权组合下的菜单与计数;
// 以及两种语言的新增文案键都存在。
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
  const onDecideAll = async (decision) => { decisions.push(["*", decision]); };
  await env.act(async () => root.render(env.React.createElement(ToolApprovalBar, { pending, onDecide, onDecideAll })));
  const cleanup = async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); };
  const menuItems = () => [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  return { env, host, decisions, cleanup, menuItems };
}

test("会话级提示排在首位且后面还有待审批项:计数 1/2,菜单只有批量动作", async () => {
  const { env, host, decisions, cleanup, menuItems } = await renderBar([
    { toolCallId: "c1", toolName: "computer_exec", summary: '{"action":"call","tool":"click"}', sessionScope: "call:click", sessionWide: true, allowSession: false, deadlineAt: Date.now() + 60_000 },
    { toolCallId: "c2", toolName: "Bash", summary: "rm -rf build", allowSession: false, deadlineAt: Date.now() + 30_000 },
  ]);
  try {
    assert.match(host.querySelector('[role="timer"]').textContent, /^1 \/ 2 · /);
    assert.ok(host.querySelector('[aria-label="更多审批选项"]'), "多条待审批时仍要有菜单入口");
    assert.deepEqual(menuItems(), ["全部允许", "全部拒绝"]);
    assert.match(host.textContent, /允许后，本对话里的 Computer Use 操作不再询问/);
    const approve = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-keyshortcuts") === "Enter");
    assert.equal(approve.textContent.replace("↵", ""), "允许");
    assert.match(approve.className, /rounded-r-none/, "有菜单时主按钮右侧与下拉拼接");
    const [approveAll] = host.querySelectorAll('[role="menuitem"]');
    await env.act(async () => { approveAll.click(); await Promise.resolve(); });
    assert.deepEqual(decisions, [["*", "approve"]]);
  } finally {
    await cleanup();
  }
});

test("后端提供 allow_always 时菜单显示带授权范围的会话项,并以 approve_session 提交", async () => {
  const { env, host, decisions, cleanup, menuItems } = await renderBar([
    { toolCallId: "c1", toolName: "computer_exec", summary: "click", sessionScope: "call:click", allowSession: true, sessionWide: false },
  ]);
  try {
    assert.deepEqual(menuItems(), ["本会话始终允许 computer_exec · call:click"]);
    assert.match(host.textContent, /是否允许执行此 computer_exec 操作？/);
    const [sessionItem] = host.querySelectorAll('[role="menuitem"]');
    await env.act(async () => { sessionItem.click(); await Promise.resolve(); });
    assert.deepEqual(decisions, [["c1", "approve_session"]]);
  } finally {
    await cleanup();
  }
});

test("单条且后端不记忆授权:没有菜单入口,主按钮不留拼接圆角", async () => {
  const { host, cleanup } = await renderBar([
    { toolCallId: "c1", toolName: "Bash", summary: "ls", allowSession: false },
  ]);
  try {
    assert.equal(host.querySelector('[aria-label="更多审批选项"]'), null);
    assert.equal(host.querySelectorAll('[role="menuitem"]').length, 0);
    const approve = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-keyshortcuts") === "Enter");
    assert.doesNotMatch(approve.className, /rounded-r-none/);
  } finally {
    await cleanup();
  }
});

test("新增文案键在 en-US 与 zh-CN 都存在且不含未替换占位符", () => {
  const loader = createTsModuleLoader();
  const { EN_US_COMMON_TRANSLATIONS } = loader.loadModule("@liveagent/ui/i18n/translations/enUSCommon.ts");
  const { ZH_CN_COMMON_TRANSLATIONS } = loader.loadModule("@liveagent/ui/i18n/translations/zhCNCommon.ts");
  for (const key of ["chat.toolApproval.approveForSession", "chat.toolApproval.sessionWideBody", "chat.toolApproval.approveSession", "chat.toolApproval.approve"]) {
    for (const [locale, table] of [["en-US", EN_US_COMMON_TRANSLATIONS], ["zh-CN", ZH_CN_COMMON_TRANSLATIONS]]) {
      assert.equal(typeof table[key], "string", `${locale} 缺少 ${key}`);
      assert.ok(table[key].trim(), `${locale} ${key} 为空`);
    }
  }
  // sessionWideBody 不带 {tool} 占位符:组件直接输出,不做替换。
  assert.doesNotMatch(EN_US_COMMON_TRANSLATIONS["chat.toolApproval.sessionWideBody"], /\{tool\}/);
  assert.doesNotMatch(ZH_CN_COMMON_TRANSLATIONS["chat.toolApproval.sessionWideBody"], /\{tool\}/);
  // approveSession 两边都要有 {tool} 占位符,否则授权范围显示不出来。
  assert.match(EN_US_COMMON_TRANSLATIONS["chat.toolApproval.approveSession"], /\{tool\}/);
  assert.match(ZH_CN_COMMON_TRANSLATIONS["chat.toolApproval.approveSession"], /\{tool\}/);
});
