// Path checks for page requests such as host.openFile: a page may only name files inside
// the session workdir, given relative to it or as an absolute path within it.

function isWindowsStyle(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function splitSegments(path: string) {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * Resolves `requested` against `workdir` and returns the absolute path when it stays
 * inside the workdir, else null. `..` segments are applied lexically; control
 * characters, empty input and paths on another drive are rejected.
 */
export function resolvePathInsideWorkdir(workdir: string, requested: string): string | null {
  const root = workdir.trim();
  if (!root || typeof requested !== "string") return null;
  const path = requested.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (!path || path.length > 4096 || /[\u0000-\u001f]/.test(path)) return null;
  const windows = isWindowsStyle(root);
  const separator = windows ? "\\" : "/";
  const rootSegments = splitSegments(root);
  const rootPrefix = windows ? "" : "/";
  if (!windows && !root.startsWith("/")) return null;

  const requestIsAbsolute = windows
    ? isWindowsStyle(path) || /^[\\/]/.test(path)
    : path.startsWith("/");
  if (windows && /^[\\/]/.test(path) && !path.startsWith("\\\\")) return null;
  if (!windows && /^[A-Za-z]:[\\/]/.test(path)) return null;
  const base = requestIsAbsolute ? [] : [...rootSegments];
  for (const segment of splitSegments(path)) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  if (base.length < rootSegments.length) return null;
  const same = (left: string, right: string) =>
    windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (!same(base[index] ?? "", rootSegments[index] ?? "")) return null;
  }
  const uncPrefix = windows && root.startsWith("\\\\") ? "\\\\" : "";
  return `${uncPrefix}${rootPrefix}${base.join(separator)}`;
}
