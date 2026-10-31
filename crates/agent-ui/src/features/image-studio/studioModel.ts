import type {
  CreateJobRequest,
  ImageAsset,
  ImageEvent,
  ImageJob,
  ImageProject,
  ImageTarget,
} from "../../lib/imaging/types";
import {
  defaultTranslate,
  formatMessage,
  imageErrorText,
  type Message,
  message,
  type Translate,
} from "./studioText";

export interface FrozenSubmission {
  key: string;
  request: CreateJobRequest;
  status: "submitting" | "unknown" | "accepted";
  jobId?: string;
}
export interface StudioState {
  ownerId: string;
  backendId: string;
  projects: ImageProject[];
  jobs: Record<string, ImageJob>;
  assets: Record<string, ImageAsset>;
  selectedAssetId?: string;
  /** History entry shown in the preview; may have no assets (failed or still running). */
  selectedJobId?: string;
  lastSeqByJob: Record<string, number>;
  snapshotNeeded: Record<string, boolean>;
}
export function initialStudioState(ownerId: string, backendId: string): StudioState {
  return {
    ownerId,
    backendId,
    projects: [],
    jobs: {},
    assets: {},
    lastSeqByJob: {},
    snapshotNeeded: {},
  };
}
export const terminalJob = (job: ImageJob) =>
  ["succeeded", "partial_succeeded", "failed", "cancelled", "result_unknown"].includes(job.status);
