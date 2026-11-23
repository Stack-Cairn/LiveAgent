/**
 * `path` relative to the workspace `workdir` when it lies inside it; otherwise `path`
 * unchanged. Compares by path segments, so `/ws-other/x` is not inside `/ws`.
 */
export function workspaceRelativePath(path: string, workdir: string | undefined) {
  const root = workdir?.trim().replace(/[\\/]+$/, "");
  if (!root || !path) return path;
  const separator = path.charAt(root.length);
  if (path.startsWith(root) && (separator === "/" || separator === "\\")) {
    const relative = path.slice(root.length + 1);
    return relative || path;
  }
  return path;
}
