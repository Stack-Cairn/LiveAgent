import { invoke } from "@tauri-apps/api/core";
import { MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import { readClipboardText } from "../lib/system/clipboardText";

export const supportsExternalWorkspaceOpen = true;
export const workspaceOverlayStackClassName = "z-50";

export const readWorkspaceClipboardText = readClipboardText;

export async function saveWorkspacePreviewImage(request: {
  data: string;
  fileName: string;
  mimeType: string;
}) {
  await invoke<boolean>("system_save_preview_file", {
    data_base64: request.data,
    file_name: request.fileName,
    mime_type: request.mimeType,
  });
}

export async function copyWorkspacePreviewImage(request: { data: string; mimeType: string }) {
  await invoke("system_clipboard_write_image", {
    data_base64: request.data,
    mime_type: request.mimeType,
  });
}

export function WorkspaceOverlayTitleBar() {
  return <MacOsTitleBarSpacer className="bg-muted/45" />;
}
