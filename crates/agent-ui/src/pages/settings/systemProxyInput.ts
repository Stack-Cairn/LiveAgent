/** Return 0 for invalid drafts, matching the unconfigured proxy port sentinel. */
export function parseSystemProxyPortDraft(draft: string): number {
  const port = Number(draft);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}
