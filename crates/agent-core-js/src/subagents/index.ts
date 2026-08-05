export const AGENT_TOOL_NAME = "invoke_agent";
export const SUBAGENT_PARENT_ID = "parent";

export type SubagentTemplate = any;
export type SubagentConversationStore = any;

export function buildRosterReminder(_config: any): string {
  return "";
}

export function createSubagentScheduler(_config: any): any {
  return {};
}

export function renderMessageBusSnapshot(_snapshot: any): string {
  return "";
}

export function isSubagentCardToolCall(_call: any): boolean {
  return false;
}
