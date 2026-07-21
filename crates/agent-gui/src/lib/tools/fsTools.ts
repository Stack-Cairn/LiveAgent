import type {
  ImageContent,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import {
  type BuiltinToolBundle,
  type BuiltinToolResultDetails,
  createBuiltinMetadataMap,
  type DeleteResultDetails,
  type DisplayImageItemDetails,
  type DisplayImageResultDetails,
  type EditMatchStrategy,
  type EditResultDetails,
  type GlobResultDetails,
  type GrepResultDetails,
  type ListResultDetails,
  type ReadDocumentResultDetails,
  type ReadImageResultDetails,
  type ReadNotebookResultDetails,
  type ReadPdfResultDetails,
  type ReadTextResultDetails,
  type WriteResultDetails,
} from "./builtinTypes";
import type { FileToolState } from "./fileToolState";
import { invokeFs, isFsBackendError } from "./fsBackend";
import { buildFsErrorText, buildRequiresFullReadText, buildWriteDirectoryText } from "./pathErrors";
import { formatResolvedTarget, type ResolvedPath, ToolPathResolver } from "./pathUtils";
import type { SkillAccessPolicy } from "./skillAccessPolicy";

type ToolOk<TDetails extends BuiltinToolResultDetails = BuiltinToolResultDetails> = {
  content: (TextContent | ImageContent)[];
  details: TDetails;
};

const MAX_DISPLAY_IMAGE_PATHS = 12;
const AUTO_FULL_READ_MAX_LINES = 5_000;

function strictToolParameters(properties: Record<string, unknown>) {
  return Type.Object(properties as any, { additionalProperties: false });
}

function assertKnownArguments(toolName: string, args: unknown, allowed: readonly string[]) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${toolName} received unsupported argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

type DisplayImageSourceType = "path" | "url" | "base64" | "auto";

type DisplayImageSourceInput = {
  source: string;
  sourceType: DisplayImageSourceType;
  mimeType?: string;
  resolvedPath?: ResolvedPath;
  workdir?: string;
};

type DisplayImageEntry = {
  content?: ImageContent;
  details: DisplayImageItemDetails;
};

type SystemListSkillFilesResponse = {
  rootDir?: string | null;
};

type ReadCommandResponse = {
  kind: "text" | "image" | "pdf" | "notebook" | "word" | "spreadsheet" | "archive";
  path: string;
  content?: string | null;
  truncated?: boolean | null;
  startLine?: number | null;
  numLines?: number | null;
  totalLines?: number | null;
  isPartialView?: boolean | null;
  pageStart?: number | null;
  numPages?: number | null;
  totalPages?: number | null;
  cellStart?: number | null;
  numCells?: number | null;
  totalCells?: number | null;
  mtimeMs: number;
  contentHash: string;
  mimeType?: string | null;
  data?: string | null;
  sizeBytes?: number | null;
  fileId?: string | null;
};

type WriteCommandResponse = {
  path: string;
  mode: "rewrite";
  existedBefore: boolean;
  bytesWritten: number;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  fileId?: string | null;
};

type PathStatusCommandResponse = {
  path: string;
  exists: boolean;
  kind?: "file" | "dir" | "symlink" | "other" | null;
  sizeBytes?: number | null;
  mtimeMs?: number | null;
  fileId?: string | null;
};

type EditCommandResponse = {
  path: string;
  replacements: number;
  replaceAll: boolean;
  matchStrategy?: string | null;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  fileId?: string | null;
};

type DeleteCommandResponse = {
  path: string;
  kind: string;
};

type ListCommandResponse = {
  path?: string | null;
  targetKind?: "file" | "dir" | null;
  depth: number;
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  entries: { path: string; kind: "file" | "dir" }[];
};

type GlobCommandResponse = {
  path?: string | null;
  targetKind?: "file" | "dir" | null;
  pattern: string;
  sortBy: "path";
  offset: number;
  maxResults: number;
  total: number;
  hasMore: boolean;
  paths: string[];
};

type GrepCommandResponse = {
  path?: string | null;
  targetKind?: "file" | "dir" | null;
  pattern: string;
  filePattern?: string | null;
  ignoreCase: boolean;
  outputMode: "content" | "files" | "count";
  headLimit: number;
  offset: number;
  context: number;
  multiline: boolean;
  matchCount: number;
  fileCount: number;
  hasMore: boolean;
  matches: Array<{
    path: string;
    line: number;
    text: string;
    before: string[];
    after: string[];
  }>;
  files: Array<{
    path: string;
    count: number;
    firstLine?: number | null;
  }>;
};

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function previewSnippet(input: string, maxChars = 500) {
  const text = input || "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(${text.length} chars total)...`;
}

function formatLineWindow(startLine: number, numLines: number, totalLines: number) {
  if (totalLines === 0 || numLines === 0) return "empty";
  const endLine = startLine + numLines - 1;
  return `${startLine}-${endLine} / ${totalLines}`;
}

/** Narrow the wire value to the strategies the Rust cascade can emit. */
function parseEditMatchStrategy(value: string | null | undefined): EditMatchStrategy | undefined {
  switch (value) {
    case "exact":
    case "line-endings":
    case "trailing-whitespace":
    case "indentation":
      return value;
    default:
      return undefined;
  }
}

/**
 * Teach the model when its old_string only matched through a lenient pass, so
 * it can copy content more precisely next time instead of drifting further.
 * The exhaustive switch (no default, `string` return type) fails to compile
 * when EditMatchStrategy gains a member without a note here.
 */
function buildEditMatchStrategyNote(matchStrategy: EditMatchStrategy | undefined): string {
  switch (matchStrategy) {
    case undefined:
    case "exact":
      return "";
    case "line-endings":
      return "\nmatchStrategy=line-endings (old_string matched after normalizing CRLF/LF line endings; the file's original line-ending style was preserved)";
    case "trailing-whitespace":
      return "\nmatchStrategy=trailing-whitespace (old_string matched after ignoring per-line trailing whitespace)";
    case "indentation":
      return "\nmatchStrategy=indentation (old_string matched after a uniform indentation shift; the replacement was re-indented to the file's actual indentation)";
  }
}

function pathDetails(resolved: ResolvedPath, fileId?: string | null) {
  return {
    path: resolved.displayPath,
    scope: resolved.scope,
    absolutePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    displayPath: resolved.displayPath,
    fileId: fileId ?? undefined,
  };
}

function statePathKey(resolved: ResolvedPath, fileId?: string | null) {
  return {
    path: resolved.displayPath,
    fileId: fileId ?? undefined,
    absolutePath: resolved.absolutePath,
  };
}

function backendPath(resolved: ResolvedPath) {
  return resolved.relativePath || undefined;
}

async function invokeFsToolCommand<T>(params: {
  toolName: string;
  resolved: ResolvedPath;
  command: string;
  args: Record<string, unknown>;
}) {
  try {
    return await invokeFs<T>(params.command, params.args);
  } catch (error) {
    if (isFsBackendError(error)) {
      throw new Error(buildFsErrorText(params.toolName, params.resolved, error));
    }
    throw error;
  }
}

export function createFsTools(params: {
  workdir: string;
  fileState: FileToolState;
  resolveHomeDir?: () => Promise<string>;
  skillsRootEnabled?: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
}): BuiltinToolBundle {
  const { workdir, fileState } = params;
  const allowSkillsRoot = params.skillsRootEnabled === true;
  const skillAccessPolicy = params.skillAccessPolicy;
  let cachedSkillsRootDir =
    typeof params.skillsRootDir === "string" ? params.skillsRootDir.trim() : "";

  async function resolveSkillsRootDir() {
    if (!allowSkillsRoot) {
      throw new Error("Skill paths are only available when Skills are enabled");
    }
    if (cachedSkillsRootDir) return cachedSkillsRootDir;
    const response = await invoke<SystemListSkillFilesResponse>("system_list_skill_files");
    const rootDir = typeof response.rootDir === "string" ? response.rootDir.trim() : "";
    if (!rootDir) {
      throw new Error("Skills root is unavailable; refresh Skills discovery and retry.");
    }
    cachedSkillsRootDir = rootDir;
    return cachedSkillsRootDir;
  }

  const pathResolver = new ToolPathResolver({
    workdir,
    resolveHomeDir: params.resolveHomeDir,
    skillsRootEnabled: allowSkillsRoot,
    skillsRootDir: cachedSkillsRootDir,
    skillAccessPolicy,
    resolveSkillsRootDir,
  });

  // Loop breaker: models sometimes retry a failing call with identical
  // arguments. Track consecutive identical failures and escalate the error
  // text so the retry loop is explicitly interrupted.
  let lastFailureKey = "";
  let lastFailureCount = 0;
  let lastFailureToolCallId = "";

  function annotateRepeatedFailure(toolCall: ToolCall, text: string) {
    const args =
      toolCall.arguments && typeof toolCall.arguments === "object"
        ? (toolCall.arguments as Record<string, unknown>)
        : {};
    const path = typeof args.path === "string" ? args.path : "";
    const key = `${toolCall.name}\0${path}\0${text}`;
    if (key !== lastFailureKey) {
      lastFailureKey = key;
      lastFailureCount = 1;
      lastFailureToolCallId = toolCall.id;
    } else if (toolCall.id !== lastFailureToolCallId) {
      lastFailureCount += 1;
      lastFailureToolCallId = toolCall.id;
    }
    if (lastFailureCount < 2) return text;
    return `${text} This exact call has now failed ${lastFailureCount} times in a row. Do not retry with the same arguments — apply the correction above, or take a different approach.`;
  }

  function noteToolCallSucceeded() {
    lastFailureKey = "";
    lastFailureCount = 0;
    lastFailureToolCallId = "";
  }

  type NormalizedWriteArgs = {
    path: unknown;
    content: string;
  };

  function normalizeWriteArgs(args: unknown): NormalizedWriteArgs {
    const record =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    if ("content" in record && typeof record.content !== "string") {
      throw new Error("Write.content must be a string.");
    }
    return {
      path: record.path,
      content: typeof record.content === "string" ? record.content : "",
    };
  }

  async function resolveWriteTarget(writeArgs: NormalizedWriteArgs) {
    const resolved = await pathResolver.resolvePath(writeArgs.path, {
      label: "Write.path",
      intent: "write",
      required: true,
    });
    return { resolved, path: backendPath(resolved) };
  }

  async function readPathStatus(toolName: string, resolved: ResolvedPath, path: string) {
    return invokeFsToolCommand<PathStatusCommandResponse>({
      toolName,
      resolved,
      command: "fs_path_status",
      args: {
        workdir: resolved.root,
        path,
      },
    });
  }

  const toolRead: Tool = {
    name: "Read",
    description:
      "Read a text, image, PDF, notebook, Word, Excel/spreadsheet, or archive file from the workspace or an enabled Skill. Pass the path exactly as returned by other tools. For text files, use start_line (1-based) and limit for pagination. For PDFs, use page_start and page_limit. For notebooks (.ipynb), use cell_start and cell_limit. Word/Excel/archive files return a best-effort text preview or entry listing. Returns version metadata and may return an `unchanged` stub when content has not changed since the previous read. Use Image instead when the user asks to show, view, render, or display an image in the chat UI. Do not use Markdown image syntax or HTML img tags to display files.",
    parameters: strictToolParameters({
      path: Type.String({
        description:
          'Required file path. Prefer the workspace-relative form such as "src/App.tsx" or the skill:// form, exactly as returned by other tools; absolute, ~/..., and file:// forms are auto-normalized.',
      }),
      start_line: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "1-based starting line for text files (default: 1)",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of lines to read for text files (default: 200)",
        }),
      ),
      page_start: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "1-based starting page for PDF files (default: 1)",
        }),
      ),
      page_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of PDF pages to read (default: 5)",
        }),
      ),
      cell_start: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "1-based starting cell for notebook files (default: 1)",
        }),
      ),
      cell_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of notebook cells to summarize (default: 20)",
        }),
      ),
    }),
  };

  const toolImage: Tool = {
    name: "Image",
    description:
      "Display one or more images in the chat UI. This is the only supported way for assistant-side image rendering. Call it whenever the user asks to show, view, render, preview, open, or display images, and whenever another tool saves, downloads, screenshots, generates, or returns an image path/URL that the user should see. Supports workspace paths, enabled Skill paths, external absolute paths, http/https URLs, base64 data URLs, and SVG images (file, data URL, or raw XML). Pass local paths exactly as you see them. For remote images, pass url/urls or source/sources directly instead of downloading the image first, unless the user explicitly asks to save it locally. Do not embed images in final text with Markdown image syntax, HTML img tags, file:// URLs, or local relative image paths.",
    parameters: strictToolParameters({
      path: Type.Optional(
        Type.String({
          description:
            "Single local image path, exactly as returned by other tools. Workspace-relative, skill://, absolute, ~/..., and file:// forms are accepted; external absolute paths are allowed for images.",
        }),
      ),
      paths: Type.Optional(
        Type.Array(
          Type.String({
            description: "Local image path. Same accepted forms as `path`.",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description: "Multiple local image paths to display in order.",
          },
        ),
      ),
      url: Type.Optional(
        Type.String({
          description:
            "Single http/https image URL. Use this directly for remote images that only need to be displayed.",
        }),
      ),
      urls: Type.Optional(
        Type.Array(
          Type.String({
            description: "http/https image URL",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description:
              "Multiple remote image URLs to display in order without pre-downloading them.",
          },
        ),
      ),
      base64: Type.Optional(
        Type.String({
          description:
            "Single image as a data URL or raw base64. For raw base64, provide mimeType when possible.",
        }),
      ),
      base64s: Type.Optional(
        Type.Array(
          Type.String({
            description: "Image as a data URL or raw base64",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description:
              "Multiple base64 images to display in order. Prefer data URLs so the MIME type is explicit.",
          },
        ),
      ),
      mimeType: Type.Optional(
        Type.String({
          description:
            "MIME type for raw base64 input, for example image/png, image/jpeg, or image/svg+xml.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description:
            "Single generic image source. Accepted forms: local path, http/https URL, data URL, raw base64, or raw SVG XML. Prefer this for mixed or unknown source types.",
        }),
      ),
      sources: Type.Optional(
        Type.Array(
          Type.String({
            description: "Generic image source. Same accepted forms as `source`.",
          }),
          {
            minItems: 1,
            maxItems: MAX_DISPLAY_IMAGE_PATHS,
            description:
              "Multiple mixed image sources to display in order. Use this for mixed path + URL + base64 galleries.",
          },
        ),
      ),
    }),
  };

  const toolWrite: Tool & { prepareArguments?: (args: unknown) => unknown } = {
    name: "Write",
    description:
      "Create a new text file or fully overwrite an existing workspace or enabled Skill text file. `path` must include the intended filename, for example `notes/todo.txt`; Write creates missing parent directories but does not choose filenames from directory paths. Overwriting an existing file replaces its entire content and is checked against the file's current on-disk state automatically. Use Edit for small changes.",
    // `path` is declared before `content` on purpose: models tend to emit
    // arguments in schema order, and a path that streams first keeps live
    // previews and transport recovery well-formed for large contents.
    parameters: strictToolParameters({
      path: Type.String({
        description:
          "Required file path. Prefer the workspace-relative or skill:// form returned by other tools; absolute and ~/... forms are auto-normalized. Must resolve inside the workspace or an enabled Skill.",
      }),
      content: Type.String({ description: "Entire text content to write" }),
    }),
    // Legacy tolerance: replayed histories teach some models to send the
    // retired `mode` field; strip it before schema validation instead of
    // failing the call.
    prepareArguments: (args) => {
      if (args && typeof args === "object" && !Array.isArray(args) && "mode" in args) {
        const { mode: _legacyMode, ...rest } = args as Record<string, unknown>;
        return rest;
      }
      return args;
    },
  };

  const toolEdit: Tool = {
    name: "Edit",
    description:
      "Perform an exact-string replacement in a file you have already Read. Validates version metadata before writing and rejects stale edits — if the file changed after the last Read, Read it again before retrying. When no exact match exists, Edit automatically retries with lenient matching (CRLF/LF line endings, per-line trailing whitespace, then a uniform indentation shift) and reports the used matchStrategy in the result, so do not pad old_string with guessed whitespace. If `old_string` matches multiple places, either narrow it until unique or set `replace_all=true` explicitly.",
    parameters: strictToolParameters({
      path: Type.String({
        description:
          "Required file path. Prefer the workspace-relative or skill:// form returned by other tools; absolute and ~/... forms are auto-normalized. Must resolve inside the workspace or an enabled Skill.",
      }),
      old_string: Type.String({ description: "Exact text to replace" }),
      new_string: Type.String({ description: "Replacement text" }),
      expected_replacements: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Expected number of actual replacements. Use together with replace_all for multi-match edits.",
        }),
      ),
      replace_all: Type.Optional(
        Type.Boolean({
          description:
            "Replace every exact match when true; otherwise only a single unambiguous match is allowed",
        }),
      ),
    }),
  };

  const toolDelete: Tool = {
    name: "Delete",
    description:
      "Delete a workspace or enabled Skill file/directory. Directories are removed recursively. Use this instead of Bash rm, rmdir, unlink, or find -delete for workspace or Skill files.",
    parameters: strictToolParameters({
      path: Type.String({
        description:
          "Required path to the file or directory. Prefer the workspace-relative or skill:// form returned by other tools. Must resolve inside the workspace or an enabled Skill.",
      }),
    }),
  };

  const toolList: Tool = {
    name: "List",
    description:
      "List files and directories under the workspace or an enabled Skill using ignore-aware traversal. Supports depth-limited traversal and paginated results. Prefer this over `Bash ls` / `find` for workspace or Skill content.",
    parameters: strictToolParameters({
      path: Type.Optional(
        Type.String({
          description:
            "Optional directory to list; a file path returns that single entry. Omit to list the workspace root. Prefer the workspace-relative or skill:// form returned by other tools.",
        }),
      ),
      depth: Type.Optional(
        Type.Number({ minimum: 1, description: "Recursion depth (default: 2)" }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset (default: 0)" }),
      ),
      max_results: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of entries to return (default: 200)",
        }),
      ),
    }),
  };

  const toolGlob: Tool = {
    name: "Glob",
    description:
      "Find files by glob pattern using ignore-aware traversal. Results are paginated and sorted by path. Prefer this over `Bash find` for workspace or Skill content.",
    parameters: strictToolParameters({
      pattern: Type.String({
        description:
          'Glob pattern relative to the search root, for example "**/*.tsx" or "src/**/Chat*.ts". Use `/` as the separator (Windows `\\` is auto-normalized).',
      }),
      path: Type.Optional(
        Type.String({
          description:
            "Optional base directory to search under. Omit to search from the workspace root. Prefer the workspace-relative or skill:// form returned by other tools.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset (default: 0)" }),
      ),
      max_results: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Maximum number of results to return (default: 200)",
        }),
      ),
      sort_by: Type.Optional(
        Type.Literal("path", {
          description: "Sorting mode. Only path sorting is currently supported.",
        }),
      ),
    }),
  };

  const toolGrep: Tool = {
    name: "Grep",
    description:
      "Search file contents using a regular expression with ignore-aware traversal. Supports output_mode=content|files|count, pagination, optional surrounding context, and multiline matching. Prefer this over `Bash grep` / `rg` for any workspace or Skill content.",
    parameters: strictToolParameters({
      pattern: Type.String({ description: "Regular expression to search for in file contents." }),
      path: Type.Optional(
        Type.String({
          description:
            "Optional directory or single file to search. Omit to search from the workspace root. Prefer the workspace-relative or skill:// form returned by other tools.",
        }),
      ),
      file_pattern: Type.Optional(
        Type.String({
          description: "Optional glob filter, for example **/*.ts|**/*.tsx",
        }),
      ),
      ignore_case: Type.Optional(
        Type.Boolean({ description: "Case-insensitive when true (default: true)" }),
      ),
      output_mode: Type.Optional(
        Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count")]),
      ),
      head_limit: Type.Optional(
        Type.Number({
          minimum: 1,
          description:
            "Maximum number of rows to return for the selected output mode (default: 200)",
        }),
      ),
      offset: Type.Optional(
        Type.Number({ minimum: 0, description: "Pagination offset (default: 0)" }),
      ),
      context: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "Number of surrounding lines to include around each match (default: 0)",
        }),
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description: "Enable multiline regular expression matching when true",
        }),
      ),
    }),
  };

  const tools: Tool[] = [
    toolRead,
    toolImage,
    toolWrite,
    toolEdit,
    toolDelete,
    toolList,
    toolGlob,
    toolGrep,
  ];

  const allowedArgumentsByToolName: Record<string, readonly string[]> = {
    Read: ["path", "start_line", "limit", "page_start", "page_limit", "cell_start", "cell_limit"],
    Image: ["path", "paths", "url", "urls", "base64", "base64s", "mimeType", "source", "sources"],
    // "mode" is legacy tolerance: no longer in the schema, silently ignored.
    Write: ["path", "content", "mode"],
    Edit: ["path", "old_string", "new_string", "expected_replacements", "replace_all"],
    Delete: ["path"],
    List: ["path", "depth", "offset", "max_results"],
    Glob: ["pattern", "path", "offset", "max_results", "sort_by"],
    Grep: [
      "pattern",
      "path",
      "file_pattern",
      "ignore_case",
      "output_mode",
      "head_limit",
      "offset",
      "context",
      "multiline",
    ],
  };

  async function execRead(args: any, signal?: AbortSignal): Promise<ToolOk> {
    if (signal?.aborted) throw new Error("Cancelled");

    const resolved = await pathResolver.resolvePath(args?.path, {
      label: "Read.path",
      intent: "read",
      required: true,
    });
    const path = backendPath(resolved);
    if (!path) throw new Error("Read.path must identify a file");
    const start_line = typeof args?.start_line === "number" ? args.start_line : undefined;
    const limit = typeof args?.limit === "number" ? args.limit : undefined;
    const page_start = typeof args?.page_start === "number" ? args.page_start : undefined;
    const page_limit = typeof args?.page_limit === "number" ? args.page_limit : undefined;
    const cell_start = typeof args?.cell_start === "number" ? args.cell_start : undefined;
    const cell_limit = typeof args?.cell_limit === "number" ? args.cell_limit : undefined;

    const res = await invokeFsToolCommand<ReadCommandResponse>({
      toolName: "Read",
      resolved,
      command: "fs_read_text",
      args: {
        workdir: resolved.root,
        path,
        start_line,
        limit,
        page_start,
        page_limit,
        cell_start,
        cell_limit,
      },
    });

    if (res.kind === "image") {
      const baseDetails: ReadImageResultDetails = {
        kind: "read_image",
        ...pathDetails(resolved, res.fileId),
        mimeType: String(res.mimeType || "application/octet-stream"),
        sizeBytes: typeof res.sizeBytes === "number" ? res.sizeBytes : 0,
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };
      const previous = fileState.getExactImageRead(statePathKey(resolved, res.fileId));
      const reusedExisting =
        previous?.kind === "image" &&
        previous.mtimeMs === baseDetails.mtimeMs &&
        previous.contentHash === baseDetails.contentHash;
      const details: ReadImageResultDetails = {
        ...baseDetails,
        reusedExisting,
      };
      fileState.recordImageRead(details);

      if (reusedExisting) {
        return {
          content: [
            {
              type: "text",
              text: `Read image: ${formatResolvedTarget(resolved)}\nThis image is unchanged since the previous Read. Reuse the earlier image result.`,
            },
          ],
          details,
        };
      }

      if (typeof res.data !== "string" || !res.data) {
        throw new Error(`Read did not return image bytes for ${formatResolvedTarget(resolved)}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Read image: ${formatResolvedTarget(resolved)}\nmime=${details.mimeType}\nsizeBytes=${details.sizeBytes}`,
          },
          {
            type: "image",
            data: res.data,
            mimeType: details.mimeType,
          },
        ],
        details,
      };
    }

    if (res.kind === "pdf") {
      const pageStart = typeof res.pageStart === "number" ? res.pageStart : 1;
      const numPages = typeof res.numPages === "number" ? res.numPages : 0;
      const totalPages = typeof res.totalPages === "number" ? res.totalPages : 0;
      const baseDetails: ReadPdfResultDetails = {
        kind: "read_pdf",
        ...pathDetails(resolved, res.fileId),
        pageStart,
        numPages,
        totalPages,
        truncated: Boolean(res.truncated),
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };
      const previous = fileState.getExactPdfRead(statePathKey(resolved, res.fileId), {
        pageStart,
        numPages,
        totalPages,
      });
      const reusedExisting =
        previous?.kind === "pdf" &&
        previous.mtimeMs === baseDetails.mtimeMs &&
        previous.contentHash === baseDetails.contentHash;
      const details: ReadPdfResultDetails = {
        ...baseDetails,
        reusedExisting,
      };
      fileState.recordPdfRead(details);

      if (reusedExisting) {
        return {
          content: [
            {
              type: "text",
              text:
                `Read PDF: ${formatResolvedTarget(resolved)}\n` +
                `pages=${details.numPages > 0 ? `${details.pageStart}-${details.pageStart + details.numPages - 1}/${details.totalPages}` : `empty/${details.totalPages}`}\n` +
                "This page range is unchanged since the previous Read. Reuse the earlier content.",
            },
          ],
          details,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Read PDF: ${formatResolvedTarget(resolved)}\n` +
              `pages=${details.numPages > 0 ? `${details.pageStart}-${details.pageStart + details.numPages - 1}/${details.totalPages}` : `empty/${details.totalPages}`}\n\n` +
              `${typeof res.content === "string" && res.content ? res.content : "(no extractable text)"}`,
          },
        ],
        details,
      };
    }

    if (res.kind === "notebook") {
      const cellStart = typeof res.cellStart === "number" ? res.cellStart : 1;
      const numCells = typeof res.numCells === "number" ? res.numCells : 0;
      const totalCells = typeof res.totalCells === "number" ? res.totalCells : 0;
      const baseDetails: ReadNotebookResultDetails = {
        kind: "read_notebook",
        ...pathDetails(resolved, res.fileId),
        cellStart,
        numCells,
        totalCells,
        truncated: Boolean(res.truncated),
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };
      const previous = fileState.getExactNotebookRead(statePathKey(resolved, res.fileId), {
        cellStart,
        numCells,
        totalCells,
      });
      const reusedExisting =
        previous?.kind === "notebook" &&
        previous.mtimeMs === baseDetails.mtimeMs &&
        previous.contentHash === baseDetails.contentHash;
      const details: ReadNotebookResultDetails = {
        ...baseDetails,
        reusedExisting,
      };
      fileState.recordNotebookRead(details);

      if (reusedExisting) {
        return {
          content: [
            {
              type: "text",
              text:
                `Read notebook: ${formatResolvedTarget(resolved)}\n` +
                `cells=${details.numCells > 0 ? `${details.cellStart}-${details.cellStart + details.numCells - 1}/${details.totalCells}` : `empty/${details.totalCells}`}\n` +
                "This cell range is unchanged since the previous Read. Reuse the earlier content.",
            },
          ],
          details,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Read notebook: ${formatResolvedTarget(resolved)}\n` +
              `cells=${details.numCells > 0 ? `${details.cellStart}-${details.cellStart + details.numCells - 1}/${details.totalCells}` : `empty/${details.totalCells}`}\n\n` +
              `${typeof res.content === "string" && res.content ? res.content : "(empty notebook)"}`,
          },
        ],
        details,
      };
    }

    if (res.kind === "word" || res.kind === "spreadsheet" || res.kind === "archive") {
      const label =
        res.kind === "word"
          ? "Word document"
          : res.kind === "spreadsheet"
            ? "spreadsheet"
            : "archive";
      const details: ReadDocumentResultDetails = {
        kind:
          res.kind === "word"
            ? "read_word"
            : res.kind === "spreadsheet"
              ? "read_spreadsheet"
              : "read_archive",
        ...pathDetails(resolved, res.fileId),
        truncated: Boolean(res.truncated),
        mimeType: typeof res.mimeType === "string" ? res.mimeType : undefined,
        sizeBytes: typeof res.sizeBytes === "number" ? res.sizeBytes : undefined,
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
        reusedExisting: false,
      };

      return {
        content: [
          {
            type: "text",
            text:
              `Read ${label}: ${formatResolvedTarget(resolved)}\n` +
              [
                details.mimeType ? `mime=${details.mimeType}` : null,
                typeof details.sizeBytes === "number" ? `sizeBytes=${details.sizeBytes}` : null,
                details.truncated ? "truncated=true" : null,
              ]
                .filter((item): item is string => Boolean(item))
                .join("\n") +
              "\n\n" +
              `${typeof res.content === "string" && res.content ? res.content : "(no preview available)"}`,
          },
        ],
        details,
      };
    }

    const startLine = typeof res.startLine === "number" ? res.startLine : 1;
    const numLines = typeof res.numLines === "number" ? res.numLines : 0;
    const totalLines = typeof res.totalLines === "number" ? res.totalLines : 0;
    const baseDetails: ReadTextResultDetails = {
      kind: "read_text",
      ...pathDetails(resolved, res.fileId),
      startLine,
      numLines,
      totalLines,
      truncated: Boolean(res.truncated),
      isPartialView: Boolean(res.isPartialView),
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      reusedExisting: false,
    };
    const previous = fileState.getExactTextRead(statePathKey(resolved, res.fileId), {
      startLine,
      numLines,
      totalLines,
    });
    const reusedExisting =
      previous?.kind === "text" &&
      previous.mtimeMs === baseDetails.mtimeMs &&
      previous.contentHash === baseDetails.contentHash;
    const details: ReadTextResultDetails = {
      ...baseDetails,
      reusedExisting,
    };
    fileState.recordTextRead(details);

    if (reusedExisting) {
      return {
        content: [
          {
            type: "text",
            text:
              `Read: ${formatResolvedTarget(resolved)}\n` +
              `lines=${formatLineWindow(details.startLine, details.numLines, details.totalLines)}\n` +
              "This range is unchanged since the previous Read. Reuse the earlier content.",
          },
        ],
        details,
      };
    }

    const header = [
      `Read: ${formatResolvedTarget(resolved)}`,
      `lines=${formatLineWindow(details.startLine, details.numLines, details.totalLines)}`,
      details.isPartialView ? "view=partial" : "view=full",
    ].join("\n");
    const body = typeof res.content === "string" && res.content ? res.content : "(empty file)";
    const suffix = details.truncated ? "\n\n[...truncated...]\n" : "";

    return {
      content: [{ type: "text", text: `${header}\n\n${body}${suffix}` }],
      details,
    };
  }

  function buildFullReadLimitMessage(toolName: string, resolved: ResolvedPath, totalLines: number) {
    const target = formatResolvedTarget(resolved);
    return `${toolName} requires a full-file Read first: ${target} has ${totalLines} lines, which exceeds the automatic full-read limit (${AUTO_FULL_READ_MAX_LINES}). Call Read with path="${target}" and limit=${totalLines}, then retry ${toolName} with the same path.`;
  }

  async function primeFullTextSnapshot(params: {
    toolName: "Edit" | "Write";
    resolved: ResolvedPath;
    path: string;
    signal?: AbortSignal;
    status?: PathStatusCommandResponse;
  }) {
    const status =
      params.status ?? (await readPathStatus(params.toolName, params.resolved, params.path));
    const key = statePathKey(params.resolved, status.fileId);
    const existingSnapshot = fileState.getLatestFullText(key);
    if (existingSnapshot) {
      return { snapshot: existingSnapshot, autoRead: false, status };
    }

    const latest = fileState.getLatest(key);
    let readLimit = AUTO_FULL_READ_MAX_LINES;
    if (latest?.kind === "text" && latest.totalLines > 0) {
      if (latest.totalLines > AUTO_FULL_READ_MAX_LINES) {
        throw new Error(
          buildFullReadLimitMessage(params.toolName, params.resolved, latest.totalLines),
        );
      }
      readLimit = latest.totalLines;
    }

    await execRead(
      {
        path: params.resolved.displayPath,
        limit: readLimit,
      },
      params.signal,
    );

    const snapshot = fileState.getLatestFullText(key);
    if (snapshot) {
      return { snapshot, autoRead: true, status };
    }

    const latestAfterRead = fileState.getLatest(key);
    if (latestAfterRead?.kind === "text" && latestAfterRead.isPartialView) {
      throw new Error(
        buildFullReadLimitMessage(params.toolName, params.resolved, latestAfterRead.totalLines),
      );
    }

    throw new Error(buildRequiresFullReadText(params.toolName, params.resolved));
  }

  function normalizeRequiredImageSource(input: unknown, label: string) {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return value;
  }

  function getOptionalMimeType(args: any) {
    const value =
      typeof args?.mimeType === "string"
        ? args.mimeType
        : typeof args?.mime_type === "string"
          ? args.mime_type
          : "";
    return value.trim() || undefined;
  }

  function inferGenericImageSourceType(source: string): DisplayImageSourceType {
    if (/^data:image\//i.test(source)) return "base64";
    if (/^https?:\/\//i.test(source)) return "url";
    const compact = source.replace(/\s/g, "");
    if (/^(iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|Qk|AAABAA|PHN2Z|PD94bWwg)/.test(compact)) {
      return "base64";
    }
    return "auto";
  }

  function isInlineSvgSource(source: string) {
    const value = source.trimStart();
    return /^<\?xml\b/i.test(value) || /^<svg\b/i.test(value);
  }

  async function resolveImageLocalPathSource(
    input: unknown,
    label: string,
  ): Promise<DisplayImageSourceInput> {
    const source = normalizeRequiredImageSource(input, label);
    const resolved = await pathResolver.resolvePath(source, {
      label,
      intent: "image",
      required: true,
      allowExternal: true,
    });
    return {
      source:
        resolved.scope === "external"
          ? resolved.absolutePath
          : (backendPath(resolved) ?? resolved.absolutePath),
      sourceType: "path",
      resolvedPath: resolved,
      workdir: resolved.scope === "external" ? workdir : resolved.root,
    };
  }

  async function pushImageSources(
    sources: DisplayImageSourceInput[],
    rawItems: unknown[],
    sourceType: DisplayImageSourceType,
    label: string,
    mimeType?: string,
  ) {
    for (const [index, item] of rawItems.entries()) {
      const itemLabel = rawItems.length > 1 ? `${label}[${index}]` : label;
      if (sourceType === "path") {
        const normalized = await resolveImageLocalPathSource(item, itemLabel);
        sources.push({
          ...normalized,
          mimeType,
        });
        continue;
      }
      sources.push({
        source: normalizeRequiredImageSource(item, itemLabel),
        sourceType,
        mimeType,
      });
    }
  }

  async function pushGenericImageSources(
    sources: DisplayImageSourceInput[],
    rawItems: unknown[],
    label: string,
    mimeType?: string,
  ) {
    for (const [index, item] of rawItems.entries()) {
      const itemLabel = rawItems.length > 1 ? `${label}[${index}]` : label;
      const source = normalizeRequiredImageSource(item, itemLabel);
      const sourceType = inferGenericImageSourceType(source);
      const shouldNormalizeAsLocalPath = sourceType === "auto" && !isInlineSvgSource(source);
      if (shouldNormalizeAsLocalPath) {
        const normalized = await resolveImageLocalPathSource(source, itemLabel);
        sources.push({
          ...normalized,
          sourceType,
          mimeType,
        });
        continue;
      }
      sources.push({
        source,
        sourceType,
        mimeType,
      });
    }
  }

  async function normalizeDisplayImageSources(args: any): Promise<DisplayImageSourceInput[]> {
    const sources: DisplayImageSourceInput[] = [];
    const mimeType = getOptionalMimeType(args);

    if (Array.isArray(args?.sources) && args.sources.length > 0) {
      await pushGenericImageSources(sources, args.sources, "Image.sources", mimeType);
    } else if (typeof args?.source === "string" && args.source.trim()) {
      await pushGenericImageSources(sources, [args.source], "Image.source", mimeType);
    }

    if (Array.isArray(args?.paths) && args.paths.length > 0) {
      await pushImageSources(sources, args.paths, "path", "Image.paths");
    } else if (typeof args?.path === "string" && args.path.trim()) {
      await pushImageSources(sources, [args.path], "path", "Image.path");
    }

    if (Array.isArray(args?.urls) && args.urls.length > 0) {
      await pushImageSources(sources, args.urls, "url", "Image.urls");
    } else if (typeof args?.url === "string" && args.url.trim()) {
      await pushImageSources(sources, [args.url], "url", "Image.url");
    }

    if (Array.isArray(args?.base64s) && args.base64s.length > 0) {
      await pushImageSources(sources, args.base64s, "base64", "Image.base64s", mimeType);
    } else if (typeof args?.base64 === "string" && args.base64.trim()) {
      await pushImageSources(sources, [args.base64], "base64", "Image.base64", mimeType);
    }

    if (sources.length === 0) {
      throw new Error("Image requires path, paths, url, urls, base64, base64s, source, or sources");
    }
    if (sources.length > MAX_DISPLAY_IMAGE_PATHS) {
      throw new Error(`Image supports at most ${MAX_DISPLAY_IMAGE_PATHS} sources per call`);
    }
    return sources;
  }

  function normalizeProxyImageUrl(source: string) {
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch (error) {
      throw new Error(
        `Image.url must be an absolute URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Image.url only supports http and https");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Image.url cannot include embedded username or password");
    }
    return parsed.toString();
  }

  function buildProxyDisplayImage(input: DisplayImageSourceInput): DisplayImageEntry {
    const sourceUrl = normalizeProxyImageUrl(input.source);
    return {
      details: {
        path: sourceUrl,
        sourceType: "url",
        renderMode: "proxy",
        sourceUrl,
        mimeType: input.mimeType,
      },
    };
  }

  async function readDisplayImage(input: DisplayImageSourceInput): Promise<DisplayImageEntry> {
    if (input.sourceType === "url") {
      return buildProxyDisplayImage(input);
    }

    let res: ReadCommandResponse;
    try {
      res = await invokeFs<ReadCommandResponse>("fs_read_image_source", {
        workdir: input.workdir ?? workdir,
        source: input.source,
        source_type: input.sourceType,
        mime_type: input.mimeType,
      } as any);
    } catch (error) {
      if (isFsBackendError(error) && input.resolvedPath) {
        throw new Error(buildFsErrorText("Image", input.resolvedPath, error));
      }
      throw new Error(
        [
          `Image failed for ${input.resolvedPath ? formatResolvedTarget(input.resolvedPath) : `source="${input.source}"`}: ${asErrorMessage(error)}`,
          "Pass the path exactly as returned by the tool that created or listed it; local paths are resolved automatically.",
          "Do not use Bash, open, xdg-open, Markdown, HTML, or file:// URLs in final text to display images.",
        ].join(" "),
      );
    }

    if (res.kind !== "image") {
      throw new Error(`${input.source} is not a supported image file`);
    }
    if (typeof res.data !== "string" || !res.data) {
      throw new Error(`Image did not return image bytes for ${input.source}`);
    }

    const mimeType = String(res.mimeType || "application/octet-stream");
    const displayPath =
      input.resolvedPath?.displayPath ||
      (typeof res.path === "string" && res.path ? res.path : input.source);
    const sizeBytes = typeof res.sizeBytes === "number" ? res.sizeBytes : 0;
    return {
      content: {
        type: "image" as const,
        data: res.data,
        mimeType,
      },
      details: {
        path: displayPath,
        ...(input.resolvedPath
          ? {
              scope: input.resolvedPath.scope,
              absolutePath: input.resolvedPath.absolutePath,
              relativePath: input.resolvedPath.relativePath,
              displayPath: input.resolvedPath.displayPath,
              fileId: res.fileId ?? undefined,
            }
          : {}),
        sourceType: input.sourceType,
        renderMode: "inline",
        mimeType,
        sizeBytes,
        mtimeMs: res.mtimeMs,
        contentHash: res.contentHash,
      },
    };
  }

  async function execImage(
    args: any,
    signal?: AbortSignal,
  ): Promise<ToolOk<DisplayImageResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const sources = await normalizeDisplayImageSources(args);
    const entries: DisplayImageEntry[] = [];
    for (const source of sources) {
      if (signal?.aborted) throw new Error("Cancelled");
      entries.push(await readDisplayImage(source));
    }

    const imageDetails = entries.map((entry) => entry.details);
    const firstImage = imageDetails[0];
    if (!firstImage) {
      throw new Error("Image requires at least one source");
    }
    const loadMode = imageDetails.every((image) => image.renderMode === "proxy")
      ? "proxy"
      : imageDetails.some((image) => image.renderMode === "proxy")
        ? "mixed"
        : "inline";
    const details: DisplayImageResultDetails = {
      kind: "display_image",
      images: imageDetails,
      loadMode,
      path: firstImage?.path,
      mimeType: firstImage?.mimeType,
      sizeBytes: firstImage?.sizeBytes,
      mtimeMs: firstImage?.mtimeMs,
      contentHash: firstImage?.contentHash,
    };
    const formatImagePath = (image: DisplayImageItemDetails) => image.displayPath || image.path;
    const textSummary =
      imageDetails.length === 1
        ? [
            `Display image: ${formatImagePath(firstImage)}`,
            `sourceType=${firstImage.sourceType ?? "unknown"}`,
            `renderMode=${firstImage.renderMode ?? "inline"}`,
            firstImage.mimeType ? `mime=${firstImage.mimeType}` : null,
            typeof firstImage.sizeBytes === "number" ? `sizeBytes=${firstImage.sizeBytes}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `Display images: ${imageDetails.length}`,
            ...imageDetails.map((image, index) =>
              [
                `${index + 1}. ${formatImagePath(image)}`,
                `sourceType=${image.sourceType ?? "unknown"}`,
                `renderMode=${image.renderMode ?? "inline"}`,
                image.mimeType ? `mime=${image.mimeType}` : null,
                typeof image.sizeBytes === "number" ? `sizeBytes=${image.sizeBytes}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            ),
          ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: textSummary,
        },
        ...entries.flatMap((entry) => (entry.content ? [entry.content] : [])),
      ],
      details,
    };
  }

  async function execWrite(args: any, signal?: AbortSignal): Promise<ToolOk<WriteResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const writeArgs = normalizeWriteArgs(args);
    const { resolved, path } = await resolveWriteTarget(writeArgs);
    if (!path) throw new Error("Write.path must identify a file");
    const content = writeArgs.content;

    const status = await readPathStatus("Write", resolved, path);
    if (status.exists && status.kind === "dir") {
      throw new Error(buildWriteDirectoryText(resolved));
    }
    // Overwriting an existing file needs a full-text snapshot as the staleness
    // baseline; auto-read it when the model has not Read the file itself.
    const primed = status.exists
      ? await primeFullTextSnapshot({ toolName: "Write", resolved, path, signal, status })
      : null;

    let res: WriteCommandResponse;
    try {
      res = await invokeFsToolCommand<WriteCommandResponse>({
        toolName: "Write",
        resolved,
        command: "fs_write_text",
        args: {
          workdir: resolved.root,
          path,
          content,
          mode: "rewrite",
          expected_mtime_ms: primed?.snapshot.mtimeMs,
          expected_content_hash: primed?.snapshot.contentHash,
        },
      });
    } catch (error) {
      if (primed?.autoRead) {
        // The auto-read snapshot was never shown to the model; drop it so a
        // follow-up Read returns real content instead of an "unchanged" stub.
        fileState.clear(statePathKey(resolved, status.fileId));
      }
      throw error;
    }

    const details: WriteResultDetails = {
      kind: "write",
      ...pathDetails(resolved, res.fileId),
      mode: "rewrite",
      existedBefore: Boolean(res.existedBefore),
      bytesWritten: res.bytesWritten,
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
      preview: previewSnippet(content),
    };
    fileState.recordTextMutation({
      ...statePathKey(resolved, res.fileId),
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
    });

    return {
      content: [
        {
          type: "text",
          text:
            (details.existedBefore
              ? `File updated successfully at: ${formatResolvedTarget(resolved)}`
              : `File created successfully at: ${formatResolvedTarget(resolved)}`) +
            (primed?.autoRead ? "\nautoRead=full" : ""),
        },
      ],
      details,
    };
  }

  async function execEdit(args: any, signal?: AbortSignal): Promise<ToolOk<EditResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const resolved = await pathResolver.resolvePath(args?.path, {
      label: "Edit.path",
      intent: "edit",
      required: true,
    });
    const path = backendPath(resolved);
    if (!path) throw new Error("Edit.path must identify a file");
    const old_string = typeof args?.old_string === "string" ? args.old_string : "";
    const new_string = typeof args?.new_string === "string" ? args.new_string : "";
    const expected_replacements =
      typeof args?.expected_replacements === "number" ? args.expected_replacements : undefined;
    const replace_all = args?.replace_all === true;

    if (!old_string) {
      throw new Error("Edit.old_string must be a non-empty string");
    }

    const primed = await primeFullTextSnapshot({
      toolName: "Edit",
      resolved,
      path,
      signal,
    });
    const { snapshot, autoRead } = primed;

    let res: EditCommandResponse;
    try {
      res = await invokeFsToolCommand<EditCommandResponse>({
        toolName: "Edit",
        resolved,
        command: "fs_edit_text",
        args: {
          workdir: resolved.root,
          path,
          old_string,
          new_string,
          expected_replacements,
          replace_all,
          expected_mtime_ms: snapshot.mtimeMs,
          expected_content_hash: snapshot.contentHash,
        },
      });
    } catch (error) {
      if (autoRead) {
        // The auto-read snapshot was never shown to the model; drop it so a
        // follow-up Read returns real content instead of an "unchanged" stub.
        fileState.clear(statePathKey(resolved, primed.status.fileId));
      }
      throw error;
    }

    const matchStrategy = parseEditMatchStrategy(res.matchStrategy);
    const details: EditResultDetails = {
      kind: "edit",
      ...pathDetails(resolved, res.fileId),
      replacements: res.replacements,
      replaceAll: res.replaceAll,
      matchStrategy,
      expectedReplacements: expected_replacements,
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
      oldPreview: previewSnippet(old_string),
      newPreview: previewSnippet(new_string),
    };
    fileState.recordTextMutation({
      ...statePathKey(resolved, res.fileId),
      mtimeMs: res.mtimeMs,
      contentHash: res.contentHash,
      totalLines: res.totalLines,
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Edit: ${formatResolvedTarget(resolved)}\n` +
            `replacements=${details.replacements}\n` +
            `replaceAll=${details.replaceAll}` +
            buildEditMatchStrategyNote(matchStrategy) +
            (autoRead ? "\nautoRead=full" : ""),
        },
      ],
      details,
    };
  }

  async function execDelete(args: any, signal?: AbortSignal): Promise<ToolOk<DeleteResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const resolved = await pathResolver.resolvePath(args?.path, {
      label: "Delete.path",
      intent: "delete",
      required: true,
    });
    const path = backendPath(resolved);
    if (!path) throw new Error("Delete.path must identify a file or directory");
    const res = await invokeFsToolCommand<DeleteCommandResponse>({
      toolName: "Delete",
      resolved,
      command: "fs_delete",
      args: {
        workdir: resolved.root,
        path,
      },
    });
    fileState.clear(statePathKey(resolved));

    return {
      content: [
        {
          type: "text",
          text: `Delete: ${formatResolvedTarget(resolved)}\nkind=${res.kind}`,
        },
      ],
      details: {
        kind: "delete",
        ...pathDetails(resolved),
        targetKind: res.kind,
      },
    };
  }

  async function execList(args: any, signal?: AbortSignal): Promise<ToolOk<ListResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const resolved = await pathResolver.resolvePath(args?.path, {
      label: "List.path",
      intent: "list",
      required: false,
    });
    const path = backendPath(resolved);
    const depth = typeof args?.depth === "number" ? args.depth : undefined;
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const max_results = typeof args?.max_results === "number" ? args.max_results : undefined;

    const res = await invokeFsToolCommand<ListCommandResponse>({
      toolName: "List",
      resolved,
      command: "fs_list",
      args: {
        workdir: resolved.root,
        path,
        depth,
        offset,
        max_results,
      },
    });

    const details: ListResultDetails = {
      kind: "list",
      ...pathDetails(resolved),
      targetKind: res.targetKind ?? undefined,
      depth: res.depth,
      offset: res.offset,
      maxResults: res.maxResults,
      total: res.total,
      hasMore: res.hasMore,
      entries: res.entries,
    };

    const lines = res.entries.map(
      (entry) => `${entry.kind === "dir" ? "[DIR]" : "[FILE]"} ${entry.path}`,
    );
    const suffix = res.hasMore ? "\n...more entries omitted...\n" : "";

    return {
      content: [
        {
          type: "text",
          text:
            `List: ${formatResolvedTarget(resolved)}\n` +
            (res.targetKind === "file" ? "note=path is a file; listed that single entry\n" : "") +
            `offset=${details.offset} total=${details.total}\n` +
            `${lines.join("\n")}${suffix}`,
        },
      ],
      details,
    };
  }

  async function execGlob(args: any, signal?: AbortSignal): Promise<ToolOk<GlobResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const pattern = typeof args?.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) throw new Error("Glob.pattern is required");

    const resolved = await pathResolver.resolvePath(args?.path, {
      label: "Glob.path",
      intent: "search",
      required: false,
    });
    const path = backendPath(resolved);
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const max_results = typeof args?.max_results === "number" ? args.max_results : undefined;
    const sort_by = typeof args?.sort_by === "string" ? args.sort_by : undefined;
    if (sort_by && sort_by !== "path") {
      throw new Error("Glob.sort_by only supports path");
    }

    const res = await invokeFsToolCommand<GlobCommandResponse>({
      toolName: "Glob",
      resolved,
      command: "fs_glob",
      args: {
        workdir: resolved.root,
        path,
        pattern,
        offset,
        max_results,
        sort_by,
      },
    });

    const details: GlobResultDetails = {
      kind: "glob",
      ...pathDetails(resolved),
      targetKind: res.targetKind ?? undefined,
      pattern: res.pattern,
      sortBy: res.sortBy,
      offset: res.offset,
      maxResults: res.maxResults,
      total: res.total,
      hasMore: res.hasMore,
      paths: res.paths,
    };
    const suffix = res.hasMore ? "\n...more matches omitted...\n" : "";

    return {
      content: [
        {
          type: "text",
          text:
            `Glob: ${pattern}\n` +
            `${formatResolvedTarget(resolved)} offset=${details.offset} total=${details.total}\n` +
            (res.targetKind === "file"
              ? "note=path is a file; searched its parent directory\n"
              : "") +
            `${res.paths.join("\n")}${suffix}`,
        },
      ],
      details,
    };
  }

  async function execGrep(args: any, signal?: AbortSignal): Promise<ToolOk<GrepResultDetails>> {
    if (signal?.aborted) throw new Error("Cancelled");

    const pattern = typeof args?.pattern === "string" ? args.pattern : "";
    if (!pattern.trim()) throw new Error("Grep.pattern is required");

    const resolved = await pathResolver.resolvePath(args?.path, {
      label: "Grep.path",
      intent: "search",
      required: false,
    });
    const path = backendPath(resolved);
    const file_pattern =
      typeof args?.file_pattern === "string" ? args.file_pattern.trim() : undefined;
    const ignore_case = typeof args?.ignore_case === "boolean" ? args.ignore_case : true;
    const output_mode =
      args?.output_mode === "files" || args?.output_mode === "count" ? args.output_mode : "content";
    const head_limit = typeof args?.head_limit === "number" ? args.head_limit : undefined;
    const offset = typeof args?.offset === "number" ? args.offset : undefined;
    const context = typeof args?.context === "number" ? args.context : undefined;
    const multiline = args?.multiline === true;

    const res = await invokeFsToolCommand<GrepCommandResponse>({
      toolName: "Grep",
      resolved,
      command: "fs_grep",
      args: {
        workdir: resolved.root,
        path,
        pattern,
        file_pattern,
        ignore_case,
        output_mode,
        head_limit,
        offset,
        context,
        multiline,
      },
    });

    const details: GrepResultDetails = {
      kind: "grep",
      ...pathDetails(resolved),
      targetKind: res.targetKind ?? undefined,
      pattern: res.pattern,
      filePattern: res.filePattern ?? undefined,
      ignoreCase: res.ignoreCase,
      outputMode: res.outputMode,
      headLimit: res.headLimit,
      offset: res.offset,
      context: res.context,
      multiline: res.multiline,
      matchCount: res.matchCount,
      fileCount: res.fileCount,
      hasMore: res.hasMore,
      matches: res.matches,
      files: res.files.map((file) => ({
        path: file.path,
        count: file.count,
        firstLine: typeof file.firstLine === "number" ? file.firstLine : undefined,
      })),
    };

    const body =
      res.outputMode === "count"
        ? `matches=${res.matchCount}\nfiles=${res.fileCount}`
        : res.outputMode === "files"
          ? res.files
              .map(
                (file) =>
                  `${file.path} (${file.count}${typeof file.firstLine === "number" ? `, firstLine=${file.firstLine}` : ""})`,
              )
              .join("\n")
          : res.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n");
    const suffix = res.hasMore ? "\n...more results omitted...\n" : "";

    return {
      content: [
        {
          type: "text",
          text:
            `Grep: ${pattern}\n` +
            `${formatResolvedTarget(resolved)}\n` +
            (res.targetKind === "file" ? "note=path is a file; searched that single file\n" : "") +
            `mode=${res.outputMode} matches=${res.matchCount} files=${res.fileCount}\n` +
            `${body}${suffix}`,
        },
      ],
      details,
    };
  }

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (!workdir.trim()) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Working directory is not configured; cannot run tools." }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      let result: ToolOk;
      const allowedArguments = allowedArgumentsByToolName[toolCall.name];
      if (allowedArguments) {
        assertKnownArguments(toolCall.name, toolCall.arguments, allowedArguments);
      }
      switch (toolCall.name) {
        case "Read":
          result = await execRead(toolCall.arguments, signal);
          break;
        case "Image":
          result = await execImage(toolCall.arguments, signal);
          break;
        case "Write":
          result = await execWrite(toolCall.arguments, signal);
          break;
        case "Edit":
          result = await execEdit(toolCall.arguments, signal);
          break;
        case "Delete":
          result = await execDelete(toolCall.arguments, signal);
          break;
        case "List":
          result = await execList(toolCall.arguments, signal);
          break;
        case "Glob":
          result = await execGlob(toolCall.arguments, signal);
          break;
        case "Grep":
          result = await execGrep(toolCall.arguments, signal);
          break;
        default:
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
            details: {},
            isError: true,
            timestamp: now,
          };
      }

      noteToolCallSucceeded();
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: annotateRepeatedFailure(toolCall, asErrorMessage(err)) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "fs",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "Read",
        {
          groupId: "fs",
          kind: "read",
          isReadOnly: true,
          displayCategory: "file",
        },
      ],
      [
        "Image",
        {
          groupId: "fs",
          kind: "display_image",
          isReadOnly: true,
          displayCategory: "file",
        },
      ],
      [
        "Write",
        {
          groupId: "fs",
          kind: "write",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        "Edit",
        {
          groupId: "fs",
          kind: "edit",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        "Delete",
        {
          groupId: "fs",
          kind: "delete",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
      [
        "List",
        {
          groupId: "fs",
          kind: "list",
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
      [
        "Glob",
        {
          groupId: "fs",
          kind: "glob",
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
      [
        "Grep",
        {
          groupId: "fs",
          kind: "grep",
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
    ]),
  };
}
