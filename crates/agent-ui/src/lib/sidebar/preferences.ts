import type { WorkspaceProject } from "../settings/types";
import { workspaceProjectPathKey } from "../settings/workspaceProjects";
import type { SidebarConversation } from "./types";

// Reordering never changes a project's pinned status or group membership.
export function reorderSidebarProjects(
  projects: readonly WorkspaceProject[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): string[] | null {
  const source = projects.find((project) => project.id === sourceId);
  const target = projects.find((project) => project.id === targetId);
  if (
    !source ||
    !target ||
    sourceId === targetId ||
    Boolean(source.isPinned) !== Boolean(target.isPinned)
  )
    return null;
  const next = projects.filter((project) => project.id !== sourceId);
  const index = next.findIndex((project) => project.id === targetId);
  next.splice(index + (position === "after" ? 1 : 0), 0, source);
  return next.map((project) => workspaceProjectPathKey(project.path));
}

export type SidebarPinnedEntry =
  | { key: string; kind: "conversation"; item: SidebarConversation }
  | { key: string; kind: "workspace"; project: WorkspaceProject };

export const sidebarConversationOrderKey = (id: string) => `conversation:${id}`;
export const sidebarWorkspaceOrderKey = (path: string) =>
  `workspace:${workspaceProjectPathKey(path)}`;

export function buildSidebarPinnedEntries(
  conversations: readonly SidebarConversation[],
  projects: readonly WorkspaceProject[],
  order: readonly string[] = [],
): SidebarPinnedEntry[] {
  const entries: SidebarPinnedEntry[] = [
    ...conversations.map(
      (item): SidebarPinnedEntry => ({
        key: sidebarConversationOrderKey(item.id),
        kind: "conversation",
        item,
      }),
    ),
    ...projects.map(
      (project): SidebarPinnedEntry => ({
        key: sidebarWorkspaceOrderKey(project.path),
        kind: "workspace",
        project,
      }),
    ),
  ];
  const ranks = new Map(order.map((key, index) => [key, index]));
  // Newly pinned entries appear first; existing entries keep their saved order.
  return entries.sort((a, b) => (ranks.get(a.key) ?? -1) - (ranks.get(b.key) ?? -1));
}

export function reorderSidebarPinnedEntries(
  entries: readonly SidebarPinnedEntry[],
  source: string,
  target: string,
  position: "before" | "after",
): string[] | null {
  const keys = entries.map((entry) => entry.key);
  if (source === target || !keys.includes(source) || !keys.includes(target)) return null;
  const next = keys.filter((key) => key !== source);
  const index = next.indexOf(target);
  next.splice(index + (position === "after" ? 1 : 0), 0, source);
  return next;
}
