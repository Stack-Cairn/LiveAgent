import {
  WorkspaceOverlayTitleBar,
  workspaceOverlayStackClassName,
} from "@liveagent/adapters/workspacePreview";
import type { AppSettings, EffectiveTheme } from "@liveagent/app/lib/settings";
import type { WorkspaceCodeEditorOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import type { SftpOpenFileRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceSftpPanel";
import type { WorkspaceSshTerminalOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceSshTerminalOverlay";
import { t as translate } from "@liveagent/ui/i18n/index";
import type { CodeMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { lockMonacoNlsLocale, preparePreferredMonacoNlsLocale } from "@liveagent/ui/lib/monacoNls";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { TerminalClient, TerminalSession } from "@liveagent/ui/lib/terminal/types";
import { lazy, Suspense } from "react";

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
  onSshTerminalOpenFile?: (session: TerminalSession, request: SftpOpenFileRequest) => void;
  /** 工作台互斥/拖出(可选透传;缺省时 overlay 行为不变)。 */
  sshTerminalPaneLeasedSessionIds?: ReadonlySet<string>;
  onSshTerminalFocusLeasedSession?: (sessionId: string) => void;
  onSshTerminalSessionTabDragStart?: (
    session: TerminalSession,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
};

function WorkspaceOverlayLoading(props: { className: string; label: string }) {
  const { className, label } = props;
  return (
    <div
      className={cn(
        className,
        "absolute inset-0 flex min-h-0 flex-col border-r border-border bg-background text-sm text-muted-foreground shadow-2xl",
        workspaceOverlayStackClassName,
      )}
    >
      <WorkspaceOverlayTitleBar />
      <div className="flex min-h-0 flex-1 items-center justify-center">{label}</div>
    </div>
  );
}

/**
 * Lazy mount host for workspace overlays. It stays inside the main chat column
 * so absolute positioning leaves the sidebar usable in both hosts.
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
    onSshTerminalOpenFile,
    sshTerminalPaneLeasedSessionIds,
    onSshTerminalFocusLeasedSession,
    onSshTerminalSessionTabDragStart,
  } = props;

  return (
    <>
      {workspaceEditorMounted ? (
        <Suspense
          fallback={
            <WorkspaceOverlayLoading
              className="workspace-code-editor-overlay"
              label={translate("workspaceEditor.loading", locale)}
            />
          }
        >
          <WorkspaceCodeEditorOverlay
            openRequest={workspaceEditorOpenRequest}
            closeRequestId={workspaceEditorCloseRequestId}
            isOpen={workspaceEditorOpen}
            finalCloseRequested={workspaceEditorCleanupPending}
            theme={theme}
            sftpClient={sftpClient ?? undefined}
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
            <WorkspaceOverlayLoading
              className="workspace-file-preview-overlay"
              label={translate("workspaceFilePreview.loading", locale)}
            />
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
            <WorkspaceOverlayLoading
              className="workspace-ssh-terminal-overlay"
              label={translate("workspaceSshTerminal.loading", locale)}
            />
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
            onOpenSftpFile={onSshTerminalOpenFile}
            paneLeasedSessionIds={sshTerminalPaneLeasedSessionIds}
            onFocusLeasedSession={onSshTerminalFocusLeasedSession}
            onSessionTabDragStart={onSshTerminalSessionTabDragStart}
          />
        </Suspense>
      ) : null}
    </>
  );
}
