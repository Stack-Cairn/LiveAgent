import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { type Locale, t as translate, useLocale } from "@liveagent/ui/i18n/index";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type CheckpointTurnSummary = {
  turnSeq: number;
  turnId: string;
  fileCount: number;
  dirCount: number;
  /** 该轮存在捕获失败记录(前像不完整),回退可能遗漏部分文件。 */
  incomplete: boolean;
  firstCapturedAt: number;
};

export type CheckpointDiffStats = {
  turnSeq: number;
  restoreFiles: number;
  deleteFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  missingBlobs: number;
  /** 根已不在当前授权工作区集合内、或路径链上出现符号链接的条目：一律不回退。 */
  unresolvableFiles: number;
  captureErrors: number;
  entries: { path: string; key: string; action: string; currentHash?: string }[];
};

export type CheckpointRewindResult = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  /** 目标范围内捕获阶段就失败的记录数:这些文件没有前像,回退没有碰它们。 */
  captureErrors: number;
  /** 预览后被外部修改、被跳过未覆盖的文件(冲突检测)。 */
  conflicts: string[];
  failed: string[];
};

/** 两端各自实现的传输层:桌面端走 Tauri invoke,WebUI 走网关 checkpoint 直通臂。 */
export type CheckpointRewindClient = {
  list: (conversationId: string) => Promise<CheckpointTurnSummary[]>;
  preview: (params: {
    conversationId: string;
    turnSeq: number;
    authorizedRoots: string[];
  }) => Promise<CheckpointDiffStats>;
  rewind: (params: {
    conversationId: string;
    turnSeq: number;
    authorizedRoots: string[];
    expected: { key: string; currentHash: string }[];
  }) => Promise<CheckpointRewindResult>;
};

export type CheckpointRewoundInfo = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  conflicts: number;
  failed: number;
  /** 捕获阶段就失败的文件数:没有前像,回退没有碰它们。 */
  captureErrors: number;
};

/**
 * 回退完成通知的共享文案:两端 onRewound 都用它,避免模板漂移。
 * - 零计数一律不展示;完全没有文件改动时明确说"没有文件需要改动"。
 * - 数字与量词之间用不换行空格(U+00A0)钉住,窄 toast 里"1 个"不会被折成两行。
 * - 问题项(冲突/失败/无前像)collect 进括号尾注,与主结果分层。
 */
export function formatCheckpointRewoundNotification(
  info: CheckpointRewoundInfo,
  locale: Locale,
): { level: "success" | "error"; message: string } {
  const text = (key: string) => translate(`checkpointRewind.notice.${key}`, locale);
  const counted = (key: string, value: number) =>
    text(`${key}.${value === 1 ? "one" : "other"}`).replace("{count}", String(value));
  const changes: string[] = [];
  const issues: string[] = [];
  if (info.restoredFiles > 0) changes.push(counted("restored", info.restoredFiles));
  if (info.deletedFiles > 0) changes.push(counted("deleted", info.deletedFiles));
  if (info.conflicts > 0) issues.push(counted("conflicts", info.conflicts));
  if (info.failed > 0) issues.push(text("failed").replace("{count}", String(info.failed)));
  if (info.captureErrors > 0)
    issues.push(text("noPreImage").replace("{count}", String(info.captureErrors)));
  const separator = text("separator");
  const head =
    changes.length > 0
      ? text("head").replace(
          "{changes}",
          // Chinese closes the whole group with a single trailing noun ("files").
          text("changes").replace("{changes}", changes.join(separator)),
        )
      : text("headNone");
  const message =
    issues.length > 0
      ? text("withIssues").replace("{head}", head).replace("{issues}", issues.join(separator))
      : head;
  return {
    level: info.failed > 0 || info.conflicts > 0 || info.captureErrors > 0 ? "error" : "success",
    message,
  };
}

