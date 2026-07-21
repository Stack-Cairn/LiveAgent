import type { CompactionPayload } from "./payload";
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

const COMMAND_SIGNAL_RE =
  /(?:^|[\s`])(pnpm|npm|yarn|bun|cargo|git|node|npx|uv|pytest|python|python3|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?)\s+[^\n\r`]+/gi;
const POSIX_PATH_SIGNAL_RE =
  /(?:\/|\.{1,2}\/)[^\s"'`]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?/g;
const WINDOWS_PATH_SIGNAL_RE =
  /(?:[A-Za-z]:\\[^\s"'`]+|\\\\[^\s"'`]+|(?:[A-Za-z0-9._-]+\\){1,}[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)/g;

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

function pushVerificationSignal(
  out: string[],
  seen: Set<string>,
  candidate: string,
  maxChars = 160,
) {
  const normalized = candidate.trim().replace(/\s+/g, " ");
  if (normalized.length < 4) return;
  if (!/[./_:\\-]/.test(normalized) && !/\s/.test(normalized)) return;

  const truncated =
    normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
  const key = truncated.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(truncated);
}

function extractVerificationSignalsFromText(text: string, out: string[], seen: Set<string>) {
  if (!text.trim()) return;

  for (const match of text.matchAll(COMMAND_SIGNAL_RE)) {
    pushVerificationSignal(out, seen, match[0], 180);
    if (out.length >= 6) return;
  }

  for (const match of text.matchAll(POSIX_PATH_SIGNAL_RE)) {
    pushVerificationSignal(out, seen, match[0], 180);
    if (out.length >= 6) return;
  }

  for (const match of text.matchAll(WINDOWS_PATH_SIGNAL_RE)) {
    pushVerificationSignal(out, seen, match[0], 180);
    if (out.length >= 6) return;
  }
}

// 从 payload 的近期消息中抽取路径/命令等技术引用；摘要若一个都没保留，
// 视为幻觉性丢失，触发校验失败（self-repair 会带着错误原因重试）。
export function buildVerificationSignals(payload: CompactionPayload) {
  const out: string[] = [];
  const seen = new Set<string>();
  const recentMessages = payload.active_segment_messages.slice(-6).reverse();

  if (typeof payload.next_user_message === "string") {
    extractVerificationSignalsFromText(payload.next_user_message, out, seen);
  }

  for (const message of recentMessages) {
    if ("content" in message && typeof message.content === "string") {
      extractVerificationSignalsFromText(message.content, out, seen);
    }
    if ("text" in message && typeof message.text === "string") {
      extractVerificationSignalsFromText(message.text, out, seen);
    }
    if ("details" in message && typeof message.details === "string") {
      extractVerificationSignalsFromText(message.details, out, seen);
    }
    if ("toolCalls" in message && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        if (typeof toolCall !== "string") continue;
        extractVerificationSignalsFromText(toolCall, out, seen);
        if (out.length >= 6) return out;
      }
    }
    if (out.length >= 6) break;
  }

  return out.slice(0, 6);
}

function collectSummarySearchCorpus(parsed: CompactionSummaryParsed) {
  const out: string[] = [];
  for (const tag of SUMMARY_TAGS) {
    const value = parsed[tag].trim();
    if (value) out.push(value.toLowerCase());
  }
  return out;
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

export function validateCompactionSummary(
  raw: string,
  sourceTokens: number,
  payload: CompactionPayload,
) {
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

  const verificationSignals = buildVerificationSignals(payload);
  if (verificationSignals.length > 0) {
    const corpus = collectSummarySearchCorpus(parsed);
    const matchedCount = verificationSignals.filter((signal) =>
      corpus.some((entry) => entry.includes(signal.toLowerCase())),
    ).length;
    if (matchedCount === 0) {
      errors.push("verification pass missing recent technical refs");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Compaction summary validation failed: ${errors.join(", ")}`);
  }

  return {
    summaryText: formatSummaryForContext(parsed),
  };
}
