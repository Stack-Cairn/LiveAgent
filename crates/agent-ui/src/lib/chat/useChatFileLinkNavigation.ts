import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { WorkspaceCodeEditorOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import { useCallback } from "react";
import type { ChatFileLink } from "./chatFileLinks";
import {
  type OpenChatFileLinkParams,
  type OpenChatFileLinkResult,
  openChatFileLink,
} from "./openChatFileLink";

type WorkspaceOpenRequest = Omit<WorkspaceCodeEditorOpenRequest, "id">;
type WorkspacePreviewRequest = Omit<WorkspaceFilePreviewOpenRequest, "id">;

type UseChatFileLinkNavigationParams = {
  conversationId: string;
  conversationWorkdir: string;
  terminalProjectPathKey: string;
  notifyError: (message: string) => void;
  onRevealInFileTree: (path: string) => void;
  openWorkspaceEditorFile: (request: WorkspaceOpenRequest) => void;
  openWorkspaceFilePreview: (request: WorkspacePreviewRequest) => void;
  openLink?: (params: OpenChatFileLinkParams) => Promise<OpenChatFileLinkResult>;
  getErrorMessage?: (error: unknown) => string;
};

const FILE_OPEN_FAILED = "The linked file could not be opened.";

function defaultErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

export function useChatFileLinkNavigation(params: UseChatFileLinkNavigationParams) {
  const {
    conversationId,
    conversationWorkdir,
    terminalProjectPathKey,
    notifyError,
    onRevealInFileTree,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    openLink = openChatFileLink,
    getErrorMessage = defaultErrorMessage,
  } = params;

  return useCallback(
    (link: ChatFileLink) => {
      const workdir = conversationWorkdir.trim();
      if (!conversationId || !workdir) {
        notifyError("The conversation working directory is unavailable.");
        return;
      }
      const request = { ...link, conversationId, workdir };
      void openLink(request)
        .then(async (result) => {
          if (result.action === "opened" || result.action === "revealed") return;
          const resultWorkdir = result.workdir?.trim() ?? "";
          const resultPath = result.path?.trim() ?? "";
          if (!resultWorkdir || !resultPath) {
            notifyError(FILE_OPEN_FAILED);
            return;
          }
          if (result.action === "directory") {
            if (workspaceProjectPathKey(resultWorkdir) === terminalProjectPathKey) {
              onRevealInFileTree(resultPath);
              return;
            }
            const fallback = await openLink({ ...request, openInFileManager: true });
            if (fallback.action !== "opened") {
              notifyError("The linked directory could not be opened.");
            }
            return;
          }
          const workspaceRequest = {
            projectPathKey: workspaceProjectPathKey(resultWorkdir),
            workdir: resultWorkdir,
            path: resultPath,
          };
          if (
            !result.outsideWorkspace &&
            workspaceRequest.projectPathKey === terminalProjectPathKey
          ) {
            onRevealInFileTree(resultPath);
          }
          if (result.action === "preview") {
            openWorkspaceFilePreview(workspaceRequest);
            return;
          }
          openWorkspaceEditorFile({
            ...workspaceRequest,
            line: result.line,
            endLine: result.endLine,
            column: result.column,
          });
        })
        .catch((error: unknown) => {
          const message = getErrorMessage(error);
          const normalized = message.toLowerCase();
          notifyError(
            normalized.includes("timed out") ||
              normalized.includes("offline") ||
              normalized.includes("not connected")
              ? "The device that owns this conversation is offline or did not respond."
              : message || FILE_OPEN_FAILED,
          );
        });
    },
    [
      conversationId,
      conversationWorkdir,
      getErrorMessage,
      notifyError,
      onRevealInFileTree,
      openLink,
      openWorkspaceEditorFile,
      openWorkspaceFilePreview,
      terminalProjectPathKey,
    ],
  );
}