export const jobResultCount = (job: ImageJob) => new Set(job.assetIds).size;
function normalizeJob(job: ImageJob): ImageJob {
  const assetIds = [...new Set(job.assetIds)];
  if (["succeeded", "partial_succeeded"].includes(job.status) && !assetIds.length)
    return {
      ...job,
      assetIds,
      status: "failed",
      error: {
        code: "IMAGE_EMPTY_RESULT",
        // Display text comes from imageStudio.error.IMAGE_EMPTY_RESULT; this one stays for logs.
        message: "The job returned no usable image.",
        retryable: false,
        requestId: "",
      },
    };
  return { ...job, assetIds };
}
// Newer backends attach a snapshot cursor. Older ones can be shown but cannot safely recover an event gap.
export function snapshotSequence(job: ImageJob): number | undefined {
  const value = (job as ImageJob & { lastEventSeq?: number }).lastEventSeq;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined;
}
export function applyJobSnapshot(state: StudioState, incoming: ImageJob): StudioState {
  const previous = state.jobs[incoming.id];
  if (previous && previous.revision > incoming.revision) return state;
  const seq = snapshotSequence(incoming);
  return {
    ...state,
    jobs: { ...state.jobs, [incoming.id]: normalizeJob(incoming) },
    lastSeqByJob: {
      ...state.lastSeqByJob,
      [incoming.id]: Math.max(state.lastSeqByJob[incoming.id] ?? 0, seq ?? 0),
    },
    snapshotNeeded: { ...state.snapshotNeeded, [incoming.id]: false },
  };
}
export function applyImageEvent(state: StudioState, event: ImageEvent): StudioState {
  const job = state.jobs[event.jobId];
  const previousSeq = state.lastSeqByJob[event.jobId] ?? 0;
  if (
    !Number.isSafeInteger(event.seq) ||
    !Number.isSafeInteger(event.revision) ||
    event.seq <= previousSeq ||
    (job && event.revision < job.revision)
  )
    return state;
  if (!job || event.seq !== previousSeq + 1)
    return { ...state, snapshotNeeded: { ...state.snapshotNeeded, [event.jobId]: true } };
  const asset = event.data.asset;
  let updated = { ...job, revision: event.revision, updatedAt: event.timestamp };
  if (event.type === "asset.ready" && asset)
    updated.assetIds = [...new Set([...job.assetIds, asset.id])];
  if (event.type === "item.state_changed" && event.data.itemId)
    updated.items = job.items.map((item) =>
      item.id === event.data.itemId
        ? {
            ...item,
            ...(event.data.status ? { status: event.data.status } : {}),
            ...(event.data.error ? { error: event.data.error } : {}),
          }
        : item,
    );
  if (
    (event.type === "job.state_changed" || event.type === "job.finished") &&
    event.data.status &&
    !terminalJob(job)
  )
    updated.status = event.data.status;
  if (event.data.error && event.type !== "item.state_changed") updated.error = event.data.error;
  updated = normalizeJob(updated);
  return {
    ...state,
    jobs: { ...state.jobs, [job.id]: updated },
    assets: asset ? { ...state.assets, [asset.id]: asset } : state.assets,
    lastSeqByJob: { ...state.lastSeqByJob, [job.id]: event.seq },
  };
}
/** Snapshots a request so later draft edits cannot change what was sent. */
export function freezeSubmission(request: CreateJobRequest, key: () => string): FrozenSubmission {
  const frozen = {
    ...request,
    parameters: Object.freeze({ ...request.parameters }),
    inputs: Object.freeze(request.inputs.map((input) => Object.freeze({ ...input }))),
  };
  return { key: key(), request: Object.freeze(frozen) as CreateJobRequest, status: "submitting" };
}
export const markSubmissionUnknown = (submission: FrozenSubmission): FrozenSubmission => ({
  ...submission,
  status: "unknown",
});
export function submissionWasRejected(error: unknown): error is { code: string; status: number } {
  if (!error || typeof error !== "object" || !("status" in error) || !("code" in error))
    return false;
  const codes = [
    "IMAGE_INVALID_INPUT",
    "IMAGE_UNSUPPORTED_OPERATION",
    "IMAGE_AUTH_REQUIRED",
    "IMAGE_FORBIDDEN",
    "IMAGE_NOT_FOUND",
    "IMAGE_RATE_LIMITED",
    "IMAGE_REVISION_CONFLICT",
    "IMAGE_IDEMPOTENCY_CONFLICT",
    "IMAGE_TOO_LARGE",
  ];
  return (
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}
export function errorActionMessage(error: { code?: string } | undefined): Message {
  const code = error?.code ?? "";
  if (/401|403|AUTH|CREDENTIAL|FORBIDDEN/.test(code))
    return message("imageStudio.errorAction.auth");
  if (/429|RATE|QUOTA/.test(code)) return message("imageStudio.errorAction.rateLimit");
  if (/422|PARAMETER|INVALID/.test(code)) return message("imageStudio.errorAction.input");
  if (/UNKNOWN|UNCERTAIN/.test(code)) return message("imageStudio.errorAction.unknown");
  if (/EVENT_GAP/.test(code)) return message("imageStudio.errorAction.eventGap");
  return message("imageStudio.errorAction.default");
}
export const errorAction = (error: { code?: string } | undefined, t = defaultTranslate) =>
  formatMessage(errorActionMessage(error), t);
export type NoticeTone = "info" | "success" | "warning" | "error";
const noticeTones = new Set<string>(["info", "success", "warning", "error"]);
/**
 * Notice keys carry their tone (`imageStudio.notice.<tone>.<name>`), so the colour
 * never depends on the wording of one language. Validation lists are warnings.
 */
export function noticeTone(text: Message | undefined): NoticeTone {
  const tone = /^imageStudio\.notice\.(\w+)\./.exec(text?.key ?? "")?.[1] ?? "";
  return noticeTones.has(tone) ? (tone as NoticeTone) : "warning";
}
/** Errors wait for the user; everything else fades on its own. */
export const noticeDuration: Record<NoticeTone, number | null> = {
  success: 4000,
  info: 4000,
  warning: 8000,
  error: null,
};
/** Job-level and per-item errors usually repeat the same upstream message; show each once. */
export function jobErrorLines(job: ImageJob, t: Translate): string[] {
  const errors = [job.error, ...job.items.map((item) => item.error)].filter(
    (error): error is NonNullable<typeof error> => Boolean(error),
  );
  return [
    ...new Set(
      errors.map((error) =>
        formatMessage(
          message("imageStudio.errorLine", {
            error: imageErrorText(error, t),
            action: errorActionMessage(error),
          }),
          t,
        ),
      ),
    ),
  ];
}
export const formatJobTime = (iso: string, locale?: string) =>
  new Date(iso).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const statusKeys: Record<ImageJob["status"], string> = {
  queued: "imageStudio.status.queued",
  running: "imageStudio.status.running",
  saving: "imageStudio.status.saving",
  succeeded: "imageStudio.status.succeeded",
  partial_succeeded: "imageStudio.status.partial_succeeded",
  failed: "imageStudio.status.failed",
  cancel_requested: "imageStudio.status.cancel_requested",
  cancelled: "imageStudio.status.cancelled",
  result_unknown: "imageStudio.status.result_unknown",
};
/** A status from a newer backend has no key yet and shows as sent. */
export const statusLabel = (status: ImageJob["status"], t: Translate = defaultTranslate) =>
  Object.hasOwn(statusKeys, status) ? t(statusKeys[status]) : status;

// K-brain reports machine codes; unknown codes fall through verbatim so a new
// backend reason is still visible rather than silently swallowed.
const targetDisabledKeys = new Map([
  ["awaiting_verification", "imageStudio.targetDisabled.awaiting_verification"],
  ["auth_required", "imageStudio.targetDisabled.auth_required"],
  ["unsupported_image_model", "imageStudio.targetDisabled.unsupported_image_model"],
  ["unsupported_image_protocol", "imageStudio.targetDisabled.unsupported_image_protocol"],
  ["unsupported_provider_headers", "imageStudio.targetDisabled.unsupported_provider_headers"],
  ["unsupported_provider_endpoint", "imageStudio.targetDisabled.unsupported_provider_endpoint"],
]);
export function targetDisabledText(
  target: Pick<ImageTarget, "disabledReason">,
  t: Translate = defaultTranslate,
): string {
  const reason = target.disabledReason?.trim();
  if (!reason) return t("imageStudio.targetUnavailable");
  const key = targetDisabledKeys.get(reason);
  return key ? t(key) : reason;
}
// Provider-derived targets are named "<provider> · <model>" by K-brain.
export function splitTargetName(name: string): { model: string; provider?: string } {
  const at = name.indexOf(" · ");
  if (at <= 0) return { model: name };
  return { provider: name.slice(0, at), model: name.slice(at + 3) };
}
