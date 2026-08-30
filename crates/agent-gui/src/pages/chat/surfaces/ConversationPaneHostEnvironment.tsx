import type { ChangedFilesActions } from "@liveagent/ui/components/chat/ChangedFilesCard";
import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import type { CheckpointRewoundInfo } from "@liveagent/ui/lib/chat/checkpointRewind";
import type { ProjectRef } from "@liveagent/ui/lib/workbench/types";
import type { ChatComposerBarProps } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { createContext, type ReactNode, useContext } from "react";
import type { WorkspaceProject } from "../../../lib/settings";
import type {
  ConversationSurfaceController,
  ConversationSurfaceSnapshot,
} from "../conversations/conversationControllerTypes";
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
  /** 每个会话独立持有视图状态；后台 Pane 也能保持自己的轨迹投影。 */
  active: boolean;
  renderContent: (snapshot: ConversationSurfaceSnapshot) => ReactNode;
};

export type ConversationPaneBinding = {
  controller: ConversationSurfaceController;
  transcript: ConversationTranscriptBindings;
  composer: ConversationComposerBindings;
  changedFilesActions: ChangedFilesActions;
  checkpointRewind: ConversationPaneCheckpointRewind;
  isConversationRunning: boolean;
  fileDrop: ConversationPaneFileDropState;
  /** 轨迹视图（只读分析），按会话实例独立绑定。 */
  trajectory?: ConversationPaneTrajectory;
  /**
   * 背景 Pane 的发送通路：按本 Pane 的 conversationId 路由（运行中则入队），
   * 与 Stop 的按会话路由语义一致。未提供时沿用 composer.onSend（焦点 Pane
   * 走页面级 handleSend 管线）。
   */
  sendDraft?: (draft: MentionComposerDraft) => Promise<boolean>;
};

export type ConversationPaneHostEnvironment = {
  /**
   * Pane id is the sole host lookup key. Conversation/project identity lives
   * in the registration so a host retained by React for one transition never
   * combines stale props with a freshly rebound pane.
   */
  resolvePane(paneId: string): ConversationPaneRegistration | null;
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
    resolvePane: (paneId) => registrationsByPaneId.get(paneId.trim()) ?? null,
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

export function useConversationPaneRegistration(paneId: string) {
  const environment = useContext(ConversationPaneHostEnvironmentContext);
  if (!environment) {
    throw new Error("ConversationPaneHost requires a ConversationPaneHostEnvironmentProvider.");
  }
  return environment.resolvePane(paneId);
}
