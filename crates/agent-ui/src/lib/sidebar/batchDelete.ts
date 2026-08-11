export type SidebarBatchDeleteResult = {
  deletedIds: readonly string[];
  failedIds: readonly string[];
  skippedIds: readonly string[];
};

export type SidebarBatchDeleteOptions = {
  /**
   * Polled before each delete. Once it returns true the batch stops issuing
   * further deletes: the one already in flight settles on its own, and every
   * unattempted id is reported in `skippedIds`.
   */
  shouldStop?: () => boolean;
};

export async function deleteSidebarConversations(
  ids: readonly string[],
  deleteOne: (id: string) => Promise<boolean>,
  options?: SidebarBatchDeleteOptions,
): Promise<SidebarBatchDeleteResult> {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  const skippedIds: string[] = [];
  let stopped = false;
  for (const id of ids) {
    if (stopped || options?.shouldStop?.() === true) {
      stopped = true;
      skippedIds.push(id);
      continue;
    }
    try {
      if (await deleteOne(id)) {
        deletedIds.push(id);
      } else {
        failedIds.push(id);
      }
    } catch {
      failedIds.push(id);
    }
  }
  return { deletedIds, failedIds, skippedIds };
}
