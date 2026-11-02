import { isRecord, parseImageError, protocolError, safeInteger } from "./errors";
import type {
  ConnectionBinding,
  CreateJobRequest,
  ImageAsset,
  ImageConnection,
  ImageEvent,
  ImageItem,
  ImageJob,
  ImageProject,
  ImageSettings,
  ImageTarget,
  Page,
  ParameterSpec,
  Scalar,
  TargetCapabilities,
  TargetSnapshot,
  Usage,
  WorkflowMapping,
} from "./types";
import { IMAGE_WIRE_VERSION } from "./types";

type Decoder<T> = (value: unknown) => T;
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError();
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw protocolError();
  return value;
}
export function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw protocolError();
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw protocolError();
  return value;
}
function scalar(value: unknown): Scalar {
  if (typeof value === "number") return finite(value);
  if (typeof value === "boolean") return value;
  return text(value);
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw protocolError();
  return result;
}
function oneOf<const T extends string>(...values: T[]): Decoder<T> {
  return (value) => {
    if (typeof value !== "string" || !values.includes(value as T)) throw protocolError();
    return value as T;
  };
}
export function array<T>(decode: Decoder<T>): Decoder<T[]> {
  return (value) => {
    if (!Array.isArray(value)) throw protocolError();
    return value.map(decode);
  };
}
function optional<T>(decode: Decoder<T>): Decoder<T | undefined> {
  return (value) => (value === undefined ? undefined : decode(value));
}
function nullable<T>(decode: Decoder<T>): Decoder<T | null> {
  return (value) => (value === null ? null : decode(value));
}
/** Copies only declared fields; never returns an unchecked server object. */
function object<S extends Record<string, Decoder<unknown>>>(
  shape: S,
): Decoder<{ [K in keyof S]: ReturnType<S[K]> }> {
  return (value) => {
    const source = record(value);
    const result: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(shape)) {
      const parsed = decode(source[key]);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result as { [K in keyof S]: ReturnType<S[K]> };
  };
}
function dictionary<T>(decode: Decoder<T>): Decoder<Record<string, T>> {
  return (value) =>
    Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, decode(item)]));
}
const strings = array(text);
const operation = oneOf("generate", "reference", "edit", "mask");
export const status = oneOf(
  "queued",
  "running",
  "saving",
  "succeeded",
  "partial_succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "result_unknown",
);
export const terminalStatuses = new Set([
  "succeeded",
  "partial_succeeded",
  "failed",
  "cancelled",
  "result_unknown",
]);
export const knownEvents = new Set([
  "job.accepted",
  "job.state_changed",
  "item.state_changed",
  "asset.ready",
  "job.finished",
]);
export const parseRequest: Decoder<CreateJobRequest> = object({
  projectId: text,
  targetId: text,
  operation,
  prompt: text,
  inputs: array(object({ assetId: text, role: oneOf("source", "reference", "mask") })),
  parameters: dictionary(scalar),
  count: safeInteger,
  parentAssetId: optional(text),
});
const capabilities: Decoder<TargetCapabilities> = object({
  operations: array(operation),
  supportsCancel: bool,
  supportsReconcile: bool,
  supportsContinuation: bool,
  supportsPreview: bool,
  maxInputs: safeInteger,
  maxCount: safeInteger,
  outputFormats: strings,
});
const parameter: Decoder<ParameterSpec> = object({
  key: text,
  label: text,
  type: oneOf("string", "number", "integer", "boolean"),
  required: bool,
  enum: optional(array(scalar)),
  minimum: optional(finite),
  maximum: optional(finite),
  default: optional(scalar),
  unit: optional(text),
});
const mapping: Decoder<WorkflowMapping> = object({
  revision: safeInteger,
  inputs: array(object({ parameterKey: text, nodeId: text, inputName: text })),
  outputs: array(object({ nodeId: text, outputName: text })),
});
const targetShape = {
  id: text,
  name: text,
  connectionId: text,
  adapter: text,
  adapterVersion: text,
  kind: oneOf("model", "workflow"),
  remoteId: text,
  revision: safeInteger,
  capabilities,
  parameters: array(parameter),
  workflowMapping: optional(mapping),
};
const snapshot: Decoder<TargetSnapshot> = object(targetShape);
export const parseTarget: Decoder<ImageTarget> = object({
  ...targetShape,
  enabled: bool,
  disabledReason: optional(text),
});
function publicBaseUrl(value: unknown): string {
  const result = text(value);
  try {
    const url = new URL(result);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw protocolError();
  } catch {
    throw protocolError();
  }
  return result;
}
function opaqueRef(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(result)) throw protocolError();
  return result;
}
function binding(value: unknown): ConnectionBinding {
  const source = record(value);
  if (source.kind === "provider_ref")
    return object({ kind: oneOf("provider_ref"), providerId: text })(source);
  // Header values are private execution configuration, stripped even if an old server returns them.
  return object({
    kind: oneOf("independent"),
    baseUrl: publicBaseUrl,
    authKind: oneOf("bearer", "api_key_header", "signed_request"),
    secretRefs: optional(dictionary(opaqueRef)),
    useSystemProxy: optional(bool),
  })(source);
}
const connection: Decoder<ImageConnection> = object({
  id: text,
  name: text,
  vendor: text,
  enabled: bool,
  binding,
  credentialConfigured: bool,
  maxConcurrent: safeInteger,
});
export const parseSettings: Decoder<ImageSettings> = object({
  revision: safeInteger,
  connections: array(connection),
  targets: array(parseTarget),
});
export const parseProject: Decoder<ImageProject> = object({
  id: text,
  title: text,
  workspaceRef: optional(text),
  revision: safeInteger,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const usage: Decoder<Usage> = object({
  amount: nullable(text),
  currency: text,
  source: text,
  estimated: bool,
});
const item: Decoder<ImageItem> = object({
  id: text,
  status,
  attemptCount: safeInteger,
  outputAssetIds: strings,
  error: optional(parseImageError),
});
export const parseJob: Decoder<ImageJob> = object({
  id: text,
  projectId: text,
  request: parseRequest,
  targetSnapshot: snapshot,
  status,
  revision: safeInteger,
  assetIds: strings,
  items: array(item),
  usage: nullable(usage),
  cancelEffect: optional(text),
  error: optional(parseImageError),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventSeq: optional(safeInteger),
  firstAvailableSeq: optional(safeInteger),
});
export const parseAsset: Decoder<ImageAsset> = object({
  id: text,
  hash: text,
  mime: oneOf("image/png", "image/jpeg", "image/webp"),
  bytes: safeInteger,
  width: safeInteger,
  height: safeInteger,
  source: oneOf("upload", "generated"),
  parentAssetIds: strings,
  jobId: optional(text),
  createdAt: timestamp,
  available: bool,
});
export function parseEvent(value: unknown): ImageEvent {
  const source = record(value);
  // Go's frozen ImageEvent has no version field; validate it when an envelope adds one.
  if (source.version !== undefined && source.version !== IMAGE_WIRE_VERSION) throw protocolError();
  const header = object({
    jobId: text,
    seq: safeInteger,
    revision: safeInteger,
    type: text,
    timestamp,
  })(source);
  const data = record(source.data);
  if (!knownEvents.has(header.type)) return { ...header, data: {} };
  const result = {
    ...header,
    data: object({
      status: optional(status),
      itemId: optional(text),
      asset: optional(parseAsset),
      error: optional(parseImageError),
    })(data),
  };
  if (
    header.type === "job.finished" &&
    (!result.data.status || !terminalStatuses.has(result.data.status))
  )
    throw protocolError();
  if (header.type === "asset.ready" && !result.data.asset) throw protocolError();
  if (header.type === "item.state_changed" && (!result.data.itemId || !result.data.status))
    throw protocolError();
  if (header.type === "job.state_changed" && !result.data.status) throw protocolError();
  return result;
}
export function envelope(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.version !== IMAGE_WIRE_VERSION || result.error !== undefined) throw protocolError();
  return result;
}
export function parseJobEnvelope(value: unknown): ImageJob {
  const source = envelope(value);
  const job = parseJob(source.job);
  for (const key of ["lastEventSeq", "firstAvailableSeq"] as const) {
    if (source[key] !== undefined) job[key] = safeInteger(source[key]);
  }
  return job;
}
export function page<T>(value: unknown, decode: Decoder<T>): Page<T> {
  const source = record(value);
  // A wrapped page is still an object with items/nextCursor, never a bare data array.
  return object({ items: array(decode), nextCursor: optional(text) })(
    source.data === undefined ? source : source.data,
  );
}
