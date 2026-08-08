import { CheckCircle2, Circle, Loader2 } from "@liveagent/app/components/icons";
import type { TodoItem } from "@liveagent/app/lib/tools/builtinTypes";
import { useLocale } from "@liveagent/ui/i18n/index";

/**
 * Defensive shape filter for rendering todos straight from streaming tool-call
 * arguments: partially parsed items (missing fields, wrong types) are dropped
 * instead of crashing the checklist.
 */
export function sanitizeTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TodoItem => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate.content === "string" &&
      (candidate.status === "pending" ||
        candidate.status === "in_progress" ||
        candidate.status === "completed") &&
      typeof candidate.activeForm === "string"
    );
  });
}

function TodoRow(props: { todo: TodoItem }) {
  const { todo } = props;
  const label = todo.status === "in_progress" ? todo.activeForm : todo.content;

  return (
    <li
      data-todo-incomplete={todo.status === "completed" ? undefined : ""}
      className="flex items-start gap-2 py-1 text-[13px] leading-5"
    >
      <span className="mt-0.5 shrink-0">
        {todo.status === "completed" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--chat-success))]" />
        ) : todo.status === "in_progress" ? (
          <Loader2
            className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
            style={{ color: "hsl(var(--tool-list-accent))" }}
          />
        ) : (
          <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </span>
      <span
        className={
          todo.status === "completed"
            ? "text-muted-foreground line-through"
            : todo.status === "in_progress"
              ? "shimmer font-normal text-muted-foreground"
              : "text-foreground/80"
        }
      >
        {label}
      </span>
    </li>
  );
}

export function TodoListView(props: { todos: TodoItem[] }) {
  const { todos } = props;
  const { t } = useLocale();

  if (!Array.isArray(todos) || todos.length === 0) {
    return <div className="py-1 text-[13px] text-muted-foreground">{t("chat.tool.todoEmpty")}</div>;
  }

  return (
    <ul className="todo-list-view tool-text-scroll space-y-0.5 overflow-y-hidden">
      {todos.map((todo, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: todos are a full-replace snapshot with no stable id
        <TodoRow key={index} todo={todo} />
      ))}
    </ul>
  );
}
