export const COLLAPSED_CODE_BLOCK_PREVIEW_LINES = 24;
export const COLLAPSED_CODE_BLOCK_PREVIEW_CHARACTERS = 8_000;
export const COLLAPSED_CODE_BLOCK_CHARACTER_THRESHOLD = 12_000;
export const COLLAPSED_CODE_BLOCK_MAX_LINE_CHARACTERS = 2_000;

export function resolveCodeBlockRenderPolicy(code: string): {
  lineCount: number;
  shouldCollapse: boolean;
} {
  const normalizedLength = code.endsWith("\n") ? code.length - 1 : code.length;
  if (normalizedLength <= 0) return { lineCount: 0, shouldCollapse: false };

  let lineCount = 1;
  let currentLineLength = 0;
  let maxLineLength = 0;
  for (let index = 0; index < normalizedLength; index += 1) {
    if (code.charCodeAt(index) === 10) {
      lineCount += 1;
      maxLineLength = Math.max(maxLineLength, currentLineLength);
      currentLineLength = 0;
    } else {
      currentLineLength += 1;
    }
  }
  maxLineLength = Math.max(maxLineLength, currentLineLength);

  return {
    lineCount,
    shouldCollapse:
      lineCount > COLLAPSED_CODE_BLOCK_PREVIEW_LINES ||
      normalizedLength > COLLAPSED_CODE_BLOCK_CHARACTER_THRESHOLD ||
      maxLineLength > COLLAPSED_CODE_BLOCK_MAX_LINE_CHARACTERS,
  };
}

export function getCollapsedCodeBlockPreview(code: string): string {
  const normalizedLength = code.endsWith("\n") ? code.length - 1 : code.length;
  if (normalizedLength <= 0) return "";

  let previewEnd = Math.min(normalizedLength, COLLAPSED_CODE_BLOCK_PREVIEW_CHARACTERS);
  let lineBreaks = 0;
  for (let index = 0; index < previewEnd; index += 1) {
    if (code.charCodeAt(index) !== 10) continue;
    lineBreaks += 1;
    if (lineBreaks === COLLAPSED_CODE_BLOCK_PREVIEW_LINES) {
      previewEnd = index;
      break;
    }
  }
  if (previewEnd > 0 && /[\uD800-\uDBFF]/.test(code[previewEnd - 1] ?? "")) {
    previewEnd -= 1;
  }
  return code.slice(0, previewEnd);
}
