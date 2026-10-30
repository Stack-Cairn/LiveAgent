import type {
  CreateJobRequest,
  ImageAsset,
  ImageEvent,
  ImageJob,
  ImageProject,
  ImageTarget,
} from "../../lib/imaging/types";
import { imageErrorText, type Translate } from "./studioText";

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
        message: "任务没有返回可用图片，请修改输入后重新生成。",
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
export function errorAction(error: { code?: string } | undefined): string {
  const code = error?.code ?? "";
  if (/401|403|AUTH|CREDENTIAL|FORBIDDEN/.test(code)) return "请前往供应商设置检查地址与认证。";
  if (/429|RATE|QUOTA/.test(code)) return "请等待限额恢复后再操作。";
  if (/422|PARAMETER|INVALID/.test(code)) return "请修改提示词、参数或输入图片。";
  if (/UNKNOWN|UNCERTAIN/.test(code))
    return "请先核对任务状态；明确重新生成会创建新任务，可能再次计费。";
  if (/EVENT_GAP/.test(code)) return "事件历史已过期，请重新获取任务快照。";
  return "请刷新核对任务；确认后可修改输入重新生成。";
}
export type NoticeTone = "info" | "success" | "warning" | "error";
/** Notices are plain strings from many controller paths; classify them in one place. */
export function noticeTone(text: string): NoticeTone {
  if (/失败|已失效/.test(text)) return "error";
  if (/^(已删除历史记录|图片已保存)/.test(text)) return "success";
  if (/请|不支持|不可用|上限|不兼容|未确认|可能|计费/.test(text)) return "warning";
  return "info";
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
  return [...new Set(errors.map((error) => `${imageErrorText(error, t)} ${errorAction(error)}`))];
}
export const formatJobTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export const statusLabels: Record<ImageJob["status"], string> = {
  queued: "排队中",
  running: "生成中",
  saving: "保存中",
  succeeded: "已完成",
  partial_succeeded: "部分完成",
  failed: "失败",
  cancel_requested: "正在取消",
  cancelled: "已取消",
  result_unknown: "结果未知",
};

// K-brain reports machine codes; unknown codes fall through verbatim so a new
// backend reason is still visible rather than silently swallowed.
const targetDisabledReasons: Record<string, string> = {
  awaiting_verification: "旧配置，等待验证",
  auth_required: "供应商未配置 API Key",
  unsupported_image_model: "该模型不支持生成图片",
  unsupported_image_protocol: "供应商接口类型不支持生图",
  unsupported_provider_headers: "供应商自定义请求头不受支持",
  unsupported_provider_endpoint: "供应商接口地址不受支持",
};
export function targetDisabledText(target: Pick<ImageTarget, "disabledReason">): string {
  const reason = target.disabledReason?.trim();
  if (!reason) return "该模型暂不可用，请检查供应商配置。";
  return targetDisabledReasons[reason] ?? reason;
}
// Provider-derived targets are named "<provider> · <model>" by K-brain.
export function splitTargetName(name: string): { model: string; provider?: string } {
  const at = name.indexOf(" · ");
  if (at <= 0) return { model: name };
  return { provider: name.slice(0, at), model: name.slice(at + 3) };
}
