import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

export const NOTIFY_TOOL_NAME = "Notify";
export const NOTIFY_TITLE_MAX_CHARS = 80;
export const NOTIFY_BODY_MAX_CHARS = 300;

type NotifyOutcome = "sent" | "disabled" | "throttled" | "disabledByEnv";

const notifyTool: Tool = {
  name: NOTIFY_TOOL_NAME,
  description: `Show the user a desktop system notification. Only use it when the user explicitly asked to be notified (e.g. "notify me when this finishes") or in an unattended scheduled task whose result the user must see. Never use it for routine progress, confirmations or questions; reply in the conversation instead. Keep the title short (≤${NOTIFY_TITLE_MAX_CHARS} chars) and the body to one or two sentences (≤${NOTIFY_BODY_MAX_CHARS} chars). The user may have turned Agent notifications off, and notifications sent less than 30 seconds apart are dropped.`,
  parameters: Type.Object({
    title: Type.String({ minLength: 1, maxLength: NOTIFY_TITLE_MAX_CHARS }),
    body: Type.Optional(Type.String({ maxLength: NOTIFY_BODY_MAX_CHARS })),
  }),
};

function text(value: unknown, max: number) {
  return typeof value === "string" ? Array.from(value.trim()).slice(0, max).join("") : "";
}

/** 工具参数 → `notifications_notify` 的参数（纯函数，便于测试）；后端会再清洗一次。 */
export function buildNotifyArgs(args: Record<string, unknown>) {
  const title = text(args.title, NOTIFY_TITLE_MAX_CHARS);
  if (!title) throw new Error("A non-empty title is required.");
  return { title, body: text(args.body, NOTIFY_BODY_MAX_CHARS) };
}

/** 把投递结果说明给模型（英文）。 */
export function describeNotifyOutcome(outcome: NotifyOutcome) {
  switch (outcome) {
    case "sent":
      return "Sent as a desktop system notification.";
    case "disabled":
      return "Not sent: the user turned off Agent notifications.";
    case "throttled":
      return "Not sent: another Agent notification was sent less than 30 seconds ago.";
    default:
      return "Not sent: system notifications are disabled in this environment.";
  }
}

export function createNotifyTools(): BuiltinToolBundle {
  const executeToolCall = async (
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> => {
    let message: string;
    let isError = false;
    try {
      if (signal?.aborted) throw new Error("Cancelled");
      if (call.name !== NOTIFY_TOOL_NAME) throw new Error(`Unknown tool: ${call.name}`);
      const args = buildNotifyArgs((call.arguments ?? {}) as Record<string, unknown>);
      message = describeNotifyOutcome(await invoke<NotifyOutcome>("notifications_notify", args));
    } catch (error) {
      isError = true;
      message = error instanceof Error ? error.message : String(error);
    }
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: message }],
      details: {},
      isError,
      timestamp: Date.now(),
    };
  };
  return {
    groupId: "system",
    tools: [notifyTool],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        NOTIFY_TOOL_NAME,
        { groupId: "system", kind: "notify", isReadOnly: false, displayCategory: "system" },
      ],
    ]),
  };
}
