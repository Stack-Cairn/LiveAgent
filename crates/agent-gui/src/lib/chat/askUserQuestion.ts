// AskUserQuestion 的共享纯逻辑：类型、流式参数容错解析与应答校验。
// 该文件在 agent-gui 与 agent-gateway/web 之间逐字节镜像
// （见 scripts/mirror-manifest.json），因此必须保持零依赖纯数据逻辑。

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export const ASK_USER_QUESTION_MAX_QUESTIONS = 4;
export const ASK_USER_QUESTION_MIN_OPTIONS = 2;
export const ASK_USER_QUESTION_MAX_OPTIONS = 6;
/** 每轮提问的应答窗口：超时后按推荐项（缺省第一项）自动落定继续执行。 */
export const ASK_USER_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * 桌面端在网关上报的工具参数上附带的权威应答截止时间戳（毫秒）。
 * WebUI 卡片倒计时以它对齐桌面计时；模型参数里不存在该键（`__` 前缀防冲突）。
 */
export const ASK_USER_QUESTION_DEADLINE_ARG = "__askUserQuestionDeadlineAt";

export type AskUserQuestionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

export type AskUserQuestionItem = {
  /** 稳定问题 id（缺省按序生成 q1..qN），应答按它对齐。 */
  id: string;
  /** 顶部 tab 的短标签；缺省回退为“问题 N”。 */
  header?: string;
  prompt: string;
  options: AskUserQuestionOption[];
};

export type AskUserQuestionAnswer = {
  questionId: string;
  prompt: string;
  selectedLabel: string;
};

export type AskUserQuestionResultDetails = {
  kind: "ask_user_question";
  questions: AskUserQuestionItem[];
  answers: AskUserQuestionAnswer[];
  cancelled?: boolean;
  /** 应答窗口超时、按推荐项自动落定时为 true。 */
  timedOut?: boolean;
};

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** 读取工具参数上附带的应答截止时间戳（毫秒）；缺失或非法返回 null。 */
export function readAskUserQuestionDeadlineAt(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[ASK_USER_QUESTION_DEADLINE_ARG];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 推荐项固定排在第一位展示；其余选项保持模型给出的顺序。 */
function orderAskUserQuestionOptions(options: AskUserQuestionOption[]) {
  const index = options.findIndex((option) => option.recommended === true);
  if (index <= 0) return options;
  const recommended = options[index];
  return [recommended, ...options.slice(0, index), ...options.slice(index + 1)];
}

/**
 * 流式渲染用的容错解析：tool_call 参数尚在增量拼装时，只保留已经成形的
 * 问题（prompt 非空且至少有一个带 label 的选项），供卡片渐进渲染。
 */
export function sanitizeAskUserQuestionItems(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw)) return [];
  const items: AskUserQuestionItem[] = [];
  for (const [index, value] of raw.entries()) {
    if (items.length >= ASK_USER_QUESTION_MAX_QUESTIONS) break;
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const prompt = normalizeText(record.prompt);
    if (!prompt) continue;

    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(record.options)) {
      for (const optionValue of record.options) {
        if (options.length >= ASK_USER_QUESTION_MAX_OPTIONS) break;
        if (!optionValue || typeof optionValue !== "object") continue;
        const optionRecord = optionValue as Record<string, unknown>;
        const label = normalizeText(optionRecord.label);
        if (!label) continue;
        const option: AskUserQuestionOption = { label };
        const description = normalizeText(optionRecord.description);
        if (description) option.description = description;
        if (optionRecord.recommended === true) option.recommended = true;
        options.push(option);
      }
    }
    if (options.length === 0) continue;

    const item: AskUserQuestionItem = {
      id: normalizeText(record.id) || `q${index + 1}`,
      prompt,
      options: orderAskUserQuestionOptions(options),
    };
    const header = normalizeText(record.header);
    if (header) item.header = header;
    items.push(item);
  }
  return items;
}

/**
 * 工具执行侧的严格校验：参数完整后运行，不合法直接抛错（错误文本回给模型，
 * 引导其修正后重试）。
 */
