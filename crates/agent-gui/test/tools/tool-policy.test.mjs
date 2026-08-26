import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const toolPolicy = loader.loadModule("src/lib/tools/toolPolicy.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

const { resolveToolPolicy } = toolPolicy;
const { normalizeToolPolicies } = settings;

const meta = (over = {}) => ({
  groupId: "system",
  kind: "x",
  isReadOnly: false,
  displayCategory: "system",
  ...over,
});

test("显式策略优先于任何缺省推断", () => {
  const policies = { Bash: "deny", plugin_a_x: "allow", Read: "ask" };
  assert.equal(resolveToolPolicy("Bash", meta({ groupId: "shell" }), policies), "deny");
  assert.equal(resolveToolPolicy("plugin_a_x", meta({ groupId: "plugin" }), policies), "allow");
  // 显式 ask 覆盖只读工具的恒 allow 缺省
  assert.equal(resolveToolPolicy("Read", meta({ isReadOnly: true }), policies), "ask");
});

test("缺省:只读工具恒 allow", () => {
  assert.equal(resolveToolPolicy("Grep", meta({ isReadOnly: true, groupId: "fs" }), undefined), "allow");
  // 即便是插件的只读工具,缺省也不拦(读操作无副作用)
  assert.equal(
    resolveToolPolicy("plugin_a_read", meta({ isReadOnly: true, groupId: "plugin" }), undefined),
    "allow",
  );
});

test("缺省:内置/mcp/未知工具 allow", () => {
  assert.equal(resolveToolPolicy("Bash", meta({ groupId: "shell" }), undefined), "allow");
  assert.equal(resolveToolPolicy("mcp_s_t", meta({ groupId: "mcp" }), undefined), "allow");
  // 无元数据(未知名)不制造回归 → allow
  assert.equal(resolveToolPolicy("Mystery", undefined, undefined), "allow");
});

test("normalizeToolPolicies 丢弃非法值与空键,空表归一为 undefined", () => {
  assert.equal(normalizeToolPolicies(undefined), undefined);
  assert.equal(normalizeToolPolicies({ "": "deny", Bash: "nope" }), undefined);
  assert.deepEqual(normalizeToolPolicies({ Bash: "ask", " Write ": "deny", X: 1 }), {
    Bash: "ask",
    Write: "deny",
  });
});

test("normalizeSystemSettings 透传 toolPolicies 且旧快照缺失时不报错", () => {
  const withPolicies = settings.normalizeSystemSettings({ toolPolicies: { Bash: "deny" } });
  assert.deepEqual(withPolicies.toolPolicies, { Bash: "deny" });
  const legacy = settings.normalizeSystemSettings({});
  assert.equal(legacy.toolPolicies, undefined);
});

test("CUA 默认 ask：没有用户策略也没有 trustMode 时，group:cua 走 ask 缺省", () => {
  const cuaMeta = { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" };
  assert.equal(resolveToolPolicy("cua_click", cuaMeta, undefined), "ask");
  assert.equal(resolveToolPolicy("cua_screenshot", cuaMeta, undefined), "ask");
});

test("CUA 用户显式策略覆盖 ask 缺省", () => {
  const cuaMeta = { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" };
  assert.equal(resolveToolPolicy("cua_click", cuaMeta, { "group:cua": "deny" }), "deny");
  assert.equal(resolveToolPolicy("cua_click", cuaMeta, { "group:cua": "allow" }), "allow");
  assert.equal(resolveToolPolicy("cua_click", cuaMeta, { cua_click: "deny" }), "deny");
});

test("CUA trustMode 开启时 extraGroupDefaults 把 group:cua 强制 allow，但仍低于用户策略", () => {
  const cuaMeta = { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" };
  const trust = { cua: "allow" };
  assert.equal(resolveToolPolicy("cua_click", cuaMeta, undefined, trust), "allow");
  // 用户 deny 仍然生效（用户策略 > extra defaults > 硬编码默认）。
  assert.equal(resolveToolPolicy("cua_click", cuaMeta, { "group:cua": "deny" }, trust), "deny");
});

test("isHardcodedGroupDefault 暴露 CUA ask 缺省供 UI 提示", () => {
  const { isHardcodedGroupDefault } = toolPolicy;
  assert.equal(isHardcodedGroupDefault("cua"), "ask");
  assert.equal(isHardcodedGroupDefault("mcp"), undefined);
  assert.equal(isHardcodedGroupDefault("shell"), undefined);
});
