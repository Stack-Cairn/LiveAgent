import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import type {
  SubagentBatchDetails,
  SubagentCardDetails,
  SubagentMessageDetails,
} from "../subagents/protocol";
import type { SubagentScheduler } from "../subagents/scheduler";

export type BuiltinToolGroupId =
  | "fs"
  | "shell"
  | "skill"
  | "system"
  | "mcp"
  | "subagent"
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

export type BuiltinToolBundle<TExtra extends object = object> = TExtra & {
  groupId: BuiltinToolGroupId;
  tools: Tool[];
  executeToolCall: BuiltinToolExecutor;
  metadataByName: Map<string, BuiltinToolMetadata>;
};

export function createBuiltinMetadataMap(
  entries: Array<
    [
      toolName: string,
      metadata: Omit<BuiltinToolMetadata, "groupId"> & {
        groupId: BuiltinToolGroupId;
      },
    ]
  >,
) {
  return new Map<string, BuiltinToolMetadata>(entries);
}

export type FsEntryKind = "file" | "dir";
export type PathScope = "workspace" | "skill" | "external";

export type ResolvedPathResultDetails = {
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
};

export type ReadTextResultDetails = {
  kind: "read_text";
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
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
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  mimeType: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
  reusedExisting: boolean;
};

export type DisplayImageItemDetails = {
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
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
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
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
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
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
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
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

export type WriteResultDetails = {
  kind: "write";
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  mode: "rewrite";
  existedBefore: boolean;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  preview: string;
};

/** Matching pass that located old_string, strictest first. */
export type EditMatchStrategy = "exact" | "line-endings" | "trailing-whitespace" | "indentation";

export type EditResultDetails = {
  kind: "edit";
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  replacements: number;
  replaceAll: boolean;
  matchStrategy?: EditMatchStrategy;
  expectedReplacements?: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  oldPreview: string;
  newPreview: string;
};

export type DeleteResultDetails = {
  kind: "delete";
  path: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  targetKind: string;
};

export type ListResultEntry = {
  path: string;
  kind: FsEntryKind;
};

export type ListResultDetails = {
  kind: "list";
  path?: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  targetKind?: FsEntryKind;
  depth: number;
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  entries: ListResultEntry[];
};

export type GlobResultDetails = {
  kind: "glob";
  path?: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  targetKind?: FsEntryKind;
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
  path?: string;
  scope?: PathScope;
  absolutePath?: string;
  relativePath?: string;
  displayPath?: string;
  fileId?: string;
  targetKind?: FsEntryKind;
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

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export type TodoWriteResultDetails = {
  kind: "todo_write";
  todos: TodoItem[];
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
  | SubagentBatchDetails
  | SubagentCardDetails
  | SubagentMessageDetails
  | WriteResultDetails
  | EditResultDetails
  | DeleteResultDetails
  | ListResultDetails
  | GlobResultDetails
  | GrepResultDetails
  | TodoWriteResultDetails
  | Record<string, unknown>;
