import { useId, useState } from "react";
import { Link2, Maximize2 } from "../../components/IconSet";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { useLocale } from "../../i18n";
import type { ImageTarget, ParameterSpec } from "../../lib/imaging/types";
import { cn } from "../../lib/shared/utils";
import {
  FRAMING_RATIOS,
  FRAMING_TIERS,
  type Framing,
  framingPixels,
  isAspectRatioSpec,
  isAutoValue,
  isPixelSizeSpec,
  usesPromptFraming,
} from "./framing";
import { defaultTranslate, formatMessage, message, type Translate } from "./studioText";
import { TargetParameterForm } from "./TargetParameterForm";

// Two ways to frame an image:
// - parameter mode: the target declares a ratio/size enum (OpenAI "WxH", Gemini
//   aspectRatio + imageSize); only declared values are offered.
// - prompt mode: the target takes no size parameter; a generic ratio/resolution
//   choice is appended to the prompt on submit (see framing.ts).

type Values = Record<string, unknown>;
interface Choice {
  value?: string;
  label: string;
  shape?: [number, number];
}
interface Plan {
  mode: "params" | "prompt";
  ratios: Choice[];
  ratio?: string;
  tiers: Choice[];
  tier?: string;
  /** Exact (parameter mode) or estimated (prompt mode) output size. */
  pixels?: { w: number; h: number };
  rest: ParameterSpec[];
}

const PIXELS = /^(\d+)x(\d+)$/;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const parsePixels = (value: unknown) => {
  const match = PIXELS.exec(String(value ?? ""));
  return match ? { w: Number(match[1]), h: Number(match[2]) } : undefined;
};
const ratioShape = (ratio: string): [number, number] | undefined => {
  const [w, h] = ratio.split(":").map(Number);
  return w && h ? [w, h] : undefined;
};
const wideFirst = (a: Choice, b: Choice) =>
  (b.shape ? b.shape[0] / b.shape[1] : 0) - (a.shape ? a.shape[0] / a.shape[1] : 0);
/** "Auto" sends the provider's own "auto" when declared, else leaves the key unset. */
const withAuto = (spec: ParameterSpec, list: Choice[], auto: Choice): Choice[] =>
  spec.enum?.some(isAutoValue)
    ? [{ value: "auto", label: auto.label }, ...list]
    : spec.required
      ? list
      : [auto, ...list];

function planFor(
  target: ImageTarget | undefined,
  values: Values,
  framing: Framing | undefined,
  t: Translate,
): Plan {
  const params = target?.parameters ?? [];
  const auto: Choice = { label: t("imageStudio.size.auto") };
  if (!target || usesPromptFraming(target)) {
    return {
      mode: "prompt",
      ratios: [auto, ...FRAMING_RATIOS.map((r) => ({ value: r, label: r, shape: ratioShape(r) }))],
      ratio: framing?.ratio,
      tiers: [auto, ...FRAMING_TIERS.map((tier) => ({ value: tier, label: tier }))],
      tier: framing?.tier,
      pixels: framingPixels(framing),
      rest: params,
    };
  }
  const aspect = params.find(isAspectRatioSpec);
  const size = params.find(isPixelSizeSpec);
  const resolution = params.find((p) => p.key === "imageSize" && p.enum?.length);
  const ratioSpec = (aspect ?? size) as ParameterSpec;
  const ratios = (ratioSpec.enum ?? [])
    .filter((raw) => !isAutoValue(raw))
    .map((raw): Choice => {
      const value = String(raw);
      if (ratioSpec === aspect) return { value, label: value, shape: ratioShape(value) };
      const { w, h } = parsePixels(value) ?? { w: 1, h: 1 };
      const d = gcd(w, h);
      return { value, label: `${w / d}:${h / d}`, shape: [w, h] };
    })
    .sort(wideFirst);
  // Sizes that reduce to the same ratio (256/512/1024 squares) need their pixels.
  const counts = new Map<string, number>();
  for (const choice of ratios) counts.set(choice.label, (counts.get(choice.label) ?? 0) + 1);
  for (const choice of ratios)
    if ((counts.get(choice.label) ?? 0) > 1)
      choice.label = `${choice.label} ${choice.value?.replace("x", "×")}`;
  const tiers = (resolution?.enum ?? [])
    .filter((raw) => !isAutoValue(raw))
    .map((raw) => ({ value: String(raw), label: String(raw) }));
  const ratio = values[ratioSpec.key] as string | undefined;
  const pixels = ratioSpec === size ? parsePixels(ratio) : undefined;
  const handled = new Set([ratioSpec.key, resolution?.key]);
  return {
    mode: "params",
    ratios: withAuto(ratioSpec, ratios, auto),
    ratio,
    tiers: resolution ? withAuto(resolution, tiers, auto) : tiers,
    tier: resolution
      ? (values[resolution.key] as string | undefined)
      : pixels
        ? `${Math.round((Math.max(pixels.w, pixels.h) / 1024) * 2) / 2}K`
        : undefined,
    pixels,
    rest: params.filter((p) => !handled.has(p.key)),
  };
}

/** One-line summary for the composer footer. */
export function describeImageSize(
  target: ImageTarget | undefined,
  values: Values,
  framing?: Framing,
  t: Translate = defaultTranslate,
) {
  const plan = planFor(target, values, framing, t);
  const text = (key: string, value: string) => formatMessage(message(key, { value }), t);
  if (plan.mode === "params" && plan.pixels)
    return text("imageStudio.size.current", `${plan.pixels.w}x${plan.pixels.h}`);
  const parts = [
    plan.ratio && !isAutoValue(plan.ratio)
      ? text(
          "imageStudio.size.ratio",
          plan.ratios.find((c) => c.value === plan.ratio)?.label ?? plan.ratio,
        )
      : "",
    plan.tier && !isAutoValue(plan.tier) ? text("imageStudio.size.tier", plan.tier) : "",
    plan.mode === "prompt" && plan.pixels
      ? text("imageStudio.size.approx", `${plan.pixels.w}x${plan.pixels.h}`)
      : "",
  ].filter(Boolean);
  if (!parts.length) return t("imageStudio.size.modelDecides");
  return plan.mode === "prompt"
    ? [...parts, t("imageStudio.size.inPrompt")].join(" · ")
    : parts.join(" · ");
}

