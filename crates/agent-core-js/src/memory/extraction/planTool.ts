// SubmitMemoryPlan: the extraction model's single submission channel. The
// schema is validated per-item — one malformed item is rejected with a coded
// reason while the rest of the plan still applies. This replaces the fenced
// four-block text protocol whose all-or-nothing parser silently dropped whole
// turns.

import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { EXTRACTION_PLAN_ITEM_LIMIT, MEMORY_BODY_LIMIT_BYTES } from "../config";
import type {
  ApplyDecision,
  ExtractionPlanAction,
  ExtractionPlanItem,
  ExtractionPlanSubmission,
  MemoryEvidenceFields,
  MemoryScope,
  MemoryType,
  MemoryUpdateMode,
  PlanItemRejection,
  ValidatedPlanItem,
} from "../schema";
import { EXTRACTION_PLAN_ACTIONS, isMemoryScope, isMemoryType } from "../schema";

export const SUBMIT_MEMORY_PLAN_TOOL_NAME = "SubmitMemoryPlan";

const PLAN_ITEM_SCHEMA = Type.Object({
  action: Type.Union(
    EXTRACTION_PLAN_ACTIONS.map((action) => Type.Literal(action)),
    {
      description:
        "write creates a new durable memory; update revises an existing slug (evidence-only allowed); accept promotes a user-confirmed unreviewed entry; delete removes a refuted/forgotten entry; append_daily appends a journal bullet.",
    },
  ),
  slug: Type.Optional(
    Type.String({
      description: "Stable kebab-case semantic id. Required for every action except append_daily.",
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("global"), Type.Literal("project")], {
      description:
        "Required for write/accept/delete. Optional for update (omit to auto-resolve project then global).",
    }),
  ),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("user"),
        Type.Literal("feedback"),
        Type.Literal("project"),
        Type.Literal("reference"),
      ],
      { description: "Memory type. Required for write." },
    ),
  ),
  description: Type.Optional(
    Type.String({ description: "One-line user-facing description. Required for write." }),
  ),
  body: Type.Optional(
    Type.String({
      description:
        "Markdown body. Required for write and append_daily; optional for update (omit for evidence-only updates).",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("merge"), Type.Literal("replace")], {
      description: "Update mode; defaults to merge so unchanged details survive.",
    }),
  ),
  confidence: Type.Optional(
    Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
      description: "Self-rated confidence per the rubric. high requires source_quote >=5 chars.",
    }),
  ),
  source_quote: Type.Optional(
    Type.String({ description: "Verbatim user quote supporting this item, max 80 chars." }),
  ),
  reasoning: Type.Optional(
    Type.String({
      description:
        "One short sentence: why durable. For scope=project it MUST cite the qualifying workspace mutation or explicit user pin.",
    }),
  ),
  aliases: Type.Optional(
    Type.Array(Type.String(), { description: "Optional short recall terms (max 8)." }),
  ),
  supersedes: Type.Optional(
    Type.String({ description: "Slug this item replaces, when correcting older memory." }),
  ),
  conflicts_with: Type.Optional(
    Type.Array(Type.String(), { description: "Slugs that may conflict with this item." }),
  ),
  override_reject: Type.Optional(
    Type.String({
      description:
        "Required when re-writing a slug listed in <recent-rejections>: why this overrides the user's recent rejection.",
    }),
  ),
});

export function createSubmitMemoryPlanTool(): Tool {
  return {
    name: SUBMIT_MEMORY_PLAN_TOOL_NAME,
    description:
      "Submit the final memory plan for this extraction pass. Call exactly once, after reasoning through identify → match → plan. Items are validated individually; rejected items are reported back with a coded reason while the rest still apply.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("updated"), Type.Literal("noop")], {
        description: "noop with items=[] when nothing in this turn qualifies.",
      }),
      note: Type.Optional(
        Type.String({
          description: "Optional one-sentence human-readable summary (developer views only).",
          maxLength: 200,
        }),
      ),
      items: Type.Array(PLAN_ITEM_SCHEMA, { maxItems: EXTRACTION_PLAN_ITEM_LIMIT }),
    }),
  };
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  return items.length > 0 ? items : undefined;
}

