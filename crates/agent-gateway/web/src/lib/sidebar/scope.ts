// Scope keys and scope filtering for the sidebar conversation list.
// Byte-mirrored between agent-gui and agent-gateway/web.

import type { SidebarConversation, SidebarScope } from "./types";

export function sidebarScopeKey(scope: SidebarScope): string {
  switch (scope.kind) {
    case "workdir": {
      const cwd = scope.cwd.trim();
      return cwd ? `cwd:${cwd}` : "none";
    }
    case "unscoped":
      return "cwd-empty";
    case "none":
      return "none";
  }
}

export function conversationMatchesScope(
  conversation: SidebarConversation,
  scope: SidebarScope,
): boolean {
  switch (scope.kind) {
    case "workdir": {
      const cwd = scope.cwd.trim();
      return cwd ? conversation.cwd?.trim() === cwd : false;
    }
    case "unscoped":
      return !conversation.cwd?.trim();
    case "none":
      return false;
  }
}

export function filterConversationsForScope(
  conversations: readonly SidebarConversation[],
  scope: SidebarScope,
): readonly SidebarConversation[] {
  const filtered = conversations.filter((item) => conversationMatchesScope(item, scope));
  return filtered.length === conversations.length ? conversations : filtered;
}
