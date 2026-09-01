// crates/agent-ui/src/components/chat/clarify/clarifyProtocol.ts
// 结构化澄清协议：模型每轮要么以 [CLARIFY_QUESTIONS] + 严格 JSON 提出一批
// 可点选的问题（1-N 道，数量由模型按需决定），要么以 [CLARIFY_FINAL] + 纯文本
// 直接给出终稿提示词。用户的点选/自由输入以 [CLARIFY_ANSWERS] 文本块回传。
import type {
  ClarifyContext,
  ClarifyMessage,
  ClarifyOption,
  ClarifyQuestion,
  ClarifyRound,
} from "./clarifyTypes";

export const CLARIFY_QUESTIONS_MARKER = "[CLARIFY_QUESTIONS]";
export const CLARIFY_FINAL_MARKER = "[CLARIFY_FINAL]";
export const CLARIFY_ANSWERS_MARKER = "[CLARIFY_ANSWERS]";

/** 超过硬上限后前端强制注入终稿指令，防止 LLM 无限追问（设计文档「错误处理」）。 */
export const CLARIFY_MAX_ROUNDS = 3;
/** 单轮问题数上限：解析时超量截断，与系统提示词中的约束一致。 */
export const CLARIFY_MAX_QUESTIONS_PER_ROUND = 4;
/** 单题选项数上限：超量截断（UI 恒补「其他」行，选项过多反而降低可读性）。 */
export const CLARIFY_MAX_OPTIONS_PER_QUESTION = 6;

export type ParsedClarifyTurn =
  | { kind: "questions"; questions: ClarifyQuestion[] }
  | { kind: "final"; text: string };

