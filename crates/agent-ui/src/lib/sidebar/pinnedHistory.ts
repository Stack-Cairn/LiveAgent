import type { SidebarListPage } from "./backend";
import type { SidebarConversation } from "./types";

// History endpoints order pinned rows first. Stop as soon as the first
// ordinary row arrives, without scanning every project's history.
export async function listPinnedSidebarConversations(
  listPage: (page: number, pageSize: number) => Promise<SidebarListPage>,
): Promise<SidebarConversation[]> {
  const result = new Map<string, SidebarConversation>();
  for (let pageNumber = 1; ; pageNumber++) {
    const page = await listPage(pageNumber, 200);
    for (const item of page.items) {
      if (!item.isPinned) return Array.from(result.values());
      result.set(item.id, item);
    }
    if (page.items.length < 200 || pageNumber * 200 >= page.totalCount)
      return Array.from(result.values());
  }
}