export function parsePlanSubmission(args: unknown): ExtractionPlanSubmission {
  if (!args || typeof args !== "object") return {};
  const record = args as Record<string, unknown>;
  const items = Array.isArray(record.items)
    ? record.items.filter((item): item is ExtractionPlanItem =>
        Boolean(item && typeof item === "object"),
      )
    : [];
  return {
    status: asTrimmedString(record.status),
    note: asTrimmedString(record.note),
    items,
  };
}

export type PlanValidationContext = {
  /** Whether a workspace directory is configured for this turn. */
  hasWorkdir: boolean;
  /** Slugs the user recently rejected/deleted (write/update needs override_reject). */
  rejectedSlugs: ReadonlySet<string>;
  /** Slugs already mutated by an earlier pass in this turn (dropped as duplicates). */
  alreadyWrittenSlugs: ReadonlySet<string>;
};

export type PlanValidationResult = {
  accepted: ValidatedPlanItem[];
  rejected: PlanItemRejection[];
};

function evidenceFromItem(item: ExtractionPlanItem): MemoryEvidenceFields | undefined {
  const evidence: MemoryEvidenceFields = {
    confidence: asTrimmedString(item.confidence),
    sourceQuote: asTrimmedString(item.source_quote),
    reasoning: asTrimmedString(item.reasoning),
    aliases: asStringArray(item.aliases),
    conflictsWith: asStringArray(item.conflicts_with),
    supersedes: asTrimmedString(item.supersedes),
    overrideReject: asTrimmedString(item.override_reject),
  };
  const hasAny = Object.values(evidence).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
  return hasAny ? evidence : undefined;
}

const utf8 = new TextEncoder();

function bodyTooLarge(body: string | undefined): boolean {
  return Boolean(body && utf8.encode(body).length > MEMORY_BODY_LIMIT_BYTES);
}

export function validateSubmittedPlan(
  submission: ExtractionPlanSubmission,
  ctx: PlanValidationContext,
): PlanValidationResult {
  const accepted: ValidatedPlanItem[] = [];
  const rejected: PlanItemRejection[] = [];
  // Per-slug mutation bookkeeping inside this plan: a slug may receive at most
  // one write/update, optionally followed by an accept; delete excludes all
  // other work on the slug.
  const mutatedSlugs = new Set<string>();
  const deletedSlugs = new Set<string>();

  const reject = (index: number, code: PlanItemRejection["code"], message: string) => {
    rejected.push({ index, code, message });
  };

  (submission.items ?? []).forEach((item, index) => {
    const action = asTrimmedString(item.action) as ExtractionPlanAction | undefined;
    if (!action || !(EXTRACTION_PLAN_ACTIONS as readonly string[]).includes(action)) {
      reject(index, "invalid-action", `unknown action: ${item.action ?? "(missing)"}`);
      return;
    }

    if (action === "append_daily") {
      const body = asTrimmedString(item.body);
      if (!body) {
        reject(index, "empty-daily-body", "append_daily requires a non-empty body");
        return;
      }
      if (bodyTooLarge(body)) {
        reject(index, "body-too-large", "daily bullet exceeds the body limit");
        return;
      }
      accepted.push({ action, slug: "", body });
      return;
    }

    const slug = asTrimmedString(item.slug)?.toLowerCase();
    if (!slug || slug.length < 3) {
      reject(index, "missing-slug", `${action} requires a slug of >=3 chars`);
      return;
    }

    const scope = asTrimmedString(item.scope);
    if (action === "write" || action === "accept" || action === "delete") {
      if (!isMemoryScope(scope)) {
        reject(index, "invalid-scope", `${action} requires scope "global" or "project"`);
        return;
      }
    } else if (scope !== undefined && !isMemoryScope(scope)) {
      reject(index, "invalid-scope", `invalid scope: ${scope}`);
      return;
    }
    if (scope === "project" && !ctx.hasWorkdir && action !== "delete") {
      reject(
        index,
        "project-scope-gate",
        "no workspace directory is configured for this turn; project scope is unavailable",
      );
      return;
    }

    if (deletedSlugs.has(slug) || (mutatedSlugs.has(slug) && action !== "accept")) {
      reject(index, "duplicate-slug-in-plan", `slug already mutated in this plan: ${slug}`);
      return;
    }

    if (action === "write" || action === "update") {
      if (ctx.alreadyWrittenSlugs.has(slug)) {
        reject(
          index,
          "already-written-this-turn",
          `slug was already written by an earlier pass this turn: ${slug}`,
        );
        return;
      }
      if (ctx.rejectedSlugs.has(slug) && !asTrimmedString(item.override_reject)) {
        reject(
          index,
          "rejected-slug-no-override",
          `slug was recently rejected by the user and the item has no override_reject: ${slug}`,
        );
        return;
      }
      if (bodyTooLarge(item.body)) {
        reject(index, "body-too-large", `body exceeds ${MEMORY_BODY_LIMIT_BYTES} bytes`);
        return;
      }
    }

    if (action === "write") {
      const type = asTrimmedString(item.type);
      if (!isMemoryType(type)) {
        reject(
          index,
          "missing-type-for-write",
          "write requires type user|feedback|project|reference",
        );
        return;
      }
      const description = asTrimmedString(item.description);
      if (!description) {
        reject(index, "missing-description-for-write", "write requires a description");
        return;
      }
      const body = asTrimmedString(item.body);
      if (!body) {
        reject(index, "missing-body-for-write", "write requires a body");
        return;
      }
      mutatedSlugs.add(slug);
      accepted.push({
        action,
        slug,
        scope: scope as MemoryScope,
        type: type as MemoryType,
        description,
        body,
        evidence: evidenceFromItem(item),
      });
      return;
    }

    if (action === "update") {
      const mode = asTrimmedString(item.mode);
      mutatedSlugs.add(slug);
      accepted.push({
        action,
        slug,
        scope: scope as MemoryScope | undefined,
        type: isMemoryType(asTrimmedString(item.type))
          ? (asTrimmedString(item.type) as MemoryType)
          : undefined,
        description: asTrimmedString(item.description),
        body: asTrimmedString(item.body),
        mode: (mode === "replace" ? "replace" : "merge") as MemoryUpdateMode,
        evidence: evidenceFromItem(item),
      });
      return;
    }

    if (action === "delete") {
      deletedSlugs.add(slug);
      accepted.push({
        action,
        slug,
        scope: scope as MemoryScope,
        evidence: evidenceFromItem(item),
      });
      return;
    }

    // accept
    accepted.push({ action, slug, scope: scope as MemoryScope });
  });

  return { accepted, rejected };
}

