// AskUserQuestion 的共享纯逻辑：类型、流式参数容错解析与应答校验。
// 该共享模块必须保持零依赖纯数据逻辑。

export const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
/**
 * K-brain 代理自带的提问工具（Stack-Cairn/K-brain#162）。它与 AskUserQuestion 走同一个
 * question.requested 事件，但参数用 `question` 而不是 `prompt`、有单问题写法，结果是纯文本。
 * 接入层把它规范成 AskUserQuestion，界面只认一种卡片。
 */
export const KBRAIN_QUESTION_TOOL_NAME = "question";
/** 多选题合成应答时各选项的分隔符，与 K-brain 拼接多选标签的写法一致。 */
export const ASK_USER_QUESTION_MULTI_SEPARATOR = ", ";

export const ASK_USER_QUESTION_MAX_QUESTIONS = 4;
export const ASK_USER_QUESTION_MIN_OPTIONS = 2;
export const ASK_USER_QUESTION_MAX_OPTIONS = 6;
/** 每轮提问的应答窗口：超时后按推荐项（缺省第一项）自动落定继续执行。 */
export const ASK_USER_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;
/** UI 合成"其他（自行输入）"应答的最大长度；超出部分截断。 */
export const ASK_USER_QUESTION_CUSTOM_MAX_LENGTH = 2000;
/**
 * 桌面端在网关上报的工具参数上附带的权威应答截止时间戳（毫秒）。
 * WebUI 卡片倒计时以它对齐桌面计时；模型参数里不存在该键（`__` 前缀防冲突）。
 */
export const ASK_USER_QUESTION_DEADLINE_ARG = "__askUserQuestionDeadlineAt";
/**
 * 桌面端在网关上报的工具参数上附带的“提问确已挂起”标记。工具调用事件先于
 * 提问登记到达（K-brain 的 AI 审查或审批门可能夹在中间），WebUI 卡片据此
 * 只在桌面端真有挂起提问时可作答。
 */
export const ASK_USER_QUESTION_PENDING_ARG = "__askUserQuestionPending";

/**
 * K-brain question 工具调用的原始参数：调用改名 AskUserQuestion 显示时留一份，
 * 转写的对话再交给 K-brain（用本地历史新建会话）时还原成模型真正调用的工具。
 */
export const KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG = "__kbrainQuestionArguments";

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
  /** 可多选（K-brain question 工具的 multiple）。 */
  multiple?: boolean;
};

export type AskUserQuestionAnswer = {
  questionId: string;
  prompt: string;
  /**
   * 发给后端的应答文本。单选为所选 label 或自行输入的原文；多选为各项按
   * ASK_USER_QUESTION_MULTI_SEPARATOR 拼接（自行输入的文本排在最后）。
   */
  selectedLabel: string;
  /** 应答含用户自行输入的文本（单选时 selectedLabel 即原文）。 */
  custom?: boolean;
  /** 多选题选中的列出选项，按选项顺序。 */
  selectedLabels?: string[];
  /** 多选题里与选项并列的自行输入文本。 */
  customText?: string;
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

/** 读取参数上的挂起标记；旧版桌面端不盖章，缺失返回 null。 */
export function readAskUserQuestionPendingMarker(args: unknown): boolean | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[ASK_USER_QUESTION_PENDING_ARG];
  return typeof value === "boolean" ? value : null;
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
    const prompt = normalizeText(record.prompt) || normalizeText(record.question);
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
    if (record.multiple === true) item.multiple = true;
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
    if (record.multiple === true) item.multiple = true;
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

function normalizeCustomText(value: unknown) {
  return normalizeText(value).slice(0, ASK_USER_QUESTION_CUSTOM_MAX_LENGTH);
}

/** 多选题应答：选中的列出选项按选项顺序排列，自行输入的文本排最后拼成 selectedLabel。 */
export function buildMultiSelectAnswer(
  question: AskUserQuestionItem,
  labels: readonly string[],
  customText = "",
): AskUserQuestionAnswer {
  const chosen = new Set(labels);
  const ordered = question.options
    .map((option) => option.label)
    .filter((label) => chosen.has(label));
  const text = customText.trim().slice(0, ASK_USER_QUESTION_CUSTOM_MAX_LENGTH);
  return {
    questionId: question.id,
    prompt: question.prompt,
    selectedLabel: [...ordered, ...(text ? [text] : [])]
      .join(ASK_USER_QUESTION_MULTI_SEPARATOR)
      .slice(0, ASK_USER_QUESTION_CUSTOM_MAX_LENGTH),
    selectedLabels: ordered,
    ...(text ? { custom: true, customText: text } : {}),
  };
}

/**
 * 把后端回传的一条多选应答拆回各选项：K-brain 只认一条 selected_label，多选按
 * ASK_USER_QUESTION_MULTI_SEPARATOR 拼接。选项 label 自身可能含分隔符，按最长匹配；
 * 匹配不上的片段视为自行输入的文本。
 */
function splitMultiSelection(question: AskUserQuestionItem, text: string) {
  const listed = new Set(question.options.map((option) => option.label));
  if (listed.has(text)) return { labels: [text], rest: "" };
  const parts = text.split(ASK_USER_QUESTION_MULTI_SEPARATOR);
  const labels: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < parts.length; ) {
    let end = parts.length;
    while (
      end > index &&
      !listed.has(parts.slice(index, end).join(ASK_USER_QUESTION_MULTI_SEPARATOR))
    )
      end -= 1;
    if (end > index) {
      labels.push(parts.slice(index, end).join(ASK_USER_QUESTION_MULTI_SEPARATOR));
      index = end;
    } else {
      rest.push(parts[index]);
      index += 1;
    }
  }
  return { labels, rest: rest.join(ASK_USER_QUESTION_MULTI_SEPARATOR).trim() };
}

