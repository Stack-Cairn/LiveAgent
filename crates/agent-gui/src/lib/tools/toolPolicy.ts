import type { ToolPolicy } from "../settings";
import type { BuiltinToolMetadata } from "./builtinTypes";

export type { ToolPolicy } from "../settings";

/**
 * 工具组级默认策略在 toolPolicies 里以 `group:<groupId>` 为键存储(如 group:mcp)。
 * 真实工具名不含冒号前缀,不会与之冲突;复用同一张策略表,免去
 * 新增设置字段与同步链路。单个工具名的显式策略仍优先于组级。
 */
export const TOOL_GROUP_POLICY_PREFIX = "group:";

export function toolGroupPolicyKey(groupId: string): string {
  return `${TOOL_GROUP_POLICY_PREFIX}${groupId}`;
}

/**
 * MCP 按 server 的策略以 `server:<serverId>` 为键存储。粒度介于"单个工具"与"整组
 * MCP"之间:未对某 server 显式设置时,回落到组级(group:mcp)再回落到缺省。
 */
export const TOOL_SERVER_POLICY_PREFIX = "server:";

export function toolServerPolicyKey(serverId: string): string {
  return `${TOOL_SERVER_POLICY_PREFIX}${serverId}`;
}

/**
 * 解析一次工具调用的审批策略。设计目标:显式配置永远优先,缺省值保证既有
 * 体验零回归(内置/MCP 默认放行),只对第三方插件工具默认拦审。
 *
 * 判定顺序(由细到粗,任一命中即返回):
 * 1. 该工具名的显式覆盖(toolPolicies[toolName])—— 最细,最高优先级。
 * 2. MCP 按 server 的策略(server:<serverId>,仅对带 serverId 的 MCP 工具)。
 * 3. 工具组级默认(group:<groupId>,如把"所有 MCP 工具"设为 ask/deny)。
 *    2、3 都是用户对更大范围的明确表态,应盖过下面的只读缺省。
 * 4. browser 组无显式配置时缺省 ask:浏览器可出网、可交互外部站点,
 *    首次使用必须过一次用户审批(用户可 approve_session 放行本会话)。
 *    该缺省同时声明在 agent-ui builtinToolCatalog 的 defaultPolicy 字段
 *    (设置页据此展示缺省并决定何时写显式键),两处需保持同步。
 * 5. 只读工具(metadata.isReadOnly)恒 allow:读操作无副作用,不应打断对话。
 * 6. 其余(内置、mcp、无元数据的未知名)缺省 allow:保持现状,不制造回归。
 */
export function resolveToolPolicy(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
  policies: Record<string, ToolPolicy> | undefined,
): ToolPolicy {
  const explicit = policies?.[toolName];
  if (explicit) return explicit;
  const serverPolicy = metadata?.serverId
    ? policies?.[toolServerPolicyKey(metadata.serverId)]
    : undefined;
  if (serverPolicy) return serverPolicy;
  const groupId = metadata?.groupId;
  const groupPolicy = groupId ? policies?.[toolGroupPolicyKey(groupId)] : undefined;
  if (groupPolicy) return groupPolicy;
  if (groupId === "browser") return "ask";
  if (metadata?.isReadOnly) return "allow";
  return "allow";
}
