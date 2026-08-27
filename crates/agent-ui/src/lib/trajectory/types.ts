/**
 * 轨迹域的单一类型真源。
 *
 * 三种形态严格分开：
 * - `TrajectoryEvent` 是**线格式**：短字段名，走实时通道并落盘，字段只增不改。
 * - `TrajectoryLedger` 是**规范化中间态**：eventLog 收敛后的可读结构，纯内存。
 * - `TrajectoryRecord` 是**视觉记录**：布局产物，UI 只认这个。
 */

/** 一次操作的终态。`running` 只在实时账本里出现。 */
export type TrajectoryStatus = "running" | "complete" | "error" | "aborted";

/** 账本行类别，与泳道归属一一对应。 */
export type TrajectoryRecordKind =
  | "system"
  | "user"
  | "context"
  | "compacted"
  | "message"
  | "tool"
  | "subtool";

/** 与 `UsagePanelUsage` 对齐，另加推理 token。 */
export type TrajectoryUsage = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

/**
 * 线格式中的固定槽位顺序。只能向末尾追加：前六项已经落盘，重排会把旧事件的
 * toolsSuffix/toolCatalog 错读成别的内容。
 */
export const TRAJECTORY_SECTION_SLOTS = [
  "base",
  "agent",
  "skills",
  "memory",
  "toolsSuffix",
  "toolCatalog",
  "runtime",
] as const;

export type TrajectorySectionSlot = (typeof TRAJECTORY_SECTION_SLOTS)[number];

/** 模型实际看到的 system prompt 拼接顺序；toolCatalog 是请求参数，不进入正文。 */
export const TRAJECTORY_PROMPT_SECTION_SLOTS = [
  "base",
  "agent",
  "skills",
  "memory",
  "runtime",
  "toolsSuffix",
] as const satisfies readonly TrajectorySectionSlot[];

/** 各槽位的 sectionId，缺省为 null；旧记录允许短于当前槽位数。 */
export type TrajectorySectionRefs = readonly (string | null)[];

/** 请求头相对上一份的变化类别。 */
export type TrajectoryHeaderChange = "initial" | "system" | "tools" | "system-and-tools" | "none";

/** 一份分段内容，内容寻址。 */
export type TrajectorySection = {
  sectionId: string;
  slot: TrajectorySectionSlot;
  content: string;
};

// ---------------------------------------------------------------------------
// 线格式
// ---------------------------------------------------------------------------

/**
 * 落盘与实时通道共用的紧凑事件。字段名刻意取短名：一个 50 次工具调用的长回合
 * 约 150 条事件，短名把它压在 ~18 KB，远低于中继窗口的 8 MiB 上限。
 */
