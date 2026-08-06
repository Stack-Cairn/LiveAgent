import { estimateTextTokens } from "./tokenLedger";

const MIN_SUMMARY_TOKENS = 80;

const SUMMARY_TAGS = [
  "task",
  "constraints",
  "state",
  "artifacts",
  "decisions",
  "dead_ends",
  "knowledge",
  "open_loops",
  "next_steps",
  "breadcrumbs",
] as const;

const REQUIRED_SUMMARY_TAGS: ReadonlyArray<(typeof SUMMARY_TAGS)[number]> = [
  "task",
  "state",
  "next_steps",
  "artifacts",
];

export type CompactionSummaryParsed = Record<(typeof SUMMARY_TAGS)[number], string>;

const ARTIFACT_LINE_RE = /^-\s*\[(\w+)]\s+(.+?)\s*\|\s*(\w+)/;

function extractTagContent(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function parseCompactionSummaryXml(raw: string): CompactionSummaryParsed {
  const cleaned = raw
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  const result = {} as CompactionSummaryParsed;
  for (const tag of SUMMARY_TAGS) {
    result[tag] = extractTagContent(cleaned, tag) ?? "";
  }
  return result;
}

export function formatSummaryForContext(s: CompactionSummaryParsed): string {
  const sections: string[] = [`## Task\n${s.task}`];
  if (s.constraints) sections.push(`## Constraints\n${s.constraints}`);
  sections.push(`## Current State\n${s.state}`);
  if (s.artifacts) sections.push(`## Artifacts\n${s.artifacts}`);
  if (s.decisions) sections.push(`## Decisions\n${s.decisions}`);
  if (s.dead_ends) sections.push(`## Dead Ends\n${s.dead_ends}`);
  if (s.knowledge) sections.push(`## Key Knowledge\n${s.knowledge}`);
  if (s.open_loops) sections.push(`## Open Loops\n${s.open_loops}`);
  sections.push(`## Next Steps\n${s.next_steps}`);
  if (s.breadcrumbs) sections.push(`## Breadcrumbs\n${s.breadcrumbs}`);
  return sections.join("\n\n");
}

export function validateCompactionSummary(raw: string, sourceTokens: number) {
  const parsed = parseCompactionSummaryXml(raw);
  const errors: string[] = [];

  for (const tag of REQUIRED_SUMMARY_TAGS) {
    if (!parsed[tag]) errors.push(`missing <${tag}>`);
  }

  if (parsed.artifacts) {
    const artifactLines = parsed.artifacts.split("\n").filter((l) => l.trim().startsWith("-"));
    if (artifactLines.length === 0) {
      errors.push("no artifact entries found (expected bullet lines starting with -)");
    } else {
      const malformed = artifactLines.filter((l) => !ARTIFACT_LINE_RE.test(l.trim()));
      if (malformed.length === artifactLines.length) {
        errors.push("no valid artifact lines (expected: - [kind] ref | status)");
      }
    }
  }

  // 用 CJK 感知的估算做"过短"下限：中文摘要每字符 token 密度更高，
  // 按纯字符数会把信息量足够的 CJK 摘要误判为过短。
  const totalTokens = estimateTextTokens(Object.values(parsed).join(""));
  if (sourceTokens >= 400 && totalTokens < MIN_SUMMARY_TOKENS) {
    errors.push("summary too short");
  }

  if (errors.length > 0) {
    throw new Error(`Compaction summary validation failed: ${errors.join(", ")}`);
  }

  return {
    summaryText: formatSummaryForContext(parsed),
  };
}
