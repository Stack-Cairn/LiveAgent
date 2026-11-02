import type {
  MentionComposerDraft,
  MentionComposerSkill,
} from "@liveagent/ui/components/chat/MentionComposerModel";

/* ------------------------------------------------------------------ */
/*  Host contract                                                      */
/* ------------------------------------------------------------------ */

/**
 * 后端目录里的一条指令（GUI 直连 K-brain 的 GET /v1/commands，WebUI 经 Gateway
 * 转发）。action 由输入框按名称处理，prompt 原样发送、由后端展开。
 */
export type ComposerCatalogCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "action" | "prompt";
  source: string;
};

/** “/”指令带来的单轮语义，随发送一路传给运行层。 */
export type ComposerTurnCommand =
  | { kind: "plan" }
  | { kind: "goal"; action: "set"; goal: string }
  | { kind: "goal"; action: "resume" }
  | { kind: "prompt" };

/** /loop 列表里的一项：当前会话上按间隔重复发送的提示词。 */
export type ComposerLoopEntry = {
  id: string;
  interval: string;
  prompt: string;
  enabled: boolean;
};

/**
 * 输入框“/”指令的宿主接口。每个动作都是可选方法：宿主不提供时对应指令不出现
 * 在弹层里，也不拦截发送。不传 commandHost 时输入框只有 Skill 弹层。
 */
export interface ComposerCommandHost {
  /** 后端指令目录；不提供时只有 Skill。 */
  listCommands?: () => Promise<readonly ComposerCatalogCommand[]>;
  /**
   * 发送一轮带指令语义的消息。text 是转录区里的用户消息；planMode 只作用于
   * 这一轮（/plan 任务）。
   */
  sendTurn?: (
    text: string,
    command?: ComposerTurnCommand,
    options?: { planMode?: boolean; draft?: MentionComposerDraft },
  ) => unknown;
  /**
   * sendTurn 能带上草稿的结构化上下文（options.draft 里的会话引用、大段粘贴）和
   * 输入框的待上传附件。不声明时，带这些内容的指令会报错并保留草稿，不会静默丢弃。
   */
  carriesComposerContext?: boolean;
  /**
   * 输入框正在编辑某条排队消息时返回 true：草稿属于那条排队项，发送走保存编辑，
   * 不按指令执行。
   */
  isDraftReserved?: () => boolean;
  /**
   * 把不经过模型的指令（/loop、/goal clear）和结果作为一问一答写进当前会话，
   * 转录区里显示，之后的对话也能看到。不提供或写入失败时退回输入框上方的面板。
   */
  recordCommandResult?: (command: string, result: string) => Promise<void>;
  /** /goal clear：清除当前会话目标。 */
  clearGoal?: () => unknown;
  /** /goal pause：暂停当前会话目标；不提供时 /goal pause 报不支持。 */
  pauseGoal?: () => unknown;
  /** /plan 不带任务：打开计划模式。ChatComposerBar 会用运行时开关补上。 */
  enablePlanMode?: () => void;
  /** /compact：手动压缩当前会话。 */
  compact?: () => unknown;
  /** /model 无参数时打开模型选择；ChatComposerBar 会用自己的模型弹层补上。 */
  openModelPicker?: () => void;
  /** /model 名称：按名称切换模型。 */
  selectModel?: (name: string) => unknown;
  /**
   * /rewind：回退最近一轮 Agent 的文件改动（沿用行内回退的预览、确认与冲突
   * 检测）。ChatComposerBar 会按会话 id 自动补上。
   */
  rewindLastTurn?: () => unknown;
  /** /loop：在当前会话上按间隔重复发送提示词。 */
  loops?: {
    create: (interval: string, prompt: string) => Promise<ComposerLoopEntry>;
    list: () => Promise<readonly ComposerLoopEntry[]>;
    cancel: (id: string) => Promise<void>;
  };
}

/**
 * /model 名称：先按显示名或模型 id 精确匹配，再不区分大小写匹配；匹配不到
 * 抛错，由指令面板展示。宿主据此实现 selectModel。
 */
