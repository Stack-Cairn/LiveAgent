import type { Tool } from "@earendil-works/pi-ai";

import {
  AGENT_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  type SubagentSpec,
  type SubagentWorktreeStatus,
  type ToolMetadataLike,
  type WorktreeApplyDecision,
  type WorktreeCleanupDecision,
} from "./types";

// Cleans paths coming out of git status/porcelain output. Malformed entries
// are dropped, not surfaced — git plumbing noise is not a tool-input error.
function normalizeGitStatusPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.startsWith("/") ||
    normalized === "." ||
    normalized === ".."
  ) {
    return "";
  }

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || segment.includes(":")) return "";
    segments.push(segment);
  }
  return segments.join("/");
}

function globAllowedOutputPathToRegExp(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1] ?? "";
    if (char === "*" && next === "*") {
      const after = pattern[index + 2] ?? "";
      if (after === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function pathMatchesAllowedOutput(path: string, allowedPath: string) {
  if (!allowedPath || allowedPath === ".") return true;
  if (allowedPath.includes("*") || allowedPath.includes("?") || allowedPath.includes("[")) {
    return globAllowedOutputPathToRegExp(allowedPath).test(path);
  }
  return path === allowedPath || path.startsWith(`${allowedPath}/`);
}

function decodeGitQuotedPath(value: string) {
  const text = value.trim();
  if (!(text.startsWith('"') && text.endsWith('"'))) return text;
  const body = text.slice(1, -1);
  const decoder = new TextDecoder();
  let output = "";
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    output += decoder.decode(new Uint8Array(bytes));
    bytes = [];
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      flushBytes();
      output += char;
      continue;
    }

    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }

    flushBytes();
    const escaped = body[index + 1] ?? "";
    const replacements: Record<string, string> = {
      "\\": "\\",
      '"': '"',
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
    };
    output += replacements[escaped] ?? escaped;
    index += escaped ? 1 : 0;
  }
  flushBytes();
  return output;
}

function parseWorktreeStatusPath(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("?? ")) {
    return normalizeGitStatusPath(decodeGitQuotedPath(trimmed.slice(3)));
  }
  const body = line.length > 3 ? line.slice(3).trim() : trimmed.slice(2).trim();
  const renamedPath = body.includes(" -> ") ? (body.split(" -> ").pop() ?? body) : body;
  return normalizeGitStatusPath(decodeGitQuotedPath(renamedPath));
}

function removeParentDirectoryPaths(paths: string[]) {
  return paths.filter((path) => {
    const prefix = `${path}/`;
    return !paths.some((candidate) => candidate !== path && candidate.startsWith(prefix));
  });
}

function shouldIgnoreChangedPath(path: string) {
  const basename = path.split("/").pop() ?? "";
  return basename === ".DS_Store" || basename === "Thumbs.db" || basename === "Desktop.ini";
}

export function collectWorktreeChangedPaths(status: SubagentWorktreeStatus) {
  const paths = new Set<string>();
  for (const file of status.untrackedFiles ?? []) {
    const normalized = normalizeGitStatusPath(decodeGitQuotedPath(file));
    if (normalized && !shouldIgnoreChangedPath(normalized)) paths.add(normalized);
  }
  for (const line of (status.status || "").split(/\r?\n/g)) {
    const normalized = parseWorktreeStatusPath(line);
    if (normalized && !shouldIgnoreChangedPath(normalized)) paths.add(normalized);
  }
  return removeParentDirectoryPaths([...paths].sort());
}

/**
 * Decide whether worktree changes merge back into the parent workspace.
 * Purely policy-driven: "none" never applies, "explicit" applies only when
 * every changed path matches allowed_output_paths, "auto" always applies.
 */
export function decideWorktreeApply(params: {
  spec: SubagentSpec;
  status: SubagentWorktreeStatus;
}): WorktreeApplyDecision {
  const changedPaths = collectWorktreeChangedPaths(params.status);

  if (!params.status.changed || changedPaths.length === 0) {
    return {
      shouldApply: false,
      skippedReason: params.status.changed ? "no_applyable_changes" : "no_changes",
      changedPaths,
      candidateArtifacts: [],
    };
  }

  if (params.spec.applyPolicy === "none") {
    return {
      shouldApply: false,
      skippedReason: "apply_policy_none",
      changedPaths,
      candidateArtifacts: changedPaths,
    };
  }

  if (params.spec.applyPolicy === "explicit") {
    const disallowedPaths = changedPaths.filter(
      (path) =>
        !params.spec.allowedOutputPaths.some((allowedPath) =>
          pathMatchesAllowedOutput(path, allowedPath),
        ),
    );
    if (disallowedPaths.length > 0) {
      return {
        shouldApply: false,
        skippedReason: "explicit_apply_paths_mismatch",
        changedPaths,
        candidateArtifacts: disallowedPaths,
      };
    }
  }

  return {
    shouldApply: true,
    changedPaths,
    candidateArtifacts: [],
  };
}

export function decideWorktreeCleanup(params: {
  spec: SubagentSpec;
  status?: SubagentWorktreeStatus;
  statusError?: string;
  applyStatus?: "applied" | "skipped" | "failed";
  applySkippedReason?: string;
}): WorktreeCleanupDecision {
  if (params.spec.retainWorktree) {
    return { shouldCleanup: false, reason: "retain_worktree" };
  }
  if (params.statusError) {
    return { shouldCleanup: false, reason: "status_unavailable" };
  }
  if (params.applyStatus === "failed") {
    return { shouldCleanup: false, reason: "apply_failed" };
  }
  if (params.applyStatus === "applied") {
    return { shouldCleanup: true, reason: "applied" };
  }
  if (params.applySkippedReason === "already_applied") {
    return { shouldCleanup: true, reason: "already_applied" };
  }
  if (params.status && !params.status.changed) {
    return { shouldCleanup: true, reason: "no_changes" };
  }
  if (params.applySkippedReason === "no_changes") {
    return { shouldCleanup: true, reason: "no_changes" };
  }
  return { shouldCleanup: false, reason: "unapplied_changes" };
}

/** Readonly children: read-only builtin tools + MCP business tools. */
export function selectReadOnlyTools(params: {
  tools: Tool[];
  metadataByName: Map<string, ToolMetadataLike>;
}) {
  return params.tools.filter((tool) => {
    if (tool.name === AGENT_TOOL_NAME) return false;
    if (tool.name === SEND_MESSAGE_TOOL_NAME) return true;
    const metadata = params.metadataByName.get(tool.name);
    return (
      metadata?.isReadOnly === true || (metadata?.groupId === "mcp" && metadata.kind === "mcp")
    );
  });
}

/** Worktree children: fs + shell + read-only memory + MCP business tools. */
export function selectWorktreeTools(params: {
  tools: Tool[];
  metadataByName: Map<string, ToolMetadataLike>;
}) {
  return params.tools.filter((tool) => {
    if (tool.name === AGENT_TOOL_NAME) return false;
    if (tool.name === SEND_MESSAGE_TOOL_NAME) return true;
    const metadata = params.metadataByName.get(tool.name);
    return (
      metadata?.groupId === "fs" ||
      metadata?.groupId === "shell" ||
      (metadata?.groupId === "memory" && metadata.isReadOnly === true) ||
      (metadata?.groupId === "mcp" && metadata.kind === "mcp")
    );
  });
}
