// MCP form elicitation (K-brain /v1 `elicitation.*`, Stack-Cairn/K-brain#174): shared pure
// logic for the desktop app and the WebUI. Types, tolerant parsers for the K-brain payloads,
// the synthetic tool-call argument keys, and client-side validation that mirrors K-brain's
// internal/elicit/validate.go so most mistakes are caught before the answer is posted.
// Zero dependencies; every server-supplied string is data and is rendered as plain text.

/** Health capability that says the backend can relay MCP elicitation requests. */
export const MCP_ELICITATION_CAPABILITY = "mcp_elicitation";
/** Shared prefix of the synthetic arguments below (the gateway strips it as one prefix). */
export const MCP_ELICITATION_SYNTHETIC_ARG_PREFIX = "__mcpElicitation";
/**
 * Synthetic tool-call argument: the elicitation requests still waiting for an answer, in the
 * K-brain `elicitation.requested` shape. Set by the desktop app and the gateway relay so the
 * WebUI (and replays) render the same form; never part of what the model called.
 */
export const MCP_ELICITATION_PENDING_ARG = "__mcpElicitationPending";
/**
 * Synthetic tool-call argument: requests already resolved during the live run, in the
 * K-brain `elicitation.resolved` shape plus the fields of the request. The tool result's
 * `kbrainElicitations` details supersede them once the tool finishes.
 */
export const MCP_ELICITATION_RECORDS_ARG = "__mcpElicitations";
/** Tool-result details key holding K-brain's `elicitations` records for the call. */
export const MCP_ELICITATION_DETAILS_KEY = "kbrainElicitations";

export const MCP_ELICITATION_SYNTHETIC_ARG_KEYS = [
  MCP_ELICITATION_PENDING_ARG,
  MCP_ELICITATION_RECORDS_ARG,
] as const;

export type McpElicitationFieldType = "string" | "number" | "integer" | "boolean" | "array";
export type McpElicitationAction = "accept" | "decline" | "cancel";
/** How the action came about; the last three are automatic declines that never asked. */
export type McpElicitationReason =
  | "user"
  | "timeout"
  | "cancelled"
  | "no_client"
  | "unattended"
  | "limit";

export type McpElicitationOption = { value: string; label: string };

export type McpElicitationField = {
  name: string;
  type: McpElicitationFieldType;
  title?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  options?: McpElicitationOption[];
  minItems?: number;
  maxItems?: number;
  /** A free-text field that reads like a secret: masked, and never kept in history. */
  sensitive?: boolean;
};

/** Who asks: an MCP server (no source) or an SSH server's login prompt ("ssh"). */
export const MCP_ELICITATION_SOURCE_SSH = "ssh";

export type McpElicitationRequest = {
  elicitationId: string;
  /** "ssh" for an SSH login (password, passphrase or keyboard-interactive prompts). */
  source?: string;
  toolCallId: string;
  runId?: string;
  /** Answer deadline, epoch milliseconds (backend clock). */
  deadlineAt?: number;
  /** MCP server config key: who receives the answer. */
  server: string;
  tool?: string;
  message: string;
  fields: McpElicitationField[];
};

export type McpElicitationRecord = {
  /** Empty when the request never reached a /v1 client (automatic declines). */
  elicitationId?: string;
  source?: string;
  server: string;
  tool?: string;
  message: string;
  fields: McpElicitationField[];
  action: McpElicitationAction;
  reason: McpElicitationReason;
  /** The accepted answer without the values of sensitive fields. */
  content?: Record<string, unknown>;
  /** Names of fields whose values were removed. */
  redacted?: string[];
};

export type McpElicitationContent = Record<string, string | number | boolean | string[]>;

/** Draft values as the form holds them: text for strings and numbers, lists for arrays. */
export type McpElicitationDraftValue = string | boolean | string[] | undefined;
export type McpElicitationDraft = Record<string, McpElicitationDraftValue>;

/** A client-side validation problem: an i18n key plus its interpolation values. */
export type McpElicitationIssue = { key: string; values?: Record<string, string | number> };

export type McpElicitationSubmitOutcome = {
  ok: boolean;
  /** Server-side per-field messages (HTTP 400); the form stays open. */
  fieldErrors?: Record<string, string>;
  message?: string;
};

