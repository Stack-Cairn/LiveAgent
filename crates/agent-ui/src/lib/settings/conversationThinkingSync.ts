import type { ChatRuntimeControls } from "./types";

type Revisions = NonNullable<ChatRuntimeControls["thinkingByConversationRevisions"]>;

export function normalizeConversationThinkingRevisions(input: unknown): Revisions | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const entries = Object.entries(input).flatMap(([id, value]) => {
    if (!id.trim() || !value || typeof value !== "object") return [];
    const { version, writerId } = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      typeof writerId !== "string" ||
      !writerId.trim()
    )
      return [];
    return [[id.trim(), { version: version as number, writerId: writerId.trim() }]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** 全量设置快照也按会话合并；缺失记录且存在版本代表删除。 */
export function mergeConversationThinking(
  current: ChatRuntimeControls,
  incoming: ChatRuntimeControls,
): ChatRuntimeControls {
  const thinking = new Map(Object.entries(current.thinkingByConversation ?? {}));
  const revisions = new Map(Object.entries(current.thinkingByConversationRevisions ?? {}));
  const incomingThinking = incoming.thinkingByConversation ?? {};
  const ids = new Set([
    ...Object.keys(incomingThinking),
    ...Object.keys(incoming.thinkingByConversationRevisions ?? {}),
  ]);
  for (const id of ids) {
    const before = revisions.get(id);
    const after = incoming.thinkingByConversationRevisions?.[id];
    // 未带版本的旧配置只可覆盖未带版本的旧配置。
    if (
      before &&
      (!after ||
        after.version < before.version ||
        (after.version === before.version && after.writerId <= before.writerId))
    )
      continue;
    if (Object.hasOwn(incomingThinking, id)) {
      thinking.set(id, incomingThinking[id]);
    } else {
      thinking.delete(id);
    }
    if (after) revisions.set(id, after);
  }
  return {
    ...incoming,
    thinkingByConversation: thinking.size ? Object.fromEntries(thinking) : undefined,
    thinkingByConversationRevisions: revisions.size ? Object.fromEntries(revisions) : undefined,
  };
}
