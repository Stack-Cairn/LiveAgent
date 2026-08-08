import type { WorkspaceCodeEditorOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import type { WorkspaceSshTerminalOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceSshTerminalOverlay";
import { t as translate } from "@liveagent/ui/i18n/index";
import { lockMonacoNlsLocale, preparePreferredMonacoNlsLocale } from "@liveagent/ui/lib/monacoNls";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import type { TerminalClient, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { lazy, Suspense } from "react";
import type { CodeMentionReference } from "@/lib/chat/mentionReferences";
import type { AppSettings, EffectiveTheme } from "@/lib/settings";

const WorkspaceCodeEditorOverlay = lazy(async () => {
  await preparePreferredMonacoNlsLocale();
  const module = await import(
    "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay"
  );
  lockMonacoNlsLocale();
  return {
    default: module.WorkspaceCodeEditorOverlay,
  };
});

const WorkspaceFilePreviewOverlay = lazy(async () => {
  const module = await import(
    "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay"
  );
  return {
    default: module.WorkspaceFilePreviewOverlay,
  };
});

const WorkspaceSshTerminalOverlay = lazy(async () => {
  const module = await import(
    "@liveagent/ui/components/workspace-editor/WorkspaceSshTerminalOverlay"
  );
  return {
    default: module.WorkspaceSshTerminalOverlay,
  };
});

type WorkspaceOverlayHostProps = {
  locale: AppSettings["locale"];
  theme: EffectiveTheme;
  workspaceEditorMounted: boolean;
  workspaceEditorOpenRequest: WorkspaceCodeEditorOpenRequest | null;
  workspaceEditorCloseRequestId: number;
  workspaceEditorOpen: boolean;
  workspaceEditorCleanupPending: boolean;
  onWorkspaceEditorPreviewFile: (request: WorkspaceCodeEditorOpenRequest) => void;
  onWorkspaceEditorInsertCodeMention?: (reference: CodeMentionReference) => void;
  onWorkspaceEditorHide: () => void;
  onWorkspaceEditorClose: () => void;
  workspaceFilePreviewMounted: boolean;
  workspaceFilePreviewOpenRequest: WorkspaceFilePreviewOpenRequest | null;
  workspaceFilePreviewOpen: boolean;
  onWorkspaceFilePreviewOpenEditor: (request: WorkspaceFilePreviewOpenRequest) => void;
  onWorkspaceFilePreviewRequestClose: () => void;
  onWorkspaceFilePreviewClose: () => void;
  workspaceSshTerminalMounted: boolean;
  workspaceSshTerminalOpenRequest: WorkspaceSshTerminalOpenRequest | null;
  workspaceSshTerminalOpen: boolean;
  terminalProjectPathKey: string;
  terminalClient: TerminalClient | null;
  sftpClient: SftpClient | null;
  terminalSessions: TerminalSession[];
  onWorkspaceSshTerminalHide: () => void;
};

/**
 * Lazy mount host for workspace overlays. Must live inside `.gateway-main-shell`
 * (not the outer editor host) so absolute inset-0 only covers the main column
 * and leaves the chat sidebar usable.
 */
export function WorkspaceOverlayHost(props: WorkspaceOverlayHostProps) {
  const {
    locale,
    theme,
    workspaceEditorMounted,
    workspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    workspaceEditorOpen,
    workspaceEditorCleanupPending,
    onWorkspaceEditorPreviewFile,
    onWorkspaceEditorInsertCodeMention,
    onWorkspaceEditorHide,
    onWorkspaceEditorClose,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpenRequest,
    workspaceFilePreviewOpen,
    onWorkspaceFilePreviewOpenEditor,
    onWorkspaceFilePreviewRequestClose,
    onWorkspaceFilePreviewClose,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpenRequest,
    workspaceSshTerminalOpen,
    terminalProjectPathKey,
    terminalClient,
    sftpClient,
    terminalSessions,
    onWorkspaceSshTerminalHide,
  } = props;

  return (
    <>
      {workspaceEditorMounted ? (
        <Suspense
          fallback={
            <div className="workspace-code-editor-overlay absolute inset-0 z-40 flex items-center justify-center border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
              {translate("workspaceEditor.loading", locale)}
            </div>
          }
        >
          <WorkspaceCodeEditorOverlay
            openRequest={workspaceEditorOpenRequest}
            closeRequestId={workspaceEditorCloseRequestId}
            isOpen={workspaceEditorOpen}
            finalCloseRequested={workspaceEditorCleanupPending}
            theme={theme}
            onPreviewFile={onWorkspaceEditorPreviewFile}
            onInsertCodeMention={onWorkspaceEditorInsertCodeMention}
            onHide={onWorkspaceEditorHide}
            onClose={onWorkspaceEditorClose}
          />
        </Suspense>
      ) : null}
      {workspaceFilePreviewMounted ? (
        <Suspense
          fallback={
            <div className="workspace-file-preview-overlay absolute inset-0 z-40 flex items-center justify-center border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
              {translate("workspaceFilePreview.loading", locale)}
            </div>
          }
        >
          <WorkspaceFilePreviewOverlay
            openRequest={workspaceFilePreviewOpenRequest}
            isOpen={workspaceFilePreviewOpen}
            onOpenEditor={onWorkspaceFilePreviewOpenEditor}
            onRequestClose={onWorkspaceFilePreviewRequestClose}
            onClose={onWorkspaceFilePreviewClose}
          />
        </Suspense>
      ) : null}
      {workspaceSshTerminalMounted && terminalClient && sftpClient ? (
        <Suspense
          fallback={
            <div className="workspace-ssh-terminal-overlay absolute inset-0 z-40 flex items-center justify-center border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
              {translate("workspaceSshTerminal.loading", locale)}
            </div>
          }
        >
          <WorkspaceSshTerminalOverlay
            openRequest={workspaceSshTerminalOpenRequest}
            projectPathKey={terminalProjectPathKey}
            sessions={terminalSessions}
            client={terminalClient}
            sftpClient={sftpClient}
            theme={theme}
            isOpen={workspaceSshTerminalOpen}
            onHide={onWorkspaceSshTerminalHide}
          />
        </Suspense>
      ) : null}
    </>
  );
}