const FIELD_TYPES = new Set<McpElicitationFieldType>([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
]);
const FORMATS = new Set(["email", "uri", "date", "date-time"]);
const ACTIONS = new Set<McpElicitationAction>(["accept", "decline", "cancel"]);
const REASONS = new Set<McpElicitationReason>([
  "user",
  "timeout",
  "cancelled",
  "no_client",
  "unattended",
  "limit",
]);
/** Reasons that mean nobody was asked: rendered as a small note, not a card. */
export const MCP_ELICITATION_AUTO_DECLINE_REASONS: ReadonlySet<McpElicitationReason> = new Set([
  "no_client",
  "unattended",
  "limit",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptions(value: unknown): McpElicitationOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: McpElicitationOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.value !== "string") continue;
    options.push({ value: entry.value, label: readString(entry.label) || entry.value });
  }
  return options.length > 0 ? options : undefined;
}

/** Parses one field of K-brain's `fields[]` (snake_case); unusable entries yield null. */
export function parseMcpElicitationField(raw: unknown): McpElicitationField | null {
  if (!isRecord(raw)) return null;
  const name = readString(raw.name);
  const type = readString(raw.type) as McpElicitationFieldType;
  if (!name || !FIELD_TYPES.has(type)) return null;
  const field: McpElicitationField = { name, type };
  const title = readString(raw.title);
  if (title) field.title = title;
  const description = readString(raw.description);
  if (description) field.description = description;
  if (raw.required === true) field.required = true;
  if (raw.default !== undefined && raw.default !== null) field.default = raw.default;
  const format = readString(raw.format);
  if (FORMATS.has(format)) field.format = format as McpElicitationField["format"];
  const minLength = readCount(raw.min_length ?? raw.minLength);
  if (minLength !== undefined) field.minLength = minLength;
  const maxLength = readCount(raw.max_length ?? raw.maxLength);
  if (maxLength !== undefined) field.maxLength = maxLength;
  const pattern = readString(raw.pattern);
  if (pattern) field.pattern = pattern;
  const minimum = readNumber(raw.minimum);
  if (minimum !== undefined) field.minimum = minimum;
  const maximum = readNumber(raw.maximum);
  if (maximum !== undefined) field.maximum = maximum;
  const options = parseOptions(raw.options);
  if (options) field.options = options;
  const minItems = readCount(raw.min_items ?? raw.minItems);
  if (minItems !== undefined) field.minItems = minItems;
  const maxItems = readCount(raw.max_items ?? raw.maxItems);
  if (maxItems !== undefined) field.maxItems = maxItems;
  // `format: "password"` is how JSON-schema producers mark a secret; it masks like `sensitive`.
  if (raw.sensitive === true || (type === "string" && format === "password")) {
    field.sensitive = true;
  }
  return field;
}

export function parseMcpElicitationFields(raw: unknown): McpElicitationField[] {
  if (!Array.isArray(raw)) return [];
  const fields: McpElicitationField[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const field = parseMcpElicitationField(entry);
    if (!field || seen.has(field.name)) continue;
    seen.add(field.name);
    fields.push(field);
  }
  return fields;
}

/** Parses a K-brain `elicitation.requested` payload (or the pending synthetic arg entry). */
export function parseMcpElicitationRequest(raw: unknown): McpElicitationRequest | null {
  if (!isRecord(raw)) return null;
  const elicitationId = readString(raw.elicitation_id ?? raw.elicitationId);
  if (!elicitationId) return null;
  const request: McpElicitationRequest = {
    elicitationId,
    toolCallId: readString(raw.tool_call_id ?? raw.toolCallId),
    server: readString(raw.server),
    message: readString(raw.message),
    fields: parseMcpElicitationFields(raw.fields),
  };
  const runId = readString(raw.run_id ?? raw.runId);
  if (runId) request.runId = runId;
  const deadlineAt = readNumber(raw.deadline_at ?? raw.deadlineAt);
  if (deadlineAt !== undefined && deadlineAt > 0) request.deadlineAt = deadlineAt;
  const tool = readString(raw.tool);
  if (tool) request.tool = tool;
  const source = readString(raw.source);
  if (source) request.source = source;
  return request;
}

/**
 * Parses an `elicitation.resolved` payload or a history `elicitations[]` record. Unknown
 * actions or reasons yield null rather than a guess.
 */
