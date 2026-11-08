/**
 * Readable one-line argument summaries for tools only K-brain registers (no legacy
 * frontend-runtime counterpart). Argument names follow K-brain's tool schemas:
 *
 * - TerminalSession / ReadTerminal: internal/tools/liveagent_schemas.go
 * - PlanningQuery / PlanningMutate: internal/backend/planning.go
 * - wait: internal/agent/wait.go
 * - workflow / structured_output: internal/agent/workflowtool.go
 * - new_context: internal/agent/context_tool.go
 * - remember / forget: internal/agent/memory.go
 * - memory_manager: internal/agent/memory_store_tool.go, internal/memoryruntime/tool.go
 * - browser_exec / computer_exec: internal/tools/browser.go, internal/tools/computer.go
 * - ToolSearch: internal/mcp/search.go
 *
 * Each summarizer returns the parts to join with spaces; empty parts are dropped by the caller.
 */

type Args = Record<string, unknown>;
type Part = string | null | undefined;

const MIDDLE_ELLIPSIS = "...";

function clip(value: unknown, maxLen = 80): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length <= maxLen) return text;
  const keep = Math.max(1, maxLen - MIDDLE_ELLIPSIS.length);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${MIDDLE_ELLIPSIS}${text.slice(text.length - (keep - head))}`;
}

function firstLine(value: unknown, maxLen = 96): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .split(/\r?\n|;/)
    .map((part) => part.trim())
    .find(Boolean);
  return clip(line, maxLen);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function seconds(value: unknown): string | null {
  const n = finiteNumber(value);
  return n === undefined ? null : `${Number.isInteger(n) ? n : n.toFixed(1)}s`;
}

function asRecord(value: unknown): Args | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Args) : null;
}

/** Epoch milliseconds as a local calendar day; planning ranges are whole days for the user. */
function localDay(value: unknown): string | null {
  const ms = finiteNumber(value);
  if (ms === undefined) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function summarizePlanningQuery(args: Args): Part[] {
  const from = localDay(args.from);
  const to = localDay(args.to);
  if (from && to) return [from === to ? from : `${from} → ${to}`];
  if (from) return [`from ${from}`];
  if (to) return [`until ${to}`];
  return [];
}

function summarizePlanningMutate(args: Args): Part[] {
  const data = asRecord(args.data);
  return [
    clip(args.action, 40),
    clip(data?.title, 60) ?? clip(data?.name, 60),
    typeof args.id === "string" ? `id=${clip(args.id, 40)}` : null,
  ];
}

// `gh pr checks 55 match=/pass/ every=30s timeout=1800s`: the condition first, then
// the polling knobs only when the model set them.
function summarizeWait(args: Args): Part[] {
  return [
    clip(args.command, 96),
    typeof args.until === "string" && args.until.trim() ? `match=/${clip(args.until, 40)}/` : null,
    typeof args.shell === "string" && args.shell.trim() ? `shell=${clip(args.shell, 16)}` : null,
    finiteNumber(args.interval) !== undefined ? `every=${seconds(args.interval)}` : null,
    finiteNumber(args.timeout) !== undefined ? `timeout=${seconds(args.timeout)}` : null,
  ];
}

const WORKFLOW_META_NAME =
  /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/;

function summarizeWorkflow(args: Args): Part[] {
  const script = typeof args.script === "string" ? args.script : "";
  const metaName = WORKFLOW_META_NAME.exec(script)?.[2];
  return [
    clip(metaName, 60) ?? clip(args.scriptPath, 80),
    typeof args.resumeFromRunId === "string" && args.resumeFromRunId.trim()
      ? `resume=${clip(args.resumeFromRunId, 40)}`
      : null,
  ];
}

// The arguments ARE the subagent's return value; list the top-level fields it filled in.
function summarizeStructuredOutput(args: Args): Part[] {
  const keys = Object.keys(args);
  if (keys.length === 0) return [];
  const shown = keys.slice(0, 4).join(", ");
  return [keys.length > 4 ? `${shown}, +${keys.length - 4}` : shown];
}

function memoryScope(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? `scope=${clip(value, 24)}` : null;
}

function summarizeRemember(args: Args): Part[] {
  return [clip(args.text, 96), memoryScope(args.scope)];
}

function summarizeForget(args: Args): Part[] {
  const n = finiteNumber(args.n);
  return [n === undefined ? null : `#${n}`, memoryScope(args.scope)];
}

// K-brain ships two shapes: `{operation, args}` (agent memory store) and
// `{action, args}` (memory runtime). Both carry the store's argument names in args.
function summarizeMemoryManager(args: Args): Part[] {
  const inner = asRecord(args.args) ?? {};
  return [
    clip(args.operation, 24) ?? clip(args.action, 24),
    clip(inner.slug, 60),
    typeof inner.query === "string" ? `query=${clip(inner.query, 60)}` : null,
    memoryScope(inner.scope),
  ];
}

function summarizeBrowserExec(args: Args): Part[] {
  const session = typeof args.session === "string" ? args.session.trim() : "";
  return [
    firstLine(args.code),
    session && session !== "default" ? `session=${clip(session, 32)}` : null,
  ];
}

function summarizeComputerExec(args: Args): Part[] {
  return [firstLine(args.code)];
}

function summarizeToolSearch(args: Args): Part[] {
  const max = finiteNumber(args.max_results);
  return [clip(args.query, 80), max === undefined ? null : `max=${max}`];
}

const KBRAIN_TOOL_SUMMARIZERS: Readonly<Record<string, (args: Args) => Part[]>> = {
  TerminalSession: (args) => [clip(args.command, 120)],
  ReadTerminal: (args) => [
    typeof args.terminal_id === "string" ? `terminal=${clip(args.terminal_id, 40)}` : null,
    typeof args.session_id === "string" ? `session=${clip(args.session_id, 40)}` : null,
    finiteNumber(args.max_bytes) !== undefined ? `maxBytes=${args.max_bytes}` : null,
  ],
  PlanningQuery: summarizePlanningQuery,
  PlanningMutate: summarizePlanningMutate,
  wait: summarizeWait,
  workflow: summarizeWorkflow,
  structured_output: summarizeStructuredOutput,
  new_context: () => [],
  remember: summarizeRemember,
  forget: summarizeForget,
  memory_manager: summarizeMemoryManager,
  browser_exec: summarizeBrowserExec,
  computer_exec: summarizeComputerExec,
  ToolSearch: summarizeToolSearch,
};

/** Summary parts for a K-brain-only tool, or `null` when the name is not one of them. */
export function summarizeKBrainToolArgs(name: string, args: Args | undefined): Part[] | null {
  const summarize = Object.hasOwn(KBRAIN_TOOL_SUMMARIZERS, name)
    ? KBRAIN_TOOL_SUMMARIZERS[name]
    : undefined;
  return summarize ? summarize(args ?? {}) : null;
}

/** The same summary as one string ("" when there is nothing to show). */
export function summarizeKBrainToolLine(name: string, args: Args | undefined): string | null {
  const parts = summarizeKBrainToolArgs(name, args);
  return parts ? parts.filter(Boolean).join(" ") : null;
}
