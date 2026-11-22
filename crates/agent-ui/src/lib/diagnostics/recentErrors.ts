/**
 * In-memory capture of recent warnings and errors for diagnostics export.
 *
 * Bounded ring buffers only: nothing is written to disk and nothing leaves the
 * process unless the user exports a bundle (where it is redacted again).
 * Only warn/error levels are captured; info/debug output is where content
 * tends to be logged during development.
 */

import type { DiagnosticsLogEntry } from "./bundle";
import {
  emptyRedactionCounts,
  type RedactionCounts,
  redactJson,
  redactText,
  totalRedactions,
} from "./redact";

const MAX_ENTRIES = 200;
const MAX_MESSAGE_CHARS = 2000;

type CaptureTarget = {
  console: Pick<Console, "error" | "warn">;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
};

export type DiagnosticsCapture = {
  errors(): DiagnosticsLogEntry[];
  log(): DiagnosticsLogEntry[];
  record(entry: Omit<DiagnosticsLogEntry, "at" | "redactions"> & { at?: number }): void;
  dispose(): void;
};

function stringifyArgument(value: unknown, counts: RedactionCounts): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === undefined) return "undefined";
  try {
    // Structured arguments are scrubbed by key before they are flattened.
    return JSON.stringify(redactJson(value, { counts }));
  } catch {
    return String(value);
  }
}

function formatConsoleArguments(
  args: readonly unknown[],
  counts: RedactionCounts = emptyRedactionCounts(),
): string {
  const text = args.map((arg) => stringifyArgument(arg, counts)).join(" ");
  const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
  return redactText(clipped, { counts });
}

export function createDiagnosticsCapture(
  target: CaptureTarget,
  now: () => number = Date.now,
): DiagnosticsCapture {
  const errorEntries: DiagnosticsLogEntry[] = [];
  const logEntries: DiagnosticsLogEntry[] = [];
  const push = (list: DiagnosticsLogEntry[], entry: DiagnosticsLogEntry) => {
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  };
  // `counts` carries what formatting already removed, so the export preview can
  // report it even though only scrubbed text is kept in memory.
  const store = (
    entry: Omit<DiagnosticsLogEntry, "at" | "redactions"> & { at?: number },
    counts: RedactionCounts,
  ) => {
    const message = redactText(entry.message.slice(0, MAX_MESSAGE_CHARS), { counts });
    const complete: DiagnosticsLogEntry = {
      at: entry.at ?? now(),
      level: entry.level,
      source: entry.source,
      message,
      ...(totalRedactions(counts) > 0 ? { redactions: counts } : {}),
    };
    push(logEntries, complete);
    if (complete.level === "error") push(errorEntries, complete);
  };
  const record: DiagnosticsCapture["record"] = (entry) => store(entry, emptyRedactionCounts());
  const recordArgs = (level: DiagnosticsLogEntry["level"], source: string, args: unknown[]) => {
    const counts = emptyRedactionCounts();
    store({ level, source, message: formatConsoleArguments(args, counts) }, counts);
  };

  const originalError = target.console.error;
  const originalWarn = target.console.warn;
  target.console.error = (...args: unknown[]) => {
    recordArgs("error", "console", args);
    originalError.apply(target.console, args);
  };
  target.console.warn = (...args: unknown[]) => {
    recordArgs("warn", "console", args);
    originalWarn.apply(target.console, args);
  };
  const onError = (event: unknown) => {
    const error = (event as { error?: unknown; message?: string }) ?? {};
    recordArgs("error", "window", [error.error ?? error.message ?? "Unknown error"]);
  };
  const onRejection = (event: unknown) => {
    const reason = (event as { reason?: unknown })?.reason;
    recordArgs("error", "promise", [reason ?? "Unhandled rejection"]);
  };
  target.addEventListener?.("error", onError);
  target.addEventListener?.("unhandledrejection", onRejection);

  return {
    errors: () => [...errorEntries],
    log: () => [...logEntries],
    record,
    dispose() {
      target.console.error = originalError;
      target.console.warn = originalWarn;
      target.removeEventListener?.("error", onError);
      target.removeEventListener?.("unhandledrejection", onRejection);
    },
  };
}

let globalCapture: DiagnosticsCapture | null = null;

/** Installs the process-wide capture once; later calls return the same instance. */
export function installDiagnosticsCapture(): DiagnosticsCapture {
  if (globalCapture) return globalCapture;
  const scope = globalThis as unknown as CaptureTarget & { window?: CaptureTarget };
  globalCapture = createDiagnosticsCapture({
    console: globalThis.console,
    addEventListener: scope.window?.addEventListener?.bind(scope.window),
    removeEventListener: scope.window?.removeEventListener?.bind(scope.window),
  });
  return globalCapture;
}

export function getDiagnosticsCapture(): DiagnosticsCapture | null {
  return globalCapture;
}
