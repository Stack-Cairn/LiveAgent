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
  const { conversationId, disabled, onRewound } = props;
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const { confirm, dialog } = useConfirmDialog();
  const [turns, setTurns] = useState<CheckpointTurnSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyTurn, setBusyTurn] = useState<number | null>(null);

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

  const rewindTo = async (turn: CheckpointTurnSummary) => {
    const turnSeq = turn.turnSeq;
    setBusyTurn(turnSeq);
    try {
      const stats = await invoke<CheckpointDiffStats>("checkpoint_diff_stats", {
        conversation_id: conversationId,
        turn_seq: turnSeq,
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
      if (stats.captureErrors > 0 || turn.incomplete)
        parts.push(
          zh
            ? `⚠ 该轮有 ${Math.max(stats.captureErrors, 1)} 次前像捕获失败，回退可能不完整`
            : `⚠ ${Math.max(stats.captureErrors, 1)} pre-image capture failure(s); rewind may be incomplete`,
        );
      const actionable = stats.entries.filter(
        (entry) => entry.action === "restore" || entry.action === "delete",
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
      const expected = actionable.map((entry) => ({
        key: entry.key,
        currentHash: entry.currentHash ?? "absent",
      }));
      const result = await invoke<CheckpointRewindResult>("checkpoint_rewind_code", {
        conversation_id: conversationId,
        turn_seq: turnSeq,
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
          ...result.conflicts.map((path) => (zh ? `冲突(已跳过): ${path}` : `conflict (skipped): ${path}`)),
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
        onOpenChange={(open) => {
          if (open) void loadTurns();
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
