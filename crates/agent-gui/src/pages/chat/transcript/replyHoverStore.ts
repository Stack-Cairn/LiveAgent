// Only the action footer subscribes; hovering must not rerender the list or
// propagate changing props through Markdown and tool rows.
export function createReplyHoverStore() {
  let hoveredReply: string | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => hoveredReply,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHoveredReply(replyKey: string | null) {
      if (replyKey === hoveredReply) return;
      hoveredReply = replyKey;
      for (const listener of listeners) listener();
    },
  };
}
