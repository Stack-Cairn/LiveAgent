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

// cua-driver 作为普通 MCP server 接入,工具的 groupId 是 "mcp"。若只靠
// 「mcp 缺省 allow」,kill_app / type_text / clipboard_write 会被隐式放行。
const cuaDriverMeta = (over = {}) => ({
  groupId: "mcp",
  kind: "mcp",
  isReadOnly: false,
  displayCategory: "mcp",
  serverId: "cua-driver",
  // 建工具表时由 mcpServerDefaults 依据 server 配置算好带下来的。
  serverPolicyDefault: "ask",
  ...over,
});

test("cua-driver 默认 ask：没有用户策略时不走 mcp 的 allow 缺省", () => {
  assert.equal(resolveToolPolicy("mcp_cua-driver_click", cuaDriverMeta(), undefined), "ask");
  // 只读工具也要 ask：截屏会把整个桌面内容交给模型。
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_get_desktop_state", cuaDriverMeta({ isReadOnly: true }), undefined),
    "ask",
  );
  // 其他 MCP server 不受影响,仍是 allow。
  assert.equal(
    resolveToolPolicy(
      "mcp_other_t",
      cuaDriverMeta({ serverId: "other", serverPolicyDefault: undefined }),
      undefined,
    ),
    "allow",
  );
});

test("cua-driver 用户显式策略覆盖 ask 缺省", () => {
  const meta = cuaDriverMeta();
  assert.equal(resolveToolPolicy("mcp_cua-driver_click", meta, { "server:cua-driver": "deny" }), "deny");
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_click", meta, { "server:cua-driver": "allow" }),
    "allow",
  );
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_click", meta, { "mcp_cua-driver_click": "deny" }),
    "deny",
  );
});

test("server 级硬编码缺省优先于 group:mcp 的用户策略", () => {
  // 用户把「所有 MCP 工具」设为 allow,cua-driver 仍单独保持 ask——组级放
  // 行不该顺带放行一个能敲键盘杀进程的 server;要放行得显式写 server:。
  assert.equal(
    resolveToolPolicy("mcp_cua-driver_click", cuaDriverMeta(), { "group:mcp": "allow" }),
    "ask",
  );
});

const defaults = loader.loadModule("../agent-ui/src/contracts/mcpServerDefaults.ts");

test("硬编码缺省按 server 配置判定,而不是按 id", () => {
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: "cua-driver" }), "ask");
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: "other" }), undefined);
  assert.equal(defaults.effectiveServerPolicyDefault({ id: "cua-driver" }), "ask");
  assert.equal(defaults.effectiveServerPolicyDefault({ id: "other" }), "allow");
  assert.equal(defaults.effectiveServerPolicyDefault(undefined), "allow");
});

test("id 大小写与空白不影响判定", () => {
  // 一份写成 CUA-DRIVER 的配置照样被识别为受管条目：若这里查不到,缺省会
  // 从 ask 静默退回到 mcp 的兜底 allow——安全侧的缺省因大小写失效。
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: "CUA-DRIVER" }), "ask");
  assert.equal(defaults.hardcodedServerPolicyDefault({ id: " Cua-Driver " }), "ask");
  assert.ok(defaults.isCuaDriverServerId("CUA-DRIVER"));
  assert.ok(defaults.isHubHiddenServerId(" CUA-Driver "));
});

test("换个 id 但 command 仍指向 cua-driver 的条目同样按 ask 处理", () => {
  // 这是最要命的一条：id 是用户可以随手改的展示性标识。只认 id 的话,把条目
  // 命名成 my-tools 就能让 60 个点击 / 输入 / 杀进程的工具零审批放行。
  const renamed = { id: "my-tools", command: "/Users/x/.local/bin/cua-driver" };
  assert.ok(defaults.isCuaDriverServer(renamed));
  assert.equal(defaults.effectiveServerPolicyDefault(renamed), "ask");

  // 路径分隔符、扩展名、引号都要认。
  assert.ok(defaults.isCuaDriverServer({ id: "x", command: "C:\\bin\\CUA-Driver.exe" }));
  assert.ok(defaults.isCuaDriverServer({ id: "x", command: '"/opt/homebrew/bin/cua-driver"' }));
  assert.ok(defaults.isCuaDriverServer({ id: "x", command: "cua-driver" }));

  // 名字里含 cua-driver 但不是它的二进制不该被误判。
  assert.equal(defaults.isCuaDriverServer({ id: "x", command: "/bin/cua-driver-proxy" }), false);
  assert.equal(defaults.isCuaDriverServer({ id: "x", command: "/opt/cua-driver/bin/serve" }), false);
  assert.equal(defaults.isCuaDriverServer({ id: "x", command: "" }), false);
  assert.equal(defaults.isCuaDriverServer(undefined), false);
});

test("Hub 隐藏只看 id——自己加的条目不该变成谁也删不掉的幽灵配置", () => {
  assert.ok(defaults.isHubHiddenServerId("cua-driver"));
  // command 指向 cua-driver 但 id 是自己起的：安全上按 cua 处理,但仍留在
  // Hub 里可见可删。
  assert.equal(defaults.isHubHiddenServerId("my-tools"), false);
});

test("server 策略键在大小写错位时回落到规范化键", () => {
  // 设置页按条目原文写键;运行时拿到的 serverId 可能只差大小写。原文优先,
  // 规范化键兜底,显式配置不会因此失效。
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:CUA-DRIVER": "deny",
    }),
    "deny",
  );
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:cua-driver": "allow",
    }),
    "allow",
  );
  // 原文键优先于规范化键。
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:CUA-DRIVER": "deny",
      "server:cua-driver": "allow",
    }),
    "deny",
  );
});

test("server 策略键在大小写错位时回落到规范化键", () => {
  // 设置页按条目原文写键;运行时拿到的 serverId 可能只差大小写。原文优先,
  // 规范化键兜底,显式配置不会因此失效。
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:CUA-DRIVER": "deny",
    }),
    "deny",
  );
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:cua-driver": "allow",
    }),
    "allow",
  );
  // 原文键优先于规范化键。
  assert.equal(
    resolveToolPolicy("mcp_cua_click", cuaDriverMeta({ serverId: "CUA-DRIVER" }), {
      "server:CUA-DRIVER": "deny",
      "server:cua-driver": "allow",
    }),
    "deny",
  );
});
