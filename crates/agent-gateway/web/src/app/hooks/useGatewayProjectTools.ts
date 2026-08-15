import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import type { NotifyItem } from "@liveagent/ui/components/chat/NotifyToast";
import { t as translate } from "@liveagent/ui/i18n/index";
import { useChangedFilesActions } from "@liveagent/ui/lib/chat/useChangedFilesActions";
import { useChatFileLinkNavigation } from "@liveagent/ui/lib/chat/useChatFileLinkNavigation";
import {
  useComposerActions,
  useInsertCodeReviewSkill,
} from "@liveagent/ui/lib/chat/useComposerActions";
import { useRightDockSettings } from "@liveagent/ui/lib/projectTools/useRightDockSettings";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useMemo } from "react";

import type { AgentStatus } from "@/lib/gatewayTypes";
import {
  type AppSettings,
  isRightDockSingletonTabOpen,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { createGatewayWorkspaceActivityClient } from "@/lib/workspace-activity/gatewayWorkspaceActivityClient";

import { asErrorMessage } from "../chatEventUtils";
import type { useGatewayChatConfiguration } from "./useGatewayChatConfiguration";
import type { useGatewayClients } from "./useGatewayClients";
import { useProjectToolsRuntime } from "./useProjectToolsRuntime";

type UseGatewayProjectToolsOptions = {
  activeWorkspaceProjectPath: string;
  addNotify: (type: NotifyItem["type"], message: string) => void;
  api: ReturnType<typeof useGatewayClients>["api"];
  codeReviewSkill: ReturnType<typeof useGatewayChatConfiguration>["codeReviewSkill"];
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  displayedConversationId: string;
  displayedConversationWorkdir: string;
  isAgentMode: boolean;
  resetProjectToolsRuntimeRef: MutableRefObject<() => void>;
  setRightDockOpen: Dispatch<SetStateAction<boolean>>;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  settings: AppSettings;
  settingsSyncReady: boolean;
  status: AgentStatus | null;
  terminalClient: ReturnType<typeof useGatewayClients>["terminalClient"];
};

export function useGatewayProjectTools({
  activeWorkspaceProjectPath,
  addNotify,
  api,
  codeReviewSkill,
  composerRef,
  displayedConversationId,
  displayedConversationWorkdir,
  isAgentMode,
  resetProjectToolsRuntimeRef,
  setRightDockOpen,
  setSettings,
  settings,
  settingsSyncReady,
  status,
  terminalClient,
}: UseGatewayProjectToolsOptions) {
  const terminalProjectPath = isAgentMode ? activeWorkspaceProjectPath.trim() : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const {
    rightDockProjectState,
    rightDockFileTreeState,
    rightDockFileTreeOpen,
    associatedSshHostIds,
    handleChatTranscriptWidthChange,
    handleRightDockWidthChange,
    handleRightDockProjectStateChange,
    handleRightDockFileTreeStateChange,
    handleSshProjectHostIdsChange,
  } = useRightDockSettings({ settings, setSettings, terminalProjectPathKey });
  const rightDockSshTunnelOpen = isRightDockSingletonTabOpen(
    settings.customSettings,
    terminalProjectPathKey,
    "sshTunnel",
  );
  const projectToolsDisabledMessage = !settingsSyncReady
    ? "Syncing desktop settings..."
    : !isAgentMode
      ? "Project tools require Agent project mode."
      : !terminalProjectPath
        ? "Select a project to use project tools."
        : undefined;
  const terminalDisabledMessage =
    projectToolsDisabledMessage ??
    (!settings.remote.enableWebTerminal
      ? "Enable WebUI Terminal in desktop Remote settings."
      : undefined);
  const webTerminalSessionsEnabled =
    settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal;
  const runtime = useProjectToolsRuntime({
    terminalClient,
    settingsSyncReady,
    isAgentMode,
    webTerminalSessionsEnabled,
    statusOnline: status?.online,
    statusSessionId: status?.session_id,
    terminalProjectPath,
    terminalProjectPathKey,
    rightDockFileTreeOpen,
    rightDockSshTunnelOpen,
  });
  resetProjectToolsRuntimeRef.current = runtime.resetTerminalSessions;

  const gitDisabledMessage = !settings.remote.enableWebGit
    ? "WebUI Git is disabled in desktop Remote settings."
    : undefined;
  const tunnelEnabled = settingsSyncReady && settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settingsSyncReady
    ? translate("chat.runtime.tunnelSettingsSyncing", settings.locale)
    : !settings.remote.enableWebTunnels
      ? translate("projectTools.tunnelWebDisabled", settings.locale)
      : undefined;
  const workspaceActivityClient = useMemo(
    () => (api ? createGatewayWorkspaceActivityClient(api) : null),
    [api],
  );
  const {
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleChangedFileReveal,
    changedFilesActions,
  } = useChangedFilesActions({
    terminalProjectPathKey,
    setRightDockOpen,
    setSettings,
    onOpenFile: runtime.handleOpenWorkspaceFile,
  });
  const notifyChatFileLinkError = useCallback(
    (message: string) => addNotify("error", message),
    [addNotify],
  );
  const readChatFileLinkError = useCallback(
    (error: unknown) => asErrorMessage(error, "The linked file could not be opened."),
    [],
  );
  const handleOpenChatFileLink = useChatFileLinkNavigation({
    conversationId: displayedConversationId,
    conversationWorkdir: displayedConversationWorkdir,
    terminalProjectPathKey,
    notifyError: notifyChatFileLinkError,
    onRevealInFileTree: handleChangedFileReveal,
    openWorkspaceEditorFile: runtime.openWorkspaceEditorFile,
    openWorkspaceFilePreview: runtime.openWorkspaceFilePreview,
    getErrorMessage: readChatFileLinkError,
  });
  const composerActions = useComposerActions(composerRef);
  const handleRightDockInsertCodeReviewSkill = useInsertCodeReviewSkill({
    composerRef,
    codeReviewSkill,
    setSettings,
  });
  const handleRightDockClose = useCallback(() => {
    setRightDockOpen(false);
  }, [setRightDockOpen]);

  return {
    ...runtime,
    ...composerActions,
    associatedSshHostIds,
    changedFilesActions,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleChatTranscriptWidthChange,
    handleGitReviewFocusRequestHandled,
    handleOpenChatFileLink,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSshProjectHostIdsChange,
    projectToolsDisabledMessage,
    rightDockFileTreeState,
    rightDockProjectState,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    tunnelDisabledMessage,
    tunnelEnabled,
    workspaceActivityClient,
  };
}
