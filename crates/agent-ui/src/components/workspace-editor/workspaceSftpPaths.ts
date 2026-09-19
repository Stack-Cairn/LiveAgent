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
