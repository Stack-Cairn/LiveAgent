import { CHAT_RUNTIME_PROTOCOL_INCOMPATIBLE } from "./chat/runtimeCompatibility";
import type { AgentStatus } from "./gatewayTypes";

// The gateway registers a watcher under this prefix when a browser subscribes
// to a workspace whose Agent is not connected. It forwards file activity only:
// it can never chat, so it is not a target a user should land on.
const GATEWAY_LOCAL_WORKSPACE_AGENT_PREFIX = "gateway-local-workspace-";

function agentIdOf(agent: AgentStatus | null | undefined): string {
  return (agent?.agent_id ?? "").trim();
}

export function isGatewayLocalWorkspaceAgentId(agentId: string | null | undefined): boolean {
  return (agentId ?? "").trim().startsWith(GATEWAY_LOCAL_WORKSPACE_AGENT_PREFIX);
}

/** Online, ready and able to run chat turns for this WebUI. */
export function isChatCapableAgent(agent: AgentStatus | null | undefined): boolean {
  if (!agent || agent.online !== true || agent.agent_ready === false) return false;
  if (isGatewayLocalWorkspaceAgentId(agent.agent_id)) return false;
  return agent.runtime_state?.trim() !== CHAT_RUNTIME_PROTOCOL_INCOMPATIBLE;
}

/**
 * The Agent directory a user can pick from. Workspace watchers stay out unless
 * nothing else exists and the watcher is actually online.
 */
export function selectableAgents(agents: readonly AgentStatus[]): AgentStatus[] {
  const withId = agents.filter((agent) => agentIdOf(agent) !== "");
  const real = withId.filter((agent) => !isGatewayLocalWorkspaceAgentId(agent.agent_id));
  if (real.length > 0) return real;
  return withId.filter((agent) => agent.online === true);
}

function rankAgent(agent: AgentStatus): number {
  if (isChatCapableAgent(agent)) return 0;
  return agent.online === true ? 1 : 2;
}

/** Chat-capable first, then online, then offline; ties sort by id. */
function compareAgentsForSelection(left: AgentStatus, right: AgentStatus): number {
  const rankDelta = rankAgent(left) - rankAgent(right);
  if (rankDelta !== 0) return rankDelta;
  return agentIdOf(left).localeCompare(agentIdOf(right));
}

/**
 * The Agent this browser should talk to: the current choice while it is still
 * a selectable entry (an offline desktop stays chosen; the UI offers a switch),
 * otherwise the best-ranked one. Empty when the directory has nothing usable.
 */
export function pickActiveAgentId(agents: readonly AgentStatus[], currentId: string): string {
  const candidates = selectableAgents(agents);
  const current = currentId.trim();
  if (current && candidates.some((agent) => agentIdOf(agent) === current)) {
    return current;
  }
  return agentIdOf([...candidates].sort(compareAgentsForSelection)[0]);
}

/**
 * Another Agent worth offering when the current one cannot chat: the
 * best-ranked chat-capable entry other than the current one, or null.
 */
export function suggestAlternativeAgent(
  agents: readonly AgentStatus[],
  currentId: string,
): AgentStatus | null {
  const current = currentId.trim();
  const currentAgent = agents.find((agent) => agentIdOf(agent) === current);
  if (currentAgent && isChatCapableAgent(currentAgent)) return null;
  const alternative = selectableAgents(agents)
    .filter((agent) => agentIdOf(agent) !== current && isChatCapableAgent(agent))
    .sort(compareAgentsForSelection)[0];
  return alternative ?? null;
}

export function agentDisplayName(agent: AgentStatus): string {
  return agent.name?.trim() || agentIdOf(agent) || "Agent";
}
