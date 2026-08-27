import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * CUA 设置页的纯逻辑。覆盖的都是「出了错用户才会发现」的判断：策略键算错
 * 会让页面显示的审批档位和实际执行的不是同一条；超时钳制漏了会把 "6" 存成
 * 6ms；漂移判断缺失会让界面显示一个根本不会被执行的路径。
 */

const loader = createTsModuleLoader();
const form = loader.loadModule("../agent-ui/src/pages/settings/cuaDriverForm.ts");

const managed = (over = {}) => ({
  id: "cua-driver",
  enabled: true,
  transport: "stdio",
  command: "/Users/x/.local/bin/cua-driver",
  args: ["mcp"],
  url: "",
  timeoutMs: 60_000,
  ...over,
});

test.beforeEach(() => form.resetCuaProbeCache());

test("受管条目的查找对大小写与空白不敏感", () => {
  const servers = [managed({ id: "other" }), managed({ id: " CUA-Driver " })];
  assert.equal(form.findCuaDriverServer(servers)?.id, " CUA-Driver ");
  assert.equal(form.findCuaDriverServerIndex(servers), 1);
  assert.equal(form.findCuaDriverServer([]), undefined);
  assert.equal(form.findCuaDriverServerIndex([]), -1);
});

test("策略键跟随条目里那份 id 的原文", () => {
  // 运行时按原文查 server:CUA-DRIVER；这里若硬写 server:cua-driver，页面显示
  // 的档位就和实际执行的不是同一条。
  assert.equal(form.cuaServerPolicyKey(managed({ id: "CUA-DRIVER" })), "server:CUA-DRIVER");
  assert.equal(form.cuaServerPolicyKey(managed()), "server:cua-driver");
  // 条目还不存在时退回常量。
  assert.equal(form.cuaServerPolicyKey(undefined), "server:cua-driver");
});

test("缺省是 ask，显式配置优先", () => {
  assert.equal(form.cuaDefaultPolicy(managed()), "ask");
  assert.equal(form.readCuaPolicy(undefined, managed()), "ask");
  assert.equal(form.readCuaPolicy({ "server:cua-driver": "allow" }, managed()), "allow");
});

test("写回策略：等于缺省才删 key，并清掉大小写重影", () => {
  const entry = managed({ id: "CUA-DRIVER" });

  // 「始终允许」必须显式落库——删掉会退回 ask。
  assert.deepEqual(form.applyCuaPolicy(undefined, entry, "allow"), {
    "server:CUA-DRIVER": "allow",
  });

  // 回到缺省则删 key；空表返回 undefined，与其他设置一致。
  assert.equal(form.applyCuaPolicy({ "server:CUA-DRIVER": "allow" }, entry, "ask"), undefined);

  // 规范化键那条重影一并清掉，否则 resolveToolPolicy 的回落会读到旧值。
  assert.deepEqual(
    form.applyCuaPolicy({ "server:cua-driver": "allow", Bash: "deny" }, entry, "deny"),
    { Bash: "deny", "server:CUA-DRIVER": "deny" },
  );

  // 其他工具的策略不受影响。
  assert.deepEqual(form.applyCuaPolicy({ Bash: "deny" }, managed(), "ask"), { Bash: "deny" });
});

test("超时钳制：非法值回落，合法值夹在上下限之间", () => {
  assert.equal(form.clampCuaTimeoutMs("90000", 60_000), 90_000);
  assert.equal(form.clampCuaTimeoutMs("  120000  ", 60_000), 120_000);
  // 上限。
  assert.equal(form.clampCuaTimeoutMs("99999999", 60_000), form.CUA_MAX_TIMEOUT_MS);
  // 下限：6ms 这种值等于把功能关掉，任何一次调用都必然超时。
  assert.equal(form.clampCuaTimeoutMs("6", 60_000), form.CUA_MIN_TIMEOUT_MS);
  // 非法输入回落到当前值，而不是回落到某个常量——否则用户清空输入框会被
  // 静默改成默认值。
  assert.equal(form.clampCuaTimeoutMs("", 30_000), 30_000);
  assert.equal(form.clampCuaTimeoutMs("abc", 30_000), 30_000);
  assert.equal(form.clampCuaTimeoutMs("-5", 30_000), 30_000);
  assert.equal(form.clampCuaTimeoutMs("0", 30_000), 30_000);
});

