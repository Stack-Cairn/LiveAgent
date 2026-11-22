import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// A streamed delta must re-render the live activity row only: the transcript
// list (every history row, the virtualizer, the find index) stays put until
// the live reply changes shape (appears, settles).

const renders = { list: 0, activity: [], units: 0 };

// Fake virtualizer: every row is in range. Each TranscriptList render calls
// useVirtualizer exactly once, which makes it the list's render counter.
function useVirtualizer(options) {
  renders.list += 1;
  const items = Array.from({ length: options.count }, (_, index) => ({
    index,
    key: options.getItemKey(index),
    start: index * 100,
    size: 100,
    end: index * 100 + 100,
    lane: 0,
  }));
  return {
    containerRef: { current: null },
    elementsCache: new Map(),
    getSettledScrollOffset: () => 0,
    getTotalSize: () => items.length * 100,
    getVirtualItemForOffset: () => items[0],
    getVirtualItems: () => items,
    measure() {},
    measureElement() {},
    scrollToEnd() {},
    scrollToOffset() {},
    takeSnapshot: () => [],
    shouldAdjustScrollPositionOnItemSizeChange: undefined,
  };
}

// Row components are stubs (resolved lazily: React comes from the env below).
let React;
function AssistantActivityRow(props) {
  renders.activity.push({ row: props.row });
  return React.createElement("div", { "data-activity": "" }, JSON.stringify(props.row.key));
}
function AssistantRenderUnit() {
  renders.units += 1;
  return React.createElement("div", { "data-unit": "" });
}
function UserMessageRow(props) {
  return React.createElement("div", { "data-user": "" }, props.item?.text ?? "");
}

const rowMocks = {
  "./AssistantActivityRow": { AssistantActivityRow },
  "./AssistantRenderUnit": { AssistantRenderUnit },
  "./UserMessageRow": { UserMessageRow },
};
const env = await createDomTestEnv({
  mocks: {
    "@tanstack/react-virtual": { useVirtualizer },
    "./useViewportClientSize": { useViewportClientSize: () => ({ width: 800, height: 600 }) },
    ...rowMocks,
  },
});
React = env.React;
const { act, createRoot } = env;
const { TranscriptList } = env.loadModule("src/pages/chat/transcript/TranscriptList.tsx");
const { createLiveTranscriptStore } = env.loadModule(
  "src/lib/chat/conversation/liveTranscriptStore.ts",
);

function userItem(key, text) {
  return {
    kind: "user",
    key,
    segmentIndex: 0,
    text,
    attachments: [],
    timestamp: 1,
    isFromCompactedSegment: false,
  };
}

function assistantItem(key, text) {
  return {
    kind: "assistant",
    key,
    segmentIndex: 0,
    rounds: [{ round: 1, key: "r1", blocks: [{ kind: "text", id: "t1", text }] }],
    timestamp: 2,
    isFromCompactedSegment: false,
  };
}

const historyItems = [
  userItem("u1", "first question"),
  assistantItem("a1", "first answer"),
  userItem("u2", "second question"),
];

function liveRound(text) {
  return { key: "r1", round: 1, blocks: [{ kind: "text", id: "t1", text }], runningToolCallIds: [] };
}

test("a streamed delta re-renders only the live activity row", () => {
  const store = createLiveTranscriptStore();
  const container = document.createElement("div");
  const root = createRoot(container);
  const viewport = document.createElement("div");
  const props = {
    conversationId: "c1",
    historyItems,
    hasMoreHistory: false,
    onLoadEarlierHistory: async () => {},
    isHistorySwitching: false,
    liveTranscriptStore: store,
    scrollViewport: viewport,
    layoutWidth: 800,
    viewportFollowing: true,
    isSending: true,
    isCompactionRunning: false,
    showUsage: false,
    onResendFromEdit: () => {},
  };
  act(() => root.render(React.createElement(TranscriptList, props)));
  act(() => {
    store.reset();
    store.updateLiveRounds(() => [liveRound("Hello")]);
  });
  const listRendersWithLiveRow = renders.list;
  const unitRenders = renders.units;
  renders.activity = [];

  for (let index = 0; index < 5; index += 1) {
    act(() => store.updateLiveRounds(() => [liveRound(`Hello${" world".repeat(index + 1)}`)]));
  }

  assert.equal(renders.list, listRendersWithLiveRow, "the list must not re-render per delta");
  assert.equal(renders.units, unitRenders, "history units must not re-render per delta");
  assert.equal(renders.activity.length, 5, "one live row render per delta");
  const lastRow = renders.activity.at(-1).row;
  const text = JSON.stringify(lastRow);
  assert.match(text, /Hello( world){5}/, "the live row sees the latest text");

  // Settling changes the live reply's shape: now the list re-renders.
  act(() => store.settle());
  assert.ok(renders.list > listRendersWithLiveRow);
  act(() => root.unmount());
});

test.after(() => env.cleanup());
