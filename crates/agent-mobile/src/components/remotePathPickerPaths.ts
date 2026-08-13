// Pure path helpers for RemotePathPickerModal. The picker browses the paired
// desktop's file system, so every helper must accept both POSIX ("/a/b") and
// Windows ("C:\\a", "C:/a", "\\\\server\\share") shapes regardless of the
// browser's own platform.

export type RemoteFsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

export type RemoteChildEntry = {
  path: string;
  name: string;
  kind: "dir" | "file";
};

export function stripTrailingPathSeparators(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

export function normalizePathForCompare(path: string) {
  const normalized = stripTrailingPathSeparators(path).replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isSameOrDescendantPath(path: string, ancestor: string) {
  const current = normalizePathForCompare(path);
  const parent = normalizePathForCompare(ancestor);
  if (!current || !parent) return false;
  if (current === parent) return true;
  if (parent === "/") return current.startsWith("/");
  if (/^[a-z]:\/?$/.test(parent)) {
    return current.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
  }
  return current.startsWith(`${parent}/`);
}

export function findBestRootForPath(path: string, roots: RemoteFsRoot[]) {
  return (
    roots
      .filter((root) => root.path && isSameOrDescendantPath(path, root.path))
      .sort(
        (left, right) =>
          normalizePathForCompare(right.path).length - normalizePathForCompare(left.path).length,
      )[0] ?? null
  );
}

export function findRouteChild(targetPath: string, entries: RemoteChildEntry[]) {
  return (
    entries
      .filter((entry) => entry.path && isSameOrDescendantPath(targetPath, entry.path))
      .sort(
        (left, right) =>
          normalizePathForCompare(right.path).length - normalizePathForCompare(left.path).length,
      )[0] ?? null
  );
}

export function basenameFromPath(path: string) {
  const normalized = stripTrailingPathSeparators(path);
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function joinChildPath(parent: string, relative: string) {
  const base = stripTrailingPathSeparators(parent);
  const child = relative.replace(/^[\\/]+/, "");
  if (!base) return child;
  if (base === "/") return `/${child}`;
  // Drive roots survive stripTrailingPathSeparators with their separator
  // attached ("C:\\" / "C:/") or bare ("C:"); join without doubling it.
  const driveRoot = /^([A-Za-z]:)[\\/]?$/.exec(base);
  if (driveRoot) {
    return `${driveRoot[1]}${base.includes("\\") ? "\\" : "/"}${child}`;
  }
  return `${base}${base.includes("\\") ? "\\" : "/"}${child}`;
}
