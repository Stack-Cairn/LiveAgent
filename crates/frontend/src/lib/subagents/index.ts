// 前端 barrel：只保留 UI 真正消费的符号（卡片解析 + store 管理）。
// 引擎执行链（agentTool / run / bus / roster / sendMessageTool 等）已删除——
// 引擎在 crates/core/src/subagents 运行，test/subagents/* 直接加载 core 模块。
// scheduler.ts 仅因 builtinTypes 的类型引用保留。
export { isSubagentCardToolCall } from "./card";
export type {
  SubagentBatchDetails,
  SubagentCardArguments,
  SubagentCardDetails,
  SubagentMessageDetails,
  SubagentReportDetails,
} from "./protocol";
export { buildSubagentCardToolCallId, isSubagentCardArguments } from "./protocol";
export {
  collectRetainedSubagentParentToolCallIds,
  createSubagentStoreManager,
  pruneSubagentRunsForConversation,
  type SubagentConversationStore,
  type SubagentStoreManager,
} from "./store";
