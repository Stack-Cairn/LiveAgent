import { normalizeErrorMessage } from "../providers/errorMessage";

/**
 * Failed turns. K-brain records a run that fails before the model produced a
 * reply as a synthetic assistant message (`assistant-error-<run id>`) whose
 * text is the raw provider or transport error, e.g.
 * `401 Unauthorized: {"error":{"message":"Incorrect API key…"}}`. The
 * transcript shows that text as a typed error row, never as reply markdown.
 */
const KBRAIN_ERROR_MESSAGE_ID_PREFIX = "assistant-error-";

export function isKBrainErrorMessageId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(KBRAIN_ERROR_MESSAGE_ID_PREFIX);
}

export type TurnErrorKind = "auth" | "rate_limit" | "server" | "connection" | "unknown";

export type TurnErrorInfo = {
  kind: TurnErrorKind;
  /** HTTP status of the failed model request, when the error names one. */
  status?: number;
  /** The provider's own message, extracted from a structured error body. */
  detail: string;
  /** The error exactly as reported, for the collapsed details. */
  raw: string;
};

const AUTH =
  /invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed|authentication|permission denied/i;
const RATE_LIMIT = /rate[_ ]limit|too many requests|quota exceeded/i;
const SERVER = /server[_ ]error|internal server error|bad gateway|service unavailable|overloaded/i;
const CONNECTION =
  /unexpected eof|connection (?:reset|refused|closed|lost)|econnreset|socket hang up|broken pipe|network error|failed to fetch|stream ended|event stream ended|ended without a terminal event/i;

function statusOf(raw: string): number | undefined {
  const match =
    /^\s*(?:http\s+)?([1-5]\d\d)\b/i.exec(raw) ??
    /\bstatus(?:[ _]?code)?["']?\s*[:=]?\s*([1-5]\d\d)\b/i.exec(raw) ??
    /\b([45]\d\d)\s+(?:unauthorized|forbidden|too many requests|internal server error|bad gateway|service unavailable|gateway timeout)\b/i.exec(
      raw,
    );
  return match ? Number(match[1]) : undefined;
}

/** Sort a failed turn's error into the few cases the transcript explains. */
export function classifyTurnError(rawMessage: string): TurnErrorInfo {
  const raw = rawMessage.trim();
  const status = statusOf(raw);
  const detail = normalizeErrorMessage(raw, "");
  const kind: TurnErrorKind =
    status === 401 || status === 403 || (status === undefined && AUTH.test(raw))
      ? "auth"
      : status === 429 || (status === undefined && RATE_LIMIT.test(raw))
        ? "rate_limit"
        : (status !== undefined && status >= 500) || (status === undefined && SERVER.test(raw))
          ? "server"
          : CONNECTION.test(raw)
            ? "connection"
            : "unknown";
  return { kind, ...(status === undefined ? {} : { status }), detail, raw };
}
