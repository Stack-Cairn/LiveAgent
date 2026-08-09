/**
 * Canonical line-ending model for user-authored composer text.
 *
 * CRLF and bare CR are transport/platform spellings of one logical line
 * break. Internally the frontends keep that break as LF without trimming or
 * otherwise changing whitespace.
 */
export function normalizeLogicalLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

/** Escape plaintext for execCommand("insertHTML") without translating LF. */
export function plainTextToContentEditableHtml(value: string) {
  return normalizeLogicalLineEndings(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Insert canonical plaintext as one undoable browser editing operation.
 * Literal LF stays in text nodes under the composer's `white-space: pre-wrap`
 * rule, avoiding browser-generated DIV/BR structures that are ambiguous to
 * serialize. The insertText fallback remains for engines without insertHTML;
 * the serializer also handles their block DOM without duplicating blank lines.
 */
export function insertPlainTextWithUndo(value: string) {
  const normalized = normalizeLogicalLineEndings(value);
  if (document.execCommand("insertHTML", false, plainTextToContentEditableHtml(normalized))) {
    return normalized;
  }
  document.execCommand("insertText", false, normalized);
  return normalized;
}
