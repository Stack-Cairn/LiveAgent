import { deriveFileChangeStats, type FileChangeStats } from "./fileChangeStats";

export type ChangedFilesToolCall = {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
};

export type ChangedFilesToolItem = {
  toolCall: ChangedFilesToolCall;
  toolResult?: {
    isError?: boolean;
    details?: unknown;
  };
};

export type ChangedFilesRound = {
  blocks: readonly (
    | { kind: "tool"; item: ChangedFilesToolItem }
    | { kind: string; [key: string]: unknown }
  )[];
};

export type ChangedFileEntry = {
  path: string;
  added: number;
  removed: number;
  deleted: boolean;
  lastToolCallId: string;
};

export type ChangedFilesSummary = {
  files: ChangedFileEntry[];
  totalAdded: number;
  totalRemoved: number;
};

const FILE_CHANGE_TOOL_NAMES = new Set(["Write", "Edit", "Delete"]);
const statsByToolCall = new WeakMap<object, FileChangeStats | null>();

function statsForToolCall(toolCall: ChangedFilesToolCall): FileChangeStats | undefined {
  const cached = statsByToolCall.get(toolCall);
  if (cached !== undefined) return cached ?? undefined;
  const stats = deriveFileChangeStats(toolCall) ?? null;
  statsByToolCall.set(toolCall, stats);
  return stats ?? undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolResultDetails(item: ChangedFilesToolItem): Record<string, unknown> {
  const details = item.toolResult?.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

function resolveEntryPath(item: ChangedFilesToolItem, details: Record<string, unknown>): string {
  return (
    readString(details.displayPath) ||
    readString(details.relativePath) ||
    readString(details.path) ||
    readString(item.toolCall.arguments?.path)
  );
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

export function collectChangedFiles(
  rounds: readonly ChangedFilesRound[],
): ChangedFilesSummary | null {
  const byKey = new Map<string, ChangedFileEntry>();

  for (const round of rounds) {
    for (const block of round.blocks) {
      if (block.kind !== "tool") continue;
      const item = (block as { kind: "tool"; item: ChangedFilesToolItem }).item;
      const { toolCall, toolResult } = item;
      if (!FILE_CHANGE_TOOL_NAMES.has(toolCall.name)) continue;
      if (!toolResult || toolResult.isError) continue;

      const details = toolResultDetails(item);
      const path = resolveEntryPath(item, details);
      if (!path) continue;

      const key = normalizePathKey(path);
      const entry = byKey.get(key) ?? {
        path,
        added: 0,
        removed: 0,
        deleted: false,
        lastToolCallId: "",
      };

      if (toolCall.name === "Delete") {
        entry.deleted = true;
      } else {
        const stats = statsForToolCall(toolCall);
        entry.added += stats?.added ?? 0;
        entry.removed += stats?.removed ?? 0;
        entry.deleted = false;
      }

      entry.path = path;
      entry.lastToolCallId = toolCall.id || entry.lastToolCallId;
      byKey.set(key, entry);
    }
  }

  if (byKey.size === 0) return null;

  const files = Array.from(byKey.values());
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const file of files) {
    totalAdded += file.added;
    totalRemoved += file.removed;
  }
  return { files, totalAdded, totalRemoved };
}
