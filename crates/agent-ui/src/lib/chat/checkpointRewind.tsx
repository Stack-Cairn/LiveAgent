import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { useLocale } from "@liveagent/ui/i18n/index";
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
  zh: boolean,
): { level: "success" | "error"; message: string } {
  const nb = (value: number) => `\u00A0${value}\u00A0`;
  const files = (value: number) => `${value} ${value === 1 ? "file" : "files"}`;
  const changes: string[] = [];
  const issues: string[] = [];
  if (zh) {
    if (info.restoredFiles > 0) changes.push(`恢复${nb(info.restoredFiles)}个`);
    if (info.deletedFiles > 0) changes.push(`删除${nb(info.deletedFiles)}个`);
    // 组尾统一补"文件":单项时"删除 1 个文件",双项时"恢复 2 个、删除 1 个文件"。
    if (changes.length > 0) changes[changes.length - 1] += "文件";
    if (info.conflicts > 0) issues.push(`冲突跳过${nb(info.conflicts)}个`);
    if (info.failed > 0) issues.push(`失败${nb(info.failed)}个`);
    if (info.captureErrors > 0) issues.push(`${info.captureErrors}\u00A0个无前像未回退`);
  } else {
    if (info.restoredFiles > 0) changes.push(`restored ${files(info.restoredFiles)}`);
    if (info.deletedFiles > 0) changes.push(`deleted ${files(info.deletedFiles)}`);
    if (info.conflicts > 0)
      issues.push(`${info.conflicts} conflict${info.conflicts === 1 ? "" : "s"} skipped`);
    if (info.failed > 0) issues.push(`${info.failed} failed`);
    if (info.captureErrors > 0) issues.push(`${info.captureErrors} without pre-image`);
  }
  const head = zh
    ? changes.length > 0
      ? `已回退代码：${changes.join("、")}`
      : "已回退代码：没有文件需要改动"
    : changes.length > 0
      ? `Code rewound: ${changes.join(", ")}`
      : "Code rewound: no file changes were needed";
  const message =
    issues.length > 0
      ? zh
        ? `${head}（${issues.join("、")}）`
        : `${head} (${issues.join(", ")})`
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
  onRewind?: () => void;
};

type CheckpointRewindContextValue = {
  turns: Map<string, CheckpointTurnSummary>;
  loading: boolean;
  disabled: boolean;
  busyTurn: number | null;
  rewind: (turn: CheckpointTurnSummary) => void;
};

const CheckpointRewindContext = createContext<CheckpointRewindContextValue | null>(null);

