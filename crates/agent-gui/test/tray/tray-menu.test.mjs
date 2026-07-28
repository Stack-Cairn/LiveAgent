import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const trayMenu = loader.loadModule("src/lib/tray/trayMenu.ts");

const PREFS = { showConversationTitles: true, showRunningBadge: false };

function conversation(id, title, extra = {}) {
  return {
    id,
    title,
    providerId: "claude_code",
    model: "claude-sonnet-5",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function baseInput(overrides = {}) {
  return {
    locale: "zh-CN",
    theme: "system",
    conversations: [],
    runningConversationIds: new Set(),
    workspaceProjects: [],
    activeWorkspaceProjectId: undefined,
    archivedWorkspaceProjectPaths: [],
    cronTasks: [],
    remote: { enabled: false, gatewayUrl: "", token: "" },
    gatewayOnline: false,
    prefs: PREFS,
    ...overrides,
  };
}

test("recent list truncates to 8 with view-all flag and skips pending rows", () => {
  const conversations = Array.from({ length: 10 }, (_, index) =>
    conversation(`c${index}`, `对话标题 ${index}`),
  );
  conversations.unshift(conversation("pending", "草稿", { isPending: true }));

  const model = trayMenu.buildTrayMenuModel(baseInput({ conversations }));

  assert.equal(model.recent.length, 8);
  assert.equal(model.recentTruncated, true);
  assert.equal(model.recent[0].id, "c0");
  assert.equal(
    model.recent.some((entry) => entry.id === "pending"),
    false,
  );
});

test("privacy pref replaces titles with numbered placeholders", () => {
  const model = trayMenu.buildTrayMenuModel(
    baseInput({
      conversations: [conversation("c1", "机密标题")],
      runningConversationIds: new Set(["c1"]),
      prefs: { showConversationTitles: false, showRunningBadge: false },
    }),
  );

  assert.equal(model.recent[0].label, "对话 1");
  assert.equal(model.runs[0].label, "对话 1");
  assert.equal(model.recent[0].label.includes("机密"), false);
});

test("workspaces exclude archived paths and mark the active project", () => {
  const model = trayMenu.buildTrayMenuModel(
    baseInput({
      workspaceProjects: [
        { id: "w1", name: "项目一", path: "/tmp/a", kind: "folder", createdAt: 1, updatedAt: 1 },
        { id: "w2", name: "项目二", path: "/tmp/b", kind: "folder", createdAt: 1, updatedAt: 1 },
      ],
      activeWorkspaceProjectId: "w2",
      archivedWorkspaceProjectPaths: ["/tmp/a"],
    }),
  );

  assert.deepEqual(
    model.workspaces.map((entry) => entry.id),
    ["w2"],
  );
  assert.equal(model.workspaces[0].checked, true);
});

test("runs derive from the running id set with localized count label", () => {
  const model = trayMenu.buildTrayMenuModel(
    baseInput({
      conversations: [conversation("c1", "跑着的"), conversation("c2", "闲着的")],
      runningConversationIds: new Set(["c1"]),
    }),
  );

  assert.deepEqual(
    model.runs.map((entry) => entry.id),
    ["c1"],
  );
  assert.equal(model.labels.runs, "运行中 · 1 个对话");
  assert.equal(model.tooltip, "LiveAgent · 1 个对话运行中");
});

test("cron entries list all tasks with enabled checkmarks, capped at 10", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: `t${index}`,
    name: `任务 ${index}`,
    description: "",
    cron: "* * * * *",
    enabled: index !== 3,
    type: "bash",
  }));

  const model = trayMenu.buildTrayMenuModel(baseInput({ cronTasks: tasks }));

  assert.equal(model.cron.length, 10);
  // 停用任务也在列表里，只是不带勾选（点击=开关语义）。
  const disabledEntry = model.cron.find((entry) => entry.id === "t3");
  assert.equal(disabledEntry?.checked, false);
  const enabledEntry = model.cron.find((entry) => entry.id === "t0");
  assert.equal(enabledEntry?.checked, true);
});

test("gateway state maps to status suffix, label, and enablement", () => {
  const unconfigured = trayMenu.buildTrayMenuModel(baseInput());
  assert.equal(unconfigured.gatewayEnabled, false);
  assert.equal(unconfigured.statusSuffix, null);
  assert.equal(unconfigured.labels.gateway, "远程网关（未配置）");

  const online = trayMenu.buildTrayMenuModel(
    baseInput({
      remote: { enabled: true, gatewayUrl: "wss://gw", token: "tok" },
      gatewayOnline: true,
    }),
  );
  assert.equal(online.gatewayEnabled, true);
  assert.equal(online.statusSuffix, "远程已连接");

  const disabled = trayMenu.buildTrayMenuModel(
    baseInput({
      remote: { enabled: false, gatewayUrl: "wss://gw", token: "tok" },
      gatewayOnline: false,
    }),
  );
  assert.equal(disabled.statusSuffix, "远程已断开");

  const connecting = trayMenu.buildTrayMenuModel(
    baseInput({
      remote: { enabled: true, gatewayUrl: "wss://gw", token: "tok" },
      gatewayOnline: false,
    }),
  );
  assert.equal(connecting.statusSuffix, "远程连接中");
});

test("badge text appears only with the pref on and runs active", () => {
  const withBadge = trayMenu.buildTrayMenuModel(
    baseInput({
      conversations: [conversation("c1", "跑")],
      runningConversationIds: new Set(["c1"]),
      prefs: { showConversationTitles: true, showRunningBadge: true },
    }),
  );
  assert.equal(withBadge.badgeText, "1");

  const noRuns = trayMenu.buildTrayMenuModel(
    baseInput({ prefs: { showConversationTitles: true, showRunningBadge: true } }),
  );
  assert.equal(noRuns.badgeText, null);

  const prefOff = trayMenu.buildTrayMenuModel(
    baseInput({
      conversations: [conversation("c1", "跑")],
      runningConversationIds: new Set(["c1"]),
    }),
  );
  assert.equal(prefOff.badgeText, null);
});

test("en-US locale localizes static labels and theme summary", () => {
  const model = trayMenu.buildTrayMenuModel(baseInput({ locale: "en-US", theme: "dark" }));

  assert.equal(model.labels.newChat, "New Chat");
  assert.equal(model.labels.quit, "Quit LiveAgent");
  assert.equal(model.labels.appearance, "Appearance · Dark");
  assert.equal(model.theme, "dark");
});