/**
 * 按问题定义解读后端回传的一条应答文本（question.resolved 或 question 工具的结果）：
 * 多选题拆回选项，单选题不是列出选项时按自行输入处理。空文本返回 null。
 */
export function interpretAskUserQuestionAnswer(
  question: AskUserQuestionItem,
  selectedLabel: unknown,
  custom = false,
): AskUserQuestionAnswer | null {
  const text = normalizeText(selectedLabel);
  if (!text) return null;
  if (question.multiple) {
    const { labels, rest } = splitMultiSelection(question, text);
    return { ...buildMultiSelectAnswer(question, labels, rest), selectedLabel: text };
  }
  const listed = question.options.some((option) => option.label === text);
  return {
    questionId: question.id,
    prompt: question.prompt,
    selectedLabel: text,
    ...(custom || !listed ? { custom: true } : {}),
  };
}

function resolveSingleAnswer(
  question: AskUserQuestionItem,
  record: Record<string, unknown>,
): AskUserQuestionAnswer | null {
  if (record.custom === true) {
    const selectedLabel = normalizeCustomText(record.selectedLabel);
    if (!selectedLabel) return null;
    return { questionId: question.id, prompt: question.prompt, selectedLabel, custom: true };
  }
  const selectedLabel = normalizeText(record.selectedLabel);
  if (!question.options.some((option) => option.label === selectedLabel)) return null;
  return { questionId: question.id, prompt: question.prompt, selectedLabel };
}

function resolveMultiAnswer(
  question: AskUserQuestionItem,
  record: Record<string, unknown>,
): AskUserQuestionAnswer | null {
  if (!Array.isArray(record.selectedLabels)) {
    // 只带一条 selectedLabel 的旧格式：按拼接规则拆回选项。
    const text =
      record.custom === true
        ? normalizeCustomText(record.selectedLabel)
        : normalizeText(record.selectedLabel);
    const answer = interpretAskUserQuestionAnswer(question, text, record.custom === true);
    if (!answer) return null;
    if (record.custom !== true && answer.custom) return null;
    return answer;
  }
  const listed = new Set(question.options.map((option) => option.label));
  const labels: string[] = [];
  for (const value of record.selectedLabels) {
    const label = normalizeText(value);
    if (!label) continue;
    if (!listed.has(label)) return null;
    if (!labels.includes(label)) labels.push(label);
  }
  const customText = normalizeCustomText(record.customText);
  if (labels.length === 0 && !customText) return null;
  return buildMultiSelectAnswer(question, labels, customText);
}

/** 解析用户应答（本地卡片提交或远端 request_json），并对齐到问题定义。 */
export function resolveAskUserQuestionAnswers(
  questions: AskUserQuestionItem[],
  raw: unknown,
): AskUserQuestionAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const recordByQuestionId = new Map<string, Record<string, unknown>>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const questionId = normalizeText(record.questionId);
    if (questionId) recordByQuestionId.set(questionId, record);
  }

  const answers: AskUserQuestionAnswer[] = [];
  for (const question of questions) {
    const record = recordByQuestionId.get(question.id);
    if (!record) return null;
    const answer = question.multiple
      ? resolveMultiAnswer(question, record)
      : resolveSingleAnswer(question, record);
    if (!answer) return null;
    answers.push(answer);
  }
  return answers;
}

/**
 * K-brain /v1 的应答一题只有一条 selected_label，且不是列出选项时必须标 custom，
 * 否则后端拒收。多选题选了不止一项时拼接后的文本不是列出选项，因此也标 custom。
 */
export function askUserQuestionAnswerIsCustomForBackend(answer: AskUserQuestionAnswer): boolean {
  return answer.custom === true || (answer.selectedLabels?.length ?? 0) > 1;
}

