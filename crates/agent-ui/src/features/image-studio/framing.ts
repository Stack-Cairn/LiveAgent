import type { ImageTarget, ParameterSpec } from "../../lib/imaging/types";

// Models without size parameters (e.g. gpt-image behind RollDek) still get a ratio
// and resolution choice: it travels as a marked line appended to the prompt, and is
// split back out when a job is restored so it never accumulates.

export const FRAMING_RATIOS = ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"] as const;
export const FRAMING_TIERS = ["1K", "2K", "4K"] as const;
export interface Framing {
  ratio?: string;
  tier?: string;
}

// The marked line is prompt text for the model and is parsed back on restore, so it
// is wire format, not interface text: it stays the same in every interface language.
const MARK = "【画面参数】";
const PIXELS = /^\d+x\d+$/;

/** A provider "auto" value means "let the model decide", not a framing choice. */
export const isAutoValue = (value: unknown) => String(value) === "auto";

/** `size` as an enum of WxH values (optionally plus "auto"). */
export function isPixelSizeSpec(p: ParameterSpec): boolean {
  const values = (p.enum ?? []).filter((v) => !isAutoValue(v));
  return p.key === "size" && values.length > 0 && values.every((v) => PIXELS.test(String(v)));
}

export function isAspectRatioSpec(p: ParameterSpec): boolean {
  return p.key === "aspectRatio" && (p.enum ?? []).some((v) => !isAutoValue(v));
}

/** True when the target exposes no ratio/size parameter, so framing goes into the prompt. */
export function usesPromptFraming(target?: ImageTarget): boolean {
  if (!target) return false;
  return !target.parameters.some((p) => isAspectRatioSpec(p) || isPixelSizeSpec(p));
}

export function sanitizeFraming(value: unknown): Framing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { ratio, tier } = value as Record<string, unknown>;
  const framing: Framing = {};
  if (typeof ratio === "string" && (FRAMING_RATIOS as readonly string[]).includes(ratio))
    framing.ratio = ratio;
  if (typeof tier === "string" && (FRAMING_TIERS as readonly string[]).includes(tier))
    framing.tier = tier;
  return framing.ratio || framing.tier ? framing : undefined;
}

/** Approximate output size: the long edge is tier × 1024, both edges snapped to 16 px. */
export function framingPixels(framing?: Framing) {
  if (!framing?.ratio || !framing.tier) return undefined;
  const [w, h] = framing.ratio.split(":").map(Number);
  const long = Number.parseInt(framing.tier, 10) * 1024;
  const snap = (n: number) => Math.round(n / 16) * 16;
  return w >= h ? { w: long, h: snap((long * h) / w) } : { w: snap((long * w) / h), h: long };
}

export function framingText(framing?: Framing): string {
  const pixels = framingPixels(framing);
  return [
    framing?.ratio ? `画面比例 ${framing.ratio}` : "",
    framing?.tier
      ? `分辨率 ${framing.tier}${pixels ? `（约 ${pixels.w}×${pixels.h} 像素）` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("；");
}

export function composeFramedPrompt(prompt: string, framing?: Framing): string {
  const text = framingText(framing);
  return text ? `${prompt.trimEnd()}\n\n${MARK}${text}` : prompt;
}

export function splitFramedPrompt(prompt: string): { prompt: string; framing?: Framing } {
  const at = prompt.lastIndexOf(`\n\n${MARK}`);
  if (at < 0) return { prompt };
  const line = prompt.slice(at + 2 + MARK.length);
  const framing = sanitizeFraming({
    ratio: /画面比例 (\d+:\d+)/.exec(line)?.[1],
    tier: /分辨率 (\dK)/.exec(line)?.[1],
  });
  return framing ? { prompt: prompt.slice(0, at), framing } : { prompt };
}
