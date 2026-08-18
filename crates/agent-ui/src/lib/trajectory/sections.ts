/** System-prompt segmentation and content addressing. */

import { sha256Hex } from "./sha256";
import {
  TRAJECTORY_PROMPT_SECTION_SLOTS,
  TRAJECTORY_SECTION_SLOTS,
  type TrajectoryHeaderChange,
  type TrajectorySection,
  type TrajectorySectionRefs,
  type TrajectorySectionSlot,
} from "./types";

/**
 * Prompt display/composition order. Storage order deliberately keeps the legacy six slots stable
 * and appends runtime; never use the wire array order to reconstruct the model-visible prompt.
 */
export const TRAJECTORY_SYSTEM_PROMPT_SLOTS = [
  "base",
  "agent",
  "skills",
  "memory",
  "runtime",
  "toolsSuffix",
] as const satisfies readonly TrajectorySectionSlot[];

/** Full SHA-256 hex digest. IDs intentionally use the first 64 bits per the design. */
export const hashTrajectoryContent = sha256Hex;

/** Raw text for the request-boundary slots. */
export type TrajectorySectionInput = Partial<Record<TrajectorySectionSlot, string | undefined>>;

export type TrajectoryHeaderBuild = {
  headerId: string;
  refs: TrajectorySectionRefs;
  /** Newly observed sections that must be durable before their referencing event. */
  sections: readonly TrajectorySection[];
  change: TrajectoryHeaderChange;
};

function normalizeSlotContent(value: string | undefined) {
  if (typeof value !== "string" || value.trim() === "") return null;
  // Whitespace is model-visible. Only use trim to detect an empty slot; never mutate content.
  return value;
}

function appendCorePrompt(base: string | undefined, suffix: string): string {
  const head = (base || "").trim();
  const tail = (suffix || "").trim();
  if (!tail) return head;
  if (!head) return tail;
  return `${head}

${tail}`;
}

/**
 * Rebuild the exact provider-boundary system prompt represented by a header input.
 * Core runtime sections use the chat builder's trim-and-double-newline rule; toolsSuffix is
 * attached with the runner's boundary rule and therefore remains byte-for-byte unchanged.
 */
export function composeTrajectorySystemPrompt(input: TrajectorySectionInput): string | undefined {
  let core: string | undefined;
  for (const slot of TRAJECTORY_PROMPT_SECTION_SLOTS) {
    if (slot === "toolsSuffix") continue;
    const content = normalizeSlotContent(input[slot]);
    if (content !== null) core = appendCorePrompt(core, content);
  }
  const toolsSuffix = normalizeSlotContent(input.toolsSuffix);
  if (toolsSuffix === null) return core;
  const head = (core || "").trim();
  return head
    ? `${head}

${toolsSuffix}`
    : toolsSuffix;
}

type StableJson = null | boolean | number | string | StableJson[] | { [key: string]: StableJson };

function normalizeStableJson(value: unknown, stack: Set<object>): StableJson | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;

  const object = value as object;
  if (stack.has(object)) throw new TypeError("circular tool schema");
  stack.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeStableJson(entry, stack) ?? null);
    }
    const normalized: Record<string, StableJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = normalizeStableJson((value as Record<string, unknown>)[key], stack);
      if (entry !== undefined) normalized[key] = entry;
    }
    return normalized;
  } finally {
    stack.delete(object);
  }
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value, new Set()) ?? null);
}

/** Stable tool-catalog serialization independent of registration and object-key order. */
export function serializeToolCatalog(
  tools: readonly { name?: unknown; description?: unknown; parameters?: unknown }[] | undefined,
): string | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const normalized = tools
    .map((tool) => ({
      name: typeof tool?.name === "string" ? tool.name : "",
      description: typeof tool?.description === "string" ? tool.description : "",
      parameters: tool?.parameters ?? null,
    }))
    .filter((tool) => tool.name !== "")
    .sort((left, right) => left.name.localeCompare(right.name));
  if (normalized.length === 0) return undefined;
  try {
    return stableJsonStringify(normalized);
  } catch {
    // A malformed cyclic schema should not suppress the whole request header.
    return JSON.stringify(normalized.map((tool) => tool.name));
  }
}

function classifyChange(
  previous: TrajectorySectionRefs | undefined,
  next: TrajectorySectionRefs,
): TrajectoryHeaderChange {
  if (previous === undefined) return "initial";
  const changedAt = (index: number) => (previous[index] ?? null) !== (next[index] ?? null);
  const systemChanged = [0, 1, 2, 3, 6].some(changedAt);
  const toolsChanged = [4, 5].some(changedAt);
  if (systemChanged && toolsChanged) return "system-and-tools";
  if (systemChanged) return "system";
  if (toolsChanged) return "tools";
  return "none";
}

const addressedId = (prefix: "s" | "h", content: string) =>
  `${prefix}_${hashTrajectoryContent(content).slice(0, 16)}`;

/** Fold one provider request's exact slots into immutable section references. */
export function buildTrajectoryHeader(
  input: TrajectorySectionInput,
  previous?: { headerId: string; refs: TrajectorySectionRefs },
): TrajectoryHeaderBuild {
  const refs: (string | null)[] = [];
  const sections: TrajectorySection[] = [];
  for (const [index, slot] of TRAJECTORY_SECTION_SLOTS.entries()) {
    const content = normalizeSlotContent(input[slot]);
    if (content === null) {
      refs.push(null);
      continue;
    }
    const sectionId = addressedId("s", content);
    refs.push(sectionId);
    if (previous?.refs[index] === sectionId) continue;
    sections.push({ sectionId, slot, content });
  }
  const headerId = addressedId("h", refs.map((ref) => ref ?? "-").join("\u0000"));
  return {
    headerId,
    refs,
    sections,
    change: classifyChange(previous?.refs, refs),
  };
}

/** Slot index to slot name for details rendering. */
export function trajectorySectionSlotAt(index: number): TrajectorySectionSlot | undefined {
  return TRAJECTORY_SECTION_SLOTS[index];
}
