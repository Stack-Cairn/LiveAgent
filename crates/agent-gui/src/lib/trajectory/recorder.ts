/**
 * 对话运行时的轨迹埋点。
 *
 * 全部方法同步、不抛错：轨迹是诊断视图，任何自身故障都不该打断对话。内部一律
 * try/catch 吞掉并 `console.warn`。
 *
 * 事件走两条路：立即经 `publish` 下发给 Gateway（WebUI 实时骨架），并按批经
 * `persist` 落到当前 segment。两条路同源，所以 WebUI 看到的和落盘的最终一致。
 */

import {
  buildTrajectoryHeader,
  type TrajectorySectionInput,
} from "@liveagent/ui/lib/trajectory/sections";
import type {
  TrajectoryEvent,
  TrajectorySection,
  TrajectorySectionRefs,
  TrajectoryStatus,
  TrajectoryUsage,
} from "@liveagent/ui/lib/trajectory/types";
import { createTrajectoryPersistenceQueue } from "./persistenceQueue";
import { scrubSecretsFromErrorText } from "./scrub";

/** 工具参数在事件里的截断长度：实时通道要小，详情由正文索引另行提供。 */
const TOOL_ARGS_PREVIEW_CHARS = 200;
const CONTEXT_PREVIEW_CHARS = 512;
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DISPOSE_FLUSH_ATTEMPTS = 3;

export type TrajectoryRecorderPorts = {
  /** 把一批事件追加到指定 segment。 */
  persist: (conversationId: string, segmentIndex: number, eventsJson: string) => Promise<unknown>;
  /** 幂等写入新出现的 prompt 分段。 */
  persistSections: (
    conversationId: string,
    sections: readonly TrajectorySection[],
  ) => Promise<unknown>;
  /** 实时下发；未连接 Gateway 时可缺省。 */
  publish?: (events: readonly TrajectoryEvent[]) => void;
};

export type TrajectoryStepEndInfo = {
  status: TrajectoryStatus;
  usage?: TrajectoryUsage;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  error?: string;
};

export type TrajectoryRecorder = {
  /**
   * 一轮开始（用户消息落定）。同时把 `turn` 记为当前轮，后续调用不再重复传——
   * 让每个埋点点自己传 turn 号，多一个参数就多一处传错的机会。
   */
  beginTurn: (info: {
    turn: number;
    messageIndex?: number;
    messageId?: string;
    text?: string;
  }) => void;
  /** 上下文注入。 */
  noteContext: (info: { source?: string; text?: string }) => void;
  /**
   * 记录一次请求头。内容未变时复用既有 headerId 且不产生事件。
   * @returns 本次请求应引用的 headerId；埋点失败时为 undefined。
   */
  captureHeader: (input: TrajectorySectionInput) => string | undefined;
  stepStart: (step: number, headerId?: string) => void;
  firstToken: (step: number) => void;
  stepEnd: (step: number, info: TrajectoryStepEndInfo) => void;
  noteRetry: (
    step: number,
    info: {
      attempt: number;
      maxRetries?: number;
      delayMs?: number;
      error?: string;
      /** 候选标签（"Provider · model"）；failover 下区分各候选自己的重试。 */
      provider?: string;
    },
  ) => void;
  /** 跨供应商切换。`attempt` 是本次请求内的切换序号（1 起）。 */
  noteFailover: (
    step: number,
    info: {
      attempt: number;
      fromLabel?: string;
      toLabel?: string;
      targetIndex?: number;
      error?: string;
    },
  ) => void;
  /**
   * 一次实际尝试的传输装配快照。调用方必须只传头名（不传值）——
   * recorder 不做二次脱敏，线格式里根本没有放头值的字段。
   */
  noteTransport: (
    step: number,
    info: {
      provider?: string;
      upstreamOrigin?: string;
      useSystemProxy?: boolean;
      fullUrl?: boolean;
      headerNames?: readonly string[];
    },
  ) => void;
  toolStart: (step: number, toolCall: { id: string; name: string; arguments?: unknown }) => void;
  toolEnd: (
    callId: string,
    info: { isError?: boolean; summary?: string; subagentRunIds?: readonly string[] },
  ) => void;
  /** 压缩开始。`standalone` 表示发生在两轮之间，不属于任何 turn。 */
  compactionStart: (options?: { standalone?: boolean }) => void;
  compactionEnd: (info: {
    status: TrajectoryStatus;
    tokensBefore?: number;
    tokensAfter?: number;
    error?: string;
    standalone?: boolean;
  }) => void;
  endTurn: (info: { status: TrajectoryStatus; error?: string }) => void;
  /** 立即落盘缓冲区；turn 边界与会话切换时调用。 */
  flush: () => Promise<void>;
  /** 停止定时器并做最后一次落盘。 */
  dispose: () => Promise<void>;
  /** 会话已被删除/截断时丢弃尚未落盘的诊断数据并停止定时器。 */
  discard: () => void;
};

function previewArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof serialized !== "string" || serialized === "") return undefined;
    return serialized.length > TOOL_ARGS_PREVIEW_CHARS
      ? `${serialized.slice(0, TOOL_ARGS_PREVIEW_CHARS)}…`
      : serialized;
  } catch {
    return undefined;
  }
}

function previewContext(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > CONTEXT_PREVIEW_CHARS ? `${value.slice(0, CONTEXT_PREVIEW_CHARS)}…` : value;
}

/** 一个不做任何事的 recorder，供 text 模式与测试替身使用。 */
export const NOOP_TRAJECTORY_RECORDER: TrajectoryRecorder = {
  beginTurn: () => {},
  noteContext: () => {},
  captureHeader: () => undefined,
  stepStart: () => {},
  firstToken: () => {},
  stepEnd: () => {},
  noteRetry: () => {},
  noteFailover: () => {},
  noteTransport: () => {},
  toolStart: () => {},
  toolEnd: () => {},
  compactionStart: () => {},
  compactionEnd: () => {},
  endTurn: () => {},
  flush: async () => {},
  dispose: async () => {},
  discard: () => {},
};

/**
 * 创建会话级 recorder。
 *
 * @param params - 会话标识、当前活动 segment 的读取器与落盘/下发端口。
 * @returns 埋点接口。
 */
