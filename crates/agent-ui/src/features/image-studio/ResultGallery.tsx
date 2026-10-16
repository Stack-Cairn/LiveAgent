import { Button } from "../../components/ui/button";
import { AssetImage } from "./AssetImage";
import { describeParams } from "./paramsBarModel";
import type { ImageStudioController, StudioView } from "./studioController";
import { errorAction, jobResultCount, statusLabels, terminalJob } from "./studioModel";

export function ResultGallery({
  controller,
  view,
  onSelect,
}: {
  controller: ImageStudioController;
  view: StudioView;
  onSelect: (id: string) => void;
}) {
  const jobs = Object.values(view.state.jobs).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return (
    <section aria-label="图像结果画廊" className="space-y-5 p-4">
      {!jobs.length && (
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
          <h2 className="font-medium">从一个画面想法开始</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            在下方选择模型、输入描述后点击生成。添加参考图即可图生图。
          </p>
        </div>
      )}
      {jobs.map((job) => (
        <article
          key={job.id}
          className="space-y-3 rounded-lg border border-border bg-card p-3"
          aria-label={`任务 ${job.id}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium" role="status">
              {statusLabels[job.status]}
            </span>
            {!terminalJob(job) && (
              <span
                className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            <span className="text-xs text-muted-foreground">{jobResultCount(job)} 张可用结果</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => void controller.refreshJob(job.id)}>
              刷新状态
            </Button>
            {!terminalJob(job) && (
              <Button
                size="sm"
                variant="outline"
                disabled={job.status === "cancel_requested"}
                onClick={() => void controller.cancelJob(job.id)}
              >
                {job.targetSnapshot.capabilities.supportsCancel ? "取消任务" : "停止本地处理"}
              </Button>
            )}
          </div>
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm">
            {job.request.prompt}
          </p>
          <JobParams job={job} applied={view.applied[job.id]} />
          {job.status === "result_unknown" && (
            <p className="text-sm text-muted-foreground">
              结果未知。请先刷新核对；明确重新生成可能再次计费。
              {!job.targetSnapshot.capabilities.supportsReconcile && " 此目标不支持上游自动核对。"}
            </p>
          )}
          {job.cancelEffect === "local_only" && (
            <p className="text-xs text-muted-foreground">
              仅停止本地处理，上游可能仍在执行或计费；晚到图片保留为附加结果。
            </p>
          )}
          {job.error && (
            <p role="alert" className="text-sm text-destructive">
              {job.error.message} {errorAction(job.error)}
            </p>
          )}
          {job.items
            .filter((item) => item.error)
            .map((item) => (
              <p key={item.id} className="text-xs text-destructive">
                失败项：{item.error?.message} {errorAction(item.error)}
              </p>
            ))}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {[...new Set(job.assetIds)].map((id, index) => (
              <button
                type="button"
                key={id}
                className={`overflow-hidden rounded-lg border bg-muted/20 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${view.state.selectedAssetId === id ? "border-primary ring-1 ring-primary" : "border-border"}`}
                aria-label={`选择结果 ${index + 1}，${job.targetSnapshot.name}`}
                aria-pressed={view.state.selectedAssetId === id}
                onClick={() => onSelect(id)}
              >
                <AssetImage
                  client={controller.client}
                  assetId={id}
                  alt={`生成结果 ${index + 1}`}
                  className="aspect-square w-full object-contain"
                />
                <span className="block px-2 py-1 text-xs">结果 {index + 1}</span>
              </button>
            ))}
          </div>
        </article>
      ))}
      {view.jobCursor && (
        <Button variant="outline" onClick={() => void controller.moreJobs()}>
          加载更多历史
        </Button>
      )}
    </section>
  );
}

/** Model, requested parameters and — when the backend adjusted something —
 * what was actually sent, like gpt-image-studio's task card. */
function JobParams({
  job,
  applied,
}: {
  job: StudioView["state"]["jobs"][string];
  applied: StudioView["applied"][string] | undefined;
}) {
  const requested = describeParams(
    job.request.parameters as unknown as Parameters<typeof describeParams>[0],
  );
  const model = job.targetSnapshot.remoteId || job.targetSnapshot.name;
  const changed = applied?.corrections ?? [];
  return (
    <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>{model}</span>
      {requested.map((part) => (
        <span key={part}>· {part}</span>
      ))}
      {job.request.count > 1 && <span>· {job.request.count} 张</span>}
      {changed.length > 0 && (
        <span
          className="text-amber-600 dark:text-amber-400"
          title={changed.map((c) => c.reason).join("\n")}
        >
          · 已调整：{changed.map((c) => `${c.field} ${c.from}→${c.to}`).join("，")}
        </span>
      )}
    </p>
  );
}
