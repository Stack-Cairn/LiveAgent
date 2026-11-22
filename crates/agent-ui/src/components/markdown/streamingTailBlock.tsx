// Streaming Markdown where only the growing last block re-renders.
//
// In streaming mode Streamdown keeps its block list in state and swaps it in
// a transition after every content change: each streamed update cost one
// render that changed nothing and a second, deferred commit that re-rendered
// the last block. Here Streamdown is handed a block list that only changes
// when a block completes — the completed blocks verbatim, and a placeholder
// standing in for the growing last block. Streamdown's memo then skips the
// update entirely, and the placeholder's block component reads the current
// tail text from context, so a streamed delta re-parses only that one block,
// in the same commit. The DOM is the one Streamdown renders for the full list:
// same container, same per-block wrappers and keys, same text direction.

import { createContext, useContext } from "react";
import { Block, type BlockProps, detectTextDirection } from "streamdown";
import type { MarkdownBlockParser } from "../../lib/streamingMarkdownBlocks";

// Never produced by the block parser: real blocks hold Markdown text.
export const STREAMING_TAIL_PLACEHOLDER = "\u0000streaming-tail\u0000";

const StreamingBlocksContext = createContext<readonly string[]>([]);
export const StreamingBlocksProvider = StreamingBlocksContext.Provider;

function StreamingTailBlock(props: BlockProps) {
  const blocks = useContext(StreamingBlocksContext);
  const content = blocks[props.index] ?? "";
  return (
    <Block
      {...props}
      content={content}
      dir={props.dir === undefined ? undefined : detectTextDirection(content)}
    />
  );
}

/** Streamdown `BlockComponent` for a frame built by createStreamingBlockFrame. */
export function StreamingBlock(props: BlockProps) {
  return props.content === STREAMING_TAIL_PLACEHOLDER ? (
    <StreamingTailBlock {...props} />
  ) : (
    <Block {...props} />
  );
}

export type StreamingBlockFrame = {
  /** Splits `markdown`; returns the full block list for the context. */
  update: (markdown: string) => {
    blocks: string[];
    /** Streamdown `children`: changes exactly when the framed list changes. */
    key: string;
  };
  /** Streamdown `parseMarkdownIntoBlocksFn`: the framed list of the last update. */
  parse: MarkdownBlockParser;
};

export function createStreamingBlockFrame(parseBlocks: MarkdownBlockParser): StreamingBlockFrame {
  let framed: string[] = [];
  let generation = 0;
  const sameCompleted = (blocks: string[]) => {
    const completed = blocks.length - 1;
    if (framed.length !== blocks.length) return false;
    for (let index = 0; index < completed; index += 1) {
      if (framed[index] !== blocks[index]) return false;
    }
    return true;
  };
  return {
    update(markdown) {
      const blocks = parseBlocks(markdown);
      if (!sameCompleted(blocks)) {
        framed = blocks.length === 0 ? [] : [...blocks.slice(0, -1), STREAMING_TAIL_PLACEHOLDER];
        generation += 1;
      }
      return { blocks, key: `${generation}` };
    },
    parse: () => framed,
  };
}
