// Cross-audience prompt constants. Each policy string exists exactly once —
// the injection prompt, the extraction prompt, and the MemoryManager tool
// schema all compose from here, so wording can never drift between audiences.

import { CONFIDENCE_CONTRACT } from "../schema";

export const MEMORY_SLUG_POLICY =
  "Slugs are stable internal IDs. Never include the user's current name, old name, nickname, or persona label in slugs; use semantic IDs like user-name, user-communication-style, user-investment, project-purpose, or reference-api-contract.";

export const MEMORY_DESCRIPTION_POLICY =
  "Memory descriptions are user-facing in Settings. Keep them semantic; do not start them with the user's current name, old name, nickname, or persona label unless the memory is specifically about names.";

export const MEMORY_DATE_BOUND_FALLBACK_POLICY =
  "For date-bound activity questions, check the target daily journal first, then fall back to chat-history search with history_date_local/history_since/history_until instead of an unbounded search.";

export const MEMORY_PRECEDENCE_CHAIN =
  "current user message > project memory > reviewed user/feedback memory > unreviewed user memory > global reference memory > recent daily journal";

// HARD precondition for scope="project". Project memory is keyed by workspace
// directory; a turn that never touched the workspace produces no project-
// specific evidence and should not pollute that scope.
export const PROJECT_MEMORY_WRITE_EVIDENCE_GATE = [
  'Project-scope gate (HARD precondition for scope="project" write/update):',
  "- A workspace mutation must have happened in this turn. Qualifying signals:",
  "  - a successful Write/Edit tool call on a file path inside the configured workspace directory;",
  "  - a successful Bash tool call that demonstrably modified workspace state — mv/cp/rm, sed -i, redirection (`>` / `>>`), patch/apply, package install or lockfile change, git commit/checkout/branch/stash, build/codegen producing files inside the workspace, or other in-place edits;",
  "  - a successful mutating MCP tool call targeting a file inside the workspace (e.g. design/file editors that write to workspace paths).",
  "- Read-only activity does NOT satisfy the gate, no matter how workspace-specific the discussion sounds. Non-qualifying: Read/Glob/Grep, search, planning, Q&A, reasoning, file inspection, summarizing, listing files, running test/lint/typecheck/git-status WITHOUT producing or modifying workspace files, or MemoryManager calls themselves.",
  '- When no qualifying mutation occurred this turn, do NOT classify the candidate as scope="project". Re-route instead: portable preference → type="feedback" scope="global"; identity/role → type="user" scope="global"; external pointer → type="reference" scope="global"; otherwise SKIP.',
  '- Override exception: the latest USER message contains an explicit project-pin instruction (e.g. "记住本项目...", "在这个项目里以后...", "for this repo always...", "remember for this workspace") AND names a fact that is genuinely workspace-specific (not a portable preference). The explicit pin alone satisfies the gate; record it as source_quote and set reasoning="explicit user pin for this project".',
  '- action="delete" on an existing scope="project" entry is exempt when the user explicitly asks to forget it.',
  '- For any write/update on scope="project", the reasoning field MUST cite the qualifying evidence in one short clause (e.g. "edited src/foo.ts this turn" or "explicit user pin: \\"记住本项目用 pnpm\\""). A project-scope plan item without such evidence in reasoning is invalid and must be rewritten as global or SKIP.',
].join("\n");

export const MEMORY_SKIP_LIST_ITEMS = [
  "greetings, transient questions, one-off answers, and facts derivable from the current workspace",
  "secrets, credentials, raw code history, or large logs",
  "memory introspection requests such as asking what you remember, memory weights, priority, or today's memory contents",
  "daily notes that would only restate a preference and conflict with reviewed user/feedback memory",
  'scope="project" candidates whose turn produced no qualifying workspace mutation and no explicit user project-pin instruction (see Project-scope gate)',
] as const;