export type TrajectoryEvent =
  /** 用户消息开启一轮。`mi` 是会话内 messageIndex，用于跨视图定位。 */
  | { k: "user"; t: number; at: number; mi?: number; id?: string; tx?: string }
  /** 上下文注入。 */
  | { k: "context"; t: number; at: number; src?: string; tx?: string }
  /** 请求头快照。`sec` 是按线格式槽位排列的 sectionId，`ch` 变化类别，`prev` 上一份 headerId。 */
  | {
      k: "header";
      /** Header slot layout version. Missing/1 is the legacy six-slot layout. */
      v?: number;
      at: number;
      hid: string;
      sec: TrajectorySectionRefs;
      ch: TrajectoryHeaderChange;
      prev?: string;
    }
  /** 一次 provider 请求开始。 */
  | { k: "step_start"; t: number; s: number; at: number; hid?: string }
  /** 首个 text/thinking delta，用于推导 TTFT。 */
  | { k: "first_token"; t: number; s: number; at: number }
  /** 请求结束。`sr` 是 stopReason。 */
  | {
      k: "step_end";
      t: number;
      s: number;
      at: number;
      st: TrajectoryStatus;
      u?: TrajectoryUsage;
      p?: string;
      m?: string;
      api?: string;
      sr?: string;
      err?: string;
    }
  /** 失败后的重试记录。`p` 是候选标签（"Provider · model"），failover 下区分各候选的重试。 */
  | {
      k: "retry";
      t: number;
      s: number;
      at: number;
      n: number;
      max?: number;
      delay?: number;
      err?: string;
      p?: string;
    }
  /** 跨供应商切换记录。`n` 是本次请求内的切换序号，`ti` 是目标在候选队列里的下标。 */
  | {
      k: "failover";
      t: number;
      s: number;
      at: number;
      n: number;
      from?: string;
      to?: string;
      ti?: number;
      err?: string;
    }
  /**
   * 一次实际尝试的传输装配快照。脱敏不变量：只含头名（`hn`）与路由标记，
   * 绝不含任何头值或密钥；`o` 是上游 origin（scheme+host）。
   */
  | {
      k: "transport";
      t: number;
      s: number;
      at: number;
      p?: string;
      o?: string;
      sp?: boolean;
      fu?: boolean;
      hn?: readonly string[];
    }
  /** 工具开始执行。`a` 是截断后的参数文本。 */
  | { k: "tool_start"; t: number; s: number; at: number; id: string; n: string; a?: string }
  /** 工具结束。`run` 是 Agent 工具派生的子代理 runId。 */
  | {
      k: "tool_end";
      at: number;
      id: string;
      /** New writers include the host; old persisted events remain valid without it. */
      t?: number;
      s?: number;
      err?: boolean;
      sum?: string;
      run?: readonly string[];
    }
  /** 上下文压缩开始。turn 为 null 表示两轮之间的手动压缩。 */
  | { k: "compaction_start"; t: number | null; at: number }
  /** 上下文压缩结束，附压缩前后 token。 */
  | {
      k: "compaction_end";
      t: number | null;
      at: number;
      st: TrajectoryStatus;
      before?: number;
      after?: number;
      err?: string;
    }
  /** 一轮结束。 */
  | { k: "turn_end"; t: number; at: number; st: TrajectoryStatus; err?: string };

export type TrajectoryEventKind = TrajectoryEvent["k"];

// ---------------------------------------------------------------------------
// 规范化中间态
// ---------------------------------------------------------------------------

export type LedgerRetry = {
  attempt: number;
  at: number;
  maxRetries?: number;
  delayMs?: number;
  error?: string;
  /** 候选标签（"Provider · model"）；failover 下区分各候选自己的重试。 */
  provider?: string;
};

export type LedgerFailover = {
  attempt: number;
  at: number;
  fromLabel?: string;
  toLabel?: string;
  /** 目标在候选队列里的稳定下标（0 = 主选）。 */
  targetIndex?: number;
  error?: string;
};

/** 一次实际尝试的传输装配快照。只含头名与路由标记，永不含头值。 */
export type LedgerTransport = {
  at: number;
  provider?: string;
  upstreamOrigin?: string;
  useSystemProxy?: boolean;
  fullUrl?: boolean;
  headerNames?: readonly string[];
};

export type LedgerToolCall = {
  callId: string;
  name: string;
  args?: string;
  startedAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  isError: boolean;
  summary?: string;
  subagentRunIds: readonly string[];
};

export type LedgerStep = {
  turn: number;
  step: number;
  startedAt: number | null;
  firstTokenAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  error?: string;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  usage?: TrajectoryUsage;
  headerId?: string;
  retries: readonly LedgerRetry[];
  failovers: readonly LedgerFailover[];
  transports: readonly LedgerTransport[];
  tools: readonly LedgerToolCall[];
};

export type LedgerCompaction = {
  turn: number | null;
  startedAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
};

export type LedgerInput = {
  kind: "user" | "context";
  turn: number;
  at: number | null;
  /** Stable identity of the source event; keeps same-millisecond inputs distinct. */
  eventId?: string;
  messageIndex?: number;
  messageId?: string;
  source?: string;
  text?: string;
};

export type LedgerTurn = {
  turn: number;
  startedAt: number | null;
  endedAt: number | null;
  status: TrajectoryStatus;
  error?: string;
  inputs: readonly LedgerInput[];
  steps: readonly LedgerStep[];
  compactions: readonly LedgerCompaction[];
};

export type LedgerHeader = {
  /** Stable occurrence identity. The same content can become active more than once. */
  headerId: string;
  /** Content-addressed id carried on the wire (`TrajectoryEvent.hid`). */
  contentId: string;
  at: number;
  sections: TrajectorySectionRefs;
  change: TrajectoryHeaderChange;
  previousHeaderId?: string;
};

