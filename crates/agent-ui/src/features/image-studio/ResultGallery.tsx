import { useState } from "react";
import {
  ImageOff,
  Loader2,
  RefreshCw,
  Search,
  SquarePen,
  Trash2,
  Undo2,
} from "../../components/IconSet";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmActionPopover } from "../../components/ui/confirm-action-popover";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import type { ImageJob } from "../../lib/imaging/types";
import { cn } from "../../lib/shared/utils";
import { AssetImage } from "./AssetImage";
import { splitFramedPrompt } from "./framing";
import type { ImageStudioController, StudioView } from "./studioController";
import { formatJobTime, jobErrorLines, statusLabels, terminalJob } from "./studioModel";

const filters = [
  ["all", "全部"],
  ["completed", "有结果"],
  ["active", "进行中"],
  ["failed", "需关注"],
] as const;
type Filter = (typeof filters)[number][0];

const needsAttention = (job: ImageJob) =>
  ["failed", "result_unknown", "cancelled"].includes(job.status);

function matchesFilter(job: ImageJob, filter: Filter) {
  if (filter === "active") return !terminalJob(job);
  if (filter === "completed") return job.assetIds.length > 0;
  if (filter === "failed") return needsAttention(job);
  return true;
}

function statusVariant(job: ImageJob) {
  if (job.status === "succeeded" || job.status === "partial_succeeded") return "success";
  if (job.status === "failed") return "destructive";
  if (!terminalJob(job)) return "secondary";
  return "muted";
}

