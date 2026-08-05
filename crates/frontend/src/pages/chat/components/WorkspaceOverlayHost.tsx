import { lazy, Suspense } from "react";
import { MacOsTitleBarSpacer } from "../../../components/MacOsTitleBarSpacer";
import { useLocale } from "../../../i18n";
import type { CodeMentionReference } from "../../../lib/chat/messages/mentionReferences";
import { lockMonacoNlsLocale, preparePreferredMonacoNlsLocale } from "../../../lib/monacoNls";
import type { EffectiveTheme } from "../../../lib/settings";
import { tauriSftpClient } from "../../../lib/sftp/tauriSftpClient";
import { tauriTerminalClient } from "../../../lib/terminal/tauriTerminalClient";
import type { TerminalSession } from "../../../lib/terminal/types";
import type { useWorkspaceOverlays } from "../workspace/useWorkspaceOverlays";

const WorkspaceCodeEditorOverlay = lazy(async () => {
  await preparePreferredMonacoNlsLocale();
  const module = await import("../../../components/workspace-editor/WorkspaceCodeEditorOverlay");
  lockMonacoNlsLocale();
  return {
    default: module.WorkspaceCodeEditorOverlay,
  };
});

const WorkspaceFilePreviewOverlay = lazy(async () => {
  const module = await import("../../../components/workspace-editor/WorkspaceFilePreviewOverlay");
  return {
    default: module.WorkspaceFilePreviewOverlay,
  };
});

const WorkspaceSshTerminalOverlay = lazy(async () => {
  const module = await import("../../../components/workspace-editor/WorkspaceSshTerminalOverlay");
  return {
    default: module.WorkspaceSshTerminalOverlay,
  };
});

type WorkspaceOverlayHostProps = {
  overlays: ReturnType<typeof useWorkspaceOverlays>;
  theme: EffectiveTheme;
  terminalProjectPathKey: string;
  terminalSessions: TerminalSession[];
  onInsertCodeMention: (reference: CodeMentionReference) => void;
};

/**
 * Mount host for the three lazy full-window workspace overlays (code editor,
 * file preview, SSH terminal). Rendering state comes straight from
 * useWorkspaceOverlays; the lazy() definitions live here so ChatPage never
 * pays the Monaco import.
 */
export function WorkspaceOverlayHost(props: WorkspaceOverlayHostProps) {
  const { overlays, theme, terminalProjectPathKey, terminalSessions, onInsertCodeMention } = props;
  const { t } = useLocale();
  const {
    workspaceEditorMounted,
    setWorkspaceEditorMounted,
    workspaceEditorOpen,
    setWorkspaceEditorOpen,
    workspaceEditorCleanupPending,
    setWorkspaceEditorCleanupPending,
    workspaceEditorOpenRequest,
    setWorkspaceEditorOpenRequest,
    workspaceEditorCloseRequestId,
    setWorkspaceEditorCloseRequestId,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    setWorkspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
  } = overlays;

  return (
    <>
      {workspaceEditorMounted ? (
        <Suspense
          fallback={
            <div className="absolute inset-0 z-50 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
              <MacOsTitleBarSpacer className="bg-muted/45" />
              <div className="flex min-h-0 flex-1 items-center justify-center">
                {t("workspaceEditor.loading")}
              </div>
            </div>
          }
        >
          <WorkspaceCodeEditorOverlay
            openRequest={workspaceEditorOpenRequest}
            closeRequestId={workspaceEditorCloseRequestId}
            isOpen={workspaceEditorOpen}
            finalCloseRequested={workspaceEditorCleanupPending}
            theme={theme}
            onPreviewFile={(request) => openWorkspaceFilePreview(request)}
            onInsertCodeMention={onInsertCodeMention}
            onHide={() => setWorkspaceEditorOpen(false)}
            onClose={() => {
              setWorkspaceEditorOpen(false);
              setWorkspaceEditorMounted(false);
              setWorkspaceEditorCleanupPending(false);
              setWorkspaceEditorOpenRequest(null);
              setWorkspaceEditorCloseRequestId(0);
            }}
          />
        </Suspense>
      ) : null}
      {workspaceFilePreviewMounted ? (
        <Suspense
          fallback={
            <div className="absolute inset-0 z-50 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
              <MacOsTitleBarSpacer className="bg-muted/45" />
              <div className="flex min-h-0 flex-1 items-center justify-center">
                {t("workspaceFilePreview.loading")}
              </div>
            </div>
          }
        >
          <WorkspaceFilePreviewOverlay
            openRequest={workspaceFilePreviewOpenRequest}
            isOpen={workspaceFilePreviewOpen}
            onOpenEditor={(request) => openWorkspaceEditorFile(request)}
            onRequestClose={requestWorkspaceFilePreviewClose}
            onClose={handleWorkspaceFilePreviewClosed}
          />
        </Suspense>
      ) : null}
      {workspaceSshTerminalMounted ? (
        <Suspense
          fallback={
            <div className="absolute inset-0 z-50 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl">
              <MacOsTitleBarSpacer className="bg-muted/45" />
              <div className="flex min-h-0 flex-1 items-center justify-center">
                {t("workspaceSshTerminal.loading")}
              </div>
            </div>
          }
        >
          <WorkspaceSshTerminalOverlay
            openRequest={workspaceSshTerminalOpenRequest}
            projectPathKey={terminalProjectPathKey}
            sessions={terminalSessions}
            client={tauriTerminalClient}
            sftpClient={tauriSftpClient}
            theme={theme}
            isOpen={workspaceSshTerminalOpen}
            onHide={() => setWorkspaceSshTerminalOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
