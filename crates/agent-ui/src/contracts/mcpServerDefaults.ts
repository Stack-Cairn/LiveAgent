import type { ToolPolicy } from "@liveagent/app/lib/settings";

/**
 * 「这条 MCP server 的工具面直接操作用户的机器」这一事实的唯一判定处。
 *
 * 背景：`resolveToolPolicy` 对 MCP 工具的兜底是 `allow`——对绝大多数
 * MCP server（查文档、读数据）是合理的。但 `cua-driver` 暴露的 60 个
 * 工具里包含 `kill_app`、`clipboard_write`、`type_text`，隐式放行等于
 * 让模型无声地按键、改剪贴板、杀进程。这类 server 必须默认 `ask`，
 * 并且套上自指闸门（`lib/tools/cuaSelfGuard.ts`）。
 *
 * **判定依据是它启动的二进制，不是 server id。** id 是用户可以随手改的
 * 展示性标识：只要把条目命名成 `my-tools` 而 command 仍指向 cua-driver，
 * 按 id 判定的实现就会让审批缺省退回 `allow`、自指闸门根本不创建——60 个
 * 能点击、输入、杀进程的工具零审批放行。安全判定不能建立在可变标识上。
 *
 * 放在 contracts/ 是因为要被两侧共用：`agent-gui` 的 `lib/tools/` 用它决定
 * 策略缺省与闸门，`agent-ui` 的 MCP Hub 与 CUA 设置页用它做显示缺省。两边
 * 读同一处，否则会出现「UI 显示 allow、实际按 ask 执行」的错位。
 */

/** 判定所需的最小 server 描述。传完整的 `McpServerConfig` 也可以。 */
export type ServerIdentity = {
  id?: string | null;
  command?: string | null;
};

/** cua-driver 的受管 MCP server id（设置页新建条目时用的那个）。 */
export const CUA_DRIVER_SERVER_ID = "cua-driver";

/** cua-driver 可执行文件名（不含扩展名）。 */
const CUA_DRIVER_BINARY = "cua-driver";

/**
 * server id 的规范形式：去空白 + 转小写。
 *
 * 所有「这条 server 是不是那个受管条目」的判断都必须走它。否则一份写成
 * `CUA-DRIVER` 的配置会被一部分代码路径认出来、另一部分认不出来，安全侧的
 * 缺省因为大小写而失效。
 */
export function canonicalServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

/**
 * 取命令的可执行文件名：去掉目录、去掉 Windows 的 `.exe`、去掉引号。
 *
 * 配置里的 command 是绝对路径（`/Users/x/.local/bin/cua-driver`），也可能
 * 是裸名字或带引号的路径，所以不能直接比字符串。
 */
function commandBasename(command: string): string {
  const trimmed = command.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1] ?? "";
  return last.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * 这条 server 是否就是 cua-driver——**id 或 command 命中任一即算**。
 *
 * 两个条件都要看：
 * - id 命中：设置页新建的受管条目，此时 command 由 `manifest` 决定；
 * - command 命中：用户自己在 MCP Hub 里加的、或从别处导入的条目，id 可以
 *   叫任何名字。只认 id 的话这条路径完全绕开审批缺省与自指闸门。
 */
export function isCuaDriverServer(server: ServerIdentity | undefined | null): boolean {
  if (!server) return false;
  if (canonicalServerId(server.id ?? "") === CUA_DRIVER_SERVER_ID) return true;
  return commandBasename(server.command ?? "") === CUA_DRIVER_BINARY;
}

/**
 * MCP 按 server 的策略以 `server:<serverId>` 为键存储。粒度介于「单个工具」
 * 与「整组 MCP」之间：未对某 server 显式设置时，回落到组级（group:mcp）再
 * 回落到缺省。
 */
export const TOOL_SERVER_POLICY_PREFIX = "server:";

export function toolServerPolicyKey(serverId: string): string {
  return `${TOOL_SERVER_POLICY_PREFIX}${serverId}`;
}

/**
 * 一个 server 可能命中的策略键，**按查找顺序**排列：原文键（去空白）优先，
 * 规范化（转小写）键兜底。
 *
 * 两个都查是为了消除大小写错位：写策略的地方（MCP Hub 卡片、CUA 设置页）
 * 用的是各自手上那份 id，而运行时拿到的是 MCP server 返回的 id，两者可能
 * 只差大小写。只查原文键会让显式配置静默失效并退回兜底 `allow`。
 * 原文优先、规范化键仅作回落，因此不会改变已有配置的解析结果。
 *
 * **所有读策略的地方都必须走这份列表、按同一顺序**——运行时
 * （`resolveToolPolicy`）与设置页（`readCuaPolicy`）各自实现一份的话，
 * 「设置页显示 ask、运行时执行 allow」这类显示与执行不一致就会回来。
 * 原文键做过 trim：策略表的键经 `normalizeToolPolicies` 归一，带空白的
 * 键根本不会存在，不 trim 的原文候选永远查不到东西。
 */
export function serverPolicyKeyCandidates(serverId: string): string[] {
  const raw = toolServerPolicyKey(serverId.trim());
  const normalized = toolServerPolicyKey(canonicalServerId(serverId));
  return raw === normalized ? [raw] : [raw, normalized];
}

/**
 * 该 server 的硬编码缺省策略；不属于「直接操作用户机器」那一类则返回
 * undefined，由调用方回落到通用兜底。
 */
export function hardcodedServerPolicyDefault(
  server: ServerIdentity | undefined | null,
): ToolPolicy | undefined {
  return isCuaDriverServer(server) ? "ask" : undefined;
}

/** 该 server 在无显式配置时的生效策略（含全局兜底 allow）。 */
export function effectiveServerPolicyDefault(
  server: ServerIdentity | undefined | null,
): ToolPolicy {
  return hardcodedServerPolicyDefault(server) ?? "allow";
}

/**
 * 该 server 是否由专属设置页托管（MCP Hub 应当隐藏它）。
 *
 * 刻意**只**看 id，与上面的安全判定不同：这是「谁负责这条配置的界面」的
 * 归属问题。用户自己加的、command 恰好指向 cua-driver 的条目仍应留在 Hub
 * 里——否则它既不归 CUA 设置页管（那节只认受管 id），又在 Hub 里看不见，
 * 变成一条谁也删不掉的幽灵配置。
 */
export function isHubHiddenServerId(serverId: string): boolean {
  return canonicalServerId(serverId) === CUA_DRIVER_SERVER_ID;
}

/** 该 server 是否就是设置页托管的那条受管条目（大小写与空白不敏感）。 */
export function isCuaDriverServerId(serverId: string | undefined | null): boolean {
  return canonicalServerId(serverId ?? "") === CUA_DRIVER_SERVER_ID;
}
