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

/**
 * A run stopped before the model produced anything leaves a marker message
 * (`assistant-stopped-<run id>`, stop_reason "cancelled", no content). It shows
 * as "Stopped"; code that looks for the conversation's trailing user message
 * or replays history to the backend skips it.
 */
const KBRAIN_STOPPED_MARKER_ID_PREFIX = "assistant-stopped-";

export function isKBrainStoppedMarkerId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(KBRAIN_STOPPED_MARKER_ID_PREFIX);
}

export type TurnErrorKind =
  | "auth"
  | "rate_limit"
  | "server"
  | "connection"
  | "timeout"
  | "context_limit"
  | "bad_request"
  | "unknown";

/**
 * The backend's own classification of a failed run (`error_detail` on
 * `run.failed` and on the saved failure message). `kind` is kept as sent;
 * kinds this build does not know read as unknown.
 */
export type TurnErrorDetail = {
  kind: string;
  upstreamStatus?: number;
  providerMessage?: string;
};

/** Read an `error_detail` object (snake_case from K-brain, camelCase once relayed). */
export function readTurnErrorDetail(value: unknown): TurnErrorDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (!kind) return undefined;
  const status = record.upstream_status ?? record.upstreamStatus;
  const message = record.provider_message ?? record.providerMessage;
  return {
    kind,
    ...(typeof status === "number" && Number.isInteger(status) && status > 0
      ? { upstreamStatus: status }
      : {}),
    ...(typeof message === "string" && message.trim() ? { providerMessage: message.trim() } : {}),
  };
}

const DETAIL_KINDS: Record<string, TurnErrorKind> = {
  invalid_api_key: "auth",
  rate_limited: "rate_limit",
  server_error: "server",
  connection_lost: "connection",
  unreachable: "connection",
  timeout: "timeout",
  context_limit: "context_limit",
  bad_request: "bad_request",
  not_found: "bad_request",
};

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

/**
 * Sort a failed turn's error into the few cases the transcript explains. The
 * backend's structured detail wins when present; older backends only send the
 * error text, which is classified by its status and wording.
 */
export function classifyTurnError(
  rawMessage: string,
  errorDetail?: TurnErrorDetail | null,
): TurnErrorInfo {
  const raw = rawMessage.trim();
  if (errorDetail) {
    const status = errorDetail.upstreamStatus;
    return {
      kind: DETAIL_KINDS[errorDetail.kind] ?? "unknown",
      ...(status === undefined ? {} : { status }),
      detail: errorDetail.providerMessage ?? normalizeErrorMessage(raw, ""),
      raw,
    };
  }
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
