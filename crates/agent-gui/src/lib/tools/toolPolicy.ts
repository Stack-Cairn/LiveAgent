import { hardcodedServerPolicyDefault } from "@liveagent/ui/contracts/mcpServerDefaults";

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
 * 工具组级「不可被隐式 allow 绕过的硬编码缺省」。这里列出的组在没有
 * 用户显式策略时直接走该默认值。
 *
 * 顺序：`isHardcodedGroupDefault` 检查必须在用户策略解析之后——即只要
 * 用户显式写了 `group:<id>` 的策略,就以用户为准(ask / allow / deny
 * 任意)。`extraGroupDefaults` 也排在它之前,调用方注入的组级缺省能盖
 * 过这张表。
 *
 * 目前为空:唯一的登记项曾是 `group:cua`,随自研 CUA 工具组一并移除
 * ——计算机操作已改为把 `cua-driver` 当普通 MCP server 接入,门控落到
 * server 粒度的 `HARDCODED_SERVER_DEFAULTS`(见
 * `@liveagent/ui/contracts/mcpServerDefaults`)。机制本体保留,后续要
 * 给某个工具组定死缺省时直接往这里加。
 */
const HARDCODED_GROUP_DEFAULTS: Readonly<Record<string, ToolPolicy>> = Object.freeze({});

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
 * 3. server 级硬编码缺省(`hardcodedServerPolicyDefault`):个别 server
 *    的工具面直接操作用户机器(如 cua-driver 的 kill_app / type_text),
 *    不能靠第 6 步的兜底 allow 隐式放行。用户在第 2 步显式表态即可盖过。
 * 4. 工具组级默认(group:<groupId>,如把"所有 MCP 工具"设为 ask/deny)。
 *    2、4 都是用户对更大范围的明确表态,应盖过下面的只读缺省。
 * 5. 只读工具(metadata.isReadOnly)恒 allow:读操作无副作用,不应打断对话。
 * 6. 其余(内置、mcp、无元数据的未知名)缺省 allow:保持现状,不制造回归。
 *
 * `extraGroupDefaults` 由调用方注入,排在「用户组级策略」之后、
 * 「硬编码组级缺省」之前——用来实现"某个运行时开关临时放宽整组工具"
 * 这类需求,而不必回设置面板改策略表。当前没有调用方传入。
 */
export function resolveToolPolicy(
  toolName: string,
  metadata: BuiltinToolMetadata | undefined,
  policies: Record<string, ToolPolicy> | undefined,
  extraGroupDefaults?: Record<string, ToolPolicy>,
): ToolPolicy {
  const explicit = policies?.[toolName];
  if (explicit) return explicit;
  const serverId = metadata?.serverId;
  const serverPolicy = serverId ? policies?.[toolServerPolicyKey(serverId)] : undefined;
  if (serverPolicy) return serverPolicy;
  if (serverId) {
    const hardcodedServer = hardcodedServerPolicyDefault(serverId);
    if (hardcodedServer) return hardcodedServer;
  }
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