/** Collapse the validated plan into a single memory_apply_batch payload —
 *  the one persistence path shared with the organizer and manual apply. */
export function planToApplyBatchArgs(items: readonly ValidatedPlanItem[]): {
  dailyAppend?: { bullet: string };
  decisions: ApplyDecision[];
} {
  const bullets: string[] = [];
  const decisions: ApplyDecision[] = [];
  for (const item of items) {
    switch (item.action) {
      case "append_daily":
        if (item.body) bullets.push(item.body);
        break;
      case "write":
        decisions.push({
          op: "upsert",
          slug: item.slug,
          scope: item.scope,
          memoryType: item.type,
          description: item.description,
          body: item.body,
          evidence: item.evidence,
        });
        break;
      case "update":
        decisions.push({
          op: "update",
          slug: item.slug,
          scope: item.scope,
          memoryType: item.type,
          description: item.description,
          body: item.body,
          mode: item.mode ?? "merge",
          evidence: item.evidence,
        });
        break;
      case "accept":
        decisions.push({ op: "accept", slug: item.slug, scope: item.scope });
        break;
      case "delete":
        decisions.push({
          op: "delete",
          slug: item.slug,
          scope: item.scope,
          reason: item.evidence?.reasoning,
        });
        break;
    }
  }
  return {
    dailyAppend: bullets.length > 0 ? { bullet: bullets.join("\n") } : undefined,
    decisions,
  };
}

/** Tool-result text shown back to the extraction model (and developer views). */
export function buildPlanReceiptText(result: PlanValidationResult): string {
  const parts = [`Plan received: ${result.accepted.length} accepted`];
  if (result.rejected.length > 0) {
    const details = result.rejected
      .map((rejection) => `index ${rejection.index}: ${rejection.code}`)
      .join(", ");
    parts.push(`${result.rejected.length} rejected (${details})`);
  }
  return parts.join(", ");
}
