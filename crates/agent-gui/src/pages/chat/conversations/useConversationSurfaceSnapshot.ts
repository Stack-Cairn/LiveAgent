import { useEffect, useSyncExternalStore } from "react";
import type {
  ConversationSurfaceController,
  ConversationSurfaceSnapshot,
} from "./conversationControllerTypes";

export function useConversationSurfaceSnapshot(
  controller: ConversationSurfaceController,
): ConversationSurfaceSnapshot {
  useEffect(() => controller.retainView(), [controller]);
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
