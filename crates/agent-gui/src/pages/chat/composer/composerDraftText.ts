import type { MentionComposerLargePaste } from "@liveagent/ui/components/chat/MentionComposer";
import {
  buildPastedTextFileName,
  validateImportedPastedTextFiles,
} from "@liveagent/ui/lib/chat/composerDraft";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { invoke } from "../../../lib/tauriBridge";

export {
  buildTextFromComposerDraft,
  createTextComposerDraft,
} from "@liveagent/ui/lib/chat/composerDraft";

type SystemImportPastedTextsResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

export async function importPastedTextsAsFiles(
  workdir: string,
  pastes: MentionComposerLargePaste[],
) {
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("请先在项目栏选择或创建项目后再发送大段粘贴内容。");
  }
  if (pastes.length === 0) {
    return {
      files: [],
      fileByPasteId: new Map<string, PendingUploadedFile>(),
    };
  }

  const response = await invoke<SystemImportPastedTextsResponse>("system_import_pasted_texts", {
    workdir: normalizedWorkdir,
    texts: pastes.map((paste, index) => ({
      fileName: buildPastedTextFileName(paste, index),
      content: paste.text,
    })),
  });

  return validateImportedPastedTextFiles(pastes, response.files, response.skipped);
}
