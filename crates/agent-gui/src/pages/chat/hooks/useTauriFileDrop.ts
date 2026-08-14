import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import {
  type NativeFileDropTarget,
  nativeDropPositionScaleFactor,
  resolveNativeFileDropTarget,
} from "./nativeFileDropRouting";

type UseTauriFileDropParams = {
  canDropUpload: boolean;
  fileDropTitle: string;
  importReadableFilePaths: (paths: string[]) => Promise<void>;
  importWorkspaceFolderPaths: (paths: string[]) => Promise<void>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
};

/**
 * Tauri webview drag-drop listener: routes native paths by their visual drop
 * target. Workspace-zone drops add folders as projects, the explicit chat
 * zone imports attachments, and every other application surface ignores the
 * drop.
 */
export function useTauriFileDrop(params: UseTauriFileDropParams) {
  const {
    canDropUpload,
    fileDropTitle,
    importReadableFilePaths,
    importWorkspaceFolderPaths,
    setErrorMessage,
  } = params;
  const [activeDropTarget, setActiveDropTarget] = useState<NativeFileDropTarget>(null);
  const activeDropTargetRef = useRef<NativeFileDropTarget>(null);
  const hasTrackedDragPositionRef = useRef(false);

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
          const nextTarget = resolveNativeFileDropTarget(event.payload.position, { scaleFactor });
          hasTrackedDragPositionRef.current = true;
          activeDropTargetRef.current = nextTarget;
          setActiveDropTarget(nextTarget);
          return;
        }

        if (event.payload.type === "drop") {
          const scaleFactor = nativeDropPositionScaleFactor(
            window.navigator.userAgent,
            window.devicePixelRatio,
          );
          const dropTarget = hasTrackedDragPositionRef.current
            ? activeDropTargetRef.current
            : resolveNativeFileDropTarget(event.payload.position, { scaleFactor });
          setActiveDropTarget(null);
          activeDropTargetRef.current = null;
          hasTrackedDragPositionRef.current = false;
          if (dropTarget === "workspace") {
            void importWorkspaceFolderPaths(event.payload.paths);
            return;
          }
          if (dropTarget !== "upload") return;
          if (!canDropUpload) {
            setErrorMessage(fileDropTitle);
            return;
          }
          void importReadableFilePaths(event.payload.paths);
          return;
        }

        setActiveDropTarget(null);
        activeDropTargetRef.current = null;
        hasTrackedDragPositionRef.current = false;
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
      if (unlisten) {
        unlisten();
      }
    };
  }, [
    canDropUpload,
    fileDropTitle,
    importReadableFilePaths,
    importWorkspaceFolderPaths,
    setErrorMessage,
  ]);

  return {
    isFileDropActive: activeDropTarget === "upload",
    isWorkspaceFolderDropActive: activeDropTarget === "workspace",
  };
}
