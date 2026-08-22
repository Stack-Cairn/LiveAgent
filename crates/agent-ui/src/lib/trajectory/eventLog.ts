/**
 * 事件流 → 规范化账本。
 *
 * 这一层必须对**乱序、重复、截断**三种输入都稳健：实时事件经中继下发，断线重连
 * 会重放窗口内的事件；桌面落盘与 WebUI 实时合并的结果最终要收敛到同一份账本。
 *
 * 因此不做全局排序，而是按语义键归位（turn 号、step 号、callId），并用事件身份
 * 键去重——同一条事件应用两次是无操作。
 */

import type {
  LedgerCompaction,
  LedgerFailover,
  LedgerHeader,
  LedgerInput,
  LedgerRetry,
  LedgerStep,
  LedgerToolCall,
  LedgerTransport,
  LedgerTurn,
  TrajectoryEvent,
  TrajectoryLedger,
  TrajectoryStatus,
} from "./types";
import { TRAJECTORY_SECTION_SLOTS } from "./types";

function finiteAt(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Canonical JSON used only for idempotent live/persisted convergence. */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Full event identity: legitimate same-millisecond inputs must not collapse. */
function eventIdentity(event: TrajectoryEvent): string {
  return canonicalJson(event);
}

function shortEventIdentity(event: TrajectoryEvent): string {
  const text = eventIdentity(event);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv ^= code & 0xff;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    fnv ^= code >>> 8;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ code) >>> 0;
  }
  return `e_${fnv.toString(16).padStart(8, "0")}${djb
    .toString(16)
    .padStart(8, "0")}_${text.length}`;
}

/**
 * The SQLite read boundary enriches early `user` events with a stable id. That enriched event and
 * an old live replay without `id` are the same occurrence, so convergence ignores only this
 * optional compatibility field. All other fields remain part of the semantic identity.
 */
function convergenceIdentity(event: TrajectoryEvent): string {
  if (event.k !== "user") return eventIdentity(event);
  const { id: _messageId, ...legacyShape } = event;
  return `user|${canonicalJson(legacyShape)}`;
}

/**
 * 收集实时事件的收敛身份集合，供 `buildTrajectoryLedger` 的 `liveIdentities` 使用。
 *
 * 桌面端应无条件传入（空集 = 本进程不持有任何实时尾巴，是「进程已重启」的权威证据）；
 * 观察端（WebUI）建议仅在已吸收过该会话的实时事件时传入，避免页面刚重载、
 * 尚未收到任何实时数据时把仍在运行的回合误判为中断。
 */
export function trajectoryLiveEventIdentities(
  events: readonly TrajectoryEvent[],
): ReadonlySet<string> {
  const identities = new Set<string>();
  for (const event of events) {
    if (event === null || typeof event !== "object" || typeof event.k !== "string") continue;
    identities.add(convergenceIdentity(event));
  }
  return identities;
}

/**
 * 合并同一会话两个读窗口的事件（向前分页前缀 + 尾部刷新）。
 *
 * 以收敛身份去重，保留 `existing` 里的版本（SQLite 读边界增强过的 `user.id`
 * 不会被无 id 的重放副本挤掉）；`fresh` 只补齐尚未出现的条目。顺序对账本
 * 无意义 —— `buildTrajectoryLedger` 会重排 —— 但保持 existing 在前使数组稳定。
 */
export function mergeTrajectoryEventWindows(
  existing: readonly TrajectoryEvent[],
  fresh: readonly TrajectoryEvent[],
): TrajectoryEvent[] {
  const merged = [...existing];
  if (fresh.length === 0) return merged;
  const seen = new Set<string>();
  for (const event of existing) {
    if (event === null || typeof event !== "object" || typeof event.k !== "string") continue;
    seen.add(convergenceIdentity(event));
  }
  for (const event of fresh) {
    if (event === null || typeof event !== "object" || typeof event.k !== "string") continue;
    const identity = convergenceIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(event);
  }
  return merged;
}

