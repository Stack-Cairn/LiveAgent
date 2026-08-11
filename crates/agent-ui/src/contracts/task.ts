export const TASK_TOOL_NAMES = ["TaskCreate", "TaskUpdate", "TaskList"] as const;

export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];
export type TaskStatus = "pending" | "in_progress" | "completed";

export type TaskItem = {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: TaskStatus;
};

export type TaskListState = {
  runId: string;
  revision: number;
  nextTaskId: number;
  tasks: TaskItem[];
};

export type TaskListResultDetails = {
  kind: "task_list";
  action: "created" | "updated" | "listed";
  runId: string;
  revision: number;
  tasks: TaskItem[];
  taskId?: string;
};

const TASK_TOOL_NAME_SET = new Set<string>(TASK_TOOL_NAMES);

export function isTaskToolName(value: unknown): value is TaskToolName {
  return typeof value === "string" && TASK_TOOL_NAME_SET.has(value);
}
