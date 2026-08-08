// Global markdown notes live under ~/.liveagent/notes (same app storage root
// as skills/). Ensure the directory exists by probing/creating via the shared
// fs_* surface so desktop and gateway WebUI stay on one code path.
//
// MIRROR NOTICE: keep byte-identical with crates/agent-gateway/web/src.

import { invokeFs } from "../tools/fsBackend";

const APP_DIR_NAME = ".liveagent";
const NOTES_DIR_NAME = "notes";

type FsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

type FsRootsResponse = {
  roots: FsRoot[];
};

function joinFsPath(base: string, ...parts: string[]): string {
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const isWindows = /^[A-Za-z]:[\\/]/.test(trimmedBase) || trimmedBase.startsWith("\\\\");
  const sep = isWindows ? "\\" : "/";
  let out = trimmedBase;
  for (const part of parts) {
    const clean = part.replace(/^[\\/]+|[\\/]+$/g, "");
    if (!clean) continue;
    out = `${out}${sep}${clean}`;
  }
  return out;
}

async function findHomePath(): Promise<string> {
  const response = await invokeFs<FsRootsResponse>("fs_roots", {});
  const home =
    response.roots.find((root) => root.kind === "home") ??
    response.roots.find((root) => root.id === "home");
  return home?.path?.trim() ?? "";
}

async function directoryExists(absolutePath: string): Promise<boolean> {
  try {
    await invokeFs("fs_list", {
      workdir: absolutePath,
      path: null,
      depth: 1,
      offset: 0,
      max_results: 1,
      show_hidden: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureChildDirectory(parentAbsolute: string, childName: string): Promise<string> {
  const absolute = joinFsPath(parentAbsolute, childName);
  if (await directoryExists(absolute)) {
    return absolute;
  }
  try {
    await invokeFs("fs_create_dir", {
      workdir: parentAbsolute,
      path: childName,
    });
  } catch {
    // Race: another client may have created it between the probe and create.
  }
  if (!(await directoryExists(absolute))) {
    throw new Error(`Failed to create notes directory: ${absolute}`);
  }
  return absolute;
}

/** Ensure `~/.liveagent/notes` exists and return its absolute path. */
export async function ensureNotesRoot(): Promise<string> {
  const home = await findHomePath();
  if (!home) {
    throw new Error("Unable to resolve the user home directory for notes storage.");
  }
  const appDir = await ensureChildDirectory(home, APP_DIR_NAME);
  return ensureChildDirectory(appDir, NOTES_DIR_NAME);
}

export function isNotesEditablePath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith(".md") ||
    normalized.endsWith(".mdx") ||
    normalized.endsWith(".txt") ||
    normalized.endsWith(".markdown")
  );
}

export function defaultNewNoteName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `note-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
}