function preferredConvergedEvent(
  current: TrajectoryEvent,
  candidate: TrajectoryEvent,
): TrajectoryEvent {
  if (current.k !== "user" || candidate.k !== "user") return current;
  const currentId = current.id?.trim() ?? "";
  const candidateId = candidate.id?.trim() ?? "";
  if (currentId === candidateId) return current;
  if (currentId === "") return candidate;
  if (candidateId === "") return current;
  // Conflicting non-empty ids indicate malformed input; choose deterministically so arrival order
  // cannot change the ledger.
  return candidateId.localeCompare(currentId) < 0 ? candidate : current;
}

/**
 * Header content is addressed by `hid`, but activation is an occurrence.
 * A → B → A must produce three SYSTEM rows, and the key must stay stable when
 * older pages are prepended, so it is derived only from the event itself.
 */
function headerOccurrenceId(event: Extract<TrajectoryEvent, { k: "header" }>): string {
  return `header|${eventIdentity(event)}`;
}

function normalizeHeaderSections(
  event: Extract<TrajectoryEvent, { k: "header" }>,
): readonly (string | null)[] {
  const refs = Array.isArray(event.sec) ? [...event.sec] : [];
  // Runtime was appended after the original six wire slots. Never insert in the middle: doing so
  // would reinterpret legacy toolsSuffix/toolCatalog references as different content.
  while (refs.length < TRAJECTORY_SECTION_SLOTS.length) refs.push(null);
  return refs.slice(0, TRAJECTORY_SECTION_SLOTS.length);
}

const EVENT_ORDER: Record<TrajectoryEvent["k"], number> = {
  user: 0,
  context: 1,
  header: 2,
  compaction_start: 3,
  step_start: 4,
  transport: 5,
  first_token: 6,
  retry: 7,
  failover: 8,
  tool_start: 9,
  tool_end: 10,
  step_end: 11,
  compaction_end: 12,
  turn_end: 13,
};

/** Normalize once so all later pairing is independent of transport arrival order. */
function orderedUniqueEvents(events: readonly TrajectoryEvent[]): TrajectoryEvent[] {
  const byConvergenceIdentity = new Map<string, TrajectoryEvent>();
  for (const event of events) {
    if (event === null || typeof event !== "object" || typeof event.k !== "string") continue;
    const identity = convergenceIdentity(event);
    const existing = byConvergenceIdentity.get(identity);
    byConvergenceIdentity.set(
      identity,
      existing === undefined ? event : preferredConvergedEvent(existing, event),
    );
  }
  const normalized = [...byConvergenceIdentity.values()].map((event) => ({
    event,
    identity: eventIdentity(event),
  }));
  normalized.sort((left, right) => {
    const leftAt = finiteAt(left.event.at);
    const rightAt = finiteAt(right.event.at);
    if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return leftAt - rightAt;
    if (leftAt === null && rightAt !== null) return 1;
    if (leftAt !== null && rightAt === null) return -1;
    return (
      EVENT_ORDER[left.event.k] - EVENT_ORDER[right.event.k] ||
      left.identity.localeCompare(right.identity)
    );
  });
  return normalized.map(({ event }) => event);
}

type MutableTool = {
  callId: string;
  name: string;
  args?: string;
  startedAt: number | null;
  endedAt: number | null;
  isError: boolean;
  summary?: string;
  subagentRunIds: string[];
  /** 到达序，用于同 `at` 时保持稳定排序。 */
  order: number;
  /** 当前进程的 live 事件流里出现过该条目的任意事件。 */
  sawLive: boolean;
};

type MutableStep = {
  turn: number;
  step: number;
  startedAt: number | null;
  firstTokenAt: number | null;
  endedAt: number | null;
  endStatus: TrajectoryStatus | null;
  error?: string;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  usage?: LedgerStep["usage"];
  headerId?: string;
  retries: LedgerRetry[];
  failovers: LedgerFailover[];
  transports: LedgerTransport[];
  tools: MutableTool[];
  /** 当前进程的 live 事件流里出现过该条目的任意事件。 */
  sawLive: boolean;
};

