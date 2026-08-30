// crates/agent-ui/src/components/chat/clarify/clarifyProtocol.ts
import type { ClarifyContext, ClarifyMessage } from "./clarifyTypes";

export const CLARIFY_QUESTION_MARKER = "[CLARIFY_QUESTION]";
export const CLARIFY_FINAL_MARKER = "[CLARIFY_FINAL]";
/** 超过硬上限后前端强制注入终稿指令，防止 LLM 无限提问（设计文档「错误处理」）。 */
export const CLARIFY_MAX_QUESTIONS = 5;

export type ParsedClarifyTurn = { kind: "question" | "final"; text: string };

/** 完整回复解析：识别首行标记；无标记整体当 question 兜底。 */
export function parseClarifyTurn(raw: string): ParsedClarifyTurn {
  const value = raw ?? "";
  for (const [marker, kind] of [
    [CLARIFY_FINAL_MARKER, "final"],
    [CLARIFY_QUESTION_MARKER, "question"],
  ] as const) {
    if (value.startsWith(marker)) {
      return { kind, text: value.slice(marker.length).trim() };
    }
  }
  return { kind: "question", text: value.trim() };
}

/**
 * 流式显示用：剥掉开头已到/未到的标记前缀。流首 token 往往劈在标记中间，
 * 前 20 个字符在凑齐标记（或确认不是标记）之前一律隐藏。
 */
export function stripLeadingMarker(partial: string): string {
  const value = partial ?? "";
  if (value.startsWith(CLARIFY_FINAL_MARKER)) {
    return value.slice(CLARIFY_FINAL_MARKER.length).replace(/^\s+/, "");
  }
  if (value.startsWith(CLARIFY_QUESTION_MARKER)) {
    return value.slice(CLARIFY_QUESTION_MARKER.length).replace(/^\s+/, "");
  }
  // 尚未排除标记可能性：标记最长 16 字符，前缀不足 16 字符且每个字符都
  // 与某一标记前缀一致时先隐藏，避免标记碎片闪现在气泡里。
  const prefixWindow = value.slice(0, CLARIFY_QUESTION_MARKER.length);
  const couldBeMarker =
    CLARIFY_QUESTION_MARKER.startsWith(prefixWindow) ||
    CLARIFY_FINAL_MARKER.startsWith(prefixWindow);
  if (couldBeMarker && prefixWindow.length < CLARIFY_QUESTION_MARKER.length) {
    return "";
  }
  return value;
}

/** 从 superpowers brainstorming 技能拆编：一次一问、聚焦目的/约束/成功标准。 */
export function buildClarifySystemPrompt(context?: ClarifyContext): string {
  const workspace = context?.workdir?.trim();
  const branch = context?.gitBranch?.trim();
  const workspaceLines = workspace
    ? [`Workspace: ${workspace}${branch ? ` (branch: ${branch})` : ""}`]
    : [];
  return [
    "You are a prompt clarification assistant. The user gives a rough draft prompt; your job is to turn it into a well-specified, directly executable prompt through a short conversation.",
    "",
    "Rules:",
    `- 一次只问一个问题 (ask exactly ONE question per reply). Start every reply with the line "${CLARIFY_QUESTION_MARKER}".`,
    `- Prefer 2-4 concrete options the user can pick from (e.g. "A) ... B) ... C) ..."), or an open question when options would mislead.`,
    "  You may ask the user to choose \"Other\" and type freely.",
    "- Focus on: purpose (what outcome they want), constraints (tech/scope/style), and success criteria (what \"done\" looks like).",
    "- Never re-ask what the draft already makes clear. At most 5 questions total.",
    "- When the requirement is clear enough (or you have asked 5 questions), stop asking: start your reply with the line",
    `  "${CLARIFY_FINAL_MARKER}" and write the full optimized prompt. The final prompt must be a single ready-to-send message in the user's language, incorporating every answer given so far. Do not add explanations around it.`,
    "- Always reply in the language of the user's draft.",
    ...workspaceLines,
  ].join("\n");
}

/** 「直接生成」/轮数超限时注入的用户指令：绕过剩余提问直接出终稿。 */
export function buildForceFinalInstruction(): string {
  return "直接给出最终优化后的提示词（以 " + CLARIFY_FINAL_MARKER + " 开头），不要再提问。";
}

/** 完整 LLM 输入：system 前置 + 会话消息。 */
export function buildClarifyMessages(
  sessionMessages: ClarifyMessage[],
  context?: ClarifyContext,
): ClarifyMessage[] {
  return [{ role: "system", content: buildClarifySystemPrompt(context) }, ...sessionMessages];
}
