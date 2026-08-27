import { serverPolicyKeyCandidates } from "@liveagent/ui/contracts/mcpServerDefaults";

import type { ToolPolicy } from "../settings";
import type { BuiltinToolMetadata } from "./builtinTypes";

// server 策略键的构造与候选顺序住在 contracts 里：设置页（agent-ui）读策略
// 必须与这里的运行时解析走同一份顺序，见 serverPolicyKeyCandidates 的注释。
export {
  TOOL_SERVER_POLICY_PREFIX,
  toolServerPolicyKey,
} from "@liveagent/ui/contracts/mcpServerDefaults";
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
 * 解析一次工具调用的审批策略。设计目标:显式配置永远优先,缺省值保证既有
 * 体验零回归(内置/MCP 默认放行),只对第三方插件工具默认拦审。
 *
 * 判定顺序(由细到粗,任一命中即返回):
 * 1. 该工具名的显式覆盖(toolPolicies[toolName])—— 最细,最高优先级。
 * 2. MCP 按 server 的策略(server:<serverId>,仅对带 serverId 的 MCP 工具)。
 * 3. server 级硬编码缺省(`metadata.serverPolicyDefault`):个别 server
 *    的工具面直接操作用户机器(如 cua-driver 的 kill_app / type_text),
 *    不能靠第 7 步的兜底 allow 隐式放行。用户在第 2 步显式表态即可盖过。
 *    该值在建工具表时依据 server 配置(含 command)算好,不在这里按 id 现查
 *    ——id 是用户可改的展示性标识,见 contracts/mcpServerDefaults.ts。
 * 4. 工具组级默认(group:<groupId>,如把"所有 MCP 工具"设为 ask/deny)。
 *    2、4 都是用户对更大范围的明确表态,应盖过下面的只读缺省。
 * 5. browser 组无显式配置时缺省 ask:浏览器可出网、可交互外部站点,
 *    首次使用必须过一次用户审批(用户可 approve_session 放行本会话)。
 *    该缺省同时声明在 agent-ui builtinToolCatalog 的 defaultPolicy 字段
 *    (设置页据此展示缺省并决定何时写显式键),两处需保持同步。
 * 6. 只读工具(metadata.isReadOnly)恒 allow:读操作无副作用,不应打断对话。
 * 7. 其余(内置、mcp、无元数据的未知名)缺省 allow:保持现状,不制造回归。
 */
export function resolveToolPolicy(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
  policies: Record<string, ToolPolicy> | undefined,
): ToolPolicy {
  const explicit = policies?.[toolName];
  if (explicit) return explicit;
  const serverId = metadata?.serverId;
  if (serverId) {
    for (const key of serverPolicyKeyCandidates(serverId)) {
      const serverPolicy = policies?.[key];
      if (serverPolicy) return serverPolicy;
    }
  }
  if (metadata?.serverPolicyDefault) return metadata.serverPolicyDefault;
  const groupId = metadata?.groupId;
  const groupPolicy = groupId ? policies?.[toolGroupPolicyKey(groupId)] : undefined;
  if (groupPolicy) return groupPolicy;
  if (groupId === "browser") return "ask";
  if (metadata?.isReadOnly) return "allow";
  return "allow";
}
