// Streaming preview protocol for file-writing tools (Write / Edit /
// NotebookEdit) — the single derivation shared by summaries, arg displays and
// the streaming preview cards.
//
// The desktop app is the sole producer: bridge events and runtime snapshots
// both carry field text truncated to a bounded preview plus a
// __liveagent_stream_preview meta block holding the true metrics. `progress`
// (sum of true field chars) is a monotonic revision — streamed arguments only
// grow — used to reject stale writers (late deltas, lagging snapshots)
// wherever tool args are merged. Args without meta (local live rounds,
// persisted history) fall back to raw string lengths, which at any stream
// position are >= the truncated preview's metrics, so the guard composes
// across representations.

export const LIVE_TOOL_PREVIEW_META_KEY = "__liveagent_stream_preview";

export const FILE_TOOL_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Write: ["content"],
  Edit: ["old_string", "new_string"],
  NotebookEdit: ["new_source"],
};

export type PreviewFieldMetrics = {
  chars: number;
  lines: number;
  truncated: boolean;
};

export type StreamPreviewMeta = {
  v: 2;
  progress: number;
  fields: Record<string, PreviewFieldMetrics>;
};

export function countTextLines(input: string) {
  if (input.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 13) {
      lines += 1;
      if (input.charCodeAt(index + 1) === 10) {
        index += 1;
      }
    } else if (code === 10) {
      lines += 1;
    }
  }
  return lines;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Tolerant reader: accepts metas missing v/progress (older producers) —
// per-field chars still read, the progress guard just stays inert.
export function readStreamPreviewMeta(
  args: Record<string, unknown>,
): { progress?: number; fields: Record<string, Partial<PreviewFieldMetrics>> } | null {
  const meta = asRecord(args[LIVE_TOOL_PREVIEW_META_KEY]);
  const rawFields = asRecord(meta.fields);
  const fields: Record<string, Partial<PreviewFieldMetrics>> = {};
  for (const [name, value] of Object.entries(rawFields)) {
    const field = asRecord(value);
    if (Object.keys(field).length === 0) continue;
    fields[name] = {
      chars: finiteNumber(field.chars),
      lines: finiteNumber(field.lines),
      truncated: typeof field.truncated === "boolean" ? field.truncated : undefined,
    };
  }
  if (Object.keys(fields).length === 0) return null;
  return { progress: finiteNumber(meta.progress), fields };
}

// True char count of a preview field: producer meta when present, else the
// raw string length.
export function fileToolFieldChars(args: Record<string, unknown>, field: string) {
  const metaChars = readStreamPreviewMeta(args)?.fields[field]?.chars;
  if (metaChars !== undefined) return metaChars;
  const value = args[field];
  return typeof value === "string" ? value.length : undefined;
}

// True line count of a preview field: producer meta when present, else the
// raw string's line count.
export function fileToolFieldLines(args: Record<string, unknown>, field: string) {
  const metaLines = readStreamPreviewMeta(args)?.fields[field]?.lines;
  if (metaLines !== undefined) return metaLines;
  const value = args[field];
  return typeof value === "string" ? countTextLines(value) : undefined;
}

// Monotonic progress of a tool call's args; undefined for untracked tools
// (merge behavior unchanged there).
export function toolArgsProgress(name: string, args: Record<string, unknown>) {
  const fields = FILE_TOOL_TEXT_FIELDS[name];
  if (!fields) return undefined;
  const meta = readStreamPreviewMeta(args);
  if (meta?.progress !== undefined) return meta.progress;
  let progress = 0;
  for (const field of fields) {
    progress += fileToolFieldChars(args, field) ?? 0;
  }
  return progress;
}

const FILE_TOOL_DISPLAY_MAX_CHARS = 4000;

export type FileToolFieldPreview = {
  has: boolean;
  text: string;
  chars: number;
  lines: number;
  truncated: boolean;
};

export type FileToolPreview =
  | {
      kind: "write";
      name: string;
      path: string;
      field: string;
      content: FileToolFieldPreview;
    }
  | {
      kind: "edit";
      name: string;
      path: string;
      oldString: FileToolFieldPreview;
      newString: FileToolFieldPreview;
      expectedReplacements?: number;
      replaceAll: boolean;
    };

function deriveFieldPreview(args: Record<string, unknown>, field: string): FileToolFieldPreview {
  const raw = args[field];
  const has = typeof raw === "string";
  const text = has ? (raw as string) : "";
  const meta = readStreamPreviewMeta(args)?.fields[field];
  if (meta) {
    // Producer-truncated text: the meta carries the true metrics.
    return {
      has,
      text,
      chars: meta.chars ?? text.length,
      lines: meta.lines ?? countTextLines(text),
      truncated: meta.truncated ?? false,
    };
  }
  // Raw full args (local live rounds, persisted history): cap the display.
  const truncated = text.length > FILE_TOOL_DISPLAY_MAX_CHARS;
  return {
    has,
    text: truncated
      ? `${text.slice(0, FILE_TOOL_DISPLAY_MAX_CHARS)}\n...[truncated ${
          text.length - FILE_TOOL_DISPLAY_MAX_CHARS
        } chars]...`
      : text,
    chars: text.length,
    lines: countTextLines(text),
    truncated,
  };
}

export function deriveFileToolPreview(toolCall: {
  name: string;
  arguments?: Record<string, unknown>;
}): FileToolPreview | null {
  const name = toolCall.name;
  const fields = FILE_TOOL_TEXT_FIELDS[name];
  if (!fields) return null;
  const args = toolCall.arguments || {};
  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.notebook_path === "string"
        ? args.notebook_path
        : "";

  if (name === "Edit") {
    return {
      kind: "edit",
      name,
      path,
      oldString: deriveFieldPreview(args, "old_string"),
      newString: deriveFieldPreview(args, "new_string"),
      expectedReplacements:
        typeof args.expected_replacements === "number" ? args.expected_replacements : undefined,
      replaceAll: args.replace_all === true,
    };
  }
  const field = fields[0];
  return {
    kind: "write",
    name,
    path,
    field,
    content: deriveFieldPreview(args, field),
  };
}
