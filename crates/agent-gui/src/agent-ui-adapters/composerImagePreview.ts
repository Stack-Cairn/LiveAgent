import type {
  UploadedImagePreviewLoader,
  UploadedImagePreviewResult,
} from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { invoke } from "@tauri-apps/api/core";

export const loadComposerUploadedImagePreview: UploadedImagePreviewLoader = (
  workspaceRoot,
  absolutePath,
) =>
  invoke<UploadedImagePreviewResult>("system_read_uploaded_image_preview", {
    workdir: workspaceRoot,
    absolute_path: absolutePath,
  });