export function parseMcpElicitationRecord(raw: unknown): McpElicitationRecord | null {
  if (!isRecord(raw)) return null;
  const action = readString(raw.action) as McpElicitationAction;
  if (!ACTIONS.has(action)) return null;
  const reasonText = readString(raw.reason) as McpElicitationReason;
  const reason: McpElicitationReason = REASONS.has(reasonText) ? reasonText : "user";
  const record: McpElicitationRecord = {
    server: readString(raw.server),
    message: readString(raw.message),
    fields: parseMcpElicitationFields(raw.fields),
    action,
    reason,
  };
  const elicitationId = readString(raw.elicitation_id ?? raw.elicitationId);
  if (elicitationId) record.elicitationId = elicitationId;
  const tool = readString(raw.tool);
  if (tool) record.tool = tool;
  const source = readString(raw.source);
  if (source) record.source = source;
  if (action === "accept" && isRecord(raw.content)) record.content = { ...raw.content };
  if (Array.isArray(raw.redacted)) {
    const redacted = raw.redacted.filter((name): name is string => typeof name === "string");
    if (redacted.length > 0) record.redacted = redacted;
  }
  // Defence in depth: never carry a value for a field marked sensitive, even if a producer
  // forgot to redact it.
  if (record.content) {
    for (const field of record.fields) {
      if (field.sensitive && field.name in record.content) {
        delete record.content[field.name];
        record.redacted = [...new Set([...(record.redacted ?? []), field.name])];
      }
    }
  }
  return record;
}

export function parseMcpElicitationRequests(raw: unknown): McpElicitationRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseMcpElicitationRequest)
    .filter((entry): entry is McpElicitationRequest => entry !== null);
}

export function parseMcpElicitationRecords(raw: unknown): McpElicitationRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseMcpElicitationRecord)
    .filter((entry): entry is McpElicitationRecord => entry !== null);
}

/** Pending requests carried on tool-call arguments. */
export function readMcpElicitationPending(
  args: Record<string, unknown> | undefined,
): McpElicitationRequest[] {
  return parseMcpElicitationRequests(args?.[MCP_ELICITATION_PENDING_ARG]);
}

/** Records resolved during the live run, carried on tool-call arguments. */
export function readMcpElicitationLiveRecords(
  args: Record<string, unknown> | undefined,
): McpElicitationRecord[] {
  return parseMcpElicitationRecords(args?.[MCP_ELICITATION_RECORDS_ARG]);
}

/** Authoritative records from tool-result details (live result or history reload). */
export function readMcpElicitationDetails(details: unknown): McpElicitationRecord[] {
  return isRecord(details) ? parseMcpElicitationRecords(details[MCP_ELICITATION_DETAILS_KEY]) : [];
}

/** Tool-result details without the elicitation records (they get their own rendering). */
export function withoutMcpElicitationDetails(details: unknown): unknown {
  if (!isRecord(details) || !(MCP_ELICITATION_DETAILS_KEY in details)) return details;
  const { [MCP_ELICITATION_DETAILS_KEY]: _omitted, ...rest } = details;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Returns `details` with the K-brain `elicitations` records of a tool result (or history
 * tool call) attached under `kbrainElicitations`; unchanged when there are none.
 */
export function withMcpElicitationDetails<T>(details: T, rawElicitations: unknown): T {
  if (!Array.isArray(rawElicitations) || rawElicitations.length === 0) return details;
  const base = isRecord(details) ? details : {};
  return { ...base, [MCP_ELICITATION_DETAILS_KEY]: rawElicitations } as T;
}

export type McpElicitationEntry =
  | { kind: "pending"; request: McpElicitationRequest }
  | { kind: "record"; record: McpElicitationRecord };

/**
 * Everything to show for one tool call, oldest first: authoritative result records, then
 * live records the result does not cover yet, then requests still waiting for an answer.
 */
export function collectMcpElicitationEntries({
  args,
  details,
}: {
  args?: Record<string, unknown>;
  details?: unknown;
}): McpElicitationEntry[] {
  const entries: McpElicitationEntry[] = [];
  const resolvedIds = new Set<string>();
  for (const record of readMcpElicitationDetails(details)) {
    if (record.elicitationId) resolvedIds.add(record.elicitationId);
    entries.push({ kind: "record", record });
  }
  const pending = readMcpElicitationPending(args);
  const fieldsById = new Map(pending.map((request) => [request.elicitationId, request.fields]));
  for (const record of readMcpElicitationLiveRecords(args)) {
    if (record.elicitationId && resolvedIds.has(record.elicitationId)) continue;
    if (record.elicitationId) resolvedIds.add(record.elicitationId);
    const fields =
      record.fields.length > 0
        ? record.fields
        : (fieldsById.get(record.elicitationId ?? "") ?? record.fields);
    entries.push({ kind: "record", record: { ...record, fields } });
  }
  for (const request of pending) {
    if (resolvedIds.has(request.elicitationId)) continue;
    entries.push({ kind: "pending", request });
  }
  return entries;
}

export function hasPendingMcpElicitation(args: Record<string, unknown> | undefined): boolean {
  return readMcpElicitationPending(args).length > 0;
}

// ---------------------------------------------------------------------------------------
// Form drafts and validation (mirrors K-brain internal/elicit/validate.go)

export function isMcpElicitationChoice(field: McpElicitationField): boolean {
  return field.type === "string" && (field.options?.length ?? 0) > 0;
}

/** Initial draft: the server's defaults, otherwise empty. */
export function initialMcpElicitationDraft(fields: McpElicitationField[]): McpElicitationDraft {
  const draft: McpElicitationDraft = {};
  for (const field of fields) {
    const value = field.default;
    switch (field.type) {
      case "string":
        draft[field.name] = typeof value === "string" ? value : "";
        break;
      case "number":
      case "integer":
        draft[field.name] =
          typeof value === "number" && Number.isFinite(value) ? String(value) : "";
        break;
      case "boolean":
        draft[field.name] = typeof value === "boolean" ? value : undefined;
        break;
      case "array":
        draft[field.name] = Array.isArray(value)
          ? value.filter(
              (item): item is string =>
                typeof item === "string" &&
                (field.options ?? []).some((option) => option.value === item),
            )
          : [];
        break;
    }
  }
  return draft;
}

function runeLength(value: string): number {
  return Array.from(value).length;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(6)));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= days;
}

