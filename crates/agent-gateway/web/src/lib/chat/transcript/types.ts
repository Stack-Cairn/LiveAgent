import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { StreamRunActivity } from "@/lib/chat/stream/streamTypes";
import type { PendingUploadedFile } from "@/lib/chat/uploadedFiles";
import type { ChatEntry, GatewayTranscriptRound } from "@/lib/chatUi";

export type UserChatEntry = Extract<ChatEntry, { kind: "user" }>;

// A turn is one prompt/response exchange of the live stream: the user bubble
// (a single slot — a second user_message for the same run can only upsert it,
// never append a sibling) plus every assistant-side entry its run produced.
// Rows are emitted user-first from the same object, so "assistant content
// rendered above its own prompt" and "duplicate prompt bubble" are
// structurally unrepresentable.
export type TurnPhase = "pending" | "streaming" | "settled";

export type Turn = {
  // Render identity, fixed at creation and never re-keyed:
  //   req:<clientRequestId>  — this client's own submissions
  //   run:<runId>            — foreign/seeded turns (other viewers, replays)
  //   local:<n>              — local error pseudo-turns
  key: string;
  // "" until the stream binds the turn to a run.
  runId: string;
  // "" for foreign turns.
  clientRequestId: string;
  user: UserChatEntry | null;
  // Assistant-side entries: assistant | thinking | tool_call | tool_result |
  // hosted_search | checkpoint | error.
  entries: ChatEntry[];
  phase: TurnPhase;
  // Folded turns render inside the virtualized region; the fold only flips
  // this flag — row keys and objects never change, so nothing remounts.
  folded: boolean;
  // The run ended during a reset gap and the replay could not rebuild the
  // content: the kept streamed entries may be incomplete, so a history twin
  // carrying assistant content adopts wholesale (enrichTurnFromHistory)
  // instead of the usual payload-only upgrade.
  contentStale?: boolean;
};

export type TranscriptRowOrigin = "history" | "stream";

// One rendered transcript row. Both regions (virtualized + live flow) are
// slices of a single row list, so an entry can never render twice.
export type TranscriptRow =
  | {
      key: string;
      origin: TranscriptRowOrigin;
      kind: "user";
      text: string;
      attachments: PendingUploadedFile[];
      messageRef?: HistoryMessageRef;
      timestamp?: number;
    }
  | {
      key: string;
      origin: TranscriptRowOrigin;
      kind: "assistant";
      rounds: GatewayTranscriptRound[];
      turnKey?: string;
      timestamp?: number;
    }
  | {
      key: string;
      origin: TranscriptRowOrigin;
      kind: "checkpoint";
      content: string;
      summaryId: string;
      coveredMessageCount: number;
      generatedBy: {
        providerId: string;
        model: string;
        promptVersion?: string;
      };
      timestamp?: number;
    }
  | { key: string; origin: TranscriptRowOrigin; kind: "error"; text: string };

export type HistoryApplyMode = "replace" | "enrich";

export type TranscriptSnapshot = {
  // Rendered in the virtualized region. Identity-stable across streaming
  // commits — the array only changes when the history region or the folded
  // turn set changes — so the virtualized region skips re-renders while a
  // reply streams.
  foldedRows: readonly TranscriptRow[];
  // Rendered in the plain live flow below the virtualized region.
  liveRows: readonly TranscriptRow[];
  // Key of the turn whose run is streaming (live structural state + caret
  // attribution in the renderer).
  activeTurnKey: string | null;
  // Total entry count (history entries + turn entries + user slots) — drives
  // "does this conversation hold content" checks.
  entryCount: number;
  activeRun: StreamRunActivity | null;
  toolStatus: string | null;
  toolStatusIsCompaction: boolean;
  // Bumped whenever turns fold into the virtualized region.
  foldRevision: number;
  revision: number;
};
