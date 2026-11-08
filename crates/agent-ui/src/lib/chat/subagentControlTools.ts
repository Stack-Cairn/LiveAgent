/**
 * K-brain's tools for background subagents the parent already started
 * (internal/agent/subagent_control.go). Each call names its subagent by
 * `arguments.id`; `subagent_status` may omit it to list every subagent.
 *
 * - `subagent_followup` continues a finished subagent in the same conversation and
 *   returns the new report, so it renders as that subagent's card.
 * - `subagent_status`, `subagent_steer` and `subagent_cancel` are short rows: what
 *   was done, to which subagent, and what came back.
 */

export const KBRAIN_SUBAGENT_FOLLOWUP_TOOL_NAME = "subagent_followup";

export type SubagentControlAction = "status" | "steer" | "cancel" | "followup";

const CONTROL_ACTIONS: Readonly<Record<string, SubagentControlAction>> = {
  subagent_status: "status",
  subagent_steer: "steer",
  subagent_cancel: "cancel",
  [KBRAIN_SUBAGENT_FOLLOWUP_TOOL_NAME]: "followup",
};

export function subagentControlAction(name: string): SubagentControlAction | undefined {
  return Object.hasOwn(CONTROL_ACTIONS, name) ? CONTROL_ACTIONS[name] : undefined;
}

/** status / steer / cancel: the calls that render as one concise row. */
export function isSubagentControlRowToolName(name: string): boolean {
  const action = subagentControlAction(name);
  return action !== undefined && action !== "followup";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The subagent id a control call targets ("" for a status call that lists all). */
export function subagentControlTargetId(args: unknown): string {
  const id = asRecord(args)?.id;
  return typeof id === "string" ? id.trim() : "";
}

export type SubagentControlOutcome = {
  /** Short result shown where a tool row shows its status. */
  text: string;
  /** The call did not do what it was asked (K-brain reports some failures as text). */
  failed: boolean;
  /** `subagent_cancel` found the subagent already stopped. */
  inactive?: boolean;
  /** The subagent's description, when the result carries it (`subagent_status` with an id). */
  description?: string;
};

type Translate = (key: string) => string;

function firstLine(text: string, max = 80): string {
  const line =
    text
      .split(/\r?\n/)
      .find((part) => part.trim())
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function statusText(status: unknown, t: Translate): string {
  switch (status) {
    case "running":
      return t("chat.tool.running");
    case "done":
    case "completed":
      return t("chat.tool.success");
    case "cancelled":
      return t("chat.tool.stopped");
    case "error":
    case "failed":
      return t("chat.tool.failed");
    default:
      return typeof status === "string" ? status : "";
  }
}

function countText(count: number, one: string, many: string, t: Translate): string {
  return count === 1 ? t(one) : t(many).replace("{count}", String(count));
}

function summarizeStatus(text: string, t: Translate): SubagentControlOutcome | null {
  const parsed = asRecord(text);
  if (!parsed) return null;
  if (Array.isArray(parsed.tasks)) {
    const tasks = parsed.tasks.map(asRecord);
    const total =
      typeof parsed.total === "number" && Number.isFinite(parsed.total)
        ? parsed.total
        : tasks.length;
    const running = tasks.filter((task) => task?.status === "running").length;
    const parts = [
      countText(total, "chat.tool.subagent.result.countOne", "chat.tool.subagent.result.count", t),
    ];
    if (running > 0) {
      parts.push(t("chat.tool.subagent.result.running").replace("{count}", String(running)));
    }
    return { text: parts.join(" · "), failed: false };
  }
  const parts = [statusText(parsed.status, t)].filter(Boolean);
  if (parsed.following_up === true) parts.push(t("chat.tool.subagent.result.followingUp"));
  const description =
    typeof parsed.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : undefined;
  return {
    text: parts.join(" · "),
    failed: false,
    ...(description ? { description } : {}),
  };
}

/**
 * What a finished control call reported, in a few words. Returns null while the call
 * runs and for results it does not recognise, so the row keeps its generic status.
 */
export function summarizeSubagentControlResult(
  action: SubagentControlAction,
  result: { text: string; isError: boolean } | undefined,
  t: Translate,
): SubagentControlOutcome | null {
  if (!result) return null;
  const text = result.text.trim();
  if (result.isError) {
    return { text: firstLine(text) || t("chat.tool.failed"), failed: true };
  }
  // steer reports a rejected message as a normal result that starts with "Error:".
  if (/^error:/i.test(text)) {
    return {
      text: firstLine(text.replace(/^error:\s*/i, "")) || t("chat.tool.failed"),
      failed: true,
    };
  }
  switch (action) {
    case "status":
      return summarizeStatus(text, t);
    case "cancel":
      if (/^subagent is already inactive/i.test(text)) {
        return { text: t("chat.tool.subagent.result.inactive"), failed: false, inactive: true };
      }
      if (/^cancellation requested/i.test(text)) {
        return { text: t("chat.tool.subagent.result.cancelRequested"), failed: false };
      }
      return null;
    case "steer":
      return /^steered\b/i.test(text)
        ? { text: t("chat.tool.subagent.result.steered"), failed: false }
        : null;
    default:
      return null;
  }
}

export type SubagentControlRow = {
  /** Verb phrase for the row title ("Checked subagent"). */
  title: string;
  /** The subagent the call is about: its description when known, else its id. */
  target: string;
  outcome: SubagentControlOutcome | null;
};

/**
 * Title, target and result of a control call's row. `label` is the subagent's
 * description when the host linked the call to a known subagent.
 */
export function describeSubagentControlCall(
  call: { name: string; arguments: unknown },
  result: { text: string; isError: boolean } | undefined,
  options: { running: boolean; label?: string },
  t: Translate,
): SubagentControlRow | null {
  const action = subagentControlAction(call.name);
  if (!action) return null;
  const outcome = summarizeSubagentControlResult(action, result, t);
  const phase =
    outcome?.failed || result?.isError
      ? "failed"
      : options.running || !result
        ? "running"
        : outcome?.inactive
          ? "inactive"
          : "completed";
  const id = subagentControlTargetId(call.arguments);
  const label = options.label?.trim() || outcome?.description || id;
  return {
    title: t(`chat.tool.subagent.${action}.${phase}`),
    target: label || (action === "status" ? t("chat.tool.subagent.all") : ""),
    outcome,
  };
}