/** 剥掉模型偶发无视指令包上的 markdown 围栏，再截取首尾花括号间的 JSON。 */
function extractJsonPayload(text: string): unknown {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeOptions(value: unknown): ClarifyOption[] {
  if (!Array.isArray(value)) return [];
  const options: ClarifyOption[] = [];
  const seenLabels = new Set<string>();
  for (const entry of value) {
    if (options.length >= CLARIFY_MAX_OPTIONS_PER_QUESTION) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    // label 是应答载荷与 UI 选中键：空值或重复都会让点选歧义，直接丢弃。
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    const description =
      typeof record.description === "string" && record.description.trim()
        ? record.description.trim()
        : undefined;
    options.push({
      label,
      ...(description ? { description } : {}),
      ...(record.recommended === true ? { recommended: true } : {}),
    });
  }
  return options;
}

/**
 * 校验并归一化模型给出的问题列表：prompt 为空的条目丢弃、id 缺失/重复时
 * 按序号重派、问题与选项超量截断。整体无一道有效问题时返回 null（由
 * parseClarifyTurn 走开放问题兜底）。
 */
export function normalizeClarifyQuestions(value: unknown): ClarifyQuestion[] | null {
  if (typeof value !== "object" || value === null) return null;
  const list = (value as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return null;
  const questions: ClarifyQuestion[] = [];
  const seenIds = new Set<string>();
  for (const entry of list) {
    if (questions.length >= CLARIFY_MAX_QUESTIONS_PER_ROUND) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) continue;
    const rawId = typeof record.id === "string" ? record.id.trim() : "";
    // id 是答案与问题的对应键：重复 id 会让答案串题，重派为序号 id。
    const id = rawId && !seenIds.has(rawId) ? rawId : `q${questions.length + 1}`;
    seenIds.add(id);
    const header =
      typeof record.header === "string" && record.header.trim() ? record.header.trim() : undefined;
    questions.push({
      id,
      ...(header ? { header } : {}),
      prompt,
      options: normalizeOptions(record.options),
      ...(record.allowMultiple === true ? { allowMultiple: true } : {}),
    });
  }
  return questions.length > 0 ? questions : null;
}

/**
 * 完整回复解析。终稿以标记识别；问题轮标记可缺（模型偶发直接输出 JSON），
 * 按 JSON 载荷识别；两者都不像时把整段文本当一道开放问题兜底——UI 只渲染
 * 「其他」输入框，交互不断流。
 */
export function parseClarifyTurn(raw: string): ParsedClarifyTurn {
  const value = (raw ?? "").trim();
  if (value.startsWith(CLARIFY_FINAL_MARKER)) {
    return { kind: "final", text: value.slice(CLARIFY_FINAL_MARKER.length).trim() };
  }
  let body = value;
  if (body.startsWith(CLARIFY_QUESTIONS_MARKER)) {
    body = body.slice(CLARIFY_QUESTIONS_MARKER.length);
  }
  const questions = normalizeClarifyQuestions(extractJsonPayload(body));
  if (questions) return { kind: "questions", questions };
  return {
    kind: "questions",
    questions: [{ id: "q1", prompt: value || "…", options: [] }],
  };
}

/**
 * 流式显示用：终稿轮剥掉 [CLARIFY_FINAL] 前缀后逐字上屏；问题轮流的是 JSON，
 * 返回空串（面板显示思考态）。前缀尚可能凑成任一标记时一律先隐藏，
 * 避免标记碎片闪现在气泡里。
 */
export function clarifyStreamPreview(partial: string): string {
  const value = (partial ?? "").trimStart();
  if (!value) return "";
  if (value.startsWith(CLARIFY_FINAL_MARKER)) {
    return value.slice(CLARIFY_FINAL_MARKER.length).replace(/^\s+/, "");
  }
  // 问题轮：带标记、裸 JSON、markdown 围栏三种形态都不上屏。
  if (
    value.startsWith(CLARIFY_QUESTIONS_MARKER) ||
    value.startsWith("{") ||
    value.startsWith("`")
  ) {
    return "";
  }
  const longestMarker = Math.max(CLARIFY_FINAL_MARKER.length, CLARIFY_QUESTIONS_MARKER.length);
  const prefixWindow = value.slice(0, longestMarker);
  const couldBeMarker =
    CLARIFY_FINAL_MARKER.startsWith(prefixWindow) ||
    CLARIFY_QUESTIONS_MARKER.startsWith(prefixWindow);
  if (couldBeMarker && prefixWindow.length < longestMarker) {
    return "";
  }
  return value;
}

/**
 * 把一轮已落定的问答序列化为回传给模型的用户消息。逐题一组 Q/A 行；
 * 未回答的问题标记 "(not answered)"——系统提示词已向模型解释该记号。
 */
export function buildClarifyAnswersMessage(round: ClarifyRound): string {
  const answersById = new Map((round.answers ?? []).map((answer) => [answer.questionId, answer]));
  const lines = [CLARIFY_ANSWERS_MARKER];
  round.questions.forEach((question, index) => {
    const answer = answersById.get(question.id);
    const parts: string[] = [];
    if (answer) {
      parts.push(...answer.selectedLabels.filter((label) => label.trim().length > 0));
      const custom = answer.customText?.trim();
      if (custom) parts.push(custom);
    }
    lines.push(`Q${index + 1}: ${question.prompt}`);
    lines.push(`A${index + 1}: ${parts.length > 0 ? parts.join("; ") : "(not answered)"}`);
  });
  return lines.join("\n");
}

/** 从 superpowers brainstorming 技能拆编：按需成批提问、聚焦目的/约束/成功标准。 */
export function buildClarifySystemPrompt(context?: ClarifyContext): string {
  const workspace = context?.workdir?.trim();
  const branch = context?.gitBranch?.trim();
  const workspaceLines = workspace
    ? ["", `Workspace: ${workspace}${branch ? ` (branch: ${branch})` : ""}`]
    : [];
  return [
    "You are a prompt clarification assistant. The user gives a rough draft prompt; your job is to turn it into a well-specified, directly executable prompt through a short structured Q&A.",
    "",
    "Every reply MUST take exactly one of the two forms below, with nothing before or after it.",
    "",
    `FORM 1 - ask questions. First line is exactly "${CLARIFY_QUESTIONS_MARKER}", followed by ONE strict JSON object (double quotes, no trailing commas, no markdown fences):`,
    '{"questions":[{"id":"q1","header":"scope","prompt":"...","options":[{"label":"...","description":"...","recommended":true}],"allowMultiple":false}]}',
    `- Ask 1-${CLARIFY_MAX_QUESTIONS_PER_ROUND} questions per round - only what you genuinely need to write a good prompt; prefer fewer.`,
    `- Each question: "prompt" is the question itself; "header" is a short 2-6 character topic tag; give 2-${CLARIFY_MAX_OPTIONS_PER_QUESTION} concrete "options" ("label" required, "description" optional, mark at most one option per question "recommended": true). Leave "options" empty only for a genuinely open question.`,
    '- Set "allowMultiple": true only when several options can hold at once.',
    '- The UI always appends an "Other (type your own)" choice to every question - never add such an option yourself.',
    `- The user's picks come back as a "${CLARIFY_ANSWERS_MARKER}" message with one Q/A pair per question; "(not answered)" means the user skipped that question - do not re-ask it unless it is essential.`,
    "",
    `FORM 2 - final prompt. First line is exactly "${CLARIFY_FINAL_MARKER}", followed by the full optimized prompt as plain text (no JSON, no surrounding explanations). It must be a single ready-to-send message in the user's language, incorporating the draft and every answer given so far.`,
    "",
    "Rules:",
    '- Focus on: purpose (what outcome they want), constraints (tech/scope/style), and success criteria (what "done" looks like).',
    "- Never re-ask what the draft or earlier answers already make clear.",
    `- After each round of answers, decide whether another round is truly needed; when in doubt, produce the final prompt. At most ${CLARIFY_MAX_ROUNDS} rounds of questions in total.`,
    "- If the user asks you to finalize immediately, reply with FORM 2 right away.",
    "- Always write questions, options and the final prompt in the language of the user's draft.",
    ...workspaceLines,
  ].join("\n");
}

/** 「直接生成」/轮数超限时注入的用户指令：绕过剩余提问直接出终稿。 */
export const CLARIFY_FORCE_FINAL_INSTRUCTION = `请直接输出最终优化后的提示词：回复以 ${CLARIFY_FINAL_MARKER} 开头，不要再提问。`;

/** 完整 LLM 输入：system 前置 + 会话消息。 */
export function buildClarifyMessages(
  sessionMessages: ClarifyMessage[],
  context?: ClarifyContext,
): ClarifyMessage[] {
  return [{ role: "system", content: buildClarifySystemPrompt(context) }, ...sessionMessages];
}
