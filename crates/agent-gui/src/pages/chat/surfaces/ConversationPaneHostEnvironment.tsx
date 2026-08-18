import type { ChangedFilesActions } from "@liveagent/ui/components/chat/ChangedFilesCard";
import type { CheckpointRewoundInfo } from "@liveagent/ui/lib/chat/checkpointRewind";
import type { ProjectRef } from "@liveagent/ui/lib/workbench/types";
import type { ChatComposerBarProps } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { createContext, type ReactNode, useContext } from "react";
import type { WorkspaceProject } from "../../../lib/settings";
import type { ConversationSurfaceController } from "../conversations/conversationControllerTypes";
import type { ChatTranscriptProps } from "../transcript/ChatTranscript";

export type ConversationTranscriptBindings = Omit<
  ChatTranscriptProps,
  | "conversationId"
  | "followRef"
  | "historyItems"
  | "hasMoreHistory"
  | "isSending"
  | "isCompactionRunning"
  | "bottomReservePx"
>;

export type ConversationComposerBindings = Omit<
  ChatComposerBarProps,
  | "composerRef"
  | "isSending"
  | "pendingUploadedFiles"
  | "queuedTurns"
  | "onStop"
  | "onManualCompactConfirm"
  | "manualCompactBlocked"
  | "onHeightChange"
  | "taskProgressBar"
  | "approvalBar"
  | "fileDropOverlay"
>;

export type ConversationPaneFileDropState = {
  active: boolean;
  canDropUpload: boolean;
  title: string;
  description: string;
  limitHint: string;
};

export type ConversationPaneIdentity = {
  paneId: string;
  conversationId: string;
  project: ProjectRef;
};

export type ConversationPaneCheckpointRewind = {
  /** 授权根来源项目;背景 Pane 传 null 表示仅用会话工作区根。 */
  project: Pick<WorkspaceProject, "id" | "path"> | null;
  disabled: boolean;
  onRewound: (info: CheckpointRewoundInfo) => void;
};

export type ConversationPaneTrajectory = {
  /** 视图开关跟随全局 Tabs;仅当前会话的 Pane 会拿到 active=true。 */
  active: boolean;
  content: ReactNode;
};

export type ConversationPaneBinding = {
  controller: ConversationSurfaceController;
  transcript: ConversationTranscriptBindings;
  composer: ConversationComposerBindings;
  changedFilesActions: ChangedFilesActions;
  checkpointRewind: ConversationPaneCheckpointRewind;
  isConversationRunning: boolean;
  fileDrop: ConversationPaneFileDropState;
  /** 轨迹视图(只读分析);背景 Pane 不提供,始终渲染常规转录。 */
  trajectory?: ConversationPaneTrajectory;
};

export type ConversationPaneHostEnvironment = {
  resolvePane(identity: ConversationPaneIdentity): ConversationPaneBinding;
};

export type ConversationPaneRegistration = {
  identity: ConversationPaneIdentity;
  binding: ConversationPaneBinding;
};

export function createConversationPaneHostEnvironment(
  registrations: readonly ConversationPaneRegistration[],
): ConversationPaneHostEnvironment {
  const registrationsByPaneId = new Map<string, ConversationPaneRegistration>();
  for (const registration of registrations) {
    const paneId = registration.identity.paneId.trim();
    if (!paneId) {
      throw new Error("Conversation pane registrations require a stable pane id.");
    }
    if (registrationsByPaneId.has(paneId)) {
      throw new Error(`Duplicate conversation pane registration: ${paneId}`);
    }
    if (registration.binding.controller.conversationId !== registration.identity.conversationId) {
      throw new Error("Conversation pane registration controller identity mismatch.");
    }
    registrationsByPaneId.set(paneId, registration);
  }

  return {
    resolvePane(identity) {
      const registration = registrationsByPaneId.get(identity.paneId.trim());
      if (
        !registration ||
        registration.identity.conversationId !== identity.conversationId ||
        registration.identity.project.projectId !== identity.project.projectId ||
        registration.identity.project.projectPathKey !== identity.project.projectPathKey
      ) {
        throw new Error(`Conversation pane environment cannot resolve pane: ${identity.paneId}`);
      }
      return registration.binding;
    },
  };
}

const ConversationPaneHostEnvironmentContext =
  createContext<ConversationPaneHostEnvironment | null>(null);

export function ConversationPaneHostEnvironmentProvider(props: {
  value: ConversationPaneHostEnvironment;
  children: ReactNode;
}) {
  return (
    <ConversationPaneHostEnvironmentContext.Provider value={props.value}>
      {props.children}
    </ConversationPaneHostEnvironmentContext.Provider>
  );
}

export function useConversationPaneBinding(identity: ConversationPaneIdentity) {
  const environment = useContext(ConversationPaneHostEnvironmentContext);
  if (!environment) {
    throw new Error("ConversationPaneHost requires a ConversationPaneHostEnvironmentProvider.");
  }
  const binding = environment.resolvePane(identity);
  if (binding.controller.conversationId !== identity.conversationId) {
    throw new Error("ConversationPaneHost resolved a controller for a different conversation.");
  }
  return binding;
}
