export const TOOL_APPROVAL_TIMEOUT_MS = 30000;

export function getToolApprovalDeadlineAt(startedAt: number): number {
  return startedAt + TOOL_APPROVAL_TIMEOUT_MS;
}
