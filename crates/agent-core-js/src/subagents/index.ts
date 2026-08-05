export type SubagentStoreManager = any;

export function collectRetainedSubagentParentToolCallIds(state: any): Set<string> {
  return new Set();
}

export function pruneSubagentRunsForConversation(state: any): any {
  return state;
}
