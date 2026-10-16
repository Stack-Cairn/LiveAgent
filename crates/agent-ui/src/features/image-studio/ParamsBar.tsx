import { useId, useState } from "react";
import { Input } from "../../components/ui/input";
import type { GenerationParams, ImageTarget } from "../../lib/imaging/types";
import {
  allowedFields,
  FORMAT_LABELS,
  FORMAT_VALUES,
  QUALITY_LABELS,
  QUALITY_VALUES,
  SIZE_PRESETS,
} from "./paramsBarModel";

export const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
const chipSelect =
  "h-8 rounded-md border border-input bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50";

const TIERS = Object.keys(SIZE_PRESETS);
const RATIOS = Object.keys(SIZE_PRESETS["1K"]);

function presetOf(size: string): { tier: string; ratio: string } | undefined {
  for (const tier of TIERS)
    for (const ratio of RATIOS) if (SIZE_PRESETS[tier][ratio] === size) return { tier, ratio };
  return undefined;
}

/** One row of chips, like gpt-image-studio's input bar. Unsupported controls
 * stay visible but disabled with a tooltip, so switching models never moves
 * the layout and the user can see what the platform cannot do. */
export function ParamsBar({
  target,
  params,
  count,
  maxCount,
  onChange,
  onCount,
}: {
  target: ImageTarget | undefined;
  params: GenerationParams;
  count: number;
  maxCount: number;
  onChange: (next: GenerationParams) => void;
  onCount: (count: number) => void;
}) {
  const id = useId();
  const allowed = allowedFields(target);
  const preset = presetOf(params.size);
  const [custom, setCustom] = useState(params.size !== "auto" && !preset);
  const unsupported = "当前模型不支持，此项不会发送";
  const set = (patch: Partial<GenerationParams>) => onChange({ ...params, ...patch });
  const sizeValue = params.size === "auto" ? "auto" : custom || !preset ? "custom" : params.size;
  return (
    <fieldset className="flex flex-wrap items-center gap-2" aria-label="生成参数">
      <label htmlFor={`${id}-size`} className="sr-only">
        尺寸
      </label>
      <select
        id={`${id}-size`}
        className={chipSelect}
        disabled={!allowed.has("size")}
        title={allowed.has("size") ? "尺寸" : unsupported}
        value={sizeValue}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "custom") {
            setCustom(true);
            if (params.size === "auto") set({ size: "1024x1024" });
            return;
          }
          setCustom(false);
          set({ size: value });
        }}
      >
        <option value="auto">尺寸：自动</option>
        {TIERS.map((tier) => (
          <optgroup key={tier} label={tier}>
            {RATIOS.map((ratio) => (
              <option key={`${tier}-${ratio}`} value={SIZE_PRESETS[tier][ratio]}>
                {ratio} · {SIZE_PRESETS[tier][ratio]}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="custom">自定义宽高…</option>
      </select>
      {sizeValue === "custom" && allowed.has("size") && (
        <Input
          aria-label="自定义尺寸（宽x高）"
          className="h-8 w-32 text-xs"
          value={params.size === "auto" ? "" : params.size}
          placeholder="1600x900"
          onChange={(event) => set({ size: event.target.value.trim().replace(/[×X*]/g, "x") })}
        />
      )}

      <label htmlFor={`${id}-quality`} className="sr-only">
        质量
      </label>
      <select
        id={`${id}-quality`}
        className={chipSelect}
        disabled={!allowed.has("quality")}
        title={allowed.has("quality") ? "质量" : unsupported}
        value={allowed.has("quality") ? (params.quality ?? "auto") : "auto"}
        onChange={(event) => set({ quality: event.target.value })}
      >
        {QUALITY_VALUES.map((value) => (
          <option key={value} value={value}>
            质量：{QUALITY_LABELS[value]}
          </option>
        ))}
      </select>

      <label htmlFor={`${id}-format`} className="sr-only">
        格式
      </label>
      <select
        id={`${id}-format`}
        className={chipSelect}
        disabled={!allowed.has("outputFormat")}
        title={allowed.has("outputFormat") ? "输出格式" : unsupported}
        value={allowed.has("outputFormat") ? (params.outputFormat ?? "png") : "png"}
        onChange={(event) => {
          const outputFormat = event.target.value;
          set({
            outputFormat,
            // Compression only applies to lossy formats.
            ...(outputFormat === "png" ? { outputCompression: undefined } : {}),
          });
        }}
      >
        {FORMAT_VALUES.map((value) => (
          <option key={value} value={value}>
            {FORMAT_LABELS[value]}
          </option>
        ))}
      </select>

      <label htmlFor={`${id}-count`} className="sr-only">
        数量
      </label>
      <select
        id={`${id}-count`}
        className={chipSelect}
        title={maxCount > 1 ? "生成数量" : "当前模型每次只能生成 1 张"}
        disabled={maxCount <= 1}
        value={Math.min(count, Math.max(1, maxCount))}
        onChange={(event) => onCount(Number(event.target.value))}
      >
        {Array.from({ length: Math.max(1, Math.min(10, maxCount)) }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n} 张
          </option>
        ))}
      </select>

      <details className="relative">
        <summary className="flex h-8 cursor-pointer items-center rounded-md border border-input px-2 text-xs">
          更多
        </summary>
        <div className="absolute left-0 top-9 z-10 w-64 space-y-2 rounded-md border border-border bg-background p-3 shadow-md">
          <label
            htmlFor={`${id}-compression`}
            className="flex items-center justify-between gap-2 text-xs"
          >
            <span>压缩率（JPEG/WebP）</span>
            <Input
              id={`${id}-compression`}
              className="h-8 w-20 text-xs"
              inputMode="numeric"
              disabled={
                !allowed.has("outputCompression") || (params.outputFormat ?? "png") === "png"
              }
              title={allowed.has("outputCompression") ? undefined : unsupported}
              value={params.outputCompression ?? ""}
              placeholder="默认"
              onChange={(event) => {
                const raw = event.target.value.trim();
                const value = Number(raw);
                set({
                  outputCompression:
                    raw === "" || !Number.isInteger(value)
                      ? undefined
                      : Math.max(0, Math.min(100, value)),
                });
              }}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-xs">
            <span>内容审核</span>
            <select
              className={chipSelect}
              disabled={!allowed.has("moderation")}
              title={allowed.has("moderation") ? undefined : unsupported}
              value={allowed.has("moderation") ? (params.moderation ?? "auto") : "auto"}
              onChange={(event) => set({ moderation: event.target.value })}
            >
              <option value="auto">标准</option>
              <option value="low">宽松</option>
            </select>
          </label>
          <label
            className="flex items-center gap-2 text-xs"
            title={allowed.has("transparentOutput") ? undefined : unsupported}
          >
            <input
              type="checkbox"
              disabled={!allowed.has("transparentOutput")}
              checked={allowed.has("transparentOutput") && params.transparentOutput === true}
              onChange={(event) => set({ transparentOutput: event.target.checked })}
            />
            透明背景（PNG/WebP）
          </label>
          <p className="text-[11px] text-muted-foreground">
            置灰的选项当前模型不支持，提交时会自动略过；后端还会按平台限制修正尺寸和数量，并在任务里注明。
          </p>
        </div>
      </details>
    </fieldset>
  );
}
