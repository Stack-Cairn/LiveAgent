import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

import type { SubagentScheduler } from "../chat/subagent/subagentScheduler";

export type BuiltinToolGroupId =
  | "fs"
  | "shell"
  | "skill"
  | "system"
  | "mcp"
  | "delegate"
  | "memory";

export type BuiltinToolDisplayCategory =
  | "file"
  | "search"
  | "terminal"
  | "system"
  | "mcp"
  | "other";

export type BuiltinToolMetadata = {
  groupId: BuiltinToolGroupId;
  kind: string;
  isReadOnly: boolean;
  displayCategory: BuiltinToolDisplayCategory;
};

export type BuiltinToolExecutionContext = {
  parentToolCall: ToolCall;
  subagentScheduler?: SubagentScheduler;
  emitToolCall?: (toolCall: ToolCall) => void;
  emitToolExecutionStart?: (toolCall: ToolCall) => void;
  emitToolResult?: (toolCall: ToolCall, toolResult: ToolResultMessage) => void;
  emitToolStatus?: (status: string | null) => void;
};

export type BuiltinToolExecutor = (
  toolCall: ToolCall,
  signal?: AbortSignal,
  context?: BuiltinToolExecutionContext,
) => Promise<ToolResultMessage>;

export type BuiltinToolBundle<TExtra extends object = {}> = TExtra & {
  groupId: BuiltinToolGroupId;
  tools: Tool[];
  executeToolCall: BuiltinToolExecutor;
  metadataByName: Map<string, BuiltinToolMetadata>;
};

export function createBuiltinMetadataMap(
  entries: Array<[toolName: string, metadata: Omit<BuiltinToolMetadata, "groupId"> & {
    groupId: BuiltinToolGroupId;
  }]>,
) {
  return new Map<string, BuiltinToolMetadata>(entries);
}

export type FsEntryKind = "file" | "dir";
export type FileToolRoot = "workspace" | "skills";

export type ReadTextResultDetails = {
  kind: "read_text";
  root?: FileToolRoot;
  path: string;
  startLine: number;
  numLines: number;
  totalLines: number;
  truncated: boolean;
  isPartialView: boolean;
  mtimeMs: number;
  contentHash: string;
  reusedExisting: boolean;
};

export type ReadImageResultDetails = {
  kind: "read_image";
  root?: FileToolRoot;
  path: string;
  mimeType: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
  reusedExisting: boolean;
};

export type DisplayImageItemDetails = {
  root?: FileToolRoot;
  path: string;
  sourceType?: "path" | "url" | "base64" | "auto";
  renderMode?: "inline" | "proxy";
  sourceUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  contentHash?: string;
};

export type DisplayImageResultDetails = {
  kind: "display_image";
  images: DisplayImageItemDetails[];
  loadMode: "inline" | "proxy" | "mixed";
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  mtimeMs?: number;
  contentHash?: string;
};

export type ReadPdfResultDetails = {
  kind: "read_pdf";
  root?: FileToolRoot;
  path: string;
  pageStart: number;
  numPages: number;
  totalPages: number;
  truncated: boolean;
  mtimeMs: number;
  contentHash: string;
  reusedExisting: boolean;
};

export type ReadNotebookResultDetails = {
  kind: "read_notebook";
  root?: FileToolRoot;
  path: string;
  cellStart: number;
  numCells: number;
  totalCells: number;
  truncated: boolean;
  mtimeMs: number;
  contentHash: string;
  reusedExisting: boolean;
};

export type ReadDocumentResultDetails = {
  kind: "read_word" | "read_spreadsheet" | "read_archive";
  root?: FileToolRoot;
  path: string;
  truncated: boolean;
  mimeType?: string;
  sizeBytes?: number;
  mtimeMs: number;
  contentHash: string;
  reusedExisting: boolean;
};

export type SkillsManagerReadResultDetails = {
  kind: "read_skill";
  path: string;
  startLine: number;
  numLines: number;
  truncated: boolean;
};

export type SkillsManagerActionResultDetails = {
  kind: "manage_skill";
  action: string;
  rootDir: string;
  path?: string;
  skillsCount?: number;
  invalidCount?: number;
  installedCount?: number;
  createdName?: string;
  deletedName?: string;
  validationOk?: boolean;
  packageArchive?: string;
  seededCount?: number;
  target?: string;
  backup?: string;
  clawhubResultCount?: number;
  clawhubNextCursor?: string;
  clawhubSlug?: string;
  clawhubDownloadUrl?: string;
  errors?: string[];
};

export type SkillsManagerResultDetails =
  | SkillsManagerReadResultDetails
  | SkillsManagerActionResultDetails;

export type McpManagerResultDetails = {
  kind: "manage_mcp";
  action: string;
  serverId?: string;
  serverIds?: string[];
  transport?: string;
  ok?: boolean;
  phase?: string;
  serverCount?: number;
  enabledCount?: number;
  toolsCount?: number;
  changed?: boolean;
  stopped?: boolean;
  errors?: string[];
};

