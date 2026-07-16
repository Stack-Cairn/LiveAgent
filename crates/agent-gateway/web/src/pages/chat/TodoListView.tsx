import { CheckCircle2, Circle, ListChecks, Loader2 } from "../../components/icons";
import { useLocale } from "../../i18n";
import type { ToolTraceItem } from "../../lib/chat/uiMessages";
import type { TodoItem, TodoWriteResultDetails } from "../../lib/tools/builtinTypes";
import { getBuiltinResultKind } from "./assistant-bubble/assistantBubbleUtils";

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

export function shouldRenderTodoInline(item: ToolTraceItem): boolean {
  return item.toolCall.name === "TodoWrite" && !item.toolResult?.isError;
}

export function resolveTodoItems(item: ToolTraceItem): TodoItem[] {
  const result = item.toolResult;
  if (result && !result.isError && getBuiltinResultKind(result) === "todo_write") {
    return sanitizeTodoItems((result.details as TodoWriteResultDetails).todos);
  }
  return sanitizeTodoItems(item.toolCall.arguments?.todos);
}

function TodoRow(props: { todo: TodoItem; className?: string }) {
  const { todo, className } = props;
  const label = todo.status === "in_progress" ? todo.activeForm : todo.content;

  return (
    <li className={`flex items-start gap-2 text-[13px] leading-5 ${className ?? "py-1"}`}>
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

/** A settled or streaming TodoWrite rendered directly in the assistant reply flow. */
export function TodoListBlock({ item }: { item: ToolTraceItem }) {
  const { t } = useLocale();
  const todos = resolveTodoItems(item);

  // Avoid flashing an empty frame while streaming arguments are incomplete.
  if (!item.toolResult && todos.length === 0) return null;

  return (
    <div className="tool-card-enter overflow-hidden rounded-[8px] border border-black/[0.06] bg-white/[0.72] shadow-sm backdrop-blur-xl dark:border-white/[0.1] dark:bg-white/[0.06] dark:shadow-none">
      <div className="flex items-center gap-2 border-b border-black/[0.04] px-2.5 py-[7px] dark:border-white/[0.05]">
        <div
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px]"
          style={{ background: "hsl(var(--tool-list-accent) / 0.1)" }}
        >
          <ListChecks className="h-3 w-3" style={{ color: "hsl(var(--tool-list-accent))" }} />
        </div>
        <span className="font-sans text-[calc(12.5px*var(--zone-font-scale,1))] font-semibold text-foreground/90">
          {t("chat.tool.todoTitle")}
        </span>
      </div>
      {todos.length === 0 ? (
        <div className="px-3 py-2 text-[13px] text-muted-foreground">
          {t("chat.tool.todoEmpty")}
        </div>
      ) : (
        <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
          {todos.map((todo, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: todos are a full-replace snapshot with no stable id
            <TodoRow className="px-3 py-1.5" key={index} todo={todo} />
          ))}
        </ul>
      )}
    </div>
  );
}