function checkFormat(format: McpElicitationField["format"], value: string): string | null {
  switch (format) {
    case "email":
      return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/.test(value)
        ? null
        : "chat.mcpElicitation.error.email";
    case "uri":
      return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/[ \t\n]/.test(value)
        ? null
        : "chat.mcpElicitation.error.uri";
    case "date": {
      const match = DATE_RE.exec(value);
      return match && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
        ? null
        : "chat.mcpElicitation.error.date";
    }
    case "date-time": {
      const match = DATE_TIME_RE.exec(value);
      const valid =
        match !== null &&
        isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
        Number(match[4]) < 24 &&
        Number(match[5]) < 60 &&
        Number(match[6]) < 60 &&
        (match[9] === undefined || (Number(match[9]) < 24 && Number(match[10]) < 60));
      return valid ? null : "chat.mcpElicitation.error.dateTime";
    }
    default:
      return null;
  }
}

/**
 * Tests a pattern the way JSON Schema does (unanchored). Patterns use Go RE2 syntax; one
 * JavaScript cannot compile is left to the server, which is authoritative.
 */
function matchesPattern(pattern: string, value: string): boolean | null {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return null;
    }
  }
}

type FieldCheck = { value?: string | number | boolean | string[]; issue?: McpElicitationIssue };

function checkField(field: McpElicitationField, draftValue: McpElicitationDraftValue): FieldCheck {
  // An empty input counts as absent: optional fields are left out, required ones flagged.
  const absent =
    draftValue === undefined ||
    (typeof draftValue === "string" && draftValue.trim() === "" && field.type !== "string") ||
    (typeof draftValue === "string" && draftValue === "") ||
    (Array.isArray(draftValue) && draftValue.length === 0);
  if (absent) {
    return field.required ? { issue: { key: "chat.mcpElicitation.error.required" } } : {};
  }
  switch (field.type) {
    case "string": {
      if (typeof draftValue !== "string")
        return { issue: { key: "chat.mcpElicitation.error.type" } };
      if (isMcpElicitationChoice(field)) {
        return (field.options ?? []).some((option) => option.value === draftValue)
          ? { value: draftValue }
          : { issue: { key: "chat.mcpElicitation.error.choice" } };
      }
      const length = runeLength(draftValue);
      if (field.minLength !== undefined && length < field.minLength) {
        return {
          issue: { key: "chat.mcpElicitation.error.minLength", values: { count: field.minLength } },
        };
      }
      if (field.maxLength !== undefined && length > field.maxLength) {
        return {
          issue: { key: "chat.mcpElicitation.error.maxLength", values: { count: field.maxLength } },
        };
      }
      const formatIssue = checkFormat(field.format, draftValue);
      if (formatIssue) return { issue: { key: formatIssue } };
      if (field.pattern && matchesPattern(field.pattern, draftValue) === false) {
        return { issue: { key: "chat.mcpElicitation.error.pattern" } };
      }
      return { value: draftValue };
    }
    case "number":
    case "integer": {
      const text = typeof draftValue === "string" ? draftValue.trim() : "";
      const number = text === "" ? Number.NaN : Number(text);
      if (!Number.isFinite(number)) return { issue: { key: "chat.mcpElicitation.error.number" } };
      if (field.type === "integer" && !Number.isInteger(number)) {
        return { issue: { key: "chat.mcpElicitation.error.integer" } };
      }
      if (field.minimum !== undefined && number < field.minimum) {
        return {
          issue: {
            key: "chat.mcpElicitation.error.minimum",
            values: { value: formatNumber(field.minimum) },
          },
        };
      }
      if (field.maximum !== undefined && number > field.maximum) {
        return {
          issue: {
            key: "chat.mcpElicitation.error.maximum",
            values: { value: formatNumber(field.maximum) },
          },
        };
      }
      return { value: number };
    }
    case "boolean":
      return typeof draftValue === "boolean"
        ? { value: draftValue }
        : { issue: { key: "chat.mcpElicitation.error.boolean" } };
    case "array": {
      if (!Array.isArray(draftValue)) return { issue: { key: "chat.mcpElicitation.error.choice" } };
      const options = field.options ?? [];
      const chosen = new Set(draftValue);
      if (
        chosen.size !== draftValue.length ||
        draftValue.some((item) => !options.some((o) => o.value === item))
      ) {
        return { issue: { key: "chat.mcpElicitation.error.choice" } };
      }
      if (field.minItems !== undefined && chosen.size < field.minItems) {
        return {
          issue: { key: "chat.mcpElicitation.error.minItems", values: { count: field.minItems } },
        };
      }
      if (field.maxItems !== undefined && chosen.size > field.maxItems) {
        return {
          issue: { key: "chat.mcpElicitation.error.maxItems", values: { count: field.maxItems } },
        };
      }
      // Option order, as the server canonicalises it.
      return { value: options.filter((o) => chosen.has(o.value)).map((o) => o.value) };
    }
  }
  return { issue: { key: "chat.mcpElicitation.error.type" } };
}

