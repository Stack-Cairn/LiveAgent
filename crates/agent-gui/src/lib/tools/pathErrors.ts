import type { FsBackendError } from "./fsBackend";
import { formatResolvedTarget, type ResolvedPath } from "./pathUtils";

function displayCandidate(resolved: ResolvedPath, candidate: string) {
  return resolved.scope === "skill" ? `skill://${candidate}` : candidate;
}

function rootNote(resolved: ResolvedPath) {
  return resolved.scope === "workspace" ? ` (workspace root: ${resolved.root})` : "";
}

function childDisplayPath(target: string, fileName: string) {
  return target === "." || target === "" ? fileName : `${target}/${fileName}`;
}

export function buildRequiresFullReadText(
  toolName: string,
  resolved: ResolvedPath,
  totalLines?: number,
) {
  const target = formatResolvedTarget(resolved);
  const lineNote = typeof totalLines === "number" && totalLines > 0 ? ` (${totalLines} lines)` : "";
  const limitNote =
    typeof totalLines === "number" && totalLines > 200 ? ` and limit=${totalLines}` : "";
  return `${toolName} requires a full-file Read first for existing files: ${target}${lineNote}. Call Read with path="${target}"${limitNote}, then retry ${toolName} with the same path.`;
}

export function buildStaleFileText(toolName: string, resolved: ResolvedPath) {
  const target = formatResolvedTarget(resolved);
  return `${target} changed on disk after your last Read. Read it again with the same path, re-derive your change from the fresh content, then retry ${toolName}.`;
}

export function buildWriteDirectoryText(resolved: ResolvedPath) {
  const target = formatResolvedTarget(resolved);
  return `Write.path points to a directory, not a file: ${target}. Directories are created implicitly — there is no separate create-directory step. To create or populate ${target}, Write a file inside it with the filename appended, for example path="${childDisplayPath(target, "notes.md")}"; missing parent directories are created automatically.`;
}

export function buildFsErrorText(
  toolName: string,
  resolved: ResolvedPath,
  error: FsBackendError,
): string {
  const target = formatResolvedTarget(resolved);
  switch (error.code) {
    case "not_found": {
      const lead = `${toolName} failed: ${target} does not exist${rootNote(resolved)}.`;
      if (error.didYouMean.length > 0) {
        const candidates = error.didYouMean
          .map((candidate) => displayCandidate(resolved, candidate))
          .join(", ");
        return `${lead} Did you mean: ${candidates}? Retry with one of these exact paths.`;
      }
      const fileName = target.split("/").filter(Boolean).at(-1) ?? target;
      return `${lead} Locate it with Glob pattern="**/${fileName}" or List the parent directory, then retry with the returned path.`;
    }
    case "out_of_bounds":
      return `${toolName}.path resolves outside the allowed root: ${resolved.absolutePath}. Write, Edit, and Delete only operate inside the workspace root (${resolved.root}) or an enabled skill:// path. Use a path returned by a previous tool.`;
    case "not_a_file":
      if (toolName === "Write") return buildWriteDirectoryText(resolved);
      return `${toolName}.path points to a directory, not a file: ${target}. Use List with this path to inspect its contents instead.`;
    case "not_a_directory":
      return `${toolName}.path must be a directory but ${target} is not one. Retry with the parent directory as path.`;
    case "requires_full_read":
      return buildRequiresFullReadText(toolName, resolved);
    case "stale_file":
      return buildStaleFileText(toolName, resolved);
    case "edit_no_match":
      return `Edit found no occurrence of old_string in ${target}, even after line-ending, trailing-whitespace, and uniform-indentation tolerant matching. The content likely differs from what you expect: Read the exact region again and copy old_string verbatim from the fresh output, or locate the text with Grep first.`;
    case "edit_ambiguous":
      return `Edit failed for ${target}: ${error.message}. Extend old_string with surrounding lines until it is unique, or set replace_all=true deliberately.`;
    case "edit_count_mismatch":
      return `Edit failed for ${target}: ${error.message}. Set expected_replacements to the actual match count, or refine old_string.`;
    case "too_large":
      return `${toolName} failed for ${target}: ${error.message}. Read supports pagination: retry with start_line and limit (text), page_start (PDF), or cell_start (notebook) to read a smaller window.`;
    case "not_utf8":
      return `${toolName} failed for ${target}: ${error.message}. This file is not UTF-8 text; Read previews binary document formats, and Image displays images.`;
    default:
      return `${toolName} failed for ${target}: ${error.message}`;
  }
}
