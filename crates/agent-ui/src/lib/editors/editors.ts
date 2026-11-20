// "Open in editor": installed code editors (detected by the desktop host) and
// the device-local preferred editor.
//
// Desktop only. The backend commands (`editor_list`, `editor_open_path`) exist
// only behind the Tauri bridge; on other hosts the list stays empty and every
// "Open in" entry point hides itself.

import { invoke } from "@liveagent/app/shims/tauriCore";
import { useEffect, useSyncExternalStore } from "react";

export type EditorInfo = {
  id: string;
  name: string;
};

export type OpenInEditorRequest = {
  editorId: string;
  /** Absolute workspace root the path is relative to. */
  workdir: string;
  /** Path relative to `workdir`; empty for the workspace root itself. */
  path: string;
  line?: number;
  column?: number;
};

type EditorsSnapshot = {
  /** Detection finished (successfully or not). */
  loaded: boolean;
  editors: readonly EditorInfo[];
};

// Device preference: kept in localStorage, never synced with settings that
// travel to other devices (another machine has different editors installed).
export const PREFERRED_EDITOR_STORAGE_KEY = "liveagent.preferredEditor.v1";

const EMPTY_EDITORS: readonly EditorInfo[] = Object.freeze([]);
const listeners = new Set<() => void>();
let snapshot: EditorsSnapshot = { loaded: false, editors: EMPTY_EDITORS };
let preferredEditorId: string | null | undefined;
let request: Promise<readonly EditorInfo[]> | undefined;

function hasDesktopBridge() {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

function emit() {
  for (const listener of listeners) listener();
}

function normalizeEditors(input: unknown): readonly EditorInfo[] {
  if (!Array.isArray(input)) return EMPTY_EDITORS;
  const seen = new Set<string>();
  const editors: EditorInfo[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") continue;
    if (!id.trim() || !name.trim() || seen.has(id)) continue;
    seen.add(id);
    editors.push({ id, name });
  }
  return editors.length > 0 ? editors : EMPTY_EDITORS;
}

/**
 * Loads the detected editors once per session (the backend caches detection
 * too). `refresh` re-runs detection, e.g. after installing an editor.
 */
export function loadDetectedEditors(options?: { refresh?: boolean }) {
  if (!hasDesktopBridge()) {
    if (!snapshot.loaded) {
      snapshot = { loaded: true, editors: EMPTY_EDITORS };
      emit();
    }
    return Promise.resolve(EMPTY_EDITORS);
  }
  if (request && !options?.refresh) return request;
  const current = invoke<unknown>("editor_list", { refresh: options?.refresh === true })
    .then(normalizeEditors)
    .catch(() => EMPTY_EDITORS)
    .then((editors) => {
      if (request === current) {
        snapshot = { loaded: true, editors };
        emit();
      }
      return editors;
    });
  request = current;
  return current;
}

export function getDetectedEditorsSnapshot(): EditorsSnapshot {
  return snapshot;
}

export function subscribeEditors(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readPreferredEditorId(): string | null {
  if (preferredEditorId !== undefined) return preferredEditorId;
  try {
    const raw = globalThis.localStorage?.getItem(PREFERRED_EDITOR_STORAGE_KEY);
    preferredEditorId = raw?.trim() ? raw.trim() : null;
  } catch {
    preferredEditorId = null;
  }
  return preferredEditorId;
}

/** `null` clears the choice and falls back to the first detected editor. */
export function writePreferredEditorId(editorId: string | null) {
  const next = editorId?.trim() ? editorId.trim() : null;
  preferredEditorId = next;
  try {
    if (next) globalThis.localStorage?.setItem(PREFERRED_EDITOR_STORAGE_KEY, next);
    else globalThis.localStorage?.removeItem(PREFERRED_EDITOR_STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice holds for this run only.
  }
  emit();
}

/**
 * The editor "Open in" targets by default: the stored preference when that
 * editor is still installed, otherwise the first detected editor.
 */
export function resolvePreferredEditor(
  editors: readonly EditorInfo[],
  preferredId: string | null | undefined,
): EditorInfo | null {
  if (editors.length === 0) return null;
  return editors.find((editor) => editor.id === preferredId) ?? editors[0] ?? null;
}

/** Editors other than `editor`, in detection order. */
export function otherEditors(
  editors: readonly EditorInfo[],
  editor: EditorInfo | null,
): readonly EditorInfo[] {
  return editor ? editors.filter((candidate) => candidate.id !== editor.id) : editors;
}

export function openInEditorLabel(template: string, editorName: string) {
  return template.replace("{name}", editorName);
}

export function openPathInEditor(request: OpenInEditorRequest) {
  return invoke("editor_open_path", {
    editor_id: request.editorId,
    workdir: request.workdir,
    path: request.path,
    line: request.line,
    column: request.column,
  });
}

type PreferredEditorState = {
  loaded: boolean;
  editors: readonly EditorInfo[];
  /** Stored preference (may name an editor that is no longer installed). */
  preferredId: string | null;
  /** Effective default target; null when no editor is detected. */
  preferred: EditorInfo | null;
};

let lastState: PreferredEditorState | undefined;

function readState(): PreferredEditorState {
  const { loaded, editors } = snapshot;
  const preferredId = readPreferredEditorId();
  if (
    lastState &&
    lastState.loaded === loaded &&
    lastState.editors === editors &&
    lastState.preferredId === preferredId
  ) {
    return lastState;
  }
  lastState = {
    loaded,
    editors,
    preferredId,
    preferred: resolvePreferredEditor(editors, preferredId),
  };
  return lastState;
}

/** Detected editors plus the effective preferred one; loads lazily on mount. */
export function useEditors(): PreferredEditorState {
  const state = useSyncExternalStore(subscribeEditors, readState, readState);
  useEffect(() => {
    void loadDetectedEditors();
  }, []);
  return state;
}

/** Test hook: forget the cached detection and preference. */
export function resetEditorsForTests() {
  snapshot = { loaded: false, editors: EMPTY_EDITORS };
  preferredEditorId = undefined;
  request = undefined;
  lastState = undefined;
  emit();
}