test("条目由探测结果生成，manifest 给的调用方式优先于裸路径", () => {
  const config = form.buildCuaServerConfig({
    installed: true,
    path: "/usr/local/bin/cua-driver",
    mcpCommand: "/Users/x/.local/bin/cua-driver",
    mcpArgs: ["mcp", "--verbose"],
  });
  assert.equal(config.id, "cua-driver");
  assert.equal(config.command, "/Users/x/.local/bin/cua-driver");
  assert.deepEqual(config.args, ["mcp", "--verbose"]);

  // manifest 没给就回落。刻意不带 --direct：那会让 TCC 归属落到宿主身上。
  const fallback = form.buildCuaServerConfig({ installed: true, path: "/usr/local/bin/cua-driver" });
  assert.equal(fallback.command, "/usr/local/bin/cua-driver");
  assert.deepEqual(fallback.args, ["mcp"]);
  assert.equal(fallback.args.includes("--direct"), false);
});

test("显示的是将要执行的命令，不是碰巧探测到的那个", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };
  const entry = managed({ command: "/opt/custom/cua-driver" });

  assert.equal(form.cuaDisplayCommand(entry, probe), "/opt/custom/cua-driver");
  // 没有条目时才退回探测路径。
  assert.equal(form.cuaDisplayCommand(undefined, probe), "/usr/local/bin/cua-driver");
  assert.equal(form.cuaDisplayCommand(undefined, null), null);
});

test("配置漂移：两者不一致时报出来，一致或信息不全时不报", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };

  assert.deepEqual(form.cuaCommandDrift(managed({ command: "/opt/custom/cua-driver" }), probe), {
    configured: "/opt/custom/cua-driver",
    probed: "/usr/local/bin/cua-driver",
  });
  assert.equal(form.cuaCommandDrift(managed({ command: probe.path }), probe), null);
  assert.equal(form.cuaCommandDrift(undefined, probe), null);
  assert.equal(form.cuaCommandDrift(managed(), null), null);

  // 比的是实际会启动的那条：manifest 给了调用方式就以它为准。
  assert.equal(
    form.cuaCommandDrift(managed({ command: "/from/manifest/cua-driver" }), {
      installed: true,
      path: "/usr/local/bin/cua-driver",
      mcpCommand: "/from/manifest/cua-driver",
    }),
    null,
  );
});

test("对齐命令只改 command / args，其余自定义保留", () => {
  const entry = managed({ command: "/stale/cua-driver", args: ["mcp"], timeoutMs: 123_000 });
  const next = form.realignCuaServerConfig(entry, {
    installed: true,
    path: "/usr/local/bin/cua-driver",
    mcpArgs: ["mcp", "--verbose"],
  });
  assert.equal(next.command, "/usr/local/bin/cua-driver");
  assert.deepEqual(next.args, ["mcp", "--verbose"]);
  assert.equal(next.timeoutMs, 123_000, "用户改过的超时不该被顺手覆盖");
  assert.equal(next.enabled, true);
});

test("探测缓存按 TTL 过期", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };
  const permissions = { supported: true, accessibility: true, screenRecording: true };

  assert.equal(form.readCuaProbeCache(0), null);

  form.writeCuaProbeCache(probe, permissions, 1_000);
  assert.equal(form.readCuaProbeCache(1_000)?.probe, probe);
  assert.equal(form.readCuaProbeCache(1_000 + form.CUA_PROBE_CACHE_TTL_MS)?.probe, probe);
  assert.equal(form.readCuaProbeCache(1_001 + form.CUA_PROBE_CACHE_TTL_MS), null);
});

test("授权状态刚变过时只更新那一半，探测结果不作废", () => {
  const probe = { installed: true, path: "/usr/local/bin/cua-driver" };
  form.writeCuaProbeCache(probe, null, 1_000);

  const granted = { supported: true, accessibility: true, screenRecording: true };
  form.patchCuaProbeCachePermissions(granted);

  const cached = form.readCuaProbeCache(1_000);
  assert.equal(cached?.probe, probe);
  assert.equal(cached?.permissions, granted);
});
