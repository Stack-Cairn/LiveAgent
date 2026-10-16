import { useId, useRef, useState } from "react";
import { ArrowUp, ImageIcon, LoaderCircle, X } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { AssetImage } from "./AssetImage";
import { ParamsBar, selectClass } from "./ParamsBar";
import type { ImageStudioController, StudioView } from "./studioController";

/** Chat-style input: model + parameters on top, a text box with reference
 * thumbnails, an image button on the left and a send button on the right.
 * No images = 文生图; any reference image = 图生图. Enter sends, Shift+Enter
 * starts a new line. Every send is a new task, like another chat message. */
export function ImageComposer({
  controller,
  view,
  onOpenSettings,
}: {
  controller: ImageStudioController;
  view: StudioView;
  /** Opens provider settings, where image services are configured. */
  onOpenSettings?: () => void;
}) {
  const prefix = useId();
  const file = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const target = controller.target;
  const locked = !view.projectId || !view.draftReady;
  const errors = controller.validation();
  const submitting = view.submission?.status === "submitting";
  const unknown = view.submission?.status === "unknown";
  const canSend = !locked && !submitting && (unknown || errors.length === 0);
  const acceptsImages = controller.acceptsImages;
  const maxInputs = target?.capabilities.maxInputs ?? 0;
  const groups = new Map<string, typeof view.targets>();
  for (const item of view.targets) {
    const [service] = item.name.split(" · ");
    groups.set(service, [...(groups.get(service) ?? []), item]);
  }
  const addFiles = (files: FileList | File[] | null | undefined) => {
    for (const picked of Array.from(files ?? []).slice(
      0,
      Math.max(0, maxInputs - view.draft.inputs.length),
    ))
      void controller.upload(picked, picked.name, "reference");
  };
  const send = () => {
    if (canSend) void controller.send();
  };
  return (
    <form
      aria-label="图像创作"
      className="space-y-2 border-t border-border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${prefix}-target`} className="sr-only">
          模型
        </label>
        <select
          id={`${prefix}-target`}
          className={`${selectClass} h-8 w-auto max-w-64 text-xs`}
          value={view.draft.targetId}
          // Provider settings can change while the workbench is open; refresh
          // the list whenever the picker is about to be used.
          onFocus={() => void controller.refreshTargets()}
          onChange={(event) => controller.setTarget(event.target.value)}
        >
          <option value="">{view.targets.length ? "选择模型" : "没有可用的图像模型"}</option>
          {view.draft.targetId && !target && (
            <option value={view.draft.targetId}>原模型已删除，请重新选择</option>
          )}
          {[...groups].map(([service, items]) => (
            <optgroup key={service} label={service}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.remoteId}
                  {item.enabled ? "" : "（不可用）"}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ParamsBar
          target={target}
          params={controller.params}
          count={Number.isNaN(view.count) ? 1 : view.count}
          maxCount={Math.min(16, target?.capabilities.maxCount ?? 1)}
          onChange={(params) => controller.setParams(params)}
          onCount={(count) => controller.setCount(count)}
        />
      </div>
      {view.targets.length === 0 && !view.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          图像模型来自“设置 → 供应商”：在已填 API Key 的供应商里启用名称含 image、seedream、banana
          等的模型即可在这里使用。
          {onOpenSettings && (
            <Button
              type="button"
              size="sm"
              variant="link"
              className="h-auto px-1 text-xs"
              onClick={onOpenSettings}
            >
              打开供应商设置
            </Button>
          )}
        </p>
      )}
      {target && !target.enabled && (
        <p role="status" className="text-xs text-destructive">
          {target.disabledReason || "当前模型不可用，请在供应商设置中检查。"}
        </p>
      )}
      <fieldset
        disabled={locked}
        className={`rounded-3xl border bg-card px-3 pt-2 pb-2 transition-colors ${
          dragging ? "border-primary border-dashed" : "border-border"
        }`}
        onDragOver={(event) => {
          if (!acceptsImages) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (!acceptsImages || locked) return;
          event.preventDefault();
          addFiles(event.dataTransfer.files);
        }}
      >
        <legend className="sr-only">提示词与参考图</legend>
        {view.draft.inputs.length > 0 && (
          <ul className="flex flex-wrap gap-2 pb-2" aria-label="参考图">
            {view.draft.inputs.map((input, index) => (
              <li
                key={input.assetId}
                className="relative size-16 overflow-hidden rounded-xl border border-border"
              >
                <AssetImage
                  client={controller.client}
                  assetId={input.assetId}
                  alt={`参考图 ${index + 1}`}
                  className="size-full object-cover"
                />
                <button
                  type="button"
                  aria-label={`移除参考图 ${index + 1}`}
                  className="absolute top-0.5 right-0.5 inline-flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow"
                  onClick={() => controller.removeInput(input.assetId)}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
            {view.uploading && (
              <li className="flex size-16 items-center justify-center rounded-xl border border-dashed border-border">
                <LoaderCircle className="size-4 animate-spin" />
              </li>
            )}
          </ul>
        )}
        <label htmlFor={`${prefix}-prompt`} className="sr-only">
          提示词
        </label>
        <textarea
          id={`${prefix}-prompt`}
          name="image-prompt"
          rows={3}
          className="block max-h-48 min-h-16 w-full resize-none bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          placeholder={
            view.draft.inputs.length
              ? "描述要怎样参考或修改这些图片…"
              : "描述你想生成的画面，Enter 发送，Shift+Enter 换行"
          }
          value={view.draft.prompt}
          onChange={(event) => controller.updateDraft({ prompt: event.target.value })}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((f) =>
              f.type.startsWith("image/"),
            );
            if (images.length && acceptsImages) {
              event.preventDefault();
              addFiles(images);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center gap-2 pt-1">
          <input
            ref={file}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            accept="image/png,image/jpeg,image/webp"
            aria-label="选择参考图"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
            disabled={!acceptsImages || view.uploading || view.draft.inputs.length >= maxInputs}
            title={
              acceptsImages
                ? `添加参考图（最多 ${maxInputs} 张），也可以拖入或粘贴`
                : "当前模型不支持图生图"
            }
            onClick={() => file.current?.click()}
          >
            <ImageIcon className="size-4" />
            参考图
          </Button>
          <span className="text-xs text-muted-foreground">
            {view.draft.inputs.length ? `图生图 · ${view.draft.inputs.length} 张参考图` : "文生图"}
          </span>
          <span className="flex-1" />
          {errors.length > 0 && !unknown && view.draft.prompt.trim() && (
            <span
              className="max-w-64 truncate text-xs text-muted-foreground"
              title={errors.join("\n")}
            >
              {errors[0]}
            </span>
          )}
          <Button
            type="submit"
            size="icon"
            className="size-8 shrink-0 rounded-full"
            disabled={!canSend}
            aria-label={unknown ? "核对上一次请求" : "生成"}
            title={unknown ? "上一次请求结果未确认，点击用同一请求核对" : "生成（Enter）"}
            aria-busy={submitting}
          >
            {submitting ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
