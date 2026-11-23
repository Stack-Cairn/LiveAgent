import type { Usage } from "./agentTypes";
import type { TurnErrorDetail } from "./turnError";

/** What a round of an assistant reply settled with, as the transcript reads it. */
export type RoundMeta = {
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  /** The error a failed round ended with; the transcript shows it as an error row. */
  errorMessage?: string;
  /** The backend's structured classification of that error, when it sends one. */
  errorDetail?: TurnErrorDetail;
  /** Why a cancelled round stopped ("shutdown": the backend restarted mid-turn). */
  cancelReason?: string;
  usage?: Usage;
  contextRelevant?: boolean;
  /** Leading blocks a mid-run usage report already covers (see contextUsage). */
  usageBlockCount?: number;
};
