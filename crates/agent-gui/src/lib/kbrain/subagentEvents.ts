import type {
  KBrainEvent,
  KBrainMessage,
  KBrainModelRef,
  KBrainSubagent,
  KBrainUsage,
} from "./types";

/** Events K-brain publishes about one subagent: its lifecycle and its own transcript. */
export const SUBAGENT_EVENT_PREFIX = "subagent.";
export const CHILD_EVENT_PREFIX = "trajectory.child.";

const TERMINAL_STATUSES = new Set(["done", "completed", "error", "failed", "cancelled"]);

export function isSubagentEventType(type: string) {
  return type.startsWith(SUBAGENT_EVENT_PREFIX) || type.startsWith(CHILD_EVENT_PREFIX);
}

export function isTerminalSubagentStatus(status: string | undefined) {
  return TERMINAL_STATUSES.has(status ?? "");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** The subagent a `subagent.*` event describes, when it is well formed. */
export function subagentFromEvent(event: KBrainEvent): KBrainSubagent | undefined {
  if (!event.type.startsWith(SUBAGENT_EVENT_PREFIX)) return undefined;
  const payload = record(event.payload);
  const subagent = record(payload?.subagent) ?? payload;
  if (!subagent || typeof subagent.id !== "string" || !subagent.id) return undefined;
  if (typeof subagent.status !== "string") return undefined;
  return subagent as unknown as KBrainSubagent;
}

/** The subagent id an event belongs to, or "" for other events. */
export function subagentEventTaskId(event: KBrainEvent): string {
  if (event.type.startsWith(SUBAGENT_EVENT_PREFIX)) return subagentFromEvent(event)?.id ?? "";
  if (event.type.startsWith(CHILD_EVENT_PREFIX)) return text(record(event.payload)?.task_id);
  return "";
}

/** The child tool a `trajectory.child.tool_start` event names. */
export function childToolFromEvent(
  event: KBrainEvent,
): { id: string; name: string; arguments: string } | undefined {
  if (event.type !== "trajectory.child.tool_start") return undefined;
  const payload = record(event.payload);
  const name = text(payload?.name);
  if (!name) return undefined;
  return { id: text(payload?.id), name, arguments: text(payload?.arguments) };
}

/**
 * A later view of the same subagent wins, field by field: `subagent.*` events carry
 * the whole record, but a list fetched earlier may know usage the event omits.
 */
export function mergeSubagent(
  previous: KBrainSubagent | undefined,
  next: KBrainSubagent,
): KBrainSubagent {
  if (!previous) return next;
  const merged: KBrainSubagent = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null && value !== "") {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  if (next.status === "running") {
    delete merged.ended_at;
    delete merged.report;
    delete merged.error;
    delete merged.duration_ms;
  }
  return merged;
}

export function usageTotal(usage: KBrainUsage | undefined) {
  return (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
}

/** Milliseconds the subagent has run so far, or ran in all. */
export function subagentDurationMs(subagent: KBrainSubagent, now = Date.now()) {
  if (typeof subagent.duration_ms === "number" && subagent.duration_ms > 0) {
    return subagent.duration_ms;
  }
  const started = Date.parse(subagent.started_at ?? "");
  if (!Number.isFinite(started)) return undefined;
  const ended = Date.parse(subagent.ended_at ?? "");
  const end = Number.isFinite(ended)
    ? ended
    : isTerminalSubagentStatus(subagent.status)
      ? NaN
      : now;
  return Number.isFinite(end) ? Math.max(0, end - started) : undefined;
}

type MutableMessage = KBrainMessage & { content: NonNullable<KBrainMessage["content"]> };

/**
 * Applies one `trajectory.child.*` event to a subagent transcript, the way K-brain
 * rebuilds it for /subagents/{task}: text and thinking extend the open assistant
 * message, thinking after text or tool calls opens the next one, a tool result or
 * a steer closes it. Returns the input when the event does not change it.
 */
export function applyChildEvent(
  messages: readonly KBrainMessage[],
  event: KBrainEvent,
  model?: KBrainModelRef,
): KBrainMessage[] {
  const payload = record(event.payload);
  const next = [...messages];
  const newAssistant = (): MutableMessage => {
    const created: MutableMessage = {
      role: "assistant",
      content: [],
      created_at: event.created_at,
      ...(model?.model ? { model: model.model } : {}),
      ...(model?.provider ? { provider: model.provider } : {}),
    };
    next.push(created);
    return created;
  };
  // A tool result or a steer is a later message, so the reply before it is closed.
  const openAssistant = (): MutableMessage => {
    const current = next.at(-1);
    if (current?.role !== "assistant") return newAssistant();
    const copy = { ...current, content: [...(current.content ?? [])] } as MutableMessage;
    if (current.tool_calls) copy.tool_calls = [...current.tool_calls];
    next[next.length - 1] = copy;
    return copy;
  };
  const appendBlock = (message: MutableMessage, type: "text" | "thinking", value: string) => {
    const tail = message.content.at(-1);
    if (tail?.type === type) {
      message.content[message.content.length - 1] = { ...tail, text: `${tail.text ?? ""}${value}` };
      return;
    }
    message.content.push({ type, text: value });
  };
  switch (event.type) {
    case "trajectory.child.text": {
      const value = text(payload?.text);
      if (!value) return [...messages];
      appendBlock(openAssistant(), "text", value);
      return next;
    }
    case "trajectory.child.thinking": {
      const value = text(payload?.text);
      if (!value) return [...messages];
      const last = next.at(-1);
      // Thinking after text or tool calls is the next model reply.
      const opensNext =
        last?.role === "assistant" &&
        (last.content?.at(-1)?.type === "text" || (last.tool_calls?.length ?? 0) > 0);
      appendBlock(opensNext ? newAssistant() : openAssistant(), "thinking", value);
      return next;
    }
    case "trajectory.child.steer":
      next.push({
        role: "user",
        content: [{ type: "text", text: text(payload?.text) }],
        created_at: event.created_at,
      });
      return next;
    case "trajectory.child.tool_start": {
      const message = openAssistant();
      let args: unknown = {};
      try {
        const parsed = JSON.parse(text(payload?.arguments) || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
      } catch {
        args = {};
      }
      message.tool_calls = [
        ...(message.tool_calls ?? []),
        { id: text(payload?.id), name: text(payload?.name), arguments: args },
      ];
      return next;
    }
    case "trajectory.child.tool_end": {
      const stop =
        payload?.cancelled === true ? "cancelled" : payload?.failed === true ? "error" : undefined;
      next.push({
        role: "tool",
        tool_call_id: text(payload?.id),
        name: text(payload?.name),
        content: [{ type: "text", text: text(payload?.output) }],
        created_at: event.created_at,
        ...(stop ? { stop_reason: stop } : {}),
      });
      return next;
    }
    default:
      return [...messages];
  }
}