type MutableCompaction = {
  turn: number | null;
  startedAt: number | null;
  endedAt: number | null;
  endStatus: TrajectoryStatus | null;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
  /** 当前进程的 live 事件流里出现过该条目的任意事件。 */
  sawLive: boolean;
};

type MutableTurn = {
  turn: number;
  inputs: LedgerInput[];
  steps: Map<number, MutableStep>;
  compactions: MutableCompaction[];
  endedAt: number | null;
  endStatus: TrajectoryStatus | null;
  error?: string;
  /** 首个输入的到达序，用于没有 turn 号语义时的稳定排序。 */
  order: number;
  /** 当前进程的 live 事件流里出现过该条目的任意事件。 */
  sawLive: boolean;
};

function ensureTurn(turns: Map<number, MutableTurn>, turn: number): MutableTurn {
  let entry = turns.get(turn);
  if (entry === undefined) {
    entry = {
      turn,
      inputs: [],
      steps: new Map(),
      compactions: [],
      endedAt: null,
      endStatus: null,
      order: turns.size,
      sawLive: false,
    };
    turns.set(turn, entry);
  }
  return entry;
}

function ensureStep(turnEntry: MutableTurn, step: number): MutableStep {
  let entry = turnEntry.steps.get(step);
  if (entry === undefined) {
    entry = {
      turn: turnEntry.turn,
      step,
      startedAt: null,
      firstTokenAt: null,
      endedAt: null,
      endStatus: null,
      retries: [],
      failovers: [],
      transports: [],
      tools: [],
      sawLive: false,
    };
    turnEntry.steps.set(step, entry);
  }
  return entry;
}

function ensureTool(step: MutableStep, callId: string, order: number): MutableTool {
  const existing = step.tools.find((tool) => tool.callId === callId);
  if (existing !== undefined) return existing;
  const created: MutableTool = {
    callId,
    name: "",
    startedAt: null,
    endedAt: null,
    isError: false,
    subagentRunIds: [],
    order,
    sawLive: false,
  };
  step.tools.push(created);
  return created;
}

/**
 * 未闭合操作的终态由**上下文**推导，不需要外部传 live 标记：
 * 所属 turn 已结束 ⇒ 中断；否则仍在运行。
 */
function resolveStatus(
  endStatus: TrajectoryStatus | null,
  ownerFinished: boolean,
): TrajectoryStatus {
  if (endStatus !== null) return endStatus;
  return ownerFinished ? "aborted" : "running";
}

/**
 * 把事件流收敛成账本。
 *
 * @param events - 任意顺序、可含重复的事件。
 * @param options.liveIdentities - 当前进程实时事件的身份集合（`trajectoryLiveEventIdentities`）。
 *   提供时，仍处 running 且没有任何 live 事件覆盖的条目（turn / step / tool / compaction）
 *   收敛为 aborted：进程崩溃或强退后，重开视图不再显示永远运行中的僵尸条目。
 *   live 事件按「条目内任意事件被实时流覆盖」判定——正在执行的条目总会持续收到
 *   本进程事件，因此不会被误收敛；唯一的误收敛窗口是单会话 live 上限裁掉了仍打开
 *   条目的全部事件（极端长 turn），影响仅为展示层状态。
 * @returns 规范化账本；无事件时 turns 为空且 hasTiming 为 false。
 */
