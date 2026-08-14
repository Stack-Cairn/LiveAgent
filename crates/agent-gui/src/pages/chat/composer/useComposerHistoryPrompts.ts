import { useCallback, useEffect, useRef } from "react";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";

export function useComposerHistoryPrompts(transcriptItems: readonly RenderTimelineItem[]) {
  const transcriptItemsRef = useRef(transcriptItems);
  useEffect(() => {
    transcriptItemsRef.current = transcriptItems;
  }, [transcriptItems]);
  return useCallback(() => {
    const prompts: string[] = [];
    for (const item of transcriptItemsRef.current) {
      if (item.kind === "user" && item.text.trim()) prompts.push(item.text);
    }
    return prompts;
  }, []);
}