export type DelegateAgentItemResultDetails = {
  id: string;
  runId?: string;
  name?: string;
  role?: string;
  prompt: string;
  agentId?: string;
  agentName?: string;
  mode: "readonly" | "worktree";
  taskIntent?: "communication" | "research" | "review" | "implementation" | "document_generation";
  applyPolicy?: "none" | "explicit" | "auto";
  allowedOutputPaths?: string[];
  status: "completed" | "failed";
  summary: string;
  durationMs: number;
  rounds: number;
  toolCalls: number;
  error?: string;
  worktreeRoot?: string;
  workdir?: string;
  branchName?: string;
  changed?: boolean;
  statusText?: string;
  diffStat?: string;
  diff?: string;
  diffTruncated?: boolean;
  untrackedFiles?: string[];
  worktreeStatusError?: string;
  applyStatus?: "applied" | "skipped" | "failed";
  applyMethod?: "git_apply" | "git_apply_3way" | "file_copy_fallback";
  applyChanged?: boolean;
  applyPatchBytes?: number;
  applySkippedReason?: string;
  applyFallbackReason?: string;
  applyCopiedFiles?: string[];
  applyDeletedFiles?: string[];
  applyConflictFiles?: string[];
  applyError?: string;
  appliedToWorkdir?: string;
  worktreeCleanupStatus?: "removed" | "retained" | "skipped" | "failed";
  worktreeCleanupReason?: string;
  worktreeCleanupError?: string;
  worktreeBranchDeleted?: boolean;
  candidateArtifacts?: string[];
  changedPaths?: string[];
};

export type DelegateAgentCardResultDetails = {
  kind: "delegate_agent_item";
  parentToolCallId: string;
  index: number;
  total: number;
  concurrency: number;
  agent: DelegateAgentItemResultDetails;
};

export type DelegateAgentResultDetails = {
  kind: "delegate_agent";
  agentCount: number;
  concurrency: number;
  totalDurationMs: number;
  readOnly: boolean;
  mode: "readonly" | "worktree" | "mixed";
  agents: DelegateAgentItemResultDetails[];
};

export type SubagentMessageResultDetails = {
  kind: "subagent_message";
  parentConversationId: string;
  seq: number;
  senderAgentId: string;
  senderDisplayName?: string;
  recipientAgentId: string;
  recipientDisplayName?: string;
  channel: "direct" | "shared" | "decision" | "question";
  subject?: string;
  sourceRunId?: string;
  sourceToolCallId?: string;
  bodyPreview: string;
};

export type WriteResultDetails = {
  kind: "write";
  root?: FileToolRoot;
  path: string;
  mode: "rewrite";
  existedBefore: boolean;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  preview: string;
};

export type EditResultDetails = {
  kind: "edit";
  root?: FileToolRoot;
  path: string;
  replacements: number;
  replaceAll: boolean;
  expectedReplacements?: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  oldPreview: string;
  newPreview: string;
};

export type DeleteResultDetails = {
  kind: "delete";
  root?: FileToolRoot;
  path: string;
  targetKind: string;
};

export type ListResultEntry = {
  path: string;
  kind: FsEntryKind;
};

export type ListResultDetails = {
  kind: "list";
  root?: FileToolRoot;
  path?: string;
  depth: number;
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  entries: ListResultEntry[];
};

export type GlobResultDetails = {
  kind: "glob";
  root?: FileToolRoot;
  path?: string;
  pattern: string;
  sortBy: "path";
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  paths: string[];
};

export type GrepResultMatch = {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
};

export type GrepResultFileSummary = {
  path: string;
  count: number;
  firstLine?: number;
};

export type GrepResultDetails = {
  kind: "grep";
  root?: FileToolRoot;
  path?: string;
  pattern: string;
  filePattern?: string;
  ignoreCase: boolean;
  outputMode: "content" | "files" | "count";
  headLimit: number;
  offset: number;
  context: number;
  multiline: boolean;
  matchCount: number;
  fileCount: number;
  hasMore: boolean;
  matches: GrepResultMatch[];
  files: GrepResultFileSummary[];
};

export type BuiltinToolResultDetails =
  | ReadTextResultDetails
  | ReadImageResultDetails
  | DisplayImageResultDetails
  | ReadPdfResultDetails
  | ReadNotebookResultDetails
  | ReadDocumentResultDetails
  | SkillsManagerResultDetails
  | McpManagerResultDetails
  | DelegateAgentCardResultDetails
  | DelegateAgentResultDetails
  | SubagentMessageResultDetails
  | WriteResultDetails
  | EditResultDetails
  | DeleteResultDetails
  | ListResultDetails
  | GlobResultDetails
  | GrepResultDetails
  | Record<string, unknown>;