/** 行内回退按钮所需的全部状态:null 表示当前 turn 无检查点(按钮禁用展示)。 */
export type CheckpointRewindAction = {
  available: boolean;
  pending: boolean;
  disabled: boolean;
  disabledReason?: string;
  onRewind?: () => void;
};

type CheckpointRewindContextValue = {
  turns: Map<string, CheckpointTurnSummary>;
  loading: boolean;
  disabled: boolean;
  disabledReason?: string;
  busyTurn: number | null;
  rewind: (turn: CheckpointTurnSummary) => void;
};

const CheckpointRewindContext = createContext<CheckpointRewindContextValue | null>(null);

/**
 * 输入框“/rewind”的结果：started 表示已进入与行内按钮相同的预览确认流程；
 * none 表示本会话没有可回退的检查点；busy 表示发送中、列表加载中或已有回退在跑。
 */
export type CheckpointRewindLatestOutcome = "started" | "none" | "busy";

// 输入框与转录区不在同一棵 Provider 子树里，按会话 id 登记“回退最近一轮”。
const latestRewinders = new Map<string, () => CheckpointRewindLatestOutcome>();

/** 回退指定会话最近一轮的文件改动；该会话没有挂载中的 Provider 时返回 none。 */
export function requestCheckpointRewindLatest(
  conversationId: string,
): CheckpointRewindLatestOutcome {
  return latestRewinders.get(conversationId)?.() ?? "none";
}