export function findModelOptionByName<T extends { label: string; model: string }>(
  options: readonly T[],
  rawName: string,
  notFoundMessage: string,
): T {
  const name = rawName.trim();
  const exact = options.find((option) => option.label === name || option.model === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const loose = options.find(
    (option) => option.label.toLowerCase() === lower || option.model.toLowerCase() === lower,
  );
  if (loose) return loose;
  throw new Error(`${notFoundMessage}: ${name}`);
}

/** "10m" → "每 10 分钟" 这类可读间隔；认不出的写法原样返回。 */
export function describeLoopInterval(interval: string, t: (key: string) => string): string {
  const match = /^(\d+)([mhd])$/i.exec(interval.trim());
  if (!match) return interval;
  const key =
    match[2].toLowerCase() === "m"
      ? "chat.commands.loopEveryMinutes"
      : match[2].toLowerCase() === "h"
        ? "chat.commands.loopEveryHours"
        : "chat.commands.loopEveryDays";
  return t(key).replace("{count}", match[1]);
}

/** Validate syntax only; K-brain owns elapsed scheduling and the minimum interval. */
export function normalizeLoopInterval(interval: string): string | null {
  const match = /^(\d+)([smhd])$/i.exec(interval.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const seconds = value * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 0);
  return Number.isSafeInteger(value) && value > 0 && seconds <= 604800 ? `${value}${unit}` : null;
}
/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export type ComposerActionId = "goal" | "loop" | "plan" | "compact" | "model" | "rewind";

/** 弹层分组；后端内置的提示词（/init、/review）归入“指令”组。 */
export type ComposerCommandGroup = "commands" | "prompts" | "skills";

export type ComposerActionCommand = {
  kind: "action";
  id: ComposerActionId;
  name: string;
  description: string;
  argumentHint?: string;
  group: "commands";
};

export type ComposerPromptCommand = {
  kind: "prompt";
  name: string;
  description: string;
  argumentHint?: string;
  source: string;
  group: "commands" | "prompts";
};

export type ComposerSkillCommand = {
  kind: "skill";
  name: string;
  description: string;
  skill: MentionComposerSkill;
  group: "skills";
};

export type ComposerCommand = ComposerActionCommand | ComposerPromptCommand | ComposerSkillCommand;

/** 输入框能处理的动作，以及各自要求宿主提供的能力。 */
const ACTION_AVAILABILITY: Record<ComposerActionId, (host: ComposerCommandHost) => boolean> = {
  goal: (host) => Boolean(host.sendTurn && host.clearGoal),
  loop: (host) => Boolean(host.loops),
  plan: (host) => Boolean(host.sendTurn && host.enablePlanMode),
  compact: (host) => Boolean(host.compact),
  model: (host) => Boolean(host.openModelPicker || host.selectModel),
  rewind: (host) => Boolean(host.rewindLastTurn),
};

function isActionId(name: string): name is ComposerActionId {
  return Object.hasOwn(ACTION_AVAILABILITY, name);
}

/**
 * 输入框自己处理的动作指令名。发送时按资源路径解析 Skill 引用要跳过这些名字，
 * 免得“/compact”这类草稿被当成同名 Skill。
 */
export const COMPOSER_ACTION_COMMAND_NAMES: readonly string[] = Object.keys(ACTION_AVAILABILITY);

/** 与 Skill 提及同一字符集，保证指令名在两条解析路径上切分一致。 */
export function isComposerCommandName(name: string) {
  return /^[A-Za-z0-9_:-]+$/.test(name);
}

/**
 * 合并后端目录与 Skill。目录顺序由后端决定，输入框处理不了或宿主没提供能力
 * 的动作直接丢弃；Skill 与指令重名时让给指令（不区分大小写）。
 */
export function buildComposerCommands(params: {
  host: ComposerCommandHost | null | undefined;
  catalog?: readonly ComposerCatalogCommand[];
  skills: readonly MentionComposerSkill[];
  /** 界面语言的翻译函数；后端内置指令的说明与参数提示据此本地化。 */
  t?: (key: string) => string;
}): ComposerCommand[] {
  const { host } = params;
  // 后端只给英文；内置指令按名称取本地文案，缺失时（t 原样返回 key）沿用后端文本。
  // 用户自己的提示词模板保留作者写的描述。
  const localized = (entry: ComposerCatalogCommand, field: "description" | "hint") => {
    if (entry.source !== "builtin" || !params.t) return undefined;
    const key = `chat.commands.builtin.${entry.name}.${field}`;
    const text = params.t(key);
    return text && text !== key ? text : undefined;
  };
  const taken = new Set<string>();
  const commands: ComposerCommand[] = [];
  if (host) {
    for (const entry of params.catalog ?? []) {
      const name = entry.name.trim();
      const key = name.toLowerCase();
      if (!isComposerCommandName(name) || taken.has(key)) continue;
      const base = {
        name,
        description: localized(entry, "description") ?? entry.description?.trim() ?? "",
        argumentHint: localized(entry, "hint") ?? (entry.argumentHint?.trim() || undefined),
      };
      if (entry.kind === "action") {
        if (!isActionId(name) || !ACTION_AVAILABILITY[name](host)) continue;
        commands.push({ ...base, kind: "action", id: name, group: "commands" });
      } else {
        if (!host.sendTurn) continue;
        commands.push({
          ...base,
          kind: "prompt",
          source: entry.source,
          group: entry.source === "builtin" ? "commands" : "prompts",
        });
      }
      taken.add(key);
    }
  }
  for (const skill of params.skills) {
    const key = skill.name.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    commands.push({
      kind: "skill",
      name: skill.name,
      description: skill.description,
      skill,
      group: "skills",
    });
  }
  return commands;
}

const GROUP_ORDER: Record<ComposerCommandGroup, number> = { commands: 0, prompts: 1, skills: 2 };

/** 弹层里输入“/skill:”后只匹配 Skill；发送时 “/skill:名称” 也按 Skill 引用解析。 */
export const SKILL_COMMAND_PREFIX = "skill:";

/**
 * 弹层过滤：按分组排序，组内名称前缀命中排在包含命中之前。查询以 “skill:”
 * 开头时只在 Skill 里按其后的文字过滤。
 */
export function filterComposerCommands(
  commands: readonly ComposerCommand[],
  rawQuery: string,
  limit: number,
): ComposerCommand[] {
  let query = rawQuery.trim().toLowerCase();
  const skillsOnly = query.startsWith(SKILL_COMMAND_PREFIX);
  if (skillsOnly) query = query.slice(SKILL_COMMAND_PREFIX.length);
  const scored: { command: ComposerCommand; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    if (skillsOnly && command.kind !== "skill") return;
    const name = command.name.toLowerCase();
    let rank: number;
    if (!query || name.startsWith(query)) rank = 0;
    else if (`${name}\n${command.description}`.toLowerCase().includes(query)) rank = 1;
    else return;
    scored.push({ command, rank, index });
  });
  scored.sort(
    (a, b) =>
      GROUP_ORDER[a.command.group] - GROUP_ORDER[b.command.group] ||
      a.rank - b.rank ||
      a.index - b.index,
  );
  return scored.slice(0, limit).map((item) => item.command);
}
/* ------------------------------------------------------------------ */
/*  Draft parsing                                                      */
/* ------------------------------------------------------------------ */

