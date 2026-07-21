import type { ToolCall } from "@earendil-works/pi-ai";

import {
  ASK_USER_QUESTION_DEADLINE_ARG,
  ASK_USER_QUESTION_TOOL_NAME,
} from "../../../lib/chat/askUserQuestion";
import {
  countTextLines,
  FILE_TOOL_TEXT_FIELDS,
  LIVE_TOOL_PREVIEW_META_KEY,
  type PreviewFieldMetrics,
  type StreamPreviewMeta,
} from "../../../lib/chat/messages/toolPreview";
import { ensureAskUserQuestionDeadlineAt } from "../../../lib/tools/askUserQuestionTools";

const GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS = 4000;

function buildHeadTailPreview(input: string, maxChars = GATEWAY_TOOL_TEXT_PREVIEW_MAX_CHARS) {
  if (input.length <= maxChars) {
    return {
      text: input,
      metrics: {
        chars: input.length,
        lines: countTextLines(input),
        truncated: false,
      } satisfies PreviewFieldMetrics,
    };
  }

  const omittedChars = Math.max(0, input.length - maxChars);
  const marker = `\n...[truncated ${omittedChars} chars]...\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headChars = Math.max(0, Math.floor(budget * 0.68));
  const tailChars = Math.max(0, budget - headChars);
  const text =
    budget > 0
      ? `${input.slice(0, headChars)}${marker}${tailChars > 0 ? input.slice(-tailChars) : ""}`
      : input.slice(0, maxChars);

  return {
    text,
    metrics: {
      chars: input.length,
      lines: countTextLines(input),
      truncated: true,
    } satisfies PreviewFieldMetrics,
  };
}

// The canonical producer of streaming tool previews: bridge events
// (tool_call / tool_call_delta / tool_result) and runtime snapshot entries
// all pass through here, so every remote representation of a file tool's
// args carries the same truncated text + true metrics + monotonic progress.
export function buildGatewayToolCallPreviewArguments(
  toolCall: Pick<ToolCall, "id" | "name" | "arguments">,
) {
  const sourceArgs = toolCall.arguments || {};
  // AskUserQuestion：附带权威应答截止时间，WebUI 卡片倒计时与桌面计时同源
  //（execute 挂起时复用同一预置值；见 askUserQuestionTools）。
  if (toolCall.name === ASK_USER_QUESTION_TOOL_NAME) {
    return {
      ...sourceArgs,
      [ASK_USER_QUESTION_DEADLINE_ARG]: ensureAskUserQuestionDeadlineAt(toolCall.id),
    };
  }
  const fieldsToPreview = FILE_TOOL_TEXT_FIELDS[toolCall.name];
  if (!fieldsToPreview) {
    return sourceArgs;
  }

  const args: Record<string, unknown> = { ...sourceArgs };
  const fields: Record<string, PreviewFieldMetrics> = {};
  let progress = 0;

  for (const field of fieldsToPreview) {
    const value = args[field];
    if (typeof value !== "string") continue;
    const preview = buildHeadTailPreview(value);
    args[field] = preview.text;
    fields[field] = preview.metrics;
    progress += preview.metrics.chars;
  }

  if (Object.keys(fields).length > 0) {
    args[LIVE_TOOL_PREVIEW_META_KEY] = { v: 2, progress, fields } satisfies StreamPreviewMeta;
  }

  return args;
}
