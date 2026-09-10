import {
  absoluteWorkspacePath,
  clearActiveWorkspacePathDrag,
  clearActiveWorkspacePathNativeHover,
  dispatchActiveWorkspacePathDrop,
  dispatchActiveWorkspacePathNativeHover,
  getActiveWorkspacePathDrag,
} from "@liveagent/ui/lib/chat/workspacePathDrag";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import {
  type NativeFileDropTarget,
  nativeDropPositionScaleFactor,
  resolveFinalNativeFileDropTarget,
  resolveNativeFileDropTarget,
  resolveNativeUploadConversationId,
} from "./nativeFileDropRouting";

type UseTauriFileDropParams = {
  importUploadZonePaths: (paths: string[], targetConversationId?: string) => Promise<void>;
  importWorkspaceFolderPaths: (paths: string[]) => Promise<void>;
  /**
   * Logical (CSS pixel) hover position while a native drag is over the
   * window, null when it leaves or drops. The session workbench uses this to
   * focus the hovered conversation pane so the drop lands in it.
   */
  onDropPositionChange?: (point: { x: number; y: number } | null) => void;
};

/**
 * Tauri webview drag-drop listener: routes native paths by their visual drop
 * target. Workspace-zone drops add folders as projects, the composer dialog
 * hands the mixed payload to the upload-zone dispatcher (files become
 * attachments, folders become project roots), and every other application
 * surface ignores the drop.
 */
export function useTauriFileDrop(params: UseTauriFileDropParams) {
  const callbacksRef = useRef(params);
  callbacksRef.current = params;
  const [activeDropTarget, setActiveDropTarget] = useState<NativeFileDropTarget>(null);
  const activeDropTargetRef = useRef<NativeFileDropTarget>(null);

  useEffect(() => {
    // The Vite page can also be opened directly in a browser during
    // development. Tauri's webview API expects runtime metadata that does not
    // exist there, so native file-drop support must be a no-op on the web.
    if (!isTauri()) return;

    let cancelled = false;
    let nativeFileDragActive = false;
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { importUploadZonePaths, importWorkspaceFolderPaths, onDropPositionChange } =
          callbacksRef.current;
        if (event.payload.type === "enter" || event.payload.type === "over") {
          const scaleFactor = nativeDropPositionScaleFactor(
            window.navigator.userAgent,
            window.devicePixelRatio,
          );
          // WKWebView also reports HTML/text drags here. Only file payloads or
          // our explicit file-tree bridge may show file-import feedback.
          if (event.payload.type === "enter") {
            nativeFileDragActive = event.payload.paths.length > 0;
            if (nativeFileDragActive) clearActiveWorkspacePathDrag();
          }
          if (!nativeFileDragActive && !getActiveWorkspacePathDrag()) {
            activeDropTargetRef.current = null;
            setActiveDropTarget(null);
            onDropPositionChange?.(null);
            return;
          }
          const nextTarget = resolveNativeFileDropTarget(event.payload.position, { scaleFactor });
          // A folder from the file tree follows the same workspace import rule
          // as a Finder/Explorer folder. Elsewhere it keeps its mention semantics.
          const internalDrag = getActiveWorkspacePathDrag();
          if (internalDrag && nextTarget === "workspace") {
            clearActiveWorkspacePathNativeHover();
            const target = internalDrag.entryKind === "dir" ? "workspace" : null;
            activeDropTargetRef.current = target;
            setActiveDropTarget(target);
            onDropPositionChange?.(null);
            return;
          }
          if (getActiveWorkspacePathDrag()) {
            activeDropTargetRef.current = null;
            setActiveDropTarget(null);
            onDropPositionChange?.(null);
            dispatchActiveWorkspacePathNativeHover({
              x: event.payload.position.x / (scaleFactor || 1),
              y: event.payload.position.y / (scaleFactor || 1),
            });
            return;
          }
          clearActiveWorkspacePathNativeHover();
          activeDropTargetRef.current = nextTarget;
          setActiveDropTarget(nextTarget);
          onDropPositionChange?.({
            x: event.payload.position.x / (scaleFactor || 1),
            y: event.payload.position.y / (scaleFactor || 1),
          });
          return;
        }

        if (event.payload.type === "drop") {
          nativeFileDragActive = false;
          const scaleFactor = nativeDropPositionScaleFactor(
            window.navigator.userAgent,
            window.devicePixelRatio,
          );
          if (event.payload.paths.length > 0) clearActiveWorkspacePathDrag();
          const dropTarget = resolveFinalNativeFileDropTarget(
            activeDropTargetRef.current,
            event.payload.position,
            { scaleFactor },
          );
          if (dropTarget === "workspace") {
            const internalDrag = getActiveWorkspacePathDrag();
            const folderPath =
              internalDrag?.entryKind === "dir" ? absoluteWorkspacePath(internalDrag) : null;
            clearActiveWorkspacePathDrag();
            setActiveDropTarget(null);
            activeDropTargetRef.current = null;
            onDropPositionChange?.(null);
            const paths = internalDrag ? (folderPath ? [folderPath] : []) : event.payload.paths;
            if (paths.length > 0) void importWorkspaceFolderPaths(paths);
            return;
          }
          if (getActiveWorkspacePathDrag()) {
            setActiveDropTarget(null);
            activeDropTargetRef.current = null;
            onDropPositionChange?.(null);
            dispatchActiveWorkspacePathDrop({
              x: event.payload.position.x / (scaleFactor || 1),
              y: event.payload.position.y / (scaleFactor || 1),
            });
            return;
          }
          clearActiveWorkspacePathNativeHover();
          setActiveDropTarget(null);
          activeDropTargetRef.current = null;
          onDropPositionChange?.(null);
          if (dropTarget !== "upload") return;
          // An empty native payload is never an upload. In particular, this
          // prevents non-file drags from reaching Rust's path classifier.
          if (event.payload.paths.length === 0) return;
          const targetConversationId = resolveNativeUploadConversationId(event.payload.position, {
            scaleFactor,
          });
          if (!targetConversationId) return;
          void importUploadZonePaths(event.payload.paths, targetConversationId);
          return;
        }

        nativeFileDragActive = false;
        clearActiveWorkspacePathNativeHover();
        setActiveDropTarget(null);
        activeDropTargetRef.current = null;
        onDropPositionChange?.(null);
      })
      .then((nextUnlisten) => {
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch((error) => {
        console.error("failed to listen for Tauri file drop events", error);
      });

    return () => {
      cancelled = true;
      clearActiveWorkspacePathNativeHover();
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  return {
    isFileDropActive: activeDropTarget === "upload",
    isWorkspaceFolderDropActive: activeDropTarget === "workspace",
  };
}
