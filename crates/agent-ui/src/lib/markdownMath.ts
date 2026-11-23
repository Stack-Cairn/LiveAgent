// Math rendering (KaTeX, ~450 kB) is the largest part of the Markdown pipeline
// and only a reply with a formula needs it, so it loads on first use: Markdown
// renders the formula source until then (see components/Markdown.tsx).
import { lazyModule } from "./shared/lazyModule";

export const markdownMathPlugin = lazyModule(async () => (await import("@streamdown/math")).math);

/** True when the normalized content has a formula (normalizeLatexDelimiters writes `$$`). */
export function hasMarkdownMath(normalizedContent: string) {
  return normalizedContent.includes("$$");
}
