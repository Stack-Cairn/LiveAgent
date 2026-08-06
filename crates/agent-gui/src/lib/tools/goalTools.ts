import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  type ConversationGoal,
  createConversationGoal,
  type GoalState,
  type GoalStatus,
  goalStatusLabel,
} from "../chat/goal";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

const goalStatusSchema = Type.Union([Type.Literal("complete"), Type.Literal("blocked")]);

const getGoalTool: Tool = {
  name: GET_GOAL_TOOL_NAME,
  description:
    "Get the current goal for this conversation, including status, token budget, usage, and remaining budget.",
  parameters: Type.Object({}),
};

const createGoalTool: Tool = {
  name: CREATE_GOAL_TOOL_NAME,
  description:
    "Create a goal only when the user explicitly requests one. It fails when an unfinished goal already exists.",
  parameters: Type.Object({
    objective: Type.String({ description: "The concrete objective to pursue." }),
    token_budget: Type.Optional(
      Type.Integer({ description: "Optional positive token budget for the goal." }),
    ),
  }),
};

const updateGoalTool: Tool = {
  name: UPDATE_GOAL_TOOL_NAME,
  description:
    "Update the existing goal. Use complete only after the objective is achieved and verified. Use blocked only when the same blocker makes further progress impossible.",
  parameters: Type.Object({
    status: goalStatusSchema,
  }),
};

function result(
  toolCall: ToolCall,
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
) {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  } satisfies ToolResultMessage;
}

function goalResponse(goal: ConversationGoal | null) {
  return JSON.stringify({
    goal,
    remaining_tokens: goal?.tokenBudget
      ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
      : undefined,
  });
}

function isTerminalStatus(value: unknown): value is Extract<GoalStatus, "complete" | "blocked"> {
  return value === "complete" || value === "blocked";
}

export function createGoalTools(params: { state: GoalState }): BuiltinToolBundle {
  async function executeToolCall(toolCall: ToolCall, signal?: AbortSignal) {
    if (signal?.aborted) return result(toolCall, "Cancelled", {}, true);
    try {
      const args = (toolCall.arguments || {}) as Record<string, unknown>;
      if (toolCall.name === GET_GOAL_TOOL_NAME) {
        const goal = params.state.getGoal();
        return result(toolCall, goalResponse(goal), { kind: "goal", action: "get", goal });
      }
      if (toolCall.name === CREATE_GOAL_TOOL_NAME) {
        const objective = typeof args.objective === "string" ? args.objective : "";
        const current = params.state.getGoal();
        if (current && current.status !== "complete") {
          return result(
            toolCall,
            "Cannot create a new goal because an unfinished goal already exists. Update or complete the existing goal first.",
            {},
            true,
          );
        }
        const rawBudget = args.token_budget;
        const tokenBudget = rawBudget === undefined ? undefined : Number(rawBudget);
        const goal = createConversationGoal(objective, tokenBudget);
        params.state.setGoal(goal);
        return result(toolCall, goalResponse(goal), { kind: "goal", action: "create", goal });
      }
      if (toolCall.name === UPDATE_GOAL_TOOL_NAME) {
        const status = args.status;
        if (!isTerminalStatus(status)) {
          return result(toolCall, "update_goal status must be complete or blocked.", {}, true);
        }
        const current = params.state.getGoal();
        if (!current) return result(toolCall, "There is no goal to update.", {}, true);
        const goal = { ...current, status, updatedAt: Date.now() } satisfies ConversationGoal;
        params.state.setGoal(goal);
        return result(toolCall, `${goalStatusLabel(status)}: ${goalResponse(goal)}`, {
          kind: "goal",
          action: "update",
          goal,
        });
      }
      return result(toolCall, `Unknown goal tool: ${toolCall.name}`, {}, true);
    } catch (error) {
      return result(
        toolCall,
        error instanceof Error ? error.message : "Goal operation failed.",
        {},
        true,
      );
    }
  }

  return {
    groupId: "system",
    tools: [getGoalTool, createGoalTool, updateGoalTool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        GET_GOAL_TOOL_NAME,
        { groupId: "system", kind: "goal_get", isReadOnly: true, displayCategory: "system" },
      ],
      [
        CREATE_GOAL_TOOL_NAME,
        { groupId: "system", kind: "goal_create", isReadOnly: false, displayCategory: "system" },
      ],
      [
        UPDATE_GOAL_TOOL_NAME,
        { groupId: "system", kind: "goal_update", isReadOnly: false, displayCategory: "system" },
      ],
    ]),
  };
}
