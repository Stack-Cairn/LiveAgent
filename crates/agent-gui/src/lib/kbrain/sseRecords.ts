/**
 * Incremental splitter for a text/event-stream body: records are separated
 * by an empty line (/\r?\n\r?\n/, the same separators the stream parser has
 * always accepted). Each pushed chunk is scanned once and a record's text is
 * joined once when it completes, so a large event arriving in many chunks
 * costs O(size) rather than re-splitting the whole buffer on every chunk.
 */
export type SseRecordSplitter = {
  /** Feeds decoded text; returns the records it completed, in order. */
  push: (text: string) => string[];
  /** Text after the last complete record (an unterminated event). */
  rest: () => string;
};

const NEWLINE = "\n";
const CR = 13;

export function createSseRecordSplitter(): SseRecordSplitter {
  // The record in progress, as received.
  let parts: string[] = [];
  let length = 0;
  // Index (within the record) of its last "\n", and whether "\r" precedes it.
  let lastNewline = -1;
  let lastNewlineAfterCr = false;
  let endsWithCr = false;

  const reset = () => {
    parts = [];
    length = 0;
    lastNewline = -1;
    lastNewlineAfterCr = false;
    endsWithCr = false;
  };

  return {
    push(text) {
      const records: string[] = [];
      // Start of the current record's text inside `text`.
      let consumed = 0;
      let index = text.indexOf(NEWLINE);
      while (index >= 0) {
        const position = length + (index - consumed);
        const afterCr = index > consumed ? text.charCodeAt(index - 1) === CR : endsWithCr;
        const lineLength = position - lastNewline - 1;
        if (lastNewline >= 0 && lineLength === (afterCr ? 1 : 0)) {
          // An empty line: the record ends where the previous line break began.
          const end = lastNewline - (lastNewlineAfterCr ? 1 : 0);
          parts.push(text.slice(consumed, index + 1));
          records.push(parts.join("").slice(0, end));
          reset();
          consumed = index + 1;
        } else {
          lastNewline = position;
          lastNewlineAfterCr = afterCr;
        }
        index = text.indexOf(NEWLINE, index + 1);
      }
      if (consumed < text.length) {
        const tail = consumed === 0 ? text : text.slice(consumed);
        parts.push(tail);
        length += tail.length;
        endsWithCr = tail.charCodeAt(tail.length - 1) === CR;
      }
      return records;
    },
    rest: () => parts.join(""),
  };
}
