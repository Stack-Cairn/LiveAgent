/**
 * K-brain answers a tool call the user (or a policy) refused with an error result
 * whose text starts with "Permission denied:" (stored as "Error: Permission denied: …").
 * Such a call never ran, so the transcript reports it as denied rather than failed.
 */
const PERMISSION_DENIED_RESULT = /^\s*(?:Error:\s*)?Permission denied:/;

export function isPermissionDeniedToolResult(
  result: { isError?: boolean; content?: readonly unknown[] } | null | undefined,
) {
  if (!result?.isError || !Array.isArray(result.content)) return false;
  const first = result.content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  return first !== undefined && PERMISSION_DENIED_RESULT.test(first.text);
}
