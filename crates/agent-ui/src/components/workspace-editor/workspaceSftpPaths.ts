import type { SftpSide } from "@liveagent/ui/lib/sftp/types";

export function parentPath(path: string, side: SftpSide) {
  const normalized = normalizePath(path, side);
  if (!normalized || normalized === "." || normalized === "/") return side === "remote" ? "." : "";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  if (side === "remote" && normalized.startsWith("/")) {
    return parts.length ? `/${parts.join("/")}` : "/";
  }
  return parts.join("/") || (side === "remote" ? "." : "");
}

export function normalizePath(path: string, side: SftpSide) {
  const normalized = path.trim().replace(/\\/g, "/");
  if (side === "remote") {
    if (!normalized || normalized === ".") return ".";
    return normalized.replace(/\/+/g, "/");
  }
  return normalized.replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function joinPath(parent: string, child: string, side: SftpSide) {
  const name = child
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!name) return normalizePath(parent, side);
  const base = normalizePath(parent, side);
  if (side === "remote") {
    if (base === "/") return `/${name}`;
    if (!base || base === ".") return name;
  }
  if (!base) return name;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function isAbsoluteLocalPath(path: string) {
  const value = path.trim();
  return (
    value.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\/.test(value) ||
    /^\/\/[^/\\]+[\\/][^/\\]+/.test(value)
  );
}

function localPathSeparator(root: string) {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

function localAbsolutePathForCopy(workdir: string, path: string) {
  const rawPath = path.trim();
  if (isAbsoluteLocalPath(rawPath)) return rawPath;

  const base = workdir.trim();
  const relativePath = normalizePath(rawPath, "local");
  if (!relativePath || relativePath === ".") return base;

  const separator = localPathSeparator(base);
  const normalizedRelativePath = relativePath.replace(/\//g, separator);
  const trimmedBase = base.replace(/[\\/]+$/, "");
  if (!trimmedBase) return `${separator}${normalizedRelativePath}`;

  return `${trimmedBase}${separator}${normalizedRelativePath}`;
}

function remoteAbsolutePathForCopy(path: string) {
  const normalized = normalizePath(path, "remote");
  if (!normalized || normalized === ".") return "/";
  if (normalized.startsWith("/")) return normalized;
  return `/${normalized.replace(/^\/+/, "")}`;
}

/** The absolute path copied for an entry: local paths resolve against the workdir. */
export function absolutePathForCopy(side: SftpSide, path: string, workdir: string) {
  return side === "local"
    ? localAbsolutePathForCopy(workdir, path)
    : remoteAbsolutePathForCopy(path);
}
