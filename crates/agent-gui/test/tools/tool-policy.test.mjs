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
  assert.equal(
    resolveToolPolicy(
      "plugin_a_x",
      meta({ groupId: "plugin:com.example.a", pluginId: "com.example.a" }),
      policies,
    ),
    "allow",
  );
  // 显式 ask 覆盖只读工具的恒 allow 缺省
  assert.equal(resolveToolPolicy("Read", meta({ isReadOnly: true }), policies), "ask");
});

test("缺省:内置只读工具 allow,插件工具始终 ask", () => {
  assert.equal(resolveToolPolicy("Grep", meta({ isReadOnly: true, groupId: "fs" }), undefined), "allow");
  assert.equal(
    resolveToolPolicy(
      "plugin_a_read",
      meta({
        isReadOnly: true,
        groupId: "plugin:com.example.a",
        pluginId: "com.example.a",
      }),
      undefined,
    ),
    "ask",
  );
  assert.equal(
    resolveToolPolicy(
      "PluginCreate",
      meta({ groupId: "plugin-manager", kind: "manage_plugin" }),
      undefined,
    ),
    "ask",
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
