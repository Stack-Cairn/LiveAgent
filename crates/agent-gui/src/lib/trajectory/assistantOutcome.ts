import type { TrajectoryStatus } from "@liveagent/ui/lib/trajectory/types";

type TerminalAssistantOutcome = {
  stopReason?: unknown;
  errorMessage?: unknown;
};

export function trajectoryTerminalInfo(assistant: TerminalAssistantOutcome): {
  status: TrajectoryStatus;
  error?: string;
} {
  const status: TrajectoryStatus =
    assistant.stopReason === "error"
      ? "error"
      : assistant.stopReason === "aborted"
        ? "aborted"
        : "complete";
  const error =
    status !== "complete" &&
    typeof assistant.errorMessage === "string" &&
    assistant.errorMessage.trim() !== ""
      ? assistant.errorMessage
      : undefined;
  return { status, ...(error === undefined ? {} : { error }) };
}
