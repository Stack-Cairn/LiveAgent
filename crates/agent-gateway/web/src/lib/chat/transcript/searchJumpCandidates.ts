import type { JumpCandidate } from "@liveagent/ui/lib/chat/searchJumpTarget";
import type { TranscriptRow } from "./types";

/**
 * Search-jump candidates for the WebUI transcript. Only user rows can be scroll
 * targets; their message ref carries the canonical (whole-session) index that
 * search hits report, so an assistant hit resolves to the preceding user row.
 */
export function transcriptRowsToJumpCandidates(rows: readonly TranscriptRow[]): JumpCandidate[] {
  return rows.map((row) => ({
    kind: row.kind,
    key: row.key,
    messageId: row.kind === "user" ? row.messageRef?.messageId : undefined,
    messageIndex: row.kind === "user" ? row.messageRef?.messageIndex : undefined,
  }));
}
