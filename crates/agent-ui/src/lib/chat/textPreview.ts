/**
 * A bounded prefix of a long text, with what it leaves out. The note telling the
 * reader that the text was cut belongs to the UI, which words it in its locale.
 */
export type TextPreview = { text: string; truncated: boolean; totalChars: number };

export function truncateTextPreview(input: string, maxChars: number): TextPreview {
  const text = input || "";
  if (text.length <= maxChars) return { text, truncated: false, totalChars: text.length };
  return { text: text.slice(0, maxChars), truncated: true, totalChars: text.length };
}