/** Problem with one field's draft value, or null when it is fine. */
export function validateMcpElicitationField(
  field: McpElicitationField,
  draftValue: McpElicitationDraftValue,
): McpElicitationIssue | null {
  return checkField(field, draftValue).issue ?? null;
}

/**
 * Validates the whole draft. On success returns the content to post: only the fields the
 * user filled in, numbers as numbers and multi choices in option order.
 */
export function buildMcpElicitationContent(
  fields: McpElicitationField[],
  draft: McpElicitationDraft,
):
  | { ok: true; content: McpElicitationContent }
  | { ok: false; issues: Record<string, McpElicitationIssue> } {
  const content: McpElicitationContent = {};
  const issues: Record<string, McpElicitationIssue> = {};
  for (const field of fields) {
    const check = checkField(field, draft[field.name]);
    if (check.issue) issues[field.name] = check.issue;
    else if (check.value !== undefined) content[field.name] = check.value;
  }
  return Object.keys(issues).length > 0 ? { ok: false, issues } : { ok: true, content };
}

/** Display label of a field: its title, otherwise its property name. */
export function mcpElicitationFieldLabel(field: McpElicitationField): string {
  return field.title || field.name;
}

/** Summary text of one accepted value (choices shown by label, lists joined). */
export function formatMcpElicitationValue(
  field: McpElicitationField | undefined,
  value: unknown,
  labels: { yes: string; no: string },
): string {
  const optionLabel = (item: string) =>
    field?.options?.find((option) => option.value === item)?.label ?? item;
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return optionLabel(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? optionLabel(item) : String(item)))
      .join(", ");
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Outcome key for a resolved record:
 * accepted / declined / cancelled (by the user), timedOut, runCancelled, or one of the
 * automatic declines.
 */
export function mcpElicitationOutcome(
  record: Pick<McpElicitationRecord, "action" | "reason">,
): "accepted" | "declined" | "cancelled" | "timedOut" | "runCancelled" | McpElicitationReason {
  if (record.reason === "timeout") return "timedOut";
  if (record.reason === "cancelled") return "runCancelled";
  if (MCP_ELICITATION_AUTO_DECLINE_REASONS.has(record.reason)) return record.reason;
  if (record.action === "accept") return "accepted";
  if (record.action === "decline") return "declined";
  return "cancelled";
}

/** An SSH login form rather than an MCP server's question. */
export function isSshElicitation(entry: { source?: string; server: string }): boolean {
  return entry.source === MCP_ELICITATION_SOURCE_SSH;
}

/** The host an SSH login form is for: K-brain names the server `ssh:<host name>`. */
export function sshElicitationHost(entry: { server: string }): string {
  return entry.server.startsWith("ssh:") ? entry.server.slice(4) : entry.server;
}
