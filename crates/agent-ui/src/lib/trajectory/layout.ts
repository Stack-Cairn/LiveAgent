/**
 * 账本 → 视觉记录模型。
 *
 * 事件流只保存时序与结构；完整正文由当前已加载的转录窗口补齐。正文索引可能只是
 * 一个长会话的尾部窗口，因此所有连接都按稳定 messageId → 全局 messageIndex →
 * 局部 turn/尾部顺序逐级降级，绝不假设“窗口里的 Turn 1 就是会话 Turn 1”。
 */

import type {
  LedgerCompaction,
  LedgerInput,
  LedgerStep,
  LedgerTurn,
  TrajectoryGroupModel,
  TrajectoryLedger,
  TrajectoryRecord,
  TrajectoryRecordKind,
  TrajectorySourceBlock,
  TrajectoryStatus,
  TrajectorySubagentRun,
  TrajectoryTurnModel,
  TrajectoryUsage,
} from "./types";

export type TrajectoryContentEntry = {
  text?: string;
  blocks?: readonly TrajectorySourceBlock[];
};

export type TrajectoryAssistantContent = TrajectoryContentEntry & {
  thinking?: string;
};

export type TrajectoryToolContent = {
  args?: string;
  result?: string;
  isError?: boolean;
  schema?: string;
  blocks?: readonly TrajectorySourceBlock[];
  outputBlocks?: readonly TrajectorySourceBlock[];
};

/** 一条 assistant 正文及其前置 user 锚点。 */
export type TrajectoryIndexedAssistantContent = {
  turn: number;
  step: number;
  messageIndex?: number;
  anchorUserMessageIndex?: number;
  anchorUserMessageId?: string;
  content: TrajectoryAssistantContent;
};

/** 一条工具正文；callId 之外还保留 turn/step/user 锚点，避免供应商复用 callId。 */
export type TrajectoryIndexedToolContent = {
  turn: number;
  step: number;
  callId: string;
  messageIndex?: number;
  anchorUserMessageIndex?: number;
  anchorUserMessageId?: string;
  content: TrajectoryToolContent;
};

/** 正文索引：由宿主从当前已加载的 UiMessage 构建，布局层只读。 */
export type TrajectoryContentIndex = {
  userByTurn: ReadonlyMap<number, TrajectoryContentEntry>;
  userByMessageId?: ReadonlyMap<string, TrajectoryContentEntry>;
  userByMessageIndex?: ReadonlyMap<number, TrajectoryContentEntry>;
  turnByMessageId?: ReadonlyMap<string, number>;
  turnByMessageIndex?: ReadonlyMap<number, number>;
  /** 当前消息窗口按出现顺序对应的 turn；无稳定锚点时用于安全的尾部对齐。 */
  turnOrder?: readonly number[];
  assistantByStep: ReadonlyMap<string, TrajectoryAssistantContent>;
  assistantEntries?: readonly TrajectoryIndexedAssistantContent[];
  toolByCallId: ReadonlyMap<string, TrajectoryToolContent>;
  toolEntries?: readonly TrajectoryIndexedToolContent[];
};

export const EMPTY_TRAJECTORY_CONTENT_INDEX: TrajectoryContentIndex = {
  userByTurn: new Map(),
  userByMessageId: new Map(),
  userByMessageIndex: new Map(),
  turnByMessageId: new Map(),
  turnByMessageIndex: new Map(),
  turnOrder: [],
  assistantByStep: new Map(),
  assistantEntries: [],
  toolByCallId: new Map(),
  toolEntries: [],
};

export type TrajectoryLayoutInput = {
  ledger: TrajectoryLedger;
  content?: TrajectoryContentIndex;
  subagentRuns?: readonly TrajectorySubagentRun[];
};

const PREVIEW_MAX_CHARS = 400;

