import type { ComposerCommentInput } from "@liveagent/ui/lib/chat/composerComments";
import { createContext, type ReactNode, useContext } from "react";

/**
 * Adds a pending comment to the composer of the conversation this
 * transcript belongs to. Returns false when the composer rejected it.
 */
export type TranscriptCommentHandler = (comment: ComposerCommentInput) => boolean | undefined;

const TranscriptCommentContext = createContext<TranscriptCommentHandler | null>(null);

/** Lets deep transcript content (edit diffs in tool cards) add composer
 *  comments without threading a callback through every tool renderer. */
export function TranscriptCommentProvider(props: {
  onComment: TranscriptCommentHandler | null | undefined;
  children: ReactNode;
}) {
  return (
    <TranscriptCommentContext.Provider value={props.onComment ?? null}>
      {props.children}
    </TranscriptCommentContext.Provider>
  );
}

export function useTranscriptComment() {
  return useContext(TranscriptCommentContext);
}
