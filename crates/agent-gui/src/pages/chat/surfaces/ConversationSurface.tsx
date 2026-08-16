import type { ReactNode } from "react";

type ConversationSurfaceProps = {
  conversationId: string;
  transcript: ReactNode;
  composer: ReactNode;
  overlay?: ReactNode;
};

export function ConversationSurface(props: ConversationSurfaceProps) {
  const { conversationId, transcript, composer, overlay } = props;

  return (
    <div
      data-file-upload-drop-zone=""
      data-workbench-surface="conversation"
      data-workbench-surface-id={`conversation:${conversationId}`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div data-conversation-transcript="" className="contents">
        {transcript}
      </div>
      <div data-conversation-composer="" className="contents">
        {composer}
      </div>
      {overlay}
    </div>
  );
}