/**
 * eventLog 的收敛产物。`hasTiming` 为 false 表示这份账本是从 messages 降级推导
 * 的：结构完整但所有时长为 null，甘特图必须锁在 sequence 投影。
 */
export type TrajectoryLedger = {
  turns: readonly LedgerTurn[];
  headers: ReadonlyMap<string, LedgerHeader>;
  /** 两轮之间发生的压缩，不属于任何 turn。 */
  standaloneCompactions: readonly LedgerCompaction[];
  hasTiming: boolean;
};

/** 空账本常量，供未加载态复用同一引用避免重渲染。 */
export const EMPTY_TRAJECTORY_LEDGER: TrajectoryLedger = {
  turns: [],
  headers: new Map(),
  standaloneCompactions: [],
  hasTiming: false,
};

// ---------------------------------------------------------------------------
// 视觉记录
// ---------------------------------------------------------------------------

/** 子代理一次运行的摘要，由宿主预取后传入 layout。 */
export type TrajectorySubagentRun = {
  runId: string;
  agentId: string;
  name?: string;
  mode?: string;
  status: TrajectoryStatus;
  startedAt: number | null;
  endedAt: number | null;
  steps: readonly {
    step: number;
    startedAt: number | null;
    endedAt: number | null;
    tools: readonly {
      callId: string;
      name: string;
      isError: boolean;
      /** 工具自身的起止（来自子代理消息时间戳）；缺失时布局层回退 step 跨度。 */
      startedAt?: number | null;
      endedAt?: number | null;
    }[];
  }[];
};

/** 详情面板用的一段原始内容块，保持模型顺序。 */
export type TrajectorySourceBlock = {
  type: string;
  content: string;
  callId?: string;
  toolName?: string;
  imageSrc?: string;
  imageAlt?: string;
  filePath?: string;
  fileSource?: "absolute" | "relative" | "file-url";
};

/** assistant 专属的时序事实，用于 TTFT / 解码吞吐。 */
export type TrajectoryAssistantMetrics = {
  timingRecorded: boolean;
  stepStartAt: number | null;
  firstTokenAt: number | null;
  completedAt: number | null;
  outputTokens: number | null;
};

/** 一条账本行。`index` 是全局 1-based 序号，渲染与时间轴共用。 */
export type TrajectoryRecord = {
  index: number;
  recordId: string;
  kind: TrajectoryRecordKind;
  /** 单行摘要文本；溢出由 CSS 省略。 */
  text: string;
  /** 工具结果摘要，与调用同处一行。 */
  result?: string;
  turn: number | null;
  step: number | null;
  status: TrajectoryStatus;
  isError: boolean;
  /** 自身耗时（秒）。null 表示未知——降级账本全为 null。 */
  timeSeconds: number | null;
  startedAt: number | null;
  callId?: string;
  toolName?: string;
  messageIndex?: number;
  headerId?: string;
  previousHeaderId?: string;
  headerChange?: TrajectoryHeaderChange;
  usage?: TrajectoryUsage;
  cumulativeUsage?: TrajectoryUsage;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  error?: string;
  retries?: readonly LedgerRetry[];
  failovers?: readonly LedgerFailover[];
  transports?: readonly LedgerTransport[];
  assistantMetrics?: TrajectoryAssistantMetrics;
  inputDetail?: string;
  outputDetail?: string;
  thinkingDetail?: string;
  schemaDetail?: string;
  sourceBlocks?: readonly TrajectorySourceBlock[];
  outputBlocks?: readonly TrajectorySourceBlock[];
  tokensBefore?: number;
  tokensAfter?: number;
  subagentRunId?: string;
  /** 仅作为请求分隔锚点、不渲染内容的行。 */
  requestOnly?: boolean;
};

/** turn 内的一组记录（`Message` 或 `Step N`）。 */
export type TrajectoryGroupModel = {
  title: string;
  description?: string;
  records: readonly TrajectoryRecord[];
};

/** 一个 turn，或两轮之间的独立压缩段（turn 为 null）。 */
export type TrajectoryTurnModel = {
  turn: number | null;
  groups: readonly TrajectoryGroupModel[];
};