export function createTrajectoryRecorder(params: {
  conversationId: string;
  getSegmentIndex: () => number;
  ports: TrajectoryRecorderPorts;
  flushIntervalMs?: number;
}): TrajectoryRecorder {
  const { conversationId, getSegmentIndex, ports } = params;
  const flushIntervalMs = params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  let lastHeader: { headerId: string; refs: TrajectorySectionRefs } | undefined;
  // Events before beginTurn are retained as turn 1 rather than discarded.
  let currentTurn = 1;
  let turnOpen = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const firstTokenSeen = new Set<string>();
  const openSteps = new Set<string>();
  const toolHosts = new Map<string, { turn: number; step: number }>();

  const warn = (error: unknown) => {
    console.warn("[trajectory] recorder step failed; chat is unaffected", error);
  };
  const queue = createTrajectoryPersistenceQueue({ conversationId, ports, warn });

  /** err 字段的统一入口：供应商报错可能回显带密钥的 URL/头，落盘前洗掉。 */
  const scrubError = (error: string | undefined): string | undefined =>
    error === undefined ? undefined : scrubSecretsFromErrorText(error);

  const scheduleFlush = () => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void queue.flush();
    }, flushIntervalMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const segmentAtEmit = () => {
    try {
      const index = getSegmentIndex();
      return Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
    } catch (error) {
      warn(error);
      return 0;
    }
  };

  const emit = (event: TrajectoryEvent) => {
    if (disposed) return;
    queue.pushEvent(segmentAtEmit(), event);
    try {
      ports.publish?.([event]);
    } catch (error) {
      warn(error);
    }
    scheduleFlush();
  };

  const stopTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  async function flush(): Promise<void> {
    stopTimer();
    await queue.flush();
  }

  const stepKey = (turn: number, step: number) => `${turn} ${step}`;

  const emitStepEnd = (turn: number, step: number, info: TrajectoryStepEndInfo) => {
    openSteps.delete(stepKey(turn, step));
    const error = scrubError(info.error);
    emit({
      k: "step_end",
      t: turn,
      s: step,
      at: Date.now(),
      st: info.status,
      ...(info.usage === undefined ? {} : { u: info.usage }),
      ...(info.provider === undefined ? {} : { p: info.provider }),
      ...(info.model === undefined ? {} : { m: info.model }),
      ...(info.api === undefined ? {} : { api: info.api }),
      ...(info.stopReason === undefined ? {} : { sr: info.stopReason }),
      ...(error === undefined ? {} : { err: error }),
    });
  };

  return {
    beginTurn: ({ turn, messageIndex, messageId, text }) => {
      currentTurn = turn;
      turnOpen = true;
      emit({
        k: "user",
        t: turn,
        at: Date.now(),
        ...(messageIndex === undefined ? {} : { mi: messageIndex }),
        ...(messageId === undefined || messageId === "" ? {} : { id: messageId }),
        ...(text === undefined || text === "" ? {} : { tx: text }),
      });
    },
    noteContext: ({ source, text }) => {
      const preview = previewContext(text);
      emit({
        k: "context",
        t: currentTurn,
        at: Date.now(),
        ...(source === undefined ? {} : { src: source }),
        ...(preview === undefined ? {} : { tx: preview }),
      });
    },
    captureHeader: (input) => {
      if (disposed) return undefined;
      try {
        const built = buildTrajectoryHeader(input, lastHeader);
        if (built.change === "none" && lastHeader !== undefined) return lastHeader.headerId;
        if (built.sections.length > 0) queue.pushSections(built.sections);
        emit({
          k: "header",
          v: 2,
          at: Date.now(),
          hid: built.headerId,
          sec: built.refs,
          ch: built.change,
          ...(lastHeader === undefined ? {} : { prev: lastHeader.headerId }),
        });
        lastHeader = { headerId: built.headerId, refs: built.refs };
        return built.headerId;
      } catch (error) {
        warn(error);
        return undefined;
      }
    },
    stepStart: (step, headerId) => {
      openSteps.add(stepKey(currentTurn, step));
      emit({
        k: "step_start",
        t: currentTurn,
        s: step,
        at: Date.now(),
        ...(headerId === undefined ? {} : { hid: headerId }),
      });
    },
    firstToken: (step) => {
      const key = `${currentTurn} ${step}`;
      if (firstTokenSeen.has(key)) return;
      firstTokenSeen.add(key);
      emit({ k: "first_token", t: currentTurn, s: step, at: Date.now() });
    },
    stepEnd: (step, info) => {
      emitStepEnd(currentTurn, step, info);
    },
    noteRetry: (step, info) => {
      const error = scrubError(info.error);
      emit({
        k: "retry",
        t: currentTurn,
        s: step,
        at: Date.now(),
        n: info.attempt,
        ...(info.maxRetries === undefined ? {} : { max: info.maxRetries }),
        ...(info.delayMs === undefined ? {} : { delay: info.delayMs }),
        ...(error === undefined ? {} : { err: error }),
        ...(info.provider === undefined ? {} : { p: info.provider }),
      });
    },
    noteFailover: (step, info) => {
      const error = scrubError(info.error);
      emit({
        k: "failover",
        t: currentTurn,
        s: step,
        at: Date.now(),
        n: info.attempt,
        ...(info.fromLabel === undefined ? {} : { from: info.fromLabel }),
        ...(info.toLabel === undefined ? {} : { to: info.toLabel }),
        ...(info.targetIndex === undefined ? {} : { ti: info.targetIndex }),
        ...(error === undefined ? {} : { err: error }),
      });
    },
    noteTransport: (step, info) => {
      emit({
        k: "transport",
        t: currentTurn,
        s: step,
        at: Date.now(),
        ...(info.provider === undefined ? {} : { p: info.provider }),
        ...(info.upstreamOrigin === undefined ? {} : { o: info.upstreamOrigin }),
        ...(info.useSystemProxy === undefined ? {} : { sp: info.useSystemProxy }),
        ...(info.fullUrl === undefined ? {} : { fu: info.fullUrl }),
        ...(info.headerNames === undefined || info.headerNames.length === 0
          ? {}
          : { hn: [...info.headerNames] }),
      });
    },
    toolStart: (step, toolCall) => {
      toolHosts.set(toolCall.id, { turn: currentTurn, step: step });
      const args = previewArgs(toolCall.arguments);
      emit({
        k: "tool_start",
        t: currentTurn,
        s: step,
        at: Date.now(),
        id: toolCall.id,
        n: toolCall.name,
        ...(args === undefined ? {} : { a: args }),
      });
    },
    toolEnd: (callId, info) => {
      const toolHost = toolHosts.get(callId);
      emit({
        k: "tool_end",
        at: Date.now(),
        id: callId,
        ...(toolHost === undefined ? {} : { t: toolHost.turn, s: toolHost.step }),
        ...(info.isError === true ? { err: true } : {}),
        ...(info.summary === undefined ? {} : { sum: info.summary }),
        ...(info.subagentRunIds === undefined || info.subagentRunIds.length === 0
          ? {}
          : { run: [...info.subagentRunIds] }),
      });
      toolHosts.delete(callId);
    },
    compactionStart: (options) => {
      emit({
        k: "compaction_start",
        t: options?.standalone === true ? null : currentTurn,
        at: Date.now(),
      });
    },
    compactionEnd: (info) => {
      const error = scrubError(info.error);
      emit({
        k: "compaction_end",
        t: info.standalone === true ? null : currentTurn,
        at: Date.now(),
        st: info.status,
        ...(info.tokensBefore === undefined ? {} : { before: info.tokensBefore }),
        ...(info.tokensAfter === undefined ? {} : { after: info.tokensAfter }),
        ...(error === undefined ? {} : { err: error }),
      });
    },
    endTurn: (info) => {
      if (!turnOpen) return;
      turnOpen = false;
      const error = scrubError(info.error);
      const unfinishedSteps = [...openSteps]
        .map((key) => {
          const [turnText, stepText] = key.split(" ");
          return { turn: Number(turnText), step: Number(stepText) };
        })
        .filter(
          ({ turn, step }) =>
            turn === currentTurn && Number.isFinite(step) && Number.isInteger(step),
        )
        .sort((left, right) => left.step - right.step);
      for (const { step } of unfinishedSteps) {
        // A provider may fail or be cancelled before it yields a terminal assistant message.
        // Close the request before the turn so the model row retains the real terminal status
        // and error instead of being reconstructed later as a generic interruption.
        emitStepEnd(currentTurn, step, {
          status: info.status,
          ...(info.error === undefined ? {} : { error: info.error }),
        });
      }
      emit({
        k: "turn_end",
        t: currentTurn,
        at: Date.now(),
        st: info.status,
        ...(error === undefined ? {} : { err: error }),
      });
    },
    flush,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      stopTimer();
      for (let attempt = 0; attempt < DISPOSE_FLUSH_ATTEMPTS; attempt += 1) {
        await queue.flush();
        if (!queue.hasPending()) break;
        // Yield between immediate retries without delaying chat teardown.
        await Promise.resolve();
      }
    },
    discard: () => {
      if (disposed) return;
      disposed = true;
      stopTimer();
      queue.discard();
    },
  };
}