export const MEMORY_CONFLICT_ARBITRATION_LINES = [
  "- Conflict resolution (in order):",
  "  1. Current user message wins over all memory.",
  "  2. Reviewed project > reviewed user/feedback > unreviewed user memory > global reference > daily journal.",
  "  3. If a newer turn supersedes older memory, update with supersedes=<old-slug>.",
  "  4. If two reviewed entries truly conflict, prefer the more specific (project > user).",
  "  5. Never silently shadow: set conflicts_with=<other-slug> with a one-line reasoning.",
  "  6. (unreviewed) entries are active working memory: use them directly when relevant, but never let them override reviewed entries or the current user message.",
].join("\n");

export const MEMORY_CONFIDENCE_TONE_LINES = [
  "- Confidence-calibrated use of unreviewed working memory:",
  "  - high/medium: use naturally in the answer when relevant; do not ask for confirmation unless the current turn is ambiguous or conflicting.",
  "  - low/unknown: may still be used when helpful, but avoid overclaiming; phrase it as current memory when it materially affects the answer and leave room for correction.",
  "  - Never block the answer just to confirm unreviewed memory; let normal user corrections improve or reject it.",
].join("\n");

// Self-review rules: unreviewed entries are visible and usable as working
// memory. Promotion still needs a current user signal, not silence.
export const MEMORY_SELF_REVIEW_RULES = [
  "- Self-review of (unreviewed) entries:",
  "  - Use unreviewed entries directly as active working memory when relevant, while allowing immediate correction by the current user.",
  '  - Promote via MemoryManager(action="accept", slug=...) when the current user message confirms, restates, corrects-then-confirms, or clearly relies on the entry\'s claim.',
  "  - If the user corrects an unreviewed entry, update the same slug with the corrected fact and current source_quote; then accept it when the corrected fact is now explicit and stable.",
  "  - Delete an unreviewed entry when the current user message refutes it and there is no durable corrected replacement.",
  "  - Do NOT accept from silence, lack of objection, assistant text, or your own reasoning alone.",
  MEMORY_CONFIDENCE_TONE_LINES,
].join("\n");

export const MEMORY_CONFIDENCE_RUBRIC = [
  "Confidence rubric for durable writes:",
  "- high: the user used an explicit signal word and the quote is unambiguous.",
  "- medium: the user stated a stable fact about themselves, this project, or a reusable preference without a signal word, and the quote is unambiguous.",
  "- low: the fact is inferred from behavior or ambiguous; prefer skipping unless it is rare and high-value.",
  "- If you cannot provide a verbatim source_quote, downgrade one level; if that drops below low, skip.",
  "- Signal words (Chinese): 我叫, 请记住, 以后, 默认, 一直, 永远, 千万别, 必须, 一定, 从今往后, 我需要你, 我希望你, 帮我记, 我习惯, 一向.",
  "- Signal words (English): always, never, from now on, please remember, by default, prefer, must, I need you to, I want you to, I require, I'm used to.",
  "- NOT signal words (treat as medium ceiling): 我喜欢, 我用, 通常, 有时, 我觉得, 一般, 大概, I like, I sometimes, I tend to, often, usually, somewhat.",
  "- Negative cues (force at most low): 也许, 可能, 不确定, 试试看, maybe, perhaps, not sure, let me try, just for now.",
].join("\n");

export const MEMORY_WRITE_EVIDENCE_POLICY = [
  "For write/update of durable non-daily memory, include these structured fields whenever possible:",
  "- confidence: high | medium | low",
  "- source_quote: a verbatim user quote, max 80 characters",
  "- reasoning: one short sentence explaining why this is durable",
  "- supersedes / conflicts_with / override_reject when replacing, conflicting with, or overriding previous memory.",
  "LiveAgent stores these fields as a structured evidence block alongside the memory body.",
].join("\n");

export const MEMORY_CONFIDENCE_CONTRACT_LINE = `confidence=high requires source_quote of >=${CONFIDENCE_CONTRACT.highMinQuoteChars} characters. LiveAgent auto-downgrades high→medium when the quote is shorter, and medium→low when the quote is empty; the stored evidence records auto_downgraded: true so your self-rating remains auditable.`;
