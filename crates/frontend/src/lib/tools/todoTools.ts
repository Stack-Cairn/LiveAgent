import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap, type TodoItem } from "./builtinTypes";

export type TodoToolState = ReturnType<typeof createTodoToolState>;

export function createTodoToolState() {
  let todos: TodoItem[] = [];

  return {
    getTodos(): TodoItem[] {
      return todos;
    },
    setTodos(next: TodoItem[]) {
      todos = next;
    },
    clear() {
      todos = [];
    },
  };
}

const todoStateByConversationId = new Map<string, TodoToolState>();

export function getOrCreateTodoToolState(conversationId: string): TodoToolState {
  let state = todoStateByConversationId.get(conversationId);
  if (!state) {
    state = createTodoToolState();
    todoStateByConversationId.set(conversationId, state);
  }
  return state;
}

export function disposeTodoToolState(conversationId: string) {
  todoStateByConversationId.delete(conversationId);
}

const TODO_WRITE_TOOL_DESCRIPTION = `Create and manage a structured task list for the current session. Use this to plan multi-step work, track progress, and demonstrate thoroughness.

Every call REPLACES the entire list — always pass the complete, current set of todos, not just the ones that changed.

Use it when:
- A task requires 3 or more distinct steps or actions.
- The user provides multiple tasks (numbered or comma-separated).
- A task is non-trivial and benefits from explicit tracking.
- After completing a task, to mark it done and surface any newly discovered follow-up work.

Skip it for a single, trivial, or purely conversational task.

Rules:
- Exactly one item may have status="in_progress" at any time.
- Mark an item in_progress before starting it, and completed immediately after finishing it — do not batch completions.
- Only mark an item completed when it is FULLY done; keep it in_progress if blocked, partially done, or erroring.
- content is the imperative form ("Run tests"); activeForm is the present-continuous form shown while the item is in_progress ("Running tests").`;

const TODO_ITEM_CONTENT_DESCRIPTION = 'Imperative description of the task, e.g. "Run tests".';
const TODO_ITEM_STATUS_DESCRIPTION = "Current status of the task.";
const TODO_ITEM_ACTIVE_FORM_DESCRIPTION =
  'Present-continuous form shown while the task is in_progress, e.g. "Running tests".';

const todoWriteParameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: TODO_ITEM_CONTENT_DESCRIPTION }),
      status: Type.Union(
        [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
        { description: TODO_ITEM_STATUS_DESCRIPTION },
      ),
      activeForm: Type.String({ description: TODO_ITEM_ACTIVE_FORM_DESCRIPTION }),
    }),
    { description: "The complete, current list of todos. This replaces any previous list." },
  ),
});

function validateTodoShape(args: Record<string, unknown>): TodoItem[] {
  const rawTodos = args.todos;
  if (!Array.isArray(rawTodos)) {
    throw new Error("TodoWrite requires a `todos` array.");
  }
  return rawTodos.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`TodoWrite todos[${index}] must be an object.`);
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.content !== "string" || !candidate.content.trim()) {
      throw new Error(`TodoWrite todos[${index}].content must be a non-empty string.`);
    }
    if (
      candidate.status !== "pending" &&
      candidate.status !== "in_progress" &&
      candidate.status !== "completed"
    ) {
      throw new Error(
        `TodoWrite todos[${index}].status must be "pending", "in_progress", or "completed".`,
      );
    }
    if (typeof candidate.activeForm !== "string" || !candidate.activeForm.trim()) {
      throw new Error(`TodoWrite todos[${index}].activeForm must be a non-empty string.`);
    }
    return {
      content: candidate.content,
      status: candidate.status,
      activeForm: candidate.activeForm,
    };
  });
}

function validateSingleInProgress(todos: TodoItem[]) {
  const inProgressCount = todos.filter((todo) => todo.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new Error(
      `Only one todo may be in_progress at a time; found ${inProgressCount}. Mark others as pending or completed.`,
    );
  }
}

function buildTodoWriteResultText(todos: TodoItem[]) {
  if (todos.length === 0) {
    return "Task list cleared.";
  }
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return [
    `Task list updated (${completed}/${todos.length} completed).`,
    ...todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`),
  ].join("\n");
}

export function createTodoTools(params: { state: TodoToolState }): BuiltinToolBundle {
  const toolTodoWrite: Tool = {
    name: "TodoWrite",
    description: TODO_WRITE_TOOL_DESCRIPTION,
    parameters: todoWriteParameters,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
    if (toolCall.name !== "TodoWrite") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      const args = (toolCall.arguments || {}) as Record<string, unknown>;
      const todos = validateTodoShape(args);
      validateSingleInProgress(todos);
      params.state.setTodos(todos);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: buildTodoWriteResultText(todos) }],
        details: { kind: "todo_write", todos },
        isError: false,
        timestamp: now,
      };
    } catch (error) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          { type: "text", text: error instanceof Error ? error.message : "TodoWrite failed." },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "system",
    tools: [toolTodoWrite],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "TodoWrite",
        {
          groupId: "system",
          kind: "todo_write",
          isReadOnly: false,
          displayCategory: "system",
        },
      ],
    ]),
  };
}
