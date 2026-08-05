import {
  Ban,
  CheckCircle2,
  FolderOpen,
  GitBranch,
  Loader2,
  X,
  XCircle,
} from "../../../components/icons";
import { Button } from "../../../components/ui/button";
import { useLocale } from "../../../i18n";
import {
  cancelWorkspaceCloneTask,
  dismissWorkspaceCloneTask,
  useWorkspaceCloneTasks,
  type WorkspaceCloneTask,
} from "./cloneTasks";

type WorkspaceCloneTaskOverlayProps = {
  onOpenWorkspace: (path: string) => void;
};

function taskTone(task: WorkspaceCloneTask) {
  if (task.status === "completed") return "text-emerald-600 dark:text-emerald-300";
  if (task.status === "failed") return "text-destructive";
  if (task.status === "cancelled") return "text-muted-foreground";
  return "text-sky-600 dark:text-sky-300";
}

function TaskIcon({ task }: { task: WorkspaceCloneTask }) {
  if (task.status === "completed") return <CheckCircle2 className={`h-4 w-4 ${taskTone(task)}`} />;
  if (task.status === "failed") return <XCircle className={`h-4 w-4 ${taskTone(task)}`} />;
  if (task.status === "cancelled") return <Ban className={`h-4 w-4 ${taskTone(task)}`} />;
  return <Loader2 className={`h-4 w-4 animate-spin ${taskTone(task)}`} />;
}

function CloneTaskCard({
  task,
  onOpenWorkspace,
}: WorkspaceCloneTaskOverlayProps & { task: WorkspaceCloneTask }) {
  const { t } = useLocale();
  const active = task.status === "running" || task.status === "cancelling";
  const progress = task.progress === null ? null : Math.min(100, Math.max(0, task.progress));
  const phase = t(`chat.workspaceCloneTaskPhase.${task.phase}`);
  const message = task.status === "failed" ? task.error || task.detail : task.detail;

  return (
    <section
      className="pointer-events-auto w-80 overflow-hidden rounded-xl border border-border/70 bg-background/95 shadow-2xl backdrop-blur-xl"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/70">
          <TaskIcon task={task} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {task.repositoryName}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {progress === null || !active ? "" : `${progress}%`}
            </span>
          </div>
          <p
            className={`mt-1 truncate text-xs ${task.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {active ? phase : message}
          </p>
        </div>
        {!active ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1 -mt-1 h-7 w-7 shrink-0 text-muted-foreground"
            onClick={() => dismissWorkspaceCloneTask(task.id)}
            aria-label={t("settings.cancel")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      {active ? (
        <div className="px-3.5 pb-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            {progress === null ? (
              <div className="h-full w-2/5 animate-[hubLoadingProgress_1.45s_cubic-bezier(0.4,0,0.2,1)_infinite] rounded-full bg-sky-500" />
            ) : (
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {task.detail}
            </span>
            {task.status === "running" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => void cancelWorkspaceCloneTask(task.id)}
              >
                <Ban className="h-3.5 w-3.5" />
                {t("chat.workspaceCloneTaskCancel")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : task.status === "completed" ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/20 px-3.5 py-2.5">
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => onOpenWorkspace(task.targetPath)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("chat.workspaceCloneTaskOpen")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function WorkspaceCloneTaskOverlay({ onOpenWorkspace }: WorkspaceCloneTaskOverlayProps) {
  const tasks = useWorkspaceCloneTasks();
  if (tasks.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex max-h-[calc(100vh-2rem)] flex-col-reverse gap-2 overflow-y-auto">
      {tasks.map((task) => (
        <CloneTaskCard key={task.id} task={task} onOpenWorkspace={onOpenWorkspace} />
      ))}
    </div>
  );
}
