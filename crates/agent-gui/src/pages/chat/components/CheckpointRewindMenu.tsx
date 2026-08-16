import { History, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { WorkspaceProject } from "../../../lib/settings";
import { listWorkspaceRootGrants } from "../../../lib/workspaceRootGrants";

type CheckpointTurnSummary = {
  turnSeq: number;
  turnId: string;
  fileCount: number;
  dirCount: number;
  /** 该轮存在捕获失败记录(前像不完整),回退可能遗漏部分文件。 */
  incomplete: boolean;
  firstCapturedAt: number;
};

type CheckpointDiffStats = {
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

type CheckpointRewindResult = {
  turnSeq: number;
  restoredFiles: number;
  deletedFiles: number;
  cleanFiles: number;
  skippedDirs: number;
  /** 预览后被外部修改、被跳过未覆盖的文件(冲突检测)。 */
  conflicts: string[];
  failed: string[];
};

// 仅覆盖 Write/Edit/Delete 三个文件工具的改动;Bash 等 shell 写入不在检查点内。
// 桌面端专属入口:检查点数据只存在于桌面本机,WebUI 暂不提供(P2)。
export function CheckpointRewindMenu(props: {
  conversationId: string;
  /** 当前会话的工作区根：授权集合的基准项。 */
  workspaceRoot?: string;
  /** 当前激活项目：用于取额外授权根（workspace root grants）。 */
  project?: Pick<WorkspaceProject, "id" | "path"> | null;
  disabled?: boolean;
  /** 回退完成后回调(通知/转录记录由宿主页面处理)。 */
  onRewound?: (info: {
    turnSeq: number;
    restoredFiles: number;
    deletedFiles: number;
    conflicts: number;
    failed: number;
  }) => void;
}) {
  const { conversationId, workspaceRoot, project, disabled, onRewound } = props;
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const { confirm, dialog } = useConfirmDialog();
  const [turns, setTurns] = useState<CheckpointTurnSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const loadTurns = async () => {
    setLoading(true);
    try {
      const list = await invoke<CheckpointTurnSummary[]>("checkpoint_list", {
        conversation_id: conversationId,
      });
      setTurns(list);
    } catch {
      setTurns([]);
    } finally {
      setLoading(false);
    }
  };

  // 回退授权的唯一来源：当前会话工作区根 + 仍处于 active 的额外授权根。
  // 后端只认这个集合里的 root，记录里存的绝对路径本身不构成授权。
  const resolveAuthorizedRoots = async () => {
    const roots: string[] = [];
    const push = (raw?: string | null) => {
      const value = raw?.trim();
      if (value && !roots.includes(value)) roots.push(value);
    };
    push(workspaceRoot);
    if (project) {
      try {
        const grants = await listWorkspaceRootGrants(project);
        for (const grant of grants) {
          if (grant.state === "active") push(grant.canonicalPath);
        }
      } catch {
        // 取不到额外授权根时只保留工作区根：宁可少回退，不可越权写入。
      }
    }
    return roots;
  };

  const rewindTo = async (turn: CheckpointTurnSummary) => {
    const turnSeq = turn.turnSeq;
    setBusyTurn(turnSeq);
    try {
      const authorizedRoots = await resolveAuthorizedRoots();
      const stats = await invoke<CheckpointDiffStats>("checkpoint_diff_stats", {
        conversation_id: conversationId,
        turn_seq: turnSeq,
        authorized_roots: authorizedRoots,
      });
      const parts: string[] = [];
      if (stats.restoreFiles > 0)
        parts.push(
          zh ? `恢复 ${stats.restoreFiles} 个文件` : `restore ${stats.restoreFiles} file(s)`,
        );
      if (stats.deleteFiles > 0)
        parts.push(zh ? `删除 ${stats.deleteFiles} 个文件` : `delete ${stats.deleteFiles} file(s)`);
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
      // 检查点只记录 agent 工具写入前的前像，编辑器/文件树里的手改既不入账、
      // 也无法与工具写入区分。回退按前像整体覆盖，手改会被一并抹掉，先说清楚。
      if (actionable.length > 0)
        parts.push(
          zh
            ? "手动编辑（编辑器/文件树）不在检查点内，会被一并覆盖"
            : "Manual edits (editor / file tree) are not checkpointed and will be overwritten",
        );
      const detailPaths = actionable.map((entry) => entry.path);
      const confirmed = await confirm({
        title: zh ? "回退代码到此轮开始前" : "Rewind code to before this turn",
        subtitle: new Date(turn.firstCapturedAt).toLocaleString(),
        description:
          parts.length > 0
            ? parts.join(zh ? "，" : ", ")
            : zh
              ? "没有需要回退的改动"
              : "Nothing to rewind",
        detail: detailPaths.length > 0 ? detailPaths.join("\n") : undefined,
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
      const result = await invoke<CheckpointRewindResult>("checkpoint_rewind_code", {
        conversation_id: conversationId,
        turn_seq: turnSeq,
        authorized_roots: authorizedRoots,
        expected,
      });
      onRewound?.({
        turnSeq,
        restoredFiles: result.restoredFiles,
        deletedFiles: result.deletedFiles,
        conflicts: result.conflicts.length,
        failed: result.failed.length,
      });
      if (result.failed.length > 0 || result.conflicts.length > 0) {
        const issueLines = [
          ...result.conflicts.map((path) =>
            zh ? `冲突(已跳过): ${path}` : `conflict (skipped): ${path}`,
          ),
          ...result.failed.map((path) => (zh ? `失败: ${path}` : `failed: ${path}`)),
        ];
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
      setBusyTurn(null);
    }
  };

  const title = zh ? "回退代码改动" : "Rewind code changes";
  return (
    <>
      <DropdownMenu
        // disabled 只挡得住 trigger。菜单展开后用户才发出新一轮消息时，
        // isSending 翻真但列表还开着，仍能点进回退——那一轮的捕获正在写，
        // 回退会踩在半截时间线上。所以受控开合，disabled 一真就强制收起。
        open={open && !disabled}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) void loadTurns();
        }}
      >
        <DropdownMenuTrigger
          disabled={disabled}
          title={title}
          aria-label={title}
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95"
            />
          }
        >
          <History className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64 max-w-80">
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </DropdownMenuLabel>
          {loading ? (
            <div className="flex items-center justify-center px-2 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : !turns || turns.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {zh ? "本会话暂无文件改动检查点" : "No file-change checkpoints in this conversation"}
            </div>
          ) : (
            turns.map((turn) => (
              <DropdownMenuItem
                key={turn.turnId}
                disabled={busyTurn !== null}
                onClick={() => void rewindTo(turn)}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm">{new Date(turn.firstCapturedAt).toLocaleString()}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {busyTurn === turn.turnSeq ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    `${turn.fileCount}${zh ? " 个文件" : " file(s)"}${turn.incomplete ? " ⚠" : ""}`
                  )}
                </span>
              </DropdownMenuItem>
            ))
          )}
          <div className="px-2 pb-1 pt-1.5 text-[11px] leading-4 text-muted-foreground/80">
            {zh
              ? "仅覆盖文件工具的写入/编辑/删除；Shell 命令产生的改动不在回退范围。"
              : "Covers file-tool write/edit/delete only; shell-made changes are not tracked."}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}
