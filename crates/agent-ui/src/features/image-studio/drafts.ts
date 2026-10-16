import type { CreateJobRequest, ImageTarget } from "../../lib/imaging/types";
import {
  allowedFields,
  FORMAT_VALUES,
  MODERATION_VALUES,
  pruneParams,
  QUALITY_VALUES,
} from "./paramsBarModel";
import { type FrozenSubmission, freezeSubmission } from "./studioModel";

export interface DraftScope {
  ownerId: string;
  backendId: string;
  projectId: string;
}
export interface StudioDraft {
  prompt: string;
  targetId: string;
  parameters: Record<string, unknown>;
  inputs: CreateJobRequest["inputs"];
  parentAssetId?: string;
}
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export function draftKey(ownerId: string, backendId: string, projectId: string): string {
  return `image-studio:v1:${JSON.stringify([ownerId, backendId, projectId])}`;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const assetId = (value: unknown): value is string =>
  typeof value === "string" && /^ia_[A-Za-z0-9_-]+$/.test(value);
export function sanitizeDraft(value: unknown, targets: ImageTarget[]): StudioDraft {
  const data = record(value) ? value : {};
  const targetId = typeof data.targetId === "string" ? data.targetId : "";
  const target = targets.find((item) => item.id === targetId);
  // Drafts keep only the unified field names, and only when the current target
  // can still use them; a model switch leaves the rest to be re-picked.
  const allowed = allowedFields(target);
  const parameters: Record<string, unknown> = {};
  if (record(data.parameters)) {
    const source = data.parameters;
    const keep = (key: string, value: unknown) => {
      if (value === undefined || value === null) return;
      Object.defineProperty(parameters, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
    if (allowed.has("size")) {
      const size = source.size;
      const valid = typeof size === "string" && (size === "auto" || /^\d{2,5}x\d{2,5}$/.test(size));
      keep("size", valid ? size : "auto");
    }
    if (allowed.has("quality") && QUALITY_VALUES.includes(source.quality as never))
      keep("quality", source.quality);
    if (allowed.has("outputFormat") && FORMAT_VALUES.includes(source.outputFormat as never))
      keep("outputFormat", source.outputFormat);
    if (allowed.has("moderation") && MODERATION_VALUES.includes(source.moderation as never))
      keep("moderation", source.moderation);
    if (
      allowed.has("outputCompression") &&
      typeof source.outputCompression === "number" &&
      Number.isInteger(source.outputCompression) &&
      source.outputCompression >= 0 &&
      source.outputCompression <= 100
    )
      keep("outputCompression", source.outputCompression);
    if (allowed.has("transparentOutput") && source.transparentOutput === true)
      keep("transparentOutput", true);
  }
  const inputs: StudioDraft["inputs"] = [];
  if (Array.isArray(data.inputs))
    for (const input of data.inputs.slice(0, 16)) {
      if (
        record(input) &&
        assetId(input.assetId) &&
        ["source", "reference", "mask"].includes(String(input.role))
      )
        inputs.push({
          assetId: input.assetId,
          role: input.role as StudioDraft["inputs"][number]["role"],
        });
    }
  // pruneParams is the single definition of what a target accepts, so the
  // restored draft is exactly what a submit would send.
  const pruned = Object.keys(parameters).length ? pruneParams(target, parameters) : {};
  return {
    prompt: typeof data.prompt === "string" ? data.prompt.slice(0, 100000) : "",
    targetId,
    parameters: pruned as unknown as Record<string, unknown>,
    inputs,
    ...(assetId(data.parentAssetId) && inputs.some((input) => input.assetId === data.parentAssetId)
      ? { parentAssetId: data.parentAssetId }
      : {}),
  };
}
export function serializeDraft(
  scope: DraftScope,
  draft: StudioDraft,
  targets: ImageTarget[],
): string {
  return JSON.stringify({
    version: 1,
    scope: { ownerId: scope.ownerId, backendId: scope.backendId, projectId: scope.projectId },
    ...sanitizeDraft(draft, targets),
  });
}
export async function restoreDraft(
  raw: string | null,
  scope: DraftScope,
  targets: ImageTarget[],
  available: (id: string) => Promise<boolean>,
): Promise<VerifiedDraft | null> {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.scope) ||
    value.scope.ownerId !== scope.ownerId ||
    value.scope.backendId !== scope.backendId ||
    value.scope.projectId !== scope.projectId
  )
    return null;
  return verifyDraftAssets(sanitizeDraft(value, targets), available);
}
export interface VerifiedDraft {
  draft: StudioDraft;
  invalidAssetIds: string[];
  unverifiedAssetIds: string[];
}
// Keep the version relationship and its input in the same atomic draft update.
export function maintainParent(draft: StudioDraft): StudioDraft {
  return draft.parentAssetId && !draft.inputs.some((input) => input.assetId === draft.parentAssetId)
    ? { ...draft, parentAssetId: undefined }
    : draft;
}
export async function verifyDraftAssets(
  draft: StudioDraft,
  available: (id: string) => Promise<boolean>,
): Promise<VerifiedDraft> {
  const ids = [...new Set(draft.inputs.map((input) => input.assetId))];
  const invalidAssetIds: string[] = [];
  const unverifiedAssetIds: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        if (await available(id)) return;
      } catch (error) {
        const absent =
          record(error) &&
          ((error.code === "IMAGE_NOT_FOUND" && [404, 410].includes(Number(error.status))) ||
            (error.code === "IMAGE_INVALID_INPUT" && [400, 422].includes(Number(error.status))));
        if (!absent) {
          unverifiedAssetIds.push(id);
          return;
        }
      }
      invalidAssetIds.push(id);
    }),
  );
  return {
    draft: maintainParent({
      ...draft,
      inputs: draft.inputs.filter((input) => !invalidAssetIds.includes(input.assetId)),
    }),
    invalidAssetIds,
    unverifiedAssetIds,
  };
}