export function buildTrajectoryLedger(
  events: readonly TrajectoryEvent[],
  options?: { liveIdentities?: ReadonlySet<string> },
): TrajectoryLedger {
  const liveIdentities = options?.liveIdentities;
  /** 仅当调用方给出了 live 身份集合时才启用中断收敛；未提供时行为与旧版完全一致。 */
  const isInterrupted = (sawLive: boolean): boolean => liveIdentities !== undefined && !sawLive;
  const turns = new Map<number, MutableTurn>();
  const headers = new Map<string, LedgerHeader>();
  const latestHeaderOccurrenceByContentId = new Map<string, string>();
  const standalone: MutableCompaction[] = [];
  const orderedEvents = orderedUniqueEvents(events);
  const sawTiming = orderedEvents.some((event) => finiteAt(event.at) !== null);
  let order = 0;

  // New tool_end events carry turn/step. For old events, retain every same-id start and pair
  // by time plus unmatched ownership; providers are allowed to reuse simple call ids later.
  const hostsByCallId = new Map<
    string,
    { turn: number; step: number; at: number | null; order: number }[]
  >();
  for (const [eventOrder, event] of orderedEvents.entries()) {
    if (event.k !== "tool_start") continue;
    const hosts = hostsByCallId.get(event.id) ?? [];
    hosts.push({ turn: event.t, step: event.s, at: finiteAt(event.at), order: eventOrder });
    hostsByCallId.set(event.id, hosts);
  }

  for (const event of orderedEvents) {
    order += 1;

    const isLiveEvent = liveIdentities?.has(convergenceIdentity(event)) ?? false;
    /** 把「该事件属于本进程实时流」标注到它归属的所有条目上。 */
    const markLive = (...entries: Array<{ sawLive: boolean } | undefined>) => {
      if (!isLiveEvent) return;
      for (const entry of entries) {
        if (entry !== undefined) entry.sawLive = true;
      }
    };

    switch (event.k) {
      case "user":
      case "context": {
        const turnEntry = ensureTurn(turns, event.t);
        markLive(turnEntry);
        turnEntry.inputs.push({
          kind: event.k,
          turn: event.t,
          at: finiteAt(event.at),
          eventId: shortEventIdentity(event),
          ...(event.k === "user" && event.mi !== undefined ? { messageIndex: event.mi } : {}),
          ...(event.k === "user" && event.id !== undefined ? { messageId: event.id } : {}),
          ...(event.k === "context" && event.src !== undefined ? { source: event.src } : {}),
          ...(event.tx === undefined ? {} : { text: event.tx }),
        });
        break;
      }
      case "header": {
        const occurrenceId = headerOccurrenceId(event);
        const previousHeaderId =
          event.prev === undefined
            ? undefined
            : (latestHeaderOccurrenceByContentId.get(event.prev) ?? event.prev);
        headers.set(occurrenceId, {
          headerId: occurrenceId,
          contentId: event.hid,
          at: event.at,
          sections: normalizeHeaderSections(event),
          change: event.ch,
          ...(previousHeaderId === undefined ? {} : { previousHeaderId }),
        });
        latestHeaderOccurrenceByContentId.set(event.hid, occurrenceId);
        break;
      }
      case "step_start": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        markLive(turnEntry, step);
        const startedAt = finiteAt(event.at);
        step.startedAt =
          step.startedAt === null || startedAt === null
            ? (step.startedAt ?? startedAt)
            : Math.min(step.startedAt, startedAt);
        if (event.hid !== undefined) {
          step.headerId = latestHeaderOccurrenceByContentId.get(event.hid) ?? event.hid;
        }
        break;
      }
      case "first_token": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        markLive(turnEntry, step);
        const firstTokenAt = finiteAt(event.at);
        step.firstTokenAt =
          step.firstTokenAt === null || firstTokenAt === null
            ? (step.firstTokenAt ?? firstTokenAt)
            : Math.min(step.firstTokenAt, firstTokenAt);
        break;
      }
      case "step_end": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        markLive(turnEntry, step);
        const endedAt = finiteAt(event.at);
        step.endedAt =
          step.endedAt === null || endedAt === null
            ? (step.endedAt ?? endedAt)
            : Math.max(step.endedAt, endedAt);
        step.endStatus = event.st;
        if (event.err !== undefined) step.error = event.err;
        if (event.u !== undefined) step.usage = event.u;
        if (event.p !== undefined) step.provider = event.p;
        if (event.m !== undefined) step.model = event.m;
        if (event.api !== undefined) step.api = event.api;
        if (event.sr !== undefined) step.stopReason = event.sr;
        break;
      }
      case "retry": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        markLive(turnEntry, step);
        step.retries.push({
          attempt: event.n,
          at: event.at,
          ...(event.max === undefined ? {} : { maxRetries: event.max }),
          ...(event.delay === undefined ? {} : { delayMs: event.delay }),
          ...(event.err === undefined ? {} : { error: event.err }),
          ...(event.p === undefined ? {} : { provider: event.p }),
        });
        break;
      }
      case "failover": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        markLive(turnEntry, step);
        step.failovers.push({
          attempt: event.n,
          at: event.at,
          ...(event.from === undefined ? {} : { fromLabel: event.from }),
          ...(event.to === undefined ? {} : { toLabel: event.to }),
          ...(event.ti === undefined ? {} : { targetIndex: event.ti }),
          ...(event.err === undefined ? {} : { error: event.err }),
        });
        break;
      }
      case "transport": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        markLive(turnEntry, step);
        step.transports.push({
          at: event.at,
          ...(event.p === undefined ? {} : { provider: event.p }),
          ...(event.o === undefined ? {} : { upstreamOrigin: event.o }),
          ...(event.sp === undefined ? {} : { useSystemProxy: event.sp }),
          ...(event.fu === undefined ? {} : { fullUrl: event.fu }),
          ...(event.hn === undefined ? {} : { headerNames: [...event.hn] }),
        });
        break;
      }
      case "tool_start": {
        const turnEntry = ensureTurn(turns, event.t);
        const step = ensureStep(turnEntry, event.s);
        const tool = ensureTool(step, event.id, order);
        markLive(turnEntry, step, tool);
        tool.name = event.n;
        const startedAt = finiteAt(event.at);
        tool.startedAt =
          tool.startedAt === null || startedAt === null
            ? (tool.startedAt ?? startedAt)
            : Math.min(tool.startedAt, startedAt);
        if (event.a !== undefined) tool.args = event.a;
        break;
      }
      case "tool_end": {
        const endedAt = finiteAt(event.at);
        const explicitHost =
          event.t === undefined || event.s === undefined
            ? undefined
            : { turn: event.t, step: event.s, at: null, order: -1 };
        const host =
          explicitHost ??
          [...(hostsByCallId.get(event.id) ?? [])]
            .filter((candidate) => {
              if (endedAt !== null && candidate.at !== null && candidate.at > endedAt) return false;
              const existing = turns
                .get(candidate.turn)
                ?.steps.get(candidate.step)
                ?.tools.find((tool) => tool.callId === event.id);
              return existing?.endedAt === null;
            })
            .sort(
              (left, right) =>
                (right.at ?? Number.NEGATIVE_INFINITY) - (left.at ?? Number.NEGATIVE_INFINITY) ||
                right.order - left.order,
            )[0];
        // 没有对应的 tool_start 就无法在账本里定位这次调用，只能丢弃。
        if (host === undefined) break;
        const hostTurn = ensureTurn(turns, host.turn);
        const tool = ensureTool(ensureStep(hostTurn, host.step), event.id, order);
        markLive(hostTurn, hostTurn.steps.get(host.step), tool);
        tool.endedAt =
          tool.endedAt === null || endedAt === null
            ? (tool.endedAt ?? endedAt)
            : Math.max(tool.endedAt, endedAt);
        tool.isError = event.err === true;
        if (event.sum !== undefined) tool.summary = event.sum;
        if (Array.isArray(event.run)) tool.subagentRunIds = [...event.run];
        break;
      }
      case "compaction_start": {
        const entry: MutableCompaction = {
          turn: event.t,
          startedAt: finiteAt(event.at),
          endedAt: null,
          endStatus: null,
          sawLive: false,
        };
        if (event.t === null) {
          standalone.push(entry);
          markLive(entry);
        } else {
          const turnEntry = ensureTurn(turns, event.t);
          turnEntry.compactions.push(entry);
          markLive(entry, turnEntry);
        }
        break;
      }
      case "compaction_end": {
        const target: MutableCompaction[] =
          event.t === null ? standalone : ensureTurn(turns, event.t).compactions;
        // 控制器串行执行压缩；仍按 FIFO 匹配，使乱序传输归一后结果确定。
        const pending = target.find((entry) => entry.endStatus === null);
        const entry = pending ?? {
          turn: event.t,
          startedAt: null,
          endedAt: null,
          endStatus: null,
          sawLive: false,
        };
        if (pending === undefined) target.push(entry);
        markLive(entry, event.t === null ? undefined : turns.get(event.t));
        const endedAt = finiteAt(event.at);
        entry.endedAt =
          entry.endedAt === null || endedAt === null
            ? (entry.endedAt ?? endedAt)
            : Math.max(entry.endedAt, endedAt);
        entry.endStatus = event.st;
        if (event.before !== undefined) entry.tokensBefore = event.before;
        if (event.after !== undefined) entry.tokensAfter = event.after;
        if (event.err !== undefined) entry.error = event.err;
        break;
      }
      case "turn_end": {
        const turnEntry = ensureTurn(turns, event.t);
        markLive(turnEntry);
        const endedAt = finiteAt(event.at);
        turnEntry.endedAt =
          turnEntry.endedAt === null || endedAt === null
            ? (turnEntry.endedAt ?? endedAt)
            : Math.max(turnEntry.endedAt, endedAt);
        turnEntry.endStatus = event.st;
        if (event.err !== undefined) turnEntry.error = event.err;
        break;
      }
    }
  }

  const orderedTurns = [...turns.values()].sort(
    (left, right) => left.turn - right.turn || left.order - right.order,
  );

  const finalizedTurns: LedgerTurn[] = orderedTurns.map((turnEntry) => {
    // 进程已不再持有这个 turn（崩溃/强退后的遗留 running），按中断收敛，
    // 并让子级 step/tool/compaction 沿用「宿主已结束」的既有级联路径。
    const turnInterrupted = turnEntry.endStatus === null && isInterrupted(turnEntry.sawLive);
    const turnFinished = turnEntry.endStatus !== null || turnInterrupted;
    const orderedSteps = [...turnEntry.steps.values()].sort(
      (left, right) => left.step - right.step,
    );
    const lastStep = orderedSteps.at(-1)?.step;
    const steps: LedgerStep[] = orderedSteps.map((step) => {
      // 同一轮里已经有更靠后的 step 开跑，说明这一步不可能还在运行。
      const supersededByLaterStep = lastStep !== undefined && step.step < lastStep;
      const stepInterrupted = step.endStatus === null && isInterrupted(step.sawLive);
      const stepFinished = turnFinished || supersededByLaterStep || stepInterrupted;
      // Older/incomplete recordings may contain a provider-side turn error without the matching
      // step_end (for example, the request failed before a terminal assistant was produced).
      // Attribute that terminal error to the last open model request; earlier superseded requests
      // remain interrupted rather than all being mislabeled as failures.
      const inheritsTurnError =
        step.endStatus === null && turnEntry.endStatus === "error" && step.step === lastStep;
      const status = inheritsTurnError ? "error" : resolveStatus(step.endStatus, stepFinished);
      const error = step.error ?? (inheritsTurnError ? turnEntry.error : undefined);
      const tools: LedgerToolCall[] = [...step.tools]
        .sort(
          (left, right) =>
            (left.startedAt ?? Number.POSITIVE_INFINITY) -
              (right.startedAt ?? Number.POSITIVE_INFINITY) || left.order - right.order,
        )
        .map((tool) => ({
          callId: tool.callId,
          name: tool.name,
          ...(tool.args === undefined ? {} : { args: tool.args }),
          startedAt: tool.startedAt,
          endedAt: tool.endedAt,
          // 有 tool_end 就是终态；没有则跟随宿主 step：step 已收尾说明这次调用
          // 被中断，step 仍在跑则调用还在执行；条目自身失去 live 覆盖时同理。
          status:
            tool.endedAt !== null
              ? tool.isError
                ? ("error" as const)
                : ("complete" as const)
              : resolveStatus(
                  null,
                  status !== "running" || (tool.endedAt === null && isInterrupted(tool.sawLive)),
                ),
          isError: tool.isError,
          ...(tool.summary === undefined ? {} : { summary: tool.summary }),
          subagentRunIds: tool.subagentRunIds,
        }));
      return {
        turn: step.turn,
        step: step.step,
        startedAt: step.startedAt,
        firstTokenAt: step.firstTokenAt,
        endedAt: step.endedAt,
        status,
        ...(error === undefined ? {} : { error }),
        ...(step.provider === undefined ? {} : { provider: step.provider }),
        ...(step.model === undefined ? {} : { model: step.model }),
        ...(step.api === undefined ? {} : { api: step.api }),
        ...(step.stopReason === undefined ? {} : { stopReason: step.stopReason }),
        ...(step.usage === undefined ? {} : { usage: step.usage }),
        ...(step.headerId === undefined ? {} : { headerId: step.headerId }),
        retries: [...step.retries].sort((left, right) => left.attempt - right.attempt),
        failovers: [...step.failovers].sort(
          (left, right) => left.attempt - right.attempt || left.at - right.at,
        ),
        transports: [...step.transports].sort((left, right) => left.at - right.at),
        tools,
      };
    });
    return {
      turn: turnEntry.turn,
      startedAt: turnEntry.inputs[0]?.at ?? steps[0]?.startedAt ?? null,
      endedAt: turnEntry.endedAt,
      status: resolveStatus(turnEntry.endStatus, turnInterrupted),
      ...(turnEntry.error === undefined ? {} : { error: turnEntry.error }),
      inputs: [...turnEntry.inputs].sort(
        (left, right) =>
          (left.at ?? Number.POSITIVE_INFINITY) - (right.at ?? Number.POSITIVE_INFINITY) ||
          (left.messageIndex ?? Number.POSITIVE_INFINITY) -
            (right.messageIndex ?? Number.POSITIVE_INFINITY) ||
          (left.source ?? "").localeCompare(right.source ?? "") ||
          (left.text ?? "").localeCompare(right.text ?? ""),
      ),
      steps,
      compactions: turnEntry.compactions
        .map((entry) =>
          finalizeCompaction(
            entry,
            turnFinished,
            entry.endStatus === null && isInterrupted(entry.sawLive),
          ),
        )
        .sort(compareCompactions),
    };
  });

  return {
    turns: finalizedTurns,
    headers,
    standaloneCompactions: standalone
      .map((entry) =>
        finalizeCompaction(entry, false, entry.endStatus === null && isInterrupted(entry.sawLive)),
      )
      .sort(compareCompactions),
    hasTiming: sawTiming,
  };
}

