import {
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
  const { importUploadZonePaths, importWorkspaceFolderPaths, onDropPositionChange } = params;
  const [activeDropTarget, setActiveDropTarget] = useState<NativeFileDropTarget>(null);
  const activeDropTargetRef = useRef<NativeFileDropTarget>(null);
  const onDropPositionChangeRef = useRef(onDropPositionChange);
  onDropPositionChangeRef.current = onDropPositionChange;

  useEffect(() => {
    // The Vite page can also be opened directly in a browser during
    // development. Tauri's webview API expects runtime metadata that does not
    // exist there, so native file-drop support must be a no-op on the web.
    if (!isTauri()) return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          const scaleFactor = nativeDropPositionScaleFactor(
            window.navigator.userAgent,
            window.devicePixelRatio,
          );
          // WKWebView forwards an in-app HTML drag through this native API as
          // well. It is not an OS file upload and must keep its own target
          // semantics (composer mention / terminal path insertion).
          if (getActiveWorkspacePathDrag()) {
            activeDropTargetRef.current = null;
            setActiveDropTarget(null);
            onDropPositionChangeRef.current?.(null);
            dispatchActiveWorkspacePathNativeHover({
              x: event.payload.position.x / (scaleFactor || 1),
              y: event.payload.position.y / (scaleFactor || 1),
            });
            return;
          }
          clearActiveWorkspacePathNativeHover();
          const nextTarget = resolveNativeFileDropTarget(event.payload.position, { scaleFactor });
          activeDropTargetRef.current = nextTarget;
          setActiveDropTarget(nextTarget);
          onDropPositionChangeRef.current?.({
            x: event.payload.position.x / (scaleFactor || 1),
            y: event.payload.position.y / (scaleFactor || 1),
          });
          return;
        }

        if (event.payload.type === "drop") {
          const scaleFactor = nativeDropPositionScaleFactor(
            window.navigator.userAgent,
            window.devicePixelRatio,
          );
          if (getActiveWorkspacePathDrag()) {
            setActiveDropTarget(null);
            activeDropTargetRef.current = null;
            onDropPositionChangeRef.current?.(null);
            dispatchActiveWorkspacePathDrop({
              x: event.payload.position.x / (scaleFactor || 1),
              y: event.payload.position.y / (scaleFactor || 1),
            });
            return;
          }
          clearActiveWorkspacePathNativeHover();
          const dropTarget = resolveFinalNativeFileDropTarget(
            activeDropTargetRef.current,
            event.payload.position,
            { scaleFactor },
          );
          setActiveDropTarget(null);
          activeDropTargetRef.current = null;
          onDropPositionChangeRef.current?.(null);
          if (dropTarget === "workspace") {
            void importWorkspaceFolderPaths(event.payload.paths);
            return;
          }
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

        clearActiveWorkspacePathNativeHover();
        setActiveDropTarget(null);
        activeDropTargetRef.current = null;
        onDropPositionChangeRef.current?.(null);
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
  }, [importUploadZonePaths, importWorkspaceFolderPaths]);

  return {
    isFileDropActive: activeDropTarget === "upload",
    isWorkspaceFolderDropActive: activeDropTarget === "workspace",
  };
}