// 仅覆盖 Write/Edit/Delete 三个文件工具的改动;Bash 等 shell 写入不在检查点内。
// 回退点 = 用户消息:turnId 就是用户消息 ID,行内按钮经 useCheckpointRewindAction
// 按 messageId 命中本轮(对齐 Claude Code 的每消息回退)。
export function CheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId?: string;
  /** 发送/流式中为 true:行内按钮全体禁用,且暂停列表刷新。 */
  disabled?: boolean;
  disabledReason?: string;
  client: CheckpointRewindClient;
  /**
   * 回退授权的唯一来源:当前会话工作区根 + 仍处于 active 且可写的额外授权根。
   * 后端只认这个集合里的 root,记录里存的绝对路径本身不构成授权;access 必须
   * 由调用方过滤(回退是写操作,只读根不该被写)。
   */
  resolveAuthorizedRoots: () => Promise<string[]>;
  onRewound?: (info: CheckpointRewoundInfo) => void;
}) {
  const {
    children,
    conversationId,
    disabledReason,
    disabled = false,
    client,
    resolveAuthorizedRoots,
    onRewound,
  } = props;
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const [turns, setTurns] = useState<CheckpointTurnSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);

  // latest-ref:宿主通常内联传这两个回调(每渲染新身份)。若做依赖,rewind 与
  // context value 会随宿主每帧重建,流式期间放大成全部用户行重渲染。
  const resolveRootsRef = useRef(resolveAuthorizedRoots);
  const onRewoundRef = useRef(onRewound);
  const unavailable = disabled || Boolean(disabledReason);
  const disabledRef = useRef(unavailable);
  useEffect(() => {
    resolveRootsRef.current = resolveAuthorizedRoots;
    onRewoundRef.current = onRewound;
    disabledRef.current = unavailable;
  });

  // 列表加载代际:慢响应(切会话前发出的)一律丢弃,防乱序覆盖。
  const loadEpochRef = useRef(0);
  const loadTurns = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    if (!conversationId) {
      setTurns([]);
      return;
    }
    setLoading(true);
    try {
      const list = await client.list(conversationId);
      if (loadEpochRef.current === epoch) setTurns(list);
    } catch {
      if (loadEpochRef.current === epoch) setTurns([]);
    } finally {
      if (loadEpochRef.current === epoch) setLoading(false);
    }
  }, [client, conversationId]);

  // 切会话立刻清空旧列表:分支复制会保留消息 ID,旧会话的轮残留可能错配到
  // 新会话的同 ID 气泡上。
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity intentionally clears stale rewind state
  useEffect(() => {
    loadEpochRef.current += 1;
    setTurns([]);
  }, [conversationId]);

  // 空闲(挂载/切会话/轮次结束)时刷新;发送中不拉取,半截时间线没有展示价值。
  useEffect(() => {
    if (!unavailable) void loadTurns();
  }, [unavailable, loadTurns]);

  // busy 守卫走 ref:rewind 不依赖 busyTurn state,身份保持稳定。
  const busyTurnRef = useRef<number | null>(null);
  const rewind = useCallback(
    async (turn: CheckpointTurnSummary) => {
      if (!conversationId || disabledRef.current || busyTurnRef.current !== null) return;
      busyTurnRef.current = turn.turnSeq;
      setBusyTurn(turn.turnSeq);
      try {
        const authorizedRoots = await resolveRootsRef.current();
        const stats = await client.preview({
          conversationId,
          turnSeq: turn.turnSeq,
          authorizedRoots,
        });
        const counted = (key: string, value: number) =>
          t(`checkpointRewind.${key}.${value === 1 ? "one" : "other"}`).replace(
            "{count}",
            String(value),
          );
        const parts: string[] = [];
        if (stats.restoreFiles > 0) parts.push(counted("preview.restore", stats.restoreFiles));
        if (stats.deleteFiles > 0) parts.push(counted("preview.delete", stats.deleteFiles));
        if (stats.cleanFiles > 0) parts.push(counted("preview.clean", stats.cleanFiles));
        if (stats.skippedDirs > 0) parts.push(counted("preview.skippedDirs", stats.skippedDirs));
        if (stats.missingBlobs > 0) parts.push(counted("preview.missingBlobs", stats.missingBlobs));
        if (stats.unresolvableFiles > 0)
          parts.push(counted("preview.unresolvable", stats.unresolvableFiles));
        if (stats.captureErrors > 0 || turn.incomplete)
          parts.push(counted("preview.captureErrors", Math.max(stats.captureErrors, 1)));
        const actionable = stats.entries.filter(
          (entry) => entry.action === "restore" || entry.action === "delete",
        );
        // 检查点只记录 agent 工具写入前的前像,编辑器/文件树里的手改既不入账、
        // 也无法与工具写入区分。回退按前像整体覆盖,手改会被一并抹掉,先说清楚。
        if (actionable.length > 0) parts.push(t("checkpointRewind.preview.manualEdits"));
        const confirmed = await confirm({
          title: t("checkpointRewind.preview.title"),
          subtitle: new Date(turn.firstCapturedAt).toLocaleString(),
          description:
            parts.length > 0
              ? parts.join(t("checkpointRewind.preview.separator"))
              : t("checkpointRewind.preview.noChanges"),
          detail:
            actionable.length > 0 ? actionable.map((entry) => entry.path).join("\n") : undefined,
          confirmLabel: t("checkpointRewind.preview.confirm"),
          cancelLabel: t("checkpointRewind.preview.cancel"),
        });
        if (!confirmed) return;
        // 把预览时的现状哈希传回后端,回退前逐个复核:预览到执行之间被外部
        // 修改的文件会被跳过并报告为冲突,绝不覆盖(TOCTOU 防护)。
        // 必须回传全部可解析条目(含 clean)——后端对缺哈希的条目一律判冲突,
        // 只带 restore/delete 会让确认期间被手改的 clean 文件被静默覆盖。
        const expected = stats.entries.flatMap((entry) =>
          entry.currentHash == null ? [] : [{ key: entry.key, currentHash: entry.currentHash }],
        );
        const result = await client.rewind({
          conversationId,
          turnSeq: turn.turnSeq,
          authorizedRoots,
          expected,
        });
        onRewoundRef.current?.({
          turnSeq: turn.turnSeq,
          restoredFiles: result.restoredFiles,
          deletedFiles: result.deletedFiles,
          conflicts: result.conflicts.length,
          failed: result.failed.length,
          captureErrors: result.captureErrors,
        });
        // 完整回退会在后端剪掉 turnSeq 及之后的轮,重拉让按钮态跟上。
        await loadTurns();
        if (
          result.failed.length > 0 ||
          result.conflicts.length > 0 ||
          result.captureErrors > 0 ||
          result.skippedDirs > 0
        ) {
          const issueLines = [
            ...result.conflicts.map((path) =>
              t("checkpointRewind.result.conflict").replace("{path}", path),
            ),
            ...result.failed.map((path) =>
              t("checkpointRewind.result.failed").replace("{path}", path),
            ),
          ];
          // 捕获缺口/不可恢复目录没有具体路径列表,单独一行说明。
          if (result.captureErrors > 0)
            issueLines.push(counted("result.captureErrors", result.captureErrors));
          if (result.skippedDirs > 0)
            issueLines.push(counted("result.skippedDirs", result.skippedDirs));
          await confirm({
            title: t("checkpointRewind.result.partialTitle"),
            description: t("checkpointRewind.result.partialSummary")
              .replace("{restored}", String(result.restoredFiles))
              .replace("{deleted}", String(result.deletedFiles))
              .replace("{conflicts}", String(result.conflicts.length))
              .replace("{failed}", String(result.failed.length)),
            detail: issueLines.join("\n"),
            confirmLabel: t("checkpointRewind.result.ok"),
            cancelLabel: "",
            hideCancel: true,
          });
        }
      } catch (error) {
        await confirm({
          title: t("checkpointRewind.result.failedTitle"),
          description: String(error),
          confirmLabel: t("checkpointRewind.result.ok"),
          cancelLabel: "",
          hideCancel: true,
        });
      } finally {
        busyTurnRef.current = null;
        setBusyTurn(null);
      }
    },
    [client, confirm, conversationId, loadTurns, t],
  );

  const latestRef = useRef({ turns, loading });
  latestRef.current = { turns, loading };
  useEffect(() => {
    if (!conversationId) return;
    const rewindLatest = (): CheckpointRewindLatestOutcome => {
      const latest = latestRef.current;
      if (disabledRef.current || latest.loading || busyTurnRef.current !== null) return "busy";
      const turn = latest.turns.reduce<CheckpointTurnSummary | undefined>(
        (best, item) => (!best || item.turnSeq > best.turnSeq ? item : best),
        undefined,
      );
      if (!turn) return "none";
      void rewind(turn);
      return "started";
    };
    latestRewinders.set(conversationId, rewindLatest);
    return () => {
      // 同一会话可能被另一 Pane 的 Provider 接管，只清理自己登记的那一项。
      if (latestRewinders.get(conversationId) === rewindLatest) {
        latestRewinders.delete(conversationId);
      }
    };
  }, [conversationId, rewind]);

  const value = useMemo<CheckpointRewindContextValue>(
    () => ({
      turns: new Map(turns.map((turn) => [turn.turnId, turn])),
      loading,
      disabled: unavailable,
      disabledReason,
      busyTurn,
      rewind: (turn) => void rewind(turn),
    }),
    [busyTurn, disabledReason, loading, rewind, turns, unavailable],
  );

  return (
    <CheckpointRewindContext.Provider value={value}>
      {children}
      {dialog}
    </CheckpointRewindContext.Provider>
  );
}

/**
 * 按用户消息 ID 取本行的回退动作。Provider 之外返回 null(按钮以禁用态展示,
 * 只读页等不渲染动作区的场景自然无感)。
 */
export function useCheckpointRewindAction(turnId?: string): CheckpointRewindAction | null {
  const context = useContext(CheckpointRewindContext);
  if (!context) return null;
  const turn = turnId ? context.turns.get(turnId) : undefined;
  return {
    available: !!turn,
    pending: !!turn && context.busyTurn === turn.turnSeq,
    disabled: context.disabled || context.loading || context.busyTurn !== null || !turn,
    disabledReason: context.disabledReason,
    onRewind: turn ? () => context.rewind(turn) : undefined,
  };
}
