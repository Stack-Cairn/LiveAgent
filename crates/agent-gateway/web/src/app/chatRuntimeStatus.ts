import { VIBING_STATUS } from "@/lib/chat/chatPageHelpers";

import {
  CHAT_RUNTIME_PREPARING_STATUS,
  CHAT_RUNTIME_STARTING_STATUS,
} from "./constants";

export function getInitialChatRuntimeToolStatus(isEditResend: boolean) {
  return isEditResend ? VIBING_STATUS : null;
}

export function getPreparingChatRuntimeToolStatus(isEditResend: boolean) {
  return isEditResend ? VIBING_STATUS : CHAT_RUNTIME_PREPARING_STATUS;
}

export function shouldApplyPreparingChatRuntimeStatus(input: {
  currentStatus: string | null | undefined;
  isCompaction: boolean;
  isEditResend: boolean;
}) {
  if (input.isCompaction) {
    return false;
  }
  const currentStatus = input.currentStatus?.trim() ?? "";
  if (!currentStatus) {
    return true;
  }
  if (!input.isEditResend) {
    return false;
  }
  return (
    currentStatus === CHAT_RUNTIME_PREPARING_STATUS ||
    currentStatus === CHAT_RUNTIME_STARTING_STATUS
  );
}

export function shouldClearRetainedLocalStreamForRemoteRun(input: {
  isRunning: boolean;
  nextRunKey: string;
  previousRunKey: string;
  hasRetainedLiveStream: boolean;
  hasLocalRunning: boolean;
  hasAbortController: boolean;
}) {
  return (
    input.isRunning &&
    Boolean(input.nextRunKey.trim()) &&
    !input.previousRunKey.trim() &&
    input.hasRetainedLiveStream &&
    !input.hasLocalRunning &&
    !input.hasAbortController
  );
}

export function shouldApplyRemoteIdleEvent(input: {
  eventRunKey: string;
  activeRunKey: string;
}) {
  const eventRunKey = input.eventRunKey.trim();
  const activeRunKey = input.activeRunKey.trim();
  return !eventRunKey || !activeRunKey || eventRunKey === activeRunKey;
}