// Submission snapshots are separate from editable drafts: target migration must never rewrite them.
export function submissionKey(scope: DraftScope): string {
  return `image-studio:submission:v1:${JSON.stringify([scope.ownerId, scope.backendId, scope.projectId])}`;
}
export function serializeSubmission(
  scope: DraftScope,
  submission: FrozenSubmission | null,
  history: FrozenSubmission[] = [],
): string {
  return JSON.stringify({ version: 1, scope, submission, history });
}
// Keep replaced uncertain requests in the same atomic record as the active intent.
export function restoreSubmissionHistory(
  raw: string | null,
  scope: DraftScope,
): FrozenSubmission[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.history === undefined) return [];
  if (!Array.isArray(value.history)) throw new Error("Invalid saved submission history");
  return value.history.map((submission) => {
    const restored = restoreSubmission(JSON.stringify({ ...value, submission }), scope);
    if (!restored) throw new Error("Invalid saved submission history scope");
    return restored;
  });
}
export function restoreSubmission(raw: string | null, scope: DraftScope): FrozenSubmission | null {
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !record(value.scope))
    throw new Error("Invalid saved submission");
  if (
    value.scope.ownerId !== scope.ownerId ||
    value.scope.backendId !== scope.backendId ||
    value.scope.projectId !== scope.projectId
  )
    return null;
  const submission = value.submission;
  if (submission === null) return null;
  if (
    !record(submission) ||
    typeof submission.key !== "string" ||
    !submission.key ||
    !["submitting", "unknown", "accepted"].includes(String(submission.status)) ||
    !record(submission.request)
  )
    throw new Error("Invalid saved submission");
  const request = submission.request;
  if (
    request.projectId !== scope.projectId ||
    typeof request.targetId !== "string" ||
    typeof request.prompt !== "string" ||
    !["generate", "reference", "edit", "mask"].includes(String(request.operation)) ||
    !Number.isInteger(request.count) ||
    Number(request.count) < 1 ||
    Number(request.count) > 16 ||
    !record(request.parameters) ||
    !Object.values(request.parameters).every(
      (value) =>
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
    ) ||
    !Array.isArray(request.inputs) ||
    !request.inputs.every(
      (input) =>
        record(input) &&
        assetId(input.assetId) &&
        ["source", "reference", "mask"].includes(String(input.role)),
    ) ||
    (request.parentAssetId !== undefined &&
      (!assetId(request.parentAssetId) ||
        !request.inputs.some((input) => input.assetId === request.parentAssetId)))
  )
    throw new Error("Invalid saved submission request");
  const frozen = freezeSubmission(
    null,
    request as unknown as CreateJobRequest,
    () => submission.key as string,
  );
  return {
    ...frozen,
    status: submission.status === "accepted" ? "accepted" : "unknown",
    ...(typeof submission.jobId === "string" ? { jobId: submission.jobId } : {}),
  };
}
