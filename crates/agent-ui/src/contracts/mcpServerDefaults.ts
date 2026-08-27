import type { ToolPolicy } from "@liveagent/app/lib/settings";

/**
 * MCP server 级「不可被隐式 allow 绕过的硬编码缺省策略」。
 *
 * 背景：`resolveToolPolicy` 对 MCP 工具的兜底是 `allow`——对绝大多数
 * MCP server（查文档、读数据）是合理的。但个别 server 的工具面直接
 * 操作用户的机器：`cua-driver` 暴露的 60 个工具里包含 `kill_app`、
 * `clipboard_write`、`type_text`、`browser_download`，隐式放行等于让
 * 模型无声地按键、改剪贴板、杀进程。
 *
 * 这里列出的 server 在用户没有显式配置 `server:<id>` 策略时走该默认
 * 值。用户仍可在 MCP Hub 的 server 卡片里改成 allow / deny——显式配置
 * 永远优先。
 *
 * 放在 contracts/ 是因为要被两侧共用：`agent-gui` 的
 * `lib/tools/toolPolicy.ts` 用它做策略解析，`agent-ui` 的
 * `pages/mcp-hub/McpServersForm.tsx` 用它做下拉框的显示缺省。两边读同
 * 一张表，否则会出现「UI 显示 allow、实际按 ask 执行」的错位。
 */
const HARDCODED_SERVER_DEFAULTS: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  "cua-driver": "ask",
});

/**
 * server id 的规范形式：去空白 + 转小写。
 *
 * 这张表以及所有「这条 server 是不是那个受管条目」的判断都必须走它。
 * 否则一份写成 `CUA-DRIVER` 的配置会被一部分代码路径认出来（Hub 隐藏、
 * 设置页识别）、另一部分认不出来（硬编码缺省查表、`server:<id>` 策略
 * 键），最终从 `ask` 静默退回到通用 MCP 兜底的 `allow`——安全侧的缺省
 * 因为大小写而失效是最不该发生的一类错位。
 */
export function canonicalServerId(serverId: string): string {
  return serverId.trim().toLowerCase();
}

/** 该 server 的硬编码缺省策略；没有登记则返回 undefined。 */
export function hardcodedServerPolicyDefault(serverId: string): ToolPolicy | undefined {
  return HARDCODED_SERVER_DEFAULTS[canonicalServerId(serverId)];
}

/** 该 server 在无显式配置时的生效策略（含全局兜底 allow）。 */
export function effectiveServerPolicyDefault(serverId: string): ToolPolicy {
  return hardcodedServerPolicyDefault(serverId) ?? "allow";
}

/** cua-driver 的 MCP server id。设置页与 MCP Hub 都要认它。 */
export const CUA_DRIVER_SERVER_ID = "cua-driver";

/**
 * 由专属设置页托管、不在 MCP Hub 里露面的 server。
 *
 * cua-driver 的 MCP 条目是「设置 → CUA」那个开关的实现细节，不是用户
 * 手动维护的对象：command 由 `cua-driver manifest` 决定、args 不该随意
 * 改、权限策略与超时都在 CUA 那一节里调。在 Hub 里再列一遍只会制造两
 * 个都能改同一份配置的入口，改完还互相看不见对方的语义（比如在 Hub 里
 * 删掉条目，CUA 那节的开关会莫名变成关）。
 */
const HUB_HIDDEN_SERVER_IDS: ReadonlySet<string> = new Set([CUA_DRIVER_SERVER_ID]);

/** 该 server 是否由专属设置页托管（MCP Hub 应当隐藏它）。 */
export function isHubHiddenServerId(serverId: string): boolean {
  return HUB_HIDDEN_SERVER_IDS.has(canonicalServerId(serverId));
}

/** 该 server 是否就是 cua-driver 那条受管条目（大小写与空白不敏感）。 */
export function isCuaDriverServerId(serverId: string | undefined | null): boolean {
  return canonicalServerId(serverId ?? "") === CUA_DRIVER_SERVER_ID;
}