function readAnswerRecord(
  value: unknown,
  questionById: Map<string, AskUserQuestionItem>,
): AskUserQuestionAnswer | null {
  if (!value || typeof value !== "object") return null;
  const answerRecord = value as Record<string, unknown>;
  const questionId = normalizeText(answerRecord.questionId);
  const selectedLabel = normalizeText(answerRecord.selectedLabel);
  if (!questionId || !selectedLabel) return null;
  const prompt = normalizeText(answerRecord.prompt);
  const custom = answerRecord.custom === true;
  if (Array.isArray(answerRecord.selectedLabels)) {
    const selectedLabels = answerRecord.selectedLabels
      .map((label) => normalizeText(label))
      .filter(Boolean);
    const customText = normalizeText(answerRecord.customText);
    return {
      questionId,
      prompt,
      selectedLabel,
      selectedLabels,
      ...(custom ? { custom: true } : {}),
      ...(customText ? { customText } : {}),
    };
  }
  const question = questionById.get(questionId);
  if (question?.multiple) {
    const answer = interpretAskUserQuestionAnswer(question, selectedLabel, custom);
    if (answer) return { ...answer, prompt: prompt || answer.prompt };
  }
  return { questionId, prompt, selectedLabel, ...(custom ? { custom: true } : {}) };
}

export function parseAskUserQuestionResultDetails(
  details: unknown,
): AskUserQuestionResultDetails | null {
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (record.kind !== "ask_user_question") return null;
  const questions = sanitizeAskUserQuestionItems(record.questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const answers: AskUserQuestionAnswer[] = [];
  if (Array.isArray(record.answers)) {
    for (const value of record.answers) {
      const answer = readAnswerRecord(value, questionById);
      if (answer) answers.push(answer);
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

/**
 * K-brain question 工具的参数规范成 AskUserQuestion 的形状：单问题写法
 * （question/options/multiple）包成一题，每题 `question` 改名 `prompt`，id 缺省 q1…，
 * 与 K-brain 发给 /v1 的 question.requested 一致。`__` 前缀的合成参数原样保留。
 */
export function normalizeKBrainQuestionToolArguments(args: unknown): Record<string, unknown> {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("__")) out[key] = value;
  }
  const raw =
    Array.isArray(record.questions) && record.questions.length > 0
      ? record.questions
      : [{ question: record.question, options: record.options, multiple: record.multiple }];
  out.questions = raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { question, ...rest } = value as Record<string, unknown>;
    return {
      ...rest,
      id: normalizeText(rest.id) || `q${index + 1}`,
      prompt: normalizeText(question) || normalizeText(rest.prompt),
    };
  });
  return out;
}

const QUESTION_TOOL_NO_ANSWER = "(no answer)";

/** 读 question 工具结果文本里每题的应答（K-brain tools.AskAnswerText 的两种写法）。 */
function readQuestionToolAnswerTexts(
  questions: AskUserQuestionItem[],
  output: string,
): string[] | null {
  const text = output.trim();
  const single = "User answered ";
  if (text.startsWith(single)) {
    const exact = `${single}"${questions[0]?.prompt ?? ""}": `;
    const start = text.startsWith(exact) ? exact.length : text.indexOf('": ') + 3;
    if (start < 3) return null;
    return [text.slice(start).trim()];
  }
  if (!text.startsWith("The user answered:")) return null;
  const answers: string[] = questions.map(() => "");
  let current = -1;
  let inAnswer = false;
  for (const line of text.split("\n").slice(1)) {
    const heading = /^(\d+)\. /.exec(line);
    if (heading && !inAnswer) {
      current = Number(heading[1]) - 1;
      continue;
    }
    const answer = /^ {3}→ ?(.*)$/.exec(line);
    if (answer && current >= 0 && current < answers.length) {
      answers[current] = answer[1];
      inAnswer = true;
      continue;
    }
    if (heading) {
      current = Number(heading[1]) - 1;
      inAnswer = false;
      continue;
    }
    if (inAnswer && current >= 0 && current < answers.length) answers[current] += `\n${line}`;
  }
  return answers.map((answer) => (answer.trim() === QUESTION_TOOL_NO_ANSWER ? "" : answer.trim()));
}

/**
 * K-brain question 工具的结果（纯文本）还原成提问卡的落定详情：历史回放里没有
 * question.resolved 事件，只能从结果文本和调用参数读。用户关掉提问时工具失败，
 * 卡片显示已取消；所有题都没有应答（超时）时显示超时未选择。
 */
export function parseKBrainQuestionToolResult(
  args: unknown,
  output: string,
  isError: boolean,
): AskUserQuestionResultDetails | null {
  const questions = sanitizeAskUserQuestionItems(
    normalizeKBrainQuestionToolArguments(args).questions,
  );
  if (questions.length === 0) return null;
  if (isError) {
    return /dismissed the question|stopped the turn|cancel/i.test(output)
      ? { kind: "ask_user_question", questions, answers: [], cancelled: true }
      : null;
  }
  const texts = readQuestionToolAnswerTexts(questions, output);
  if (!texts) return null;
  const answers = questions.flatMap((question, index) => {
    const answer = texts[index] ? interpretAskUserQuestionAnswer(question, texts[index]) : null;
    return answer ? [answer] : [];
  });
  return {
    kind: "ask_user_question",
    questions,
    answers,
    ...(answers.length === 0 ? { timedOut: true } : {}),
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
      (answer, index) =>
        `${index + 1}. ${answer.prompt}\n   → ${answer.selectedLabel}${
          answer.custom ? ' (user-typed answer via "Other", not a listed option)' : ""
        }`,
    ),
  ].join("\n");
}
