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
 * 工具组级「不可由用户覆盖的硬编码缺省」。这里列出的组在没有用户
 * 显式策略时,直接走该默认值——避免任何「隐式 allow」绕过 reviewer
 * 提出的安全门控(CUA-reviewer 要求 `group:cua` 默认 ask)。
 *
 * 顺序：`isHardcodedGroupDefault` 检查必须在用户策略解析之后；解析
 * 函数里会把「硬编码默认」放在「用户组级覆盖」之前——即只要用户
 * 显式写了 `group:cua` 的策略,就以用户为准(ask / allow / deny 任
 * 意)。trustMode 切换只在 `cuaSettings.trustMode === true` 时插入
 * `group:cua: allow` 隐式覆盖,所以这里返回的默认是「未开启信任模式
 * 时的兜底」。
 */
const HARDCODED_GROUP_DEFAULTS: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  cua: "ask",
});

export function isHardcodedGroupDefault(groupId: string): ToolPolicy | undefined {
  return HARDCODED_GROUP_DEFAULTS[groupId];
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
 * 4. 只读工具(metadata.isReadOnly)恒 allow:读操作无副作用,不应打断对话。
 * 5. 其余(内置、mcp、无元数据的未知名)缺省 allow:保持现状,不制造回归。
 *
 * `extraGroupDefaults` 由调用方注入:典型场景是 CUA 在 trustMode 开
 * 启时把 `group:cua` 强行设为 `allow`,让用户切信任时立刻生效,
 * 不需要再回设置面板改策略表。`extraGroupDefaults` 优先级低于用户
 * 策略,高于硬编码默认(ask)。
 */
export function resolveToolPolicy(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
  policies: Record<string, ToolPolicy> | undefined,
  extraGroupDefaults?: Record<string, ToolPolicy>,
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
  if (groupId && extraGroupDefaults?.[groupId]) {
    return extraGroupDefaults[groupId];
  }
  if (groupId) {
    const hardcoded = isHardcodedGroupDefault(groupId);
    if (hardcoded) return hardcoded;
  }
  if (metadata?.isReadOnly) return "allow";
  return "allow";
}
