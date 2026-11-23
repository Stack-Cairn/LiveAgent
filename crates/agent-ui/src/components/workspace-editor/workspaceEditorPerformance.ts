import type * as monaco from "@liveagent/ui/lib/monacoEditor";

// Thresholds above which the code editor switches to its lightweight mode, and
// the Monaco options for either mode.

export const LARGE_EDITOR_BYTES = 1024 * 1024;
export const LARGE_EDITOR_LINES = 20_000;
export const LONG_EDITOR_LINE = 10_000;

export function needsLightweightEditor(content: string, sizeBytes: number, totalLines: number) {
  if (sizeBytes >= LARGE_EDITOR_BYTES || totalLines >= LARGE_EDITOR_LINES) return true;
  let lineLength = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    lineLength = code === 10 || code === 13 ? 0 : lineLength + 1;
    if (lineLength >= LONG_EDITOR_LINE) return true;
  }
  return false;
}

export function editorPerformanceOptions(lightweight: boolean): monaco.editor.IEditorOptions {
  return {
    minimap: { enabled: !lightweight },
    folding: !lightweight,
    glyphMargin: !lightweight,
    fontLigatures: !lightweight,
    renderWhitespace: "none",
    renderLineHighlight: lightweight ? "none" : "line",
    matchBrackets: lightweight ? "never" : "always",
    occurrencesHighlight: lightweight ? "off" : "singleFile",
    selectionHighlight: !lightweight,
    colorDecorators: !lightweight,
    stickyScroll: { enabled: !lightweight },
    stopRenderingLineAfter: LONG_EDITOR_LINE,
    // Keep find/replace available without automatically searching for a huge selection.
    find: { seedSearchStringFromSelection: lightweight ? "never" : "always" },
  };
}
