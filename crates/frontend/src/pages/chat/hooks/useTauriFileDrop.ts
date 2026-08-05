import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

type UseTauriFileDropParams = {
  canDropUpload: boolean;
  fileDropTitle: string;
  importReadableFilePaths: (paths: string[]) => Promise<void>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
};

/**
 * Tauri webview drag-drop listener: tracks the drop-overlay visibility and
 * routes dropped paths into the upload pipeline (or an error toast while
 * uploads are unavailable).
 */
export function useTauriFileDrop(params: UseTauriFileDropParams) {
  const { canDropUpload, fileDropTitle, importReadableFilePaths, setErrorMessage } = params;
  const [isFileDropActive, setIsFileDropActive] = useState(false);

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
          setIsFileDropActive(true);
          return;
        }

        if (event.payload.type === "drop") {
          setIsFileDropActive(false);
          if (!canDropUpload) {
            setErrorMessage(fileDropTitle);
            return;
          }
          void importReadableFilePaths(event.payload.paths);
          return;
        }

        setIsFileDropActive(false);
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
  }, [canDropUpload, fileDropTitle, importReadableFilePaths, setErrorMessage]);

  return { isFileDropActive };
}