export function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`;
}

function previewLine(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX_CHARS
    ? `${collapsed.slice(0, PREVIEW_MAX_CHARS)}…`
    : collapsed;
}

function durationSeconds(startedAt: number | null, endedAt: number | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const delta = endedAt - startedAt;
  return Number.isFinite(delta) ? Math.max(0, delta) / 1000 : null;
}

function addUsage(
  total: TrajectoryUsage | undefined,
  next: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (next === undefined) return total;
  if (total === undefined) return { ...next };
  const sum = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const merged: TrajectoryUsage = {};
  const totalTokens = sum(total.totalTokens, next.totalTokens);
  const input = sum(total.input, next.input);
  const output = sum(total.output, next.output);
  const cacheRead = sum(total.cacheRead, next.cacheRead);
  const cacheWrite = sum(total.cacheWrite, next.cacheWrite);
  const reasoning = sum(total.reasoning, next.reasoning);
  if (totalTokens !== undefined) merged.totalTokens = totalTokens;
  if (input !== undefined) merged.input = input;
  if (output !== undefined) merged.output = output;
  if (cacheRead !== undefined) merged.cacheRead = cacheRead;
  if (cacheWrite !== undefined) merged.cacheWrite = cacheWrite;
  if (reasoning !== undefined) merged.reasoning = reasoning;
  return merged;
}

function recordIdFor(kind: TrajectoryRecordKind, parts: readonly (string | number)[]): string {
  return [kind, ...parts].join("\u0000");
}

type Cursor = { index: number };

function nextIndex(cursor: Cursor): number {
  cursor.index += 1;
  return cursor.index;
}

type TurnContentAnchor = {
  userMessageId?: string;
  userMessageIndex?: number;
  nextUserMessageIndex?: number;
  fallbackContentTurn: number;
};

function userInputOf(turn: LedgerTurn | undefined): LedgerInput | undefined {
  return turn?.inputs.find((input) => input.kind === "user");
}

/**
 * 把权威 ledger turn 映射到当前正文窗口。
 *
 * 稳定 messageId 优先，其次是 conversation-global messageIndex；两者都没有的旧数据按
 * 当前可见窗口与 ledger 的尾部顺序对齐。这样旧会话尾窗仍可读，但不会把真实 Turn 93
 * 永久误编号为 Turn 1。
 */
function resolveContentTurnMap(
  ledger: TrajectoryLedger,
  content: TrajectoryContentIndex,
): ReadonlyMap<number, number> {
  const availableOrder = [...new Set(content.turnOrder ?? [...content.userByTurn.keys()])];
  const available = new Set(availableOrder);
  const used = new Set<number>();
  const resolved = new Map<number, number>();

  for (const turn of ledger.turns) {
    const user = userInputOf(turn);
    const messageId = user?.messageId?.trim();
    const byId = messageId ? content.turnByMessageId?.get(messageId) : undefined;
    const byIndex =
      user?.messageIndex === undefined
        ? undefined
        : content.turnByMessageIndex?.get(user.messageIndex);
    const exactTurn = content.userByTurn.has(turn.turn) ? turn.turn : undefined;
    const candidate = byId ?? byIndex ?? exactTurn;
    if (candidate === undefined || used.has(candidate)) continue;
    resolved.set(turn.turn, candidate);
    used.add(candidate);
  }

  const unresolvedLedger = ledger.turns.filter((turn) => !resolved.has(turn.turn));
  const unusedContent = availableOrder.filter((turn) => available.has(turn) && !used.has(turn));
  const pairCount = Math.min(unresolvedLedger.length, unusedContent.length);
  for (let offset = 1; offset <= pairCount; offset += 1) {
    resolved.set(
      unresolvedLedger[unresolvedLedger.length - offset].turn,
      unusedContent[unusedContent.length - offset],
    );
  }
  return resolved;
}

function buildTurnAnchor(
  ledger: TrajectoryLedger,
  turnIndex: number,
  contentTurnByLedgerTurn: ReadonlyMap<number, number>,
): TurnContentAnchor {
  const turn = ledger.turns[turnIndex];
  const user = userInputOf(turn);
  const nextUser = userInputOf(ledger.turns[turnIndex + 1]);
  const messageId = user?.messageId?.trim();
  return {
    ...(messageId ? { userMessageId: messageId } : {}),
    ...(user?.messageIndex === undefined ? {} : { userMessageIndex: user.messageIndex }),
    ...(nextUser?.messageIndex === undefined
      ? {}
      : { nextUserMessageIndex: nextUser.messageIndex }),
    fallbackContentTurn: contentTurnByLedgerTurn.get(turn.turn) ?? turn.turn,
  };
}

function userContentForInput(
  input: LedgerInput,
  content: TrajectoryContentIndex,
  anchor: TurnContentAnchor,
): TrajectoryContentEntry | undefined {
  if (input.kind !== "user") return undefined;
  const messageId = input.messageId?.trim();
  return (
    (messageId ? content.userByMessageId?.get(messageId) : undefined) ??
    (input.messageIndex === undefined
      ? undefined
      : content.userByMessageIndex?.get(input.messageIndex)) ??
    content.userByTurn.get(anchor.fallbackContentTurn) ??
    content.userByTurn.get(input.turn)
  );
}

function assistantContentForStep(
  step: LedgerStep,
  content: TrajectoryContentIndex,
  anchor: TurnContentAnchor,
): TrajectoryAssistantContent | undefined {
  const entries = content.assistantEntries ?? [];
  if (anchor.userMessageId !== undefined) {
    const byId = entries.find(
      (entry) => entry.step === step.step && entry.anchorUserMessageId === anchor.userMessageId,
    );
    if (byId !== undefined) return byId.content;
  }
  const userMessageIndex = anchor.userMessageIndex;
  if (userMessageIndex !== undefined) {
    const anchored = entries.find(
      (entry) => entry.step === step.step && entry.anchorUserMessageIndex === userMessageIndex,
    );
    if (anchored !== undefined) return anchored.content;

    const ranged = entries
      .filter(
        (entry) =>
          entry.step === step.step &&
          entry.messageIndex !== undefined &&
          entry.messageIndex > userMessageIndex &&
          (anchor.nextUserMessageIndex === undefined ||
            entry.messageIndex < anchor.nextUserMessageIndex),
      )
      .sort((left, right) => (left.messageIndex ?? 0) - (right.messageIndex ?? 0))[0];
    if (ranged !== undefined) return ranged.content;
  }
  return (
    entries.find((entry) => entry.turn === anchor.fallbackContentTurn && entry.step === step.step)
      ?.content ?? content.assistantByStep.get(stepKey(anchor.fallbackContentTurn, step.step))
  );
}

function toolContentForCall(
  step: LedgerStep,
  callId: string,
  content: TrajectoryContentIndex,
  anchor: TurnContentAnchor,
): TrajectoryToolContent | undefined {
  const entries = content.toolEntries ?? [];
  if (anchor.userMessageId !== undefined) {
    const byId = entries.find(
      (entry) =>
        entry.step === step.step &&
        entry.callId === callId &&
        entry.anchorUserMessageId === anchor.userMessageId,
    );
    if (byId !== undefined) return byId.content;
  }
  if (anchor.userMessageIndex !== undefined) {
    const byIndex = entries.find(
      (entry) =>
        entry.step === step.step &&
        entry.callId === callId &&
        entry.anchorUserMessageIndex === anchor.userMessageIndex,
    );
    if (byIndex !== undefined) return byIndex.content;
  }
  return (
    entries.find(
      (entry) =>
        entry.turn === anchor.fallbackContentTurn &&
        entry.step === step.step &&
        entry.callId === callId,
    )?.content ?? content.toolByCallId.get(callId)
  );
}

function buildSystemRecord(
  cursor: Cursor,
  ledger: TrajectoryLedger,
  headerId: string,
  effectiveAt?: number | null,
  occurrence?: string,
): TrajectoryRecord | null {
  const header = ledger.headers.get(headerId);
  if (header === undefined) return null;
  return {
    index: nextIndex(cursor),
    recordId: recordIdFor("system", [headerId, occurrence ?? header.at]),
    kind: "system",
    text: "",
    turn: null,
    step: null,
    status: "complete",
    isError: false,
    timeSeconds: null,
    startedAt:
      effectiveAt !== undefined ? effectiveAt : Number.isFinite(header.at) ? header.at : null,
    headerId,
    headerChange: header.change,
    ...(header.previousHeaderId === undefined ? {} : { previousHeaderId: header.previousHeaderId }),
  };
}

function buildInputRecords(
  cursor: Cursor,
  turn: LedgerTurn,
  content: TrajectoryContentIndex,
  anchor: TurnContentAnchor,
): TrajectoryRecord[] {
  return turn.inputs.map((input, offset) => {
    const joined = userContentForInput(input, content, anchor);
    const text = previewLine(joined?.text ?? input.text ?? input.source);
    const stableIdentity =
      input.eventId ??
      input.messageId ??
      (input.messageIndex === undefined ? undefined : `mi:${input.messageIndex}`) ??
      `${input.at ?? ""}:${input.source ?? ""}:${input.text ?? ""}:${offset}`;
    return {
      index: nextIndex(cursor),
      recordId: recordIdFor(input.kind, [turn.turn, stableIdentity]),
      kind: input.kind,
      text,
      turn: turn.turn,
      step: null,
      status: "complete" as TrajectoryStatus,
      isError: false,
      timeSeconds: null,
      startedAt: input.at,
      ...(input.messageIndex === undefined ? {} : { messageIndex: input.messageIndex }),
      ...(joined?.blocks === undefined ? {} : { sourceBlocks: joined.blocks }),
      ...(text === "" ? {} : { inputDetail: joined?.text ?? input.text ?? "" }),
    };
  });
}

function buildAssistantRecord(
  cursor: Cursor,
  step: LedgerStep,
  content: TrajectoryContentIndex,
  cumulativeUsage: TrajectoryUsage | undefined,
  anchor: TurnContentAnchor,
): TrajectoryRecord {
  const joined = assistantContentForStep(step, content, anchor);
  return {
    index: nextIndex(cursor),
    recordId: recordIdFor("message", [step.turn, step.step]),
    kind: "message",
    text: previewLine(joined?.text ?? joined?.thinking),
    turn: step.turn,
    step: step.step,
    status: step.status,
    isError: step.status === "error",
    timeSeconds: durationSeconds(step.startedAt, step.endedAt),
    startedAt: step.startedAt,
    ...(step.usage === undefined ? {} : { usage: step.usage }),
    ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
    ...(step.provider === undefined ? {} : { provider: step.provider }),
    ...(step.model === undefined ? {} : { model: step.model }),
    ...(step.api === undefined ? {} : { api: step.api }),
    ...(step.stopReason === undefined ? {} : { stopReason: step.stopReason }),
    ...(step.error === undefined ? {} : { error: step.error }),
    ...(step.headerId === undefined ? {} : { headerId: step.headerId }),
    ...(step.retries.length === 0 ? {} : { retries: step.retries }),
    ...(step.failovers.length === 0 ? {} : { failovers: step.failovers }),
    ...(step.transports.length === 0 ? {} : { transports: step.transports }),
    ...(joined?.text === undefined ? {} : { outputDetail: joined.text }),
    ...(joined?.thinking === undefined ? {} : { thinkingDetail: joined.thinking }),
    ...(joined?.blocks === undefined ? {} : { sourceBlocks: joined.blocks }),
    assistantMetrics: {
      timingRecorded:
        step.startedAt !== null && step.firstTokenAt !== null && step.endedAt !== null,
      stepStartAt: step.startedAt,
      firstTokenAt: step.firstTokenAt,
      completedAt: step.endedAt,
      outputTokens: step.usage?.output ?? null,
    },
  };
}

function buildSubagentRecords(
  cursor: Cursor,
  runIds: readonly string[],
  runsById: ReadonlyMap<string, TrajectorySubagentRun>,
  turn: number,
  step: number,
  headerId: string | undefined,
): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  for (const runId of runIds) {
    const run = runsById.get(runId);
    if (run === undefined) continue;
    for (const runStep of run.steps) {
      for (const tool of runStep.tools) {
        // 工具自身的起止优先；消息缺时间戳（旧数据）时回退所属 step 的跨度，
        // 有自身起点但结果未回时不伪造到 step 结束的时长 —— 交给状态列表达运行/中断。
        const hasOwnTiming = tool.startedAt !== undefined && tool.startedAt !== null;
        const toolStartedAt = tool.startedAt ?? runStep.startedAt;
        const toolEndedAt = hasOwnTiming
          ? (tool.endedAt ?? null)
          : (tool.endedAt ?? runStep.endedAt);
        records.push({
          index: nextIndex(cursor),
          recordId: recordIdFor("subtool", [runId, runStep.step, tool.callId]),
          kind: "subtool",
          text: tool.name,
          turn,
          step,
          status: tool.isError ? "error" : run.status,
          isError: tool.isError,
          timeSeconds: durationSeconds(toolStartedAt, toolEndedAt),
          startedAt: toolStartedAt,
          callId: tool.callId,
          toolName: tool.name,
          subagentRunId: runId,
          ...(headerId === undefined ? {} : { headerId }),
          ...(run.name === undefined ? {} : { inputDetail: run.name }),
        });
      }
    }
  }
  return records;
}

function buildToolRecords(
  cursor: Cursor,
  step: LedgerStep,
  content: TrajectoryContentIndex,
  runsById: ReadonlyMap<string, TrajectorySubagentRun>,
  anchor: TurnContentAnchor,
): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  for (const tool of step.tools) {
    const joined = toolContentForCall(step, tool.callId, content, anchor);
    const args = joined?.args ?? tool.args;
    const result = joined?.result ?? tool.summary;
    records.push({
      index: nextIndex(cursor),
      recordId: recordIdFor("tool", [step.turn, step.step, tool.callId]),
      kind: "tool",
      text: tool.name,
      ...(result === undefined ? {} : { result: previewLine(result) }),
      turn: step.turn,
      step: step.step,
      status: tool.status,
      isError: tool.isError || joined?.isError === true,
      timeSeconds: durationSeconds(tool.startedAt, tool.endedAt),
      startedAt: tool.startedAt,
      callId: tool.callId,
      toolName: tool.name,
      ...(step.headerId === undefined ? {} : { headerId: step.headerId }),
      ...(args === undefined ? {} : { inputDetail: args }),
      ...(result === undefined ? {} : { outputDetail: result }),
      ...(joined?.schema === undefined ? {} : { schemaDetail: joined.schema }),
      ...(joined?.blocks === undefined ? {} : { sourceBlocks: joined.blocks }),
      ...(joined?.outputBlocks === undefined ? {} : { outputBlocks: joined.outputBlocks }),
    });
    if (tool.subagentRunIds.length > 0) {
      records.push(
        ...buildSubagentRecords(
          cursor,
          tool.subagentRunIds,
          runsById,
          step.turn,
          step.step,
          step.headerId,
        ),
      );
    }
  }
  return records;
}

function buildCompactionRecord(
  cursor: Cursor,
  compaction: LedgerCompaction,
  ordinal: number,
): TrajectoryRecord {
  return {
    index: nextIndex(cursor),
    recordId: recordIdFor("compacted", [compaction.turn ?? "-", compaction.startedAt ?? ordinal]),
    kind: "compacted",
    text: "",
    turn: compaction.turn,
    step: null,
    status: compaction.status,
    isError: compaction.status === "error",
    timeSeconds: durationSeconds(compaction.startedAt, compaction.endedAt),
    startedAt: compaction.startedAt,
    ...(compaction.tokensBefore === undefined ? {} : { tokensBefore: compaction.tokensBefore }),
    ...(compaction.tokensAfter === undefined ? {} : { tokensAfter: compaction.tokensAfter }),
    ...(compaction.error === undefined ? {} : { error: compaction.error }),
  };
}

type TurnItem =
  | { kind: "step"; at: number | null; step: LedgerStep }
  | { kind: "compaction"; at: number | null; compaction: LedgerCompaction };

function orderTurnItems(turn: LedgerTurn): TurnItem[] {
  const items: TurnItem[] = [
    ...turn.compactions.map(
      (compaction): TurnItem => ({ kind: "compaction", at: compaction.startedAt, compaction }),
    ),
    ...turn.steps.map((step): TurnItem => ({ kind: "step", at: step.startedAt, step })),
  ];
  return items
    .map((item, order) => ({ item, order }))
    .sort((left, right) => {
      if (left.item.at !== null && right.item.at !== null) {
        return left.item.at - right.item.at || left.order - right.order;
      }
      if (left.item.at !== null) return -1;
      if (right.item.at !== null) return 1;
      return left.order - right.order;
    })
    .map((entry) => entry.item);
}

/** 最终按显示顺序重新编号，保证时间插入的 standalone compaction 不破坏单调 index。 */
function reindexModels(models: readonly TrajectoryTurnModel[]): readonly TrajectoryTurnModel[] {
  let index = 0;
  return models.map((model) => ({
    ...model,
    groups: model.groups.map((group) => ({
      ...group,
      records: group.records.map((record) => ({ ...record, index: ++index })),
    })),
  }));
}

export function deriveTrajectoryLayout(
  input: TrajectoryLayoutInput,
): readonly TrajectoryTurnModel[] {
  const { ledger } = input;
  const content = input.content ?? EMPTY_TRAJECTORY_CONTENT_INDEX;
  const runsById = new Map((input.subagentRuns ?? []).map((run) => [run.runId, run]));
  const cursor: Cursor = { index: 0 };
  const contentTurnByLedgerTurn = resolveContentTurnMap(ledger, content);
  const leading: TrajectoryTurnModel[] = [];
  let activeHeaderId: string | undefined;
  let cumulativeUsage: TrajectoryUsage | undefined;

  const firstHeaderStep = ledger.turns
    .flatMap((turn) => turn.steps)
    .find((step) => step.headerId !== undefined);
  if (firstHeaderStep?.headerId !== undefined) {
    const record = buildSystemRecord(
      cursor,
      ledger,
      firstHeaderStep.headerId,
      firstHeaderStep.startedAt,
      `${firstHeaderStep.turn}:${firstHeaderStep.step}`,
    );
    if (record !== null) {
      activeHeaderId = firstHeaderStep.headerId;
      leading.push({ turn: null, groups: [{ title: "System", records: [record] }] });
    }
  }

  const chronological: {
    model: TrajectoryTurnModel;
    at: number | null;
    order: number;
  }[] = [];
  let chronologicalOrder = 0;

  for (const [turnIndex, turn] of ledger.turns.entries()) {
    const groups: TrajectoryGroupModel[] = [];
    const anchor = buildTurnAnchor(ledger, turnIndex, contentTurnByLedgerTurn);
    const inputRecords = buildInputRecords(cursor, turn, content, anchor);
    if (inputRecords.length > 0) groups.push({ title: "Message", records: inputRecords });

    let compactionOrdinal = 0;
    for (const item of orderTurnItems(turn)) {
      if (item.kind === "compaction") {
        compactionOrdinal += 1;
        groups.push({
          title: "Compaction",
          records: [buildCompactionRecord(cursor, item.compaction, compactionOrdinal)],
        });
        continue;
      }

      const step = item.step;
      const records: TrajectoryRecord[] = [];
      if (step.headerId !== undefined && step.headerId !== activeHeaderId) {
        const record = buildSystemRecord(
          cursor,
          ledger,
          step.headerId,
          step.startedAt,
          `${step.turn}:${step.step}`,
        );
        if (record !== null) {
          activeHeaderId = step.headerId;
          records.push(record);
        }
      }
      cumulativeUsage = addUsage(cumulativeUsage, step.usage);
      records.push(buildAssistantRecord(cursor, step, content, cumulativeUsage, anchor));
      records.push(...buildToolRecords(cursor, step, content, runsById, anchor));
      groups.push({ title: `Step ${step.step}`, records });
    }

    if (groups.length > 0) {
      chronological.push({
        model: { turn: turn.turn, groups },
        at: turn.startedAt,
        order: chronologicalOrder++,
      });
    }
  }

  for (const [ordinal, compaction] of ledger.standaloneCompactions.entries()) {
    chronological.push({
      model: {
        turn: null,
        groups: [
          { title: "Compaction", records: [buildCompactionRecord(cursor, compaction, ordinal)] },
        ],
      },
      at: compaction.startedAt,
      order: chronologicalOrder++,
    });
  }

  chronological.sort((left, right) => {
    if (left.at !== null && right.at !== null) {
      return left.at - right.at || left.order - right.order;
    }
    if (left.at === null && right.at !== null) return 1;
    if (left.at !== null && right.at === null) return -1;
    return left.order - right.order;
  });

  return reindexModels([...leading, ...chronological.map(({ model }) => model)]);
}

export function flattenTrajectoryRecords(
  turns: readonly TrajectoryTurnModel[],
): readonly TrajectoryRecord[] {
  return turns.flatMap((turn) => turn.groups.flatMap((group) => group.records));
}

export function lastRecordIndex(turns: readonly TrajectoryTurnModel[]): number {
  let last = 0;
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const record of group.records) last = Math.max(last, record.index);
    }
  }
  return last;
}