export function parseAskUserQuestionItems(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("AskUserQuestion requires a non-empty `questions` array.");
  }
  if (raw.length > ASK_USER_QUESTION_MAX_QUESTIONS) {
    throw new Error(
      `AskUserQuestion supports at most ${ASK_USER_QUESTION_MAX_QUESTIONS} questions per call; got ${raw.length}.`,
    );
  }
  const seenIds = new Set<string>();
  let expectedOptionCount = 0;
  return raw.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`AskUserQuestion questions[${index}] must be an object.`);
    }
    const record = value as Record<string, unknown>;
    const prompt = normalizeText(record.prompt);
    if (!prompt) {
      throw new Error(`AskUserQuestion questions[${index}].prompt must be a non-empty string.`);
    }
    if (!Array.isArray(record.options)) {
      throw new Error(`AskUserQuestion questions[${index}].options must be an array.`);
    }
    if (
      record.options.length < ASK_USER_QUESTION_MIN_OPTIONS ||
      record.options.length > ASK_USER_QUESTION_MAX_OPTIONS
    ) {
      throw new Error(
        `AskUserQuestion questions[${index}] needs ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} options; got ${record.options.length}.`,
      );
    }
    // 同一轮里各问题的选项数必须一致，保证卡片切 tab 时布局稳定。
    if (index === 0) {
      expectedOptionCount = record.options.length;
    } else if (record.options.length !== expectedOptionCount) {
      throw new Error(
        `AskUserQuestion requires every question in one call to have the same number of options; questions[0] has ${expectedOptionCount} while questions[${index}] has ${record.options.length}.`,
      );
    }

    const labels = new Set<string>();
    let recommendedCount = 0;
    const options = record.options.map((optionValue, optionIndex) => {
      if (!optionValue || typeof optionValue !== "object") {
        throw new Error(
          `AskUserQuestion questions[${index}].options[${optionIndex}] must be an object.`,
        );
      }
      const optionRecord = optionValue as Record<string, unknown>;
      const label = normalizeText(optionRecord.label);
      if (!label) {
        throw new Error(
          `AskUserQuestion questions[${index}].options[${optionIndex}].label must be a non-empty string.`,
        );
      }
      if (labels.has(label)) {
        throw new Error(
          `AskUserQuestion questions[${index}] has duplicate option label: ${label}.`,
        );
      }
      labels.add(label);
      const option: AskUserQuestionOption = { label };
      const description = normalizeText(optionRecord.description);
      if (description) option.description = description;
      if (optionRecord.recommended === true) {
        recommendedCount += 1;
        option.recommended = true;
      }
      return option;
    });
    if (recommendedCount > 1) {
      throw new Error(
        `AskUserQuestion questions[${index}] may mark at most one option as recommended; got ${recommendedCount}.`,
      );
    }

    const id = normalizeText(record.id) || `q${index + 1}`;
    if (seenIds.has(id)) {
      throw new Error(`AskUserQuestion has duplicate question id: ${id}.`);
    }
    seenIds.add(id);

    const item: AskUserQuestionItem = {
      id,
      prompt,
      options: orderAskUserQuestionOptions(options),
    };
    const header = normalizeText(record.header);
    if (header) item.header = header;
    return item;
  });
}

/** 超时兜底：每题取推荐项，无推荐项时取第一项。 */
export function buildDefaultAskUserQuestionAnswers(
  questions: AskUserQuestionItem[],
): AskUserQuestionAnswer[] {
  return questions.map((question) => {
    const fallback =
      question.options.find((option) => option.recommended === true) ?? question.options[0];
    return {
      questionId: question.id,
      prompt: question.prompt,
      selectedLabel: fallback?.label ?? "",
    };
  });
}

/** 解析用户应答（本地卡片提交或远端 request_json），并对齐到问题定义。 */
export function resolveAskUserQuestionAnswers(
  questions: AskUserQuestionItem[],
  raw: unknown,
): AskUserQuestionAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const selectedByQuestionId = new Map<string, string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const questionId = normalizeText(record.questionId);
    const selectedLabel = normalizeText(record.selectedLabel);
    if (questionId && selectedLabel) {
      selectedByQuestionId.set(questionId, selectedLabel);
    }
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const question of questions) {
    const selectedLabel = selectedByQuestionId.get(question.id);
    if (!selectedLabel) return null;
    if (!question.options.some((option) => option.label === selectedLabel)) return null;
    answers.push({ questionId: question.id, prompt: question.prompt, selectedLabel });
  }
  return answers;
}

export function parseAskUserQuestionResultDetails(
  details: unknown,
): AskUserQuestionResultDetails | null {
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (record.kind !== "ask_user_question") return null;
  const questions = sanitizeAskUserQuestionItems(record.questions);
  const answers: AskUserQuestionAnswer[] = [];
  if (Array.isArray(record.answers)) {
    for (const value of record.answers) {
      if (!value || typeof value !== "object") continue;
      const answerRecord = value as Record<string, unknown>;
      const questionId = normalizeText(answerRecord.questionId);
      const selectedLabel = normalizeText(answerRecord.selectedLabel);
      if (!questionId || !selectedLabel) continue;
      answers.push({
        questionId,
        prompt: normalizeText(answerRecord.prompt),
        selectedLabel,
      });
    }
  }
  return {
    kind: "ask_user_question",
    questions,
    answers,
    cancelled: record.cancelled === true,
    timedOut: record.timedOut === true,
  };
}

export function buildAskUserQuestionResultText(
  answers: AskUserQuestionAnswer[],
  options?: { timedOut?: boolean },
) {
  const heading = options?.timedOut
    ? "The user did not answer within the time limit; the recommended (or first) option was auto-selected for every question. Proceed accordingly:"
    : "The user answered every question. Their selections are final — proceed accordingly:";
  return [
    heading,
    ...answers.map(
      (answer, index) => `${index + 1}. ${answer.prompt}\n   → ${answer.selectedLabel}`,
    ),
  ].join("\n");
}
