import { createKBrainClient } from "./client";

const memoryCommands = new Set([
  "memory_organizer",
  "memory_list",
  "memory_read",
  "memory_search",
  "memory_write",
  "memory_update",
  "memory_delete",
  "memory_delete_project",
  "memory_accept",
  "memory_apply_batch",
  "memory_overview",
  "memory_quota_summary",
  "memory_recent_rejections",
  "memory_organize_run_create",
  "memory_organize_run_update",
  "memory_organize_run_list",
  "memory_organize_run_read",
  "memory_organize_run_clear_history",
  "memory_organize_due_claim",
  "memory_organize_due_complete",
  "memory_index_overview",
  "memory_paths_info",
  "memory_today_local_date",
  "memory_today_daily",
  "memory_wipe_all",
]);

export function isKBrainMemoryCommand(command: string): boolean {
  return memoryCommands.has(command);
}

export async function invokeKBrainMemory<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!isKBrainMemoryCommand(command)) {
    throw new Error(`Unsupported K-brain memory command: ${command}`);
  }
  return createKBrainClient().requestMemory<T>(command, args);
}
