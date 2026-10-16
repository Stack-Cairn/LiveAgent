/** Public kbrain.image.v1 wire types. No provider handles, URLs or secret values in responses. */
export const IMAGE_WIRE_VERSION = "kbrain.image.v1" as const;
export type Operation = "generate" | "reference" | "edit" | "mask";
export type JobStatus =
  | "queued"
  | "running"
  | "saving"
  | "succeeded"
  | "partial_succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "result_unknown";
export type Scalar = string | number | boolean;
export interface InputAsset {
  assetId: string;
  role: "source" | "reference" | "mask";
}
export interface CreateJobRequest {
  projectId: string;
  targetId: string;
  operation: Operation;
  prompt: string;
  inputs: InputAsset[];
  parameters: Record<string, Scalar>;
  count: number;
  parentAssetId?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface Usage {
  amount: string | null;
  currency: string;
  source: string;
  estimated: boolean;
}
export interface ImageErrorDetails {
  parameterKey?: string;
  /** User-facing reason for a rejected profile field, shown next to that field. */
  reason?: string;
  connectionId?: string;
  targetId?: string;
  expectedRevision?: number;
  actualRevision?: number;
  firstAvailableSeq?: number;
  lastEventSeq?: number;
}
export interface ImageError {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: ImageErrorDetails;
}
export interface ImageProject {
  id: string;
  title: string;
  workspaceRef?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ImageItem {
  id: string;
  status: JobStatus;
  attemptCount: number;
  outputAssetIds: string[];
  error?: ImageError;
}
export interface ImageJob {
  id: string;
  projectId: string;
  request: CreateJobRequest;
  targetSnapshot: TargetSnapshot;
  status: JobStatus;
  revision: number;
  assetIds: string[];
  items: ImageItem[];
  usage: Usage | null;
  cancelEffect?: string;
  error?: ImageError;
  createdAt: string;
  updatedAt: string;
  /** Optional recovery metadata on newer job snapshots; zero is meaningful. */
  lastEventSeq?: number;
  firstAvailableSeq?: number;
}
export interface ImageAsset {
  id: string;
  hash: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  source: "upload" | "generated";
  parentAssetIds: string[];
  jobId?: string;
  createdAt: string;
  available: boolean;
}
export interface ImageEventData {
  status?: JobStatus;
  itemId?: string;
  asset?: ImageAsset;
  error?: ImageError;
}
export interface ImageEvent {
  jobId: string;
  seq: number;
  revision: number;
  type: string;
  timestamp: string;
  data: ImageEventData;
}
export type ConnectionBinding =
  | { kind: "provider_ref"; providerId: string }
  | {
      kind: "independent";
      baseUrl: string;
      authKind: "bearer" | "api_key_header" | "signed_request";
      // Go omitempty: empty maps and false are omitted in public responses.
      secretRefs?: Record<string, string>;
      customHeaders?: Record<string, string>;
      useSystemProxy?: boolean;
    };
export interface ImageConnection {
  id: string;
  name: string;
  vendor: string;
  enabled: boolean;
  binding: ConnectionBinding;
  credentialConfigured: boolean;
  maxConcurrent: number;
}
export interface TargetCapabilities {
  operations: Operation[];
  supportsCancel: boolean;
  supportsReconcile: boolean;
  supportsContinuation: boolean;
  supportsPreview: boolean;
  maxInputs: number;
  maxCount: number;
  outputFormats: string[];
}
export interface ParameterSpec {
  key: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  enum?: Scalar[];
  minimum?: number;
  maximum?: number;
  default?: Scalar;
  unit?: string;
}
export interface WorkflowMapping {
  revision: number;
  inputs: { parameterKey: string; nodeId: string; inputName: string }[];
  outputs: { nodeId: string; outputName: string }[];
}
export interface TargetSnapshot {
  id: string;
  name: string;
  connectionId: string;
  adapter: string;
  adapterVersion: string;
  kind: "model" | "workflow";
  remoteId: string;
  revision: number;
  capabilities: TargetCapabilities;
  parameters: ParameterSpec[];
  workflowMapping?: WorkflowMapping;
}
export interface ImageTarget extends TargetSnapshot {
  enabled: boolean;
  disabledReason?: string;
}
export interface ImageSettings {
  revision: number;
  connections: ImageConnection[];
  targets: ImageTarget[];
}
export interface ImageSettingsUpdate {
  expectedRevision: number;
  connections: ImageConnection[];
  targets: ImageTarget[];
}
/** Write only; never retain in a draft, cache, log or error. */
export interface ImageSecretInput {
  connectionId: string;
  purpose: string;
  value: string;
}
export interface ImageSecretResult {
  ref: string;
  configured: boolean;
}
export interface ImageCapabilities {
  supported: boolean;
  version?: string;
}
export type AssetVariant = "original" | "thumbnail";
export type ExportDestination = "download" | "local_workspace" | "remote_workspace";
export interface ExportResult {
  saved: boolean;
}
export interface TargetVerificationRequest {
  expectedRevision: number;
  projectId: string;
  connectionId: string;
  remoteId: string;
  targetRevision: number;
  operation: "generate";
  count: 1;
  prompt: string;
  confirmPaid: boolean;
}
export interface TargetVerificationReceipt {
  id: string;
  targetId: string;
  jobId?: string;
  state: string;
  jobStatus?: JobStatus;
  settingsRevision: number;
  reason?: string;
}
export interface TargetVerificationAttempt {
  key: string;
  input: TargetVerificationRequest;
  receipt?: TargetVerificationReceipt;
}
/** Unified generation parameters; the backend converts them per platform. */
export interface GenerationParams {
  size: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  n?: number;
  transparentOutput?: boolean;
}
export interface ParamCorrection {
  field: string;
  from: string;
  to: string;
  reason: string;
}
export interface ImageProfileTarget {
  id: string;
  model: string;
  adapter: string;
  capabilities: TargetCapabilities;
  parameters: ParameterSpec[];
  /** False when the provider has no key or its platform is unknown. */
  ready: boolean;
}
export interface ImageProfile {
  id: string;
  name: string;
  platform: string;
  providerId?: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
  selectedModel?: string;
  apiKeyConfigured: boolean;
  targets: ImageProfileTarget[];
}
export interface ImageProfileSet {
  revision: number;
  profiles: ImageProfile[];
}
export interface CreateJobWithParams extends Omit<CreateJobRequest, "parameters"> {
  params: GenerationParams;
}
export interface CreatedJob {
  job: ImageJob;
  appliedParams?: GenerationParams;
  corrections?: ParamCorrection[];
}
/** Image services are derived from the chat providers; this side is read-only. */
export interface ImageProfilesClient {
  listProfiles(): Promise<ImageProfileSet>;
  createJobWithParams(input: CreateJobWithParams, key: string): Promise<CreatedJob>;
}
export interface ImageStudioClient {
  profiles?: ImageProfilesClient;
  hasVerificationPersistence?(): boolean;
  loadVerificationAttempt?(targetId: string): TargetVerificationAttempt | null;
  clearVerificationAttempt?(targetId: string): void;
  startTargetVerification?(
    targetId: string,
    input: TargetVerificationRequest,
    key: string,
  ): Promise<TargetVerificationReceipt>;
  getTargetVerificationByKey?(targetId: string, key: string): Promise<TargetVerificationReceipt>;
  getTargetVerification?(targetId: string, receiptId: string): Promise<TargetVerificationReceipt>;
  capabilities(): Promise<ImageCapabilities>;
  listTargets(): Promise<ImageTarget[]>;
  getSettings(): Promise<ImageSettings>;
  saveSettings(input: ImageSettingsUpdate): Promise<ImageSettings>;
  /** Same-client invalidation after a confirmed settings save. Unsubscribe on scope disposal. */
  subscribeSettingsSaved?(listener: () => void): () => void;
  writeSecret(input: ImageSecretInput): Promise<ImageSecretResult>;
  listProjects(cursor?: string): Promise<Page<ImageProject>>;
  createProject(title: string, workspaceRef?: string): Promise<ImageProject>;
  updateProject(id: string, title: string, expectedRevision: number): Promise<ImageProject>;
  deleteProject(id: string): Promise<void>;
  upload(file: Blob, name: string, signal?: AbortSignal): Promise<ImageAsset>;
  createJob(input: CreateJobRequest, key: string): Promise<ImageJob>;
  getJob(id: string): Promise<ImageJob>;
  listJobs(projectId: string, cursor?: string): Promise<Page<ImageJob>>;
  cancelJob(id: string): Promise<ImageJob>;
  /** HTTP 409 IMAGE_EVENT_GAP is surfaced without retry: refresh getJob, apply its snapshot,
   * then subscribe from snapshot.lastEventSeq (including zero). Missing metadata requires upgrade.
   * Unknown event types advance the cursor but are not delivered. Resolves on job.finished only. */
  subscribe(
    id: string,
    afterSeq: number,
    onEvent: (event: ImageEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  readAsset(id: string, variant: AssetVariant, signal?: AbortSignal): Promise<Blob>;
  exportAsset(id: string, destination: ExportDestination): Promise<ExportResult>;
}
