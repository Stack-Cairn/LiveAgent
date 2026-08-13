import type { MentionComposerLargePaste } from "@liveagent/ui/components/chat/MentionComposer";
import {
  buildPastedTextFileName,
  validateImportedPastedTextFiles,
} from "@liveagent/ui/lib/chat/composerDraft";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { importReadableFiles } from "@/lib/uploadReadableFiles";

export { buildTextFromComposerDraft } from "@liveagent/ui/lib/chat/composerDraft";

export async function importPastedTextsAsFiles(params: {
  token: string;
  agentId: string;
  workdir: string;
  pastes: MentionComposerLargePaste[];
}) {
  const { token, agentId, workdir, pastes } = params;
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("项目目录未选择，无法发送大段粘贴内容。");
  }
  if (pastes.length === 0) {
    return {
      files: [],
      fileByPasteId: new Map<string, PendingUploadedFile>(),
    };
  }

  const textFiles = pastes.map(
    (paste, index) =>
      new File([paste.text], buildPastedTextFileName(paste, index), {
        type: "text/plain",
      }),
  );
  const response = await importReadableFiles(token, agentId, normalizedWorkdir, textFiles);
  return validateImportedPastedTextFiles(pastes, response.files, response.skipped);
}