function Shape({ shape }: { shape?: [number, number] }) {
  if (!shape)
    return <span className="size-4 rounded-xs border-[1.5px] border-dashed border-current" />;
  const scale = 18 / Math.max(shape[0], shape[1]);
  return (
    <span
      className="rounded-xs border-[1.5px] border-current"
      style={{ width: Math.max(7, shape[0] * scale), height: Math.max(7, shape[1] * scale) }}
    />
  );
}

function ChoiceGrid({
  label,
  choices,
  selected,
  onPick,
  columns,
  shapes,
}: {
  label: string;
  choices: Choice[];
  selected?: string;
  onPick: (value?: string) => void;
  columns: number;
  shapes?: boolean;
}) {
  const name = useId();
  return (
    <section className="space-y-2">
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1 rounded-xl bg-muted/50 p-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {choices.map((choice) => {
          const active = (choice.value ?? "") === (selected ?? "");
          return (
            <label
              key={choice.value ?? "unset"}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs transition-colors",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                active
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <input
                type="radio"
                name={name}
                checked={active}
                onChange={() => onPick(choice.value)}
                className="sr-only"
              />
              {shapes && (
                <span className="flex h-[18px] items-center justify-center">
                  <Shape shape={choice.shape} />
                </span>
              )}
              {choice.label}
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function ImageSizePicker({
  target,
  values,
  onChange,
  framing,
  onFramingChange,
}: {
  target?: ImageTarget;
  values: Values;
  onChange: (values: Values) => void;
  framing?: Framing;
  onFramingChange: (framing: Framing) => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useLocale();
  const plan = planFor(target, values, framing, t);
  const setParam = (key: string, value?: string) => {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const params = target?.parameters ?? [];
  const ratioKey = params.some((p) => p.key === "aspectRatio" && p.enum?.length)
    ? "aspectRatio"
    : "size";
  const pickRatio = (value?: string) =>
    plan.mode === "prompt"
      ? onFramingChange({ ...framing, ratio: value })
      : setParam(ratioKey, value);
  const pickTier = (value?: string) =>
    plan.mode === "prompt"
      ? onFramingChange({ ...framing, tier: value })
      : setParam("imageSize", value);
  const ratioLabel = plan.ratios.find(
    (c) => c.value && !isAutoValue(c.value) && c.value === plan.ratio,
  )?.label;
  const showTiers = plan.mode === "prompt" || params.some((p) => p.key === "imageSize");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            title={t("imageStudio.size.title")}
            className={cn(
              "inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-border px-3 text-sm transition-colors",
              "hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              open && "bg-muted/60",
            )}
          />
        }
      >
        <Maximize2 className="size-4 shrink-0 text-muted-foreground" />
        <span>{ratioLabel ?? t("imageStudio.size.autoRatio")}</span>
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        <span className="tabular-nums">
          {plan.tier && !isAutoValue(plan.tier) ? plan.tier : t("imageStudio.size.auto")}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-label={t("imageStudio.size.title")}
        className="max-h-[min(600px,80dvh)] w-80 max-w-[calc(100vw-16px)] space-y-4 overflow-y-auto rounded-2xl p-4"
      >
        <ChoiceGrid
          label={t("imageStudio.size.ratioLabel")}
          choices={plan.ratios}
          selected={plan.ratio}
          columns={3}
          shapes
          onPick={pickRatio}
        />
        {showTiers && plan.tiers.length > 0 && (
          <ChoiceGrid
            label={t("imageStudio.size.tierLabel")}
            choices={plan.tiers}
            selected={plan.tier}
            columns={Math.min(4, plan.tiers.length)}
            onPick={pickTier}
          />
        )}
        {(plan.mode === "prompt" || plan.pixels) && (
          <section className="space-y-2">
            <h3 className="text-xs text-muted-foreground">
              {t(
                plan.mode === "prompt"
                  ? "imageStudio.size.dimensionsEstimated"
                  : "imageStudio.size.dimensions",
              )}
            </h3>
            <div className="flex items-center gap-2 text-sm">
              {(["W", "H"] as const).map((axis, index) => (
                <div key={axis} className="contents">
                  {index === 1 && <Link2 className="size-4 shrink-0 text-muted-foreground" />}
                  <div className="flex h-10 flex-1 items-center justify-between rounded-xl bg-muted/50 px-3">
                    <span className="text-muted-foreground">{axis}</span>
                    <span className="tabular-nums">
                      {plan.pixels
                        ? axis === "W"
                          ? plan.pixels.w
                          : plan.pixels.h
                        : t("imageStudio.size.auto")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-right text-xs text-muted-foreground">{t("imageStudio.size.unit")}</p>
          </section>
        )}
        {plan.mode === "prompt" && (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {t("imageStudio.size.promptNote")}
          </p>
        )}
        {target && plan.rest.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs text-muted-foreground">{t("imageStudio.size.moreParams")}</h3>
            <TargetParameterForm
              target={{ ...target, parameters: plan.rest }}
              values={values}
              onChange={onChange}
            />
          </section>
        )}
      </PopoverContent>
    </Popover>
  );
}
