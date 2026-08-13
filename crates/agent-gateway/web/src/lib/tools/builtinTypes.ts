import type { BuiltinToolBundleShape } from "@liveagent/ui/contracts/builtinTools";
import type { Tool, ToolCall, ToolResultMessage } from "../agentTypes";

export * from "@liveagent/ui/contracts/builtinTools";
export type {
  TaskItem,
  TaskListResultDetails,
  TaskListState,
  TaskStatus,
} from "@liveagent/ui/contracts/task";

export type BuiltinToolExecutor = (
  toolCall: ToolCall,
  signal?: AbortSignal,
) => Promise<ToolResultMessage>;

export type BuiltinToolBundle<TExtra extends object = object> = BuiltinToolBundleShape<
  Tool,
  BuiltinToolExecutor,
  TExtra
>;