function IconAction({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      title={label}
      className={cn("size-7 rounded-md text-muted-foreground hover:text-foreground", className)}
      onClick={onClick}
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function HistoryCard({
  job,
  selected,
  controller,
  onSelectJob,
}: {
  job: ImageJob;
  selected: boolean;
  controller: ImageStudioController;
  onSelectJob: (id: string) => void;
}) {
  const assets = [...new Set(job.assetIds)];
  const active = !terminalJob(job);
  const { t } = useLocale();
  const errors = jobErrorLines(job, t);
  const { prompt, framing } = splitFramedPrompt(job.request.prompt);
  return (
    <article
      aria-label={`任务 ${job.id}`}
      className={cn(
        "group relative flex gap-3 overflow-hidden rounded-xl p-2 transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      {/* Stretched hit area: the whole card opens the job in the preview. */}
      <button
        type="button"
        aria-label={`查看任务：${prompt}`}
        aria-pressed={selected}
        // Text layers ignore the pointer so the whole card clicks; carry their
        // full content here so truncated prompts and errors stay readable.
        title={[prompt, ...errors].join("\n")}
        className="absolute inset-0 rounded-xl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onSelectJob(job.id)}
      />
      <div className="pointer-events-none relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40 text-muted-foreground">
        {assets[0] ? (
          <AssetImage
            client={controller.client}
            assetId={assets[0]}
            alt={`生成结果 1`}
            className="size-full object-cover"
          />
        ) : active ? (
          <Loader2 className="size-5 animate-spin motion-reduce:animate-none" />
        ) : (
          <ImageOff className="size-5 opacity-60" strokeWidth={1.5} />
        )}
        {assets.length > 1 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">
            {assets.length}
          </span>
        )}
      </div>
      {/* Fixed rows: prompt length or extra chips never change the card's footprint. */}
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
        <p className="line-clamp-2 h-10 break-words text-sm leading-5" title={prompt}>
          {prompt}
        </p>
        <p
          className="truncate text-xs leading-4 text-muted-foreground"
          title={`${job.targetSnapshot.name} · ${formatJobTime(job.createdAt)}`}
        >
          {job.targetSnapshot.name} ·{" "}
          <time dateTime={job.createdAt} className="tabular-nums">
            {formatJobTime(job.createdAt)}
          </time>
        </p>
        <div className="mt-1 flex h-7 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <Badge variant={statusVariant(job)} size="compact" className="shrink-0">
              {active && (
                <span
                  className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {statusLabels[job.status]}
            </Badge>
            {framing && (
              <span
                className="min-w-0 truncate rounded bg-muted/70 px-1 tabular-nums"
                title="写入提示词的画面参数"
              >
                {[framing.ratio, framing.tier].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
          <div
            className={cn(
              "pointer-events-auto relative z-10 flex shrink-0 items-center gap-0.5 transition-opacity",
              !active &&
                "lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100",
              selected && "lg:opacity-100",
            )}
          >
            <IconAction label="恢复输入" onClick={() => void controller.restoreJob(job.id)}>
              <Undo2 className="size-3.5" />
            </IconAction>
            {assets[0] && !active && (
              <IconAction label="继续修改" onClick={() => controller.editAsset(assets[0])}>
                <SquarePen className="size-3.5" />
              </IconAction>
            )}
            <IconAction label="刷新状态" onClick={() => void controller.refreshJob(job.id)}>
              <RefreshCw className="size-3.5" />
            </IconAction>
            {active ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={job.status === "cancel_requested"}
                onClick={() => void controller.cancelJob(job.id)}
              >
                {job.status === "cancel_requested"
                  ? "正在取消…"
                  : job.targetSnapshot.capabilities.supportsCancel
                    ? "取消任务"
                    : "停止本地处理"}
              </Button>
            ) : (
              <ConfirmActionPopover
                title="删除这条历史记录？"
                description="删除后不再显示在历史中，生成的图片也会在稍后清理。"
                confirmLabel="删除"
                onConfirm={() => void controller.deleteJob(job.id)}
              >
                {() => (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="删除"
                    className="size-7 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                    <span className="sr-only">删除</span>
                  </Button>
                )}
              </ConfirmActionPopover>
            )}
          </div>
        </div>
        {[
          ...errors.map((line) => ({ line, alert: true })),
          ...(job.status === "result_unknown"
            ? [{ line: "结果未知，请先刷新核对。重新生成可能再次计费。", alert: false }]
            : []),
          ...(job.cancelEffect === "local_only"
            ? [{ line: "已停止本地处理，上游可能仍在执行或计费。晚到图片会保留。", alert: false }]
            : []),
        ].map(({ line, alert }) => (
          <p
            key={line}
            className={cn(
              "truncate text-xs leading-5",
              alert ? "text-destructive" : "text-muted-foreground",
            )}
            title={line}
          >
            {line}
          </p>
        ))}
      </div>
    </article>
  );
}

export function ResultGallery({
  controller,
  view,
  activeJobId,
  onSelectJob,
}: {
  controller: ImageStudioController;
  view: StudioView;
  /** The job currently shown in the preview, highlighted in the list. */
  activeJobId?: string;
  onSelectJob: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const jobs = Object.values(view.state.jobs).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = jobs.filter(
    (job) =>
      (!needle ||
        `${splitFramedPrompt(job.request.prompt).prompt} ${job.targetSnapshot.name}`
          .toLocaleLowerCase()
          .includes(needle)) &&
      matchesFilter(job, filter),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索历史记录"
            placeholder="搜索提示词或模型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 rounded-lg pl-8"
          />
        </div>
        <fieldset aria-label="筛选历史记录" className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                filter === value
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <section
        aria-label="图像结果画廊"
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3"
      >
        {!visible.length && (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
            <p>{jobs.length ? "没有匹配的历史记录" : "暂无历史记录"}</p>
            <p className="text-xs">
              {jobs.length ? "试试其他提示词或筛选条件" : "生成后可以在这里查看和恢复作品"}
            </p>
          </div>
        )}
        {visible.map((job) => (
          <HistoryCard
            key={job.id}
            job={job}
            controller={controller}
            selected={job.id === activeJobId}
            onSelectJob={onSelectJob}
          />
        ))}
        {view.jobCursor && (
          <Button
            type="button"
            variant="outline"
            className="mt-2 w-full"
            onClick={() => void controller.moreJobs()}
          >
            加载更多历史
          </Button>
        )}
      </section>
    </div>
  );
}
