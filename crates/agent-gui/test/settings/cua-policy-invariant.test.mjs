import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * 跨模块不变量：**CUA 设置页显示的审批档位 === 运行时实际执行的档位。**
 *
 * 两边分别有自己的单测（设置页能读小写条目、运行时能回落规范化键），但
 * 分开测保证不了这条不变量本身——历史上正是「运行时补了回落、设置页没补」
 * 造成了「页面显示 ask、运行时执行 allow」。这里把两个模块放进同一张
 * 配置矩阵里逐格比对，任何一侧单独改动查表顺序都会先把这里弄红。
 */

const loader = createTsModuleLoader();
const form = loader.loadModule("../agent-ui/src/pages/settings/cuaDriverForm.ts");
const toolPolicy = loader.loadModule("src/lib/tools/toolPolicy.ts");
const defaults = loader.loadModule("../agent-ui/src/contracts/mcpServerDefaults.ts");

const entryOf = (id) => ({
  id,
  enabled: true,
  transport: "stdio",
  command: "/Users/x/.local/bin/cua-driver",
  args: ["mcp"],
  url: "",
  timeoutMs: 60_000,
});

/** 与 mcpTools.ts 建工具表的方式一致：serverId 取条目原文，缺省按配置算好带下去。 */
const metadataOf = (entry) => ({
  groupId: "mcp",
  kind: "mcp",
  isReadOnly: false,
  displayCategory: "mcp",
  serverId: entry.id,
  serverPolicyDefault: defaults.hardcodedServerPolicyDefault(entry),
});

const ids = ["cua-driver", "CUA-DRIVER", " Cua-Driver "];
const policyTables = [
  undefined,
  {},
  { "server:cua-driver": "allow" },
  { "server:cua-driver": "deny" },
  { "server:CUA-DRIVER": "allow" },
  { "server:CUA-DRIVER": "deny" },
  // 原文键与规范化键同时存在（历史写入留下的重影）。
  { "server:CUA-DRIVER": "deny", "server:cua-driver": "allow" },
  { "server:cua-driver": "ask", "server:CUA-DRIVER": "allow" },
  // 无关键不干扰。
  { Bash: "deny", "group:mcp": "allow" },
];

test("设置页显示值 === 运行时生效值（全矩阵）", () => {
  for (const id of ids) {
    const entry = entryOf(id);
    const metadata = metadataOf(entry);
    for (const policies of policyTables) {
      const uiPolicy = form.readCuaPolicy(policies, entry);
      const runtimePolicy = toolPolicy.resolveToolPolicy("mcp_cua_click", metadata, policies);
      assert.equal(
        uiPolicy,
        runtimePolicy,
        `id=${JSON.stringify(id)} policies=${JSON.stringify(policies)}: 页面显示 ${uiPolicy}，运行时执行 ${runtimePolicy}`,
      );
    }
  }
});

test("写回之后不变量依然成立（写入路径不制造新的错位）", () => {
  for (const id of ids) {
    const entry = entryOf(id);
    const metadata = metadataOf(entry);
    // 从一份带重影的表出发，把三个档位各写一遍。
    for (const next of ["allow", "ask", "deny"]) {
      const written = form.applyCuaPolicy(
        { "server:cua-driver": "allow", "server:CUA-DRIVER": "deny", Bash: "deny" },
        entry,
        next,
      );
      const uiPolicy = form.readCuaPolicy(written, entry);
      const runtimePolicy = toolPolicy.resolveToolPolicy("mcp_cua_click", metadata, written);
      assert.equal(uiPolicy, next, `写入 ${next} 后页面应显示 ${next}`);
      assert.equal(runtimePolicy, next, `写入 ${next} 后运行时应执行 ${next}`);
    }
  }
});