export type RunnableComposerCommand = ComposerActionCommand | ComposerPromptCommand;

export type ParsedComposerCommand = {
  command: RunnableComposerCommand;
  args: string;
  /** 去掉首尾空白后的整段草稿；提示词指令按它原样发送。 */
  text: string;
};

const COMMAND_DRAFT_PATTERN = /^\/([A-Za-z0-9_:-]+)(?:\s+([\s\S]*))?$/;

/**
 * 草稿以已注册的动作/提示词指令开头时返回指令与参数。Skill、未知指令和
 * 路径（指令名后紧跟另一个斜杠）返回 null，照常发送。
 */
export function parseComposerCommandDraft(
  text: string,
  commands: readonly ComposerCommand[],
): ParsedComposerCommand | null {
  const trimmed = text.trim();
  const match = COMMAND_DRAFT_PATTERN.exec(trimmed);
  if (!match) return null;
  const name = match[1].toLowerCase();
  for (const command of commands) {
    if (command.kind === "skill") continue;
    if (command.name.toLowerCase() === name) {
      // 发送前把指令名统一成目录里的写法：后端按原样（区分大小写）查找用户模板。
      const text = `/${command.name}${trimmed.slice(match[1].length + 1)}`;
      return { command, args: (match[2] ?? "").trim(), text };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Execution                                                          */
/* ------------------------------------------------------------------ */

/** composer 上方的本地面板内容；不进入转录区，也不发给模型。 */
export type ComposerCommandPanelState =
  | { type: "loops"; loops: readonly ComposerLoopEntry[] }
  | { type: "loopCreated"; loop: ComposerLoopEntry }
  | { type: "notice"; message: string }
  // command：出错的指令名（不带"/"），界面上单独显示为标签，文案里不再重复。
  // tone "warning"：会话忙这类可恢复的提醒，不按失败的红色显示。
  | { type: "error"; message: string; command?: string; tone?: "warning" };

export type ComposerCommandEffects = {
  host: ComposerCommandHost;
  t: (key: string) => string;
  /** 指令被接受、开始执行前移除草稿；用法错误时保留草稿让用户改。 */
  consumeDraft: () => void;
  /** 执行失败（含发送被拒）时把移除的草稿放回输入框；输入框已有新内容时不覆盖。 */
  restoreDraft?: () => void;
  /** 发送前的草稿快照，带会话引用、大段粘贴等结构化内容。 */
  draft?: MentionComposerDraft;
  showPanel: (panel: ComposerCommandPanelState) => void;
};

/** 定时任务的纯文本描述，写进会话用。 */
function describeLoops(loops: readonly ComposerLoopEntry[], t: (key: string) => string) {
  if (loops.length === 0) return t("chat.commands.loopsEmpty");
  return [
    t("chat.commands.loopsTitle"),
    ...loops.map(
      (loop) =>
        `- \`${loop.id}\` · ${describeLoopInterval(loop.interval, t)} · ${loop.prompt}${loop.enabled ? "" : " (disabled)"}`,
    ),
  ].join("\n");
}

function describeCreatedLoop(loop: ComposerLoopEntry, t: (key: string) => string) {
  return [
    t("chat.commands.loopCreated"),
    `- ${t("chat.commands.loopInterval")}: ${describeLoopInterval(loop.interval, t)}`,
    `- ${t("chat.commands.loopPrompt")}: ${loop.prompt}`,
    `${t("chat.commands.loopHint")} \`/loop cancel ${loop.id}\``,
  ].join("\n");
}

/** 结果优先写进会话；宿主不支持或写入失败时显示在输入框上方。 */
async function report(
  text: string,
  result: string,
  panel: ComposerCommandPanelState,
  effects: ComposerCommandEffects,
) {
  if (effects.host.recordCommandResult) {
    try {
      await effects.host.recordCommandResult(text, result);
      return;
    } catch {
      // 例如这一轮还在运行：结果仍显示给用户，只是不进历史。
    }
  }
  effects.showPanel(panel);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runLoop(text: string, args: string, effects: ComposerCommandEffects) {
  const { host, t } = effects;
  const loops = host.loops;
  if (!loops) return;
  const [head = "", ...rest] = args.split(/\s+/);
  if (head === "list") {
    effects.consumeDraft();
    const list = await loops.list();
    await report(text, describeLoops(list, t), { type: "loops", loops: list }, effects);
    return;
  }
  if (head === "cancel") {
    const id = rest.join(" ").trim();
    if (!id) throw new Error(t("chat.commands.loopUsage"));
    effects.consumeDraft();
    await loops.cancel(id);
    const message = `${t("chat.commands.loopCancelled")}: ${id}`;
    await report(text, message, { type: "notice", message }, effects);
    return;
  }
  const prompt = args.slice(head.length).trim();
  const interval = normalizeLoopInterval(head);
  if (!interval || !prompt) throw new Error(t("chat.commands.loopUsage"));
  effects.consumeDraft();
  const loop = await loops.create(interval, prompt);
  await report(text, describeCreatedLoop(loop, t), { type: "loopCreated", loop }, effects);
}

/** 草稿里发送时只能经结构化通道带上的内容；纯文本发送会丢掉它们。 */
function draftHasStructuredContext(draft: MentionComposerDraft | undefined) {
  if (!draft) return false;
  return (
    draft.largePastes.length > 0 ||
    (draft.conversationMentions?.length ?? 0) > 0 ||
    draft.segments.some(
      (segment) => segment.type === "largePaste" || segment.type === "conversationMention",
    )
  );
}

/** 把草稿开头的指令名换成目录里的写法（与 parsed.text 一致）。 */
function draftWithCommandName(draft: MentionComposerDraft, name: string): MentionComposerDraft {
  const rename = (text: string) => text.replace(/^(\s*)\/[A-Za-z0-9_:-]+/, `$1/${name}`);
  const index = draft.segments.findIndex(
    (segment) => segment.type !== "text" || segment.text.trim() !== "",
  );
  const first = draft.segments[index];
  if (!first || first.type !== "text") return draft;
  const segments = [...draft.segments];
  segments[index] = { type: "text", text: rename(first.text) };
  return {
    ...draft,
    segments,
    text: rename(draft.text),
    textWithoutLargePastes: rename(draft.textWithoutLargePastes),
  };
}

/**
 * 经 sendTurn 发出一轮。草稿带会话引用或大段粘贴时，宿主能带上就随 options.draft
 * 一起交给它；带不上（或 /goal 这类后端只收纯文本的指令）就报错，草稿由调用方放回。
 */
async function sendCommandTurn(
  parsed: ParsedComposerCommand,
  command: ComposerTurnCommand | undefined,
  options: { planMode?: boolean },
  effects: ComposerCommandEffects,
) {
  const { host, t } = effects;
  if (!host.sendTurn) return;
  const structured = draftHasStructuredContext(effects.draft);
  if (structured && (!host.carriesComposerContext || command?.kind === "goal")) {
    throw new Error(t("chat.commands.contextUnsupported"));
  }
  const draft =
    host.carriesComposerContext && effects.draft
      ? draftWithCommandName(effects.draft, parsed.command.name)
      : undefined;
  const sendOptions = { ...options, ...(draft ? { draft } : {}) };
  effects.consumeDraft();
  if (Object.keys(sendOptions).length > 0) await host.sendTurn(parsed.text, command, sendOptions);
  else await host.sendTurn(parsed.text, command);
}

async function runAction(
  parsed: ParsedComposerCommand,
  id: ComposerActionId,
  effects: ComposerCommandEffects,
) {
  const { host, t } = effects;
  const { args } = parsed;
  switch (id) {
    case "goal": {
      if (!args) throw new Error(t("chat.commands.goalUsage"));
      const subcommand = args.toLowerCase();
      if (subcommand === "clear") {
        effects.consumeDraft();
        await host.clearGoal?.();
        const message = t("chat.commands.goalCleared");
        await report(parsed.text, message, { type: "notice", message }, effects);
      } else if (subcommand === "pause") {
        if (!host.pauseGoal) throw new Error(t("chat.commands.goalPauseUnsupported"));
        effects.consumeDraft();
        await host.pauseGoal();
        const message = t("chat.commands.goalPaused");
        await report(parsed.text, message, { type: "notice", message }, effects);
      } else if (subcommand === "resume") {
        await sendCommandTurn(parsed, { kind: "goal", action: "resume" }, {}, effects);
      } else {
        // 转录区显示用户输入的原文（含 /goal），目标正文单独交给 goal 接口。
        await sendCommandTurn(parsed, { kind: "goal", action: "set", goal: args }, {}, effects);
      }
      return;
    }
    case "loop":
      await runLoop(parsed.text, args, effects);
      return;
    case "plan":
      // 带任务时整条原文发送（转录区显示 /plan 指令标签），本轮按计划模式运行。
      if (args) {
        await sendCommandTurn(parsed, undefined, { planMode: true }, effects);
      } else {
        effects.consumeDraft();
        host.enablePlanMode?.();
      }
      return;
    case "compact":
      effects.consumeDraft();
      await host.compact?.();
      return;
    case "model":
      effects.consumeDraft();
      if (args && host.selectModel) await host.selectModel(args);
      else host.openModelPicker?.();
      return;
    case "rewind":
      effects.consumeDraft();
      await host.rewindLastTurn?.();
      return;
  }
}

export async function runComposerCommand(
  parsed: ParsedComposerCommand,
  effects: ComposerCommandEffects,
): Promise<void> {
  const { command } = parsed;
  try {
    if (command.kind === "prompt") {
      await sendCommandTurn(parsed, { kind: "prompt" }, {}, effects);
      return;
    }
    await runAction(parsed, command.id, effects);
  } catch (error) {
    // 失败（含会话忙、发送被拒）不吞草稿：放回输入框，让用户改了再发。
    effects.restoreDraft?.();
    const message = errorMessage(error) || effects.t("chat.commands.failed");
    effects.showPanel({
      type: "error",
      ...(message === effects.t("chat.commands.busy") ? { tone: "warning" as const } : {}),
      command: command.name,
      message,
    });
  }
}
