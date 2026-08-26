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
 * 永远优先。与 `toolPolicy.ts` 的 `HARDCODED_GROUP_DEFAULTS` 同构，
 * 只是粒度落在 server 而非工具组。
 *
 * 放在 contracts/ 是因为要被两侧共用：`agent-gui` 的
 * `lib/tools/toolPolicy.ts` 用它做策略解析，`agent-ui` 的
 * `pages/mcp-hub/McpServersForm.tsx` 用它做下拉框的显示缺省。两边读同
 * 一张表，否则会出现「UI 显示 allow、实际按 ask 执行」的错位。
 */
const HARDCODED_SERVER_DEFAULTS: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  "cua-driver": "ask",
});

/** 该 server 的硬编码缺省策略；没有登记则返回 undefined。 */
export function hardcodedServerPolicyDefault(serverId: string): ToolPolicy | undefined {
  return HARDCODED_SERVER_DEFAULTS[serverId];
}

/** 该 server 在无显式配置时的生效策略（含全局兜底 allow）。 */
export function effectiveServerPolicyDefault(serverId: string): ToolPolicy {
  return hardcodedServerPolicyDefault(serverId) ?? "allow";
}
