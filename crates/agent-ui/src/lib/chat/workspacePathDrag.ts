import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";

export const WORKSPACE_PATH_DRAG_MIME = "application/x-liveagent-workspace-path+json";
export const WORKSPACE_PATH_NATIVE_DROP_EVENT = "liveagent:workspace-path-native-drop";

export type WorkspacePathDragPayload = {
  kind: "workspacePath";
  projectPathKey: string;
  cwd: string;
  relativePath: string;
  entryKind: "file" | "dir";
  label: string;
};

let activeWorkspacePathDrag: WorkspacePathDragPayload | null = null;
let activeWorkspacePathDragClearTimer: ReturnType<typeof setTimeout> | null = null;

type WorkspacePathDropDocument = {
  elementFromPoint: (x: number, y: number) => EventTarget | null;
};

type WorkspacePathDropEventFactory = (type: string, payload: WorkspacePathDragPayload) => Event;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeRelativePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (hasControlCharacters(value)) return null;
  return value;
}

export function createWorkspacePathDragPayload(
  input: Partial<WorkspacePathDragPayload>,
): WorkspacePathDragPayload | null {
  const projectPathKey = workspaceProjectPathKey(input.projectPathKey);
  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  const cwdProjectPathKey = workspaceProjectPathKey(cwd);
  const relativePath = normalizeRelativePath(input.relativePath);
  const entryKind = input.entryKind === "dir" ? "dir" : input.entryKind === "file" ? "file" : null;
  if (
    !projectPathKey ||
    !cwd ||
    hasControlCharacters(cwd) ||
    cwdProjectPathKey !== projectPathKey ||
    !relativePath ||
    !entryKind
  ) {
    return null;
  }
  return {
    kind: "workspacePath",
    projectPathKey,
    cwd,
    relativePath,
    entryKind,
    label:
      typeof input.label === "string" && input.label.trim()
        ? input.label.trim()
        : relativePath.split("/").at(-1) || relativePath,
  };
}

export function writeWorkspacePathDragPayload(
  dataTransfer: DataTransfer,
  input: Partial<WorkspacePathDragPayload>,
): boolean {
  const payload = createWorkspacePathDragPayload(input);
  if (!payload) return false;
  if (activeWorkspacePathDragClearTimer !== null) {
    clearTimeout(activeWorkspacePathDragClearTimer);
    activeWorkspacePathDragClearTimer = null;
  }
  activeWorkspacePathDrag = payload;
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(WORKSPACE_PATH_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.setData("text/plain", payload.relativePath);
  return true;
}

export function clearActiveWorkspacePathDrag(): void {
  if (activeWorkspacePathDragClearTimer !== null) {
    clearTimeout(activeWorkspacePathDragClearTimer);
    activeWorkspacePathDragClearTimer = null;
  }
  activeWorkspacePathDrag = null;
}

/**
 * WKWebView can deliver the DOM dragend just before Tauri's native drop
 * callback. Keep the in-app payload alive for that short handoff window;
 * successful DOM/native drops still clear it synchronously.
 */
export function finishWorkspacePathDrag(): void {
  if (!activeWorkspacePathDrag) return;
  if (activeWorkspacePathDragClearTimer !== null) {
    clearTimeout(activeWorkspacePathDragClearTimer);
  }
  activeWorkspacePathDragClearTimer = setTimeout(clearActiveWorkspacePathDrag, 1_000);
}

export function getActiveWorkspacePathDrag(): WorkspacePathDragPayload | null {
  return activeWorkspacePathDrag;
}

/**
 * Tauri's native webview drag bridge also reports in-app HTML drags, but with
 * an empty `paths` array and without a DOM `drop`. Re-dispatch the active,
 * already-validated payload at the native release point so the real composer
 * or terminal drop target can commit it synchronously.
 */
export function dispatchActiveWorkspacePathDrop(
  position: { x: number; y: number },
  options?: {
    document?: WorkspacePathDropDocument;
    createEvent?: WorkspacePathDropEventFactory;
  },
): boolean {
  const payload = activeWorkspacePathDrag;
  if (!payload) return false;
  const targetDocument = options?.document ?? document;
  const target = targetDocument.elementFromPoint(position.x, position.y);
  try {
    if (!target) return false;
    const event = options?.createEvent
      ? options.createEvent(WORKSPACE_PATH_NATIVE_DROP_EVENT, payload)
      : new CustomEvent(WORKSPACE_PATH_NATIVE_DROP_EVENT, {
          bubbles: true,
          cancelable: true,
          detail: payload,
        });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  } finally {
    clearActiveWorkspacePathDrag();
  }
}

export function readNativeWorkspacePathDrop(event: Event): WorkspacePathDragPayload | null {
  if (event.type !== WORKSPACE_PATH_NATIVE_DROP_EVENT) return null;
  return createWorkspacePathDragPayload(
    (event as CustomEvent<unknown>).detail as Partial<WorkspacePathDragPayload>,
  );
}

export function hasWorkspacePathDragPayload(dataTransfer: DataTransfer): boolean {
  return (
    activeWorkspacePathDrag !== null ||
    Array.from(dataTransfer.types).includes(WORKSPACE_PATH_DRAG_MIME)
  );
}

export function readWorkspacePathDragPayload(
  dataTransfer: DataTransfer,
): WorkspacePathDragPayload | null {
  const raw = dataTransfer.getData(WORKSPACE_PATH_DRAG_MIME);
  if (!raw) return activeWorkspacePathDrag;
  try {
    return createWorkspacePathDragPayload(JSON.parse(raw) as Partial<WorkspacePathDragPayload>);
  } catch {
    return null;
  }
}

export function workspacePathDragMatchesProject(
  payload: WorkspacePathDragPayload,
  workdir: string,
): boolean {
  return payload.projectPathKey === workspaceProjectPathKey(workdir);
}

export function absoluteWorkspacePath(payload: WorkspacePathDragPayload): string | null {
  const relativePath = normalizeRelativePath(payload.relativePath);
  const cwd = payload.cwd.trim();
  if (!relativePath || !cwd) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const root = cwd.replace(/[\\/]+$/, "");
  return windows
    ? `${root}\\${relativePath.replace(/\//g, "\\")}`
    : `${root || "/"}/${relativePath}`;
}

export type WorkspacePathShellKind = "cmd" | "posix" | "powershell";

export function workspacePathShellKind(shell: string): WorkspacePathShellKind {
  const value = shell.trim().toLowerCase().replace(/\\/g, "/");
  const executable = value.split("/").at(-1) || value;
  if (executable === "cmd" || executable === "cmd.exe") return "cmd";
  if (
    executable === "powershell" ||
    executable === "powershell.exe" ||
    executable === "pwsh" ||
    executable === "pwsh.exe"
  ) {
    return "powershell";
  }
  return "posix";
}

export function quoteWorkspacePathForShell(path: string, shell: string): string | null {
  if (!path || hasControlCharacters(path)) return null;
  switch (workspacePathShellKind(shell)) {
    case "powershell":
      return `'${path.replace(/'/g, "''")}'`;
    case "cmd":
      // Percent and delayed-expansion markers are context-sensitive in cmd.
      // Refuse them rather than inserting a path that can expand to another command.
      if (/[%!"]/.test(path)) return null;
      return `"${path}"`;
    case "posix":
      return `'${path.replace(/'/g, `'\\''`)}'`;
  }
}