function compareCompactions(left: LedgerCompaction, right: LedgerCompaction): number {
  return (
    (left.startedAt ?? Number.POSITIVE_INFINITY) - (right.startedAt ?? Number.POSITIVE_INFINITY) ||
    (left.endedAt ?? Number.POSITIVE_INFINITY) - (right.endedAt ?? Number.POSITIVE_INFINITY)
  );
}

function finalizeCompaction(
  entry: MutableCompaction,
  ownerFinished: boolean,
  interrupted: boolean,
): LedgerCompaction {
  return {
    turn: entry.turn,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    status: resolveStatus(entry.endStatus, ownerFinished || interrupted),
    ...(entry.tokensBefore === undefined ? {} : { tokensBefore: entry.tokensBefore }),
    ...(entry.tokensAfter === undefined ? {} : { tokensAfter: entry.tokensAfter }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
  };
}

/**
 * 解析落盘的事件 JSON。
 *
 * 单个 segment 的轨迹损坏时只让该段降级为空，不连累其它 segment——轨迹是诊断
 * 视图，永远不该因为自身数据问题挡住会话。
 *
 * @param raw - `trajectory_json` 原文。
 * @returns 解析出的事件数组；无法解析时为空数组。
 */
export function parseTrajectoryEvents(raw: string | null | undefined): TrajectoryEvent[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrajectoryEvent[]) : [];
  } catch (error) {
    console.warn(
      "[trajectory] failed to parse trajectory events; treating segment as empty",
      error,
    );
    return [];
  }
}