// 仅覆盖 Write/Edit/Delete 三个文件工具的改动;Bash 等 shell 写入不在检查点内。
// 回退点 = 用户消息:turnId 就是用户消息 ID,行内按钮经 useCheckpointRewindAction
// 按 messageId 命中本轮(对齐 Claude Code 的每消息回退)。
export function CheckpointRewindProvider(props: {
  children: ReactNode;
  conversationId?: string;
  /** 发送/流式中为 true:行内按钮全体禁用,且暂停列表刷新。 */
  disabled?: boolean;
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
    disabled = false,
    client,
    resolveAuthorizedRoots,
    onRewound,
  } = props;
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const { confirm, dialog } = useConfirmDialog();
  const [turns, setTurns] = useState<CheckpointTurnSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);

  // latest-ref:宿主通常内联传这两个回调(每渲染新身份)。若做依赖,rewind 与
  // context value 会随宿主每帧重建,流式期间放大成全部用户行重渲染。
  const resolveRootsRef = useRef(resolveAuthorizedRoots);
  const onRewoundRef = useRef(onRewound);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    resolveRootsRef.current = resolveAuthorizedRoots;
    onRewoundRef.current = onRewound;
    disabledRef.current = disabled;
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
    if (!disabled) void loadTurns();
  }, [disabled, loadTurns]);

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
        const parts: string[] = [];
        if (stats.restoreFiles > 0)
          parts.push(
            zh ? `恢复 ${stats.restoreFiles} 个文件` : `restore ${stats.restoreFiles} file(s)`,
          );
        if (stats.deleteFiles > 0)
          parts.push(
            zh ? `删除 ${stats.deleteFiles} 个文件` : `delete ${stats.deleteFiles} file(s)`,
          );
        if (stats.cleanFiles > 0)
          parts.push(
            zh ? `${stats.cleanFiles} 个文件已一致` : `${stats.cleanFiles} file(s) unchanged`,
          );
        if (stats.skippedDirs > 0)
          parts.push(
            zh
              ? `${stats.skippedDirs} 个目录删除不可恢复`
              : `${stats.skippedDirs} deleted dir(s) not restorable`,
          );
        if (stats.missingBlobs > 0)
          parts.push(
            zh ? `${stats.missingBlobs} 个前像缺失` : `${stats.missingBlobs} blob(s) missing`,
          );
        if (stats.unresolvableFiles > 0)
          parts.push(
            zh
              ? `${stats.unresolvableFiles} 个路径已不可回退（根未授权或路径含符号链接）`
              : `${stats.unresolvableFiles} path(s) not rewindable (root unauthorized or symlinked)`,
          );
        if (stats.captureErrors > 0 || turn.incomplete)
          parts.push(
            zh
              ? `⚠ 该轮有 ${Math.max(stats.captureErrors, 1)} 次前像捕获失败，回退可能不完整`
              : `⚠ ${Math.max(stats.captureErrors, 1)} pre-image capture failure(s); rewind may be incomplete`,
          );
        const actionable = stats.entries.filter(
          (entry) => entry.action === "restore" || entry.action === "delete",
        );
        // 检查点只记录 agent 工具写入前的前像,编辑器/文件树里的手改既不入账、
        // 也无法与工具写入区分。回退按前像整体覆盖,手改会被一并抹掉,先说清楚。
        if (actionable.length > 0)
          parts.push(
            zh
              ? "手动编辑（编辑器/文件树）不在检查点内，会被一并覆盖"
              : "Manual edits (editor / file tree) are not checkpointed and will be overwritten",
          );
        const confirmed = await confirm({
          title: zh ? "回退代码到此轮开始前" : "Rewind code to before this turn",
          subtitle: new Date(turn.firstCapturedAt).toLocaleString(),
          description:
            parts.length > 0
              ? parts.join(zh ? "，" : ", ")
              : zh
                ? "没有需要回退的改动"
                : "Nothing to rewind",
          detail:
            actionable.length > 0 ? actionable.map((entry) => entry.path).join("\n") : undefined,
          confirmLabel: zh ? "回退" : "Rewind",
          cancelLabel: zh ? "取消" : "Cancel",
          tone: "warning",
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
              zh ? `冲突(已跳过): ${path}` : `conflict (skipped): ${path}`,
            ),
            ...result.failed.map((path) => (zh ? `失败: ${path}` : `failed: ${path}`)),
          ];
          // 捕获缺口/不可恢复目录没有具体路径列表,单独一行说明。
          if (result.captureErrors > 0)
            issueLines.push(
              zh
                ? `该轮有 ${result.captureErrors} 个文件没有前像(捕获失败),未被回退`
                : `${result.captureErrors} file(s) had no pre-image (capture failed) and were not rewound`,
            );
          if (result.skippedDirs > 0)
            issueLines.push(
              zh
                ? `${result.skippedDirs} 个被删除目录无法恢复`
                : `${result.skippedDirs} deleted dir(s) could not be restored`,
            );
          await confirm({
            title: zh ? "回退部分未完成" : "Rewind partially completed",
            description: zh
              ? `已恢复 ${result.restoredFiles} 个、删除 ${result.deletedFiles} 个；冲突跳过 ${result.conflicts.length} 个、失败 ${result.failed.length} 个`
              : `Restored ${result.restoredFiles}, deleted ${result.deletedFiles}; ${result.conflicts.length} conflict(s) skipped, ${result.failed.length} failed`,
            detail: issueLines.join("\n"),
            confirmLabel: zh ? "知道了" : "OK",
            cancelLabel: "",
            hideCancel: true,
            tone: "destructive",
          });
        }
      } catch (error) {
        await confirm({
          title: zh ? "回退失败" : "Rewind failed",
          description: String(error),
          confirmLabel: zh ? "知道了" : "OK",
          cancelLabel: "",
          hideCancel: true,
          tone: "destructive",
        });
      } finally {
        busyTurnRef.current = null;
        setBusyTurn(null);
      }
    },
    [client, confirm, conversationId, loadTurns, zh],
  );

  const value = useMemo<CheckpointRewindContextValue>(
    () => ({
      turns: new Map(turns.map((turn) => [turn.turnId, turn])),
      loading,
      disabled,
      busyTurn,
      rewind: (turn) => void rewind(turn),
    }),
    [busyTurn, disabled, loading, rewind, turns],
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
    onRewind: turn ? () => context.rewind(turn) : undefined,
  };
}
