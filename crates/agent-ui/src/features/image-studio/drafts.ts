import type { CreateJobRequest, ImageTarget } from "../../lib/imaging/types";
import { type Framing, sanitizeFraming } from "./framing";
import { parameterError } from "./parameterModel";
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
  /** Ratio/resolution for models without size parameters; sent inside the prompt. */
  framing?: Framing;
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
  const parameters: Record<string, unknown> = {};
  if (record(data.parameters))
    for (const spec of target?.parameters ?? []) {
      const v = data.parameters[spec.key];
      if (v !== undefined && v !== null && !parameterError(spec, v))
        Object.defineProperty(parameters, spec.key, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  const framing = sanitizeFraming(data.framing);
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
  return {
    prompt: typeof data.prompt === "string" ? data.prompt.slice(0, 100000) : "",
    targetId,
    parameters,
    inputs,
    ...(assetId(data.parentAssetId) && inputs.some((input) => input.assetId === data.parentAssetId)
      ? { parentAssetId: data.parentAssetId }
      : {}),
    ...(framing ? { framing } : {}),
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
    request as unknown as CreateJobRequest,
    () => submission.key as string,
  );
  return {
    ...frozen,
    status: submission.status === "accepted" ? "accepted" : "unknown",
    ...(typeof submission.jobId === "string" ? { jobId: submission.jobId } : {}),
  };
}
