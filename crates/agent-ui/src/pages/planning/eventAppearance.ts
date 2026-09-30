import type { CSSProperties } from "react";
import { eventLayer, layerColor } from "../../lib/planning/layers";
import type { PlanningEvent, PlanningSnapshot } from "../../lib/planning/types";

export function eventColor(event: PlanningEvent, snapshot: PlanningSnapshot) {
  return layerColor(snapshot, eventLayer(event, snapshot));
}

/**
 * Past items fade to a light tint of their color with regular text, like Google Calendar.
 * Lowering opacity instead dropped text below 4.5:1 for every calendar color.
 */
function pastAppearance(accent: string, tint: number): CSSProperties {
  return {
    "--planning-accent": accent,
    backgroundColor: `color-mix(in srgb, ${accent} ${tint}%, hsl(var(--card)))`,
    color: "hsl(var(--foreground))",
    borderColor: `color-mix(in srgb, ${accent} 45%, hsl(var(--card)))`,
  } as CSSProperties;
}

/** Calendar colors are user data; choose readable text independently of the app theme. */
export function eventAppearance(color?: string, past = false): CSSProperties {
  if (past && color && /^#[\da-f]{6}$/i.test(color)) return pastAppearance(color, 22);
  if (!color || !/^#[\da-f]{6}$/i.test(color)) {
    return {
      backgroundColor: "hsl(var(--muted))",
      color: "hsl(var(--foreground))",
      borderColor: "hsl(var(--border))",
    };
  }
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  // The crossover of black/white contrast ratios guarantees at least 4.5:1.
  const foreground = luminance > 0.179 ? "var(--color-black)" : "var(--color-white)";
  return {
    backgroundColor: color,
    color: foreground,
    borderColor: `color-mix(in srgb, ${color} 80%, ${foreground})`,
  };
}

/**
 * Tasks must read differently from events at a glance: events are solid blocks, scheduled
 * task blocks are tinted with an accent bar, deadlines are dashed outlines.
 */
export function taskAppearance(
  color: string | undefined,
  kind: "task" | "deadline" = "task",
  past = false,
) {
  const accent = color && /^#[\da-f]{6}$/i.test(color) ? color : "hsl(var(--primary))";
  if (past) return pastAppearance(accent, kind === "task" ? 12 : 6);
  return {
    "--planning-accent": accent,
    backgroundColor: `color-mix(in srgb, ${accent} ${kind === "task" ? 32 : 12}%, hsl(var(--card)))`,
    color: "hsl(var(--foreground))",
    borderColor: accent,
  } as CSSProperties;
}
