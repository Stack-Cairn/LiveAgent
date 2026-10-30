import { useId, useRef } from "react";
import { Loader2, Sparkles } from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import type { Operation } from "../../lib/imaging/types";
import { ImageModelPicker } from "./ImageModelPicker";
import { describeImageSize, ImageSizePicker } from "./ImageSizePicker";
import { InputImageStack } from "./InputImageStack";
import type { ImageStudioController, StudioView } from "./studioController";
import { targetDisabledText } from "./studioModel";

const modeClass = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
    active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
  }`;

export function ImageComposer({
  controller,
  view,
  onOpenSettings,
}: {
  controller: ImageStudioController;
  view: StudioView;
  onOpenSettings?: () => void;
}) {
  const prefix = useId();
  const file = useRef<HTMLInputElement>(null);
  const submitting = view.submission?.status === "submitting";
  const target = controller.target;
  const imageOperation: Operation | undefined = target?.capabilities.operations.includes("edit")
    ? "edit"
    : target?.capabilities.operations.includes("reference")
      ? "reference"
      : undefined;
  const imageMode = view.operation !== "generate";
  const locked = !view.projectId || !view.draftReady;
  const { t } = useLocale();
  const errors = controller.validation(t);
  const importImage = (image: File) => {
    if (locked || !imageOperation || view.uploading) return;
    const operation = imageMode ? view.operation : imageOperation;
    if (!imageMode) controller.setOperation(operation);
    // An edit takes exactly one source; any further images ride along as references.
    const hasSource = imageMode && view.draft.inputs.some((input) => input.role === "source");
    void controller.upload(
      image,
      image.name,
      operation === "reference" || hasSource ? "reference" : "source",
    );
  };
  return (
    <form
      aria-label="图像创作"
      className="shrink-0 space-y-3 rounded-2xl border border-border bg-card p-3 sm:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.submit(t);
      }}
      onDragOver={(event) => {
        if (imageOperation) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!imageOperation) return;
        event.preventDefault();
        const image = event.dataTransfer.files[0];
        if (image) importImage(image);
      }}
      onPaste={(event) => {
        const image = Array.from(event.clipboardData.items)
          .find((item) => item.kind === "file" && item.type.startsWith("image/"))
          ?.getAsFile();
        if (image && imageOperation) {
          event.preventDefault();
          importImage(image);
        }
      }}
    >
      <fieldset disabled={locked} className="min-w-0 space-y-3">
        <legend className="sr-only">图像创作</legend>
        <div className="flex min-w-0 gap-3">
          <input
            ref={file}
            id={`${prefix}-file`}
            type="file"
            className="sr-only"
            tabIndex={-1}
            accept="image/png,image/jpeg,image/webp"
            aria-label="选择输入图片"
            onChange={(event) => {
              const image = event.target.files?.[0];
              if (image) importImage(image);
              event.target.value = "";
            }}
          />
          <InputImageStack
            client={controller.client}
            inputs={view.draft.inputs}
            canAdd={
              !!imageOperation &&
              !view.uploading &&
              view.draft.inputs.length < (target?.capabilities.maxInputs ?? 0)
            }
            disabledReason={imageOperation ? "已达到当前模型输入图片上限" : "当前模型不支持图生图"}
            uploading={view.uploading}
            onCancelUpload={() => controller.cancelUpload()}
            onAdd={() => file.current?.click()}
            onRemove={(index) =>
              controller.updateDraft({
                inputs: view.draft.inputs.filter((_, position) => position !== index),
              })
            }
          />
          <label htmlFor={`${prefix}-prompt`} className="sr-only">
            提示词
          </label>
          <Textarea
            id={`${prefix}-prompt`}
            name="image-prompt"
            rows={3}
            className="h-24 min-h-24 max-h-24 min-w-0 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0"
            placeholder="描述、拖入或粘贴你想生成或编辑的图片，例如：暖色霓虹灯下的电影感人像海报，浅景深"
            value={view.draft.prompt}
            onChange={(event) => controller.updateDraft({ prompt: event.target.value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset
            className="inline-flex shrink-0 rounded-xl border border-border p-1"
            aria-label="生成方式"
          >
            <button
              type="button"
              className={modeClass(!imageMode)}
              disabled={!target?.capabilities.operations.includes("generate")}
              aria-pressed={!imageMode}
              onClick={() => controller.setOperation("generate")}
            >
              文生图
            </button>
            <button
              type="button"
              className={modeClass(imageMode)}
              disabled={!imageOperation}
              title={imageOperation ? undefined : "当前模型不支持图生图"}
              aria-pressed={imageMode}
              onClick={() => {
                if (imageOperation && !imageMode) controller.setOperation(imageOperation);
              }}
            >
              图生图
            </button>
          </fieldset>
          <label className="sr-only" htmlFor={`${prefix}-model`}>
            图像模型
          </label>
          <ImageModelPicker
            id={`${prefix}-model`}
            targets={view.targets}
            value={view.draft.targetId}
            onOpen={() => void controller.refreshTargets()}
            onChange={(targetId) => controller.setTarget(targetId)}
          />
          <ImageSizePicker
            target={target}
            values={view.draft.parameters}
            onChange={(parameters) => controller.updateDraft({ parameters })}
            framing={view.draft.framing}
            onFramingChange={(framing) => controller.updateDraft({ framing })}
          />
          {(target?.capabilities.maxCount ?? 1) > 1 && (
            <>
              <label htmlFor={`${prefix}-count`} className="sr-only">
                生成数量
              </label>
              <Input
                id={`${prefix}-count`}
                type="number"
                min={1}
                max={Math.min(16, target?.capabilities.maxCount ?? 1)}
                step={1}
                title="生成数量"
                className="h-10 w-16 rounded-xl"
                value={Number.isNaN(view.count) ? "" : view.count}
                onChange={(event) => controller.setCount(event.target.valueAsNumber)}
              />
            </>
          )}
          <span className="flex-1" />
          <Button
            type="submit"
            className="h-10 rounded-xl px-5"
            disabled={errors.length > 0 || submitting}
            aria-busy={submitting}
            onClick={(event) => {
              // A double click is one intent; never two paid jobs.
              if (event.detail > 1) event.preventDefault();
            }}
          >
            {submitting ? (
              <Loader2 className="mr-1.5 size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Sparkles className="mr-1.5 size-4" />
            )}
            {submitting ? "正在提交…" : imageMode ? "编辑" : "生成"}
          </Button>
        </div>
        {target && !target.enabled && (
          <p role="status" className="text-xs text-destructive">
            {targetDisabledText(target)}
          </p>
        )}
        {view.dropped.length > 0 && (
          <div role="alert" className="text-xs">
            切换模型后需要调整：{controller.droppedLabels(t).join("、")}。
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => controller.acknowledgeMigration()}
            >
              确认参数调整
            </Button>
          </div>
        )}
        {view.unverifiedAssetIds.length > 0 && (
          <div role="status" className="text-xs">
            输入图片暂时无法核验，引用已保留。
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={view.verifyingInputs}
              onClick={() => void controller.revalidateInputs()}
            >
              重新核验输入图片
            </Button>
          </div>
        )}
        <p className="flex h-4 min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">
            {describeImageSize(target, view.draft.parameters, view.draft.framing)}
          </span>
          {/* Only validation is announced; size changes are visible but not spoken. */}
          <span className="min-w-0 truncate" aria-live="polite" title={errors[0]}>
            {errors[0] ? `· ${errors[0]}` : ""}
          </span>
        </p>
      </fieldset>
      {!view.targets.length && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>在供应商设置中添加支持图像生成的模型。</span>
          {onOpenSettings && (
            <Button type="button" size="sm" variant="link" onClick={onOpenSettings}>
              供应商设置
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void controller.refreshTargets()}
          >
            刷新模型
          </Button>
        </div>
      )}
    </form>
  );
}
