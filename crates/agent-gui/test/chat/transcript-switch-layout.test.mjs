import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { initialTranscriptLayout, saveTranscriptScrollPosition, readTranscriptScrollPosition } = createTsModuleLoader().loadModule(
  "src/pages/chat/transcript/initialTranscriptLayout.ts",
);
const rows = Array.from({ length: 100 }, (_, index) => ({
  key: `row-${index}`, estimate: 100, gapAfter: 10,
}));

test("cold conversations seed the first virtual range at the estimated bottom", () => {
  assert.deepEqual(initialTranscriptLayout(rows, [], 500), {
    offset: 10490, measuredViewport: false,
  });
});

test("cached tail heights permit an immediate reveal even with unvisited earlier rows", () => {
  const cache = rows.slice(-6).map(row => ({ key: row.key, size: 100 }));
  assert.deepEqual(initialTranscriptLayout(rows, cache, 500), {
    offset: 10440, measuredViewport: true,
  });
});

test("new or missing tail rows keep the layout protection", () => {
  const cache = rows.slice(-6, -1).map(row => ({ key: row.key, size: 100 }));
  assert.equal(initialTranscriptLayout(rows, cache, 500).measuredViewport, false);
  assert.equal(initialTranscriptLayout(rows, cache, 0).measuredViewport, false);
});

test("short and empty conversations never get a negative initial offset", () => {
  assert.equal(initialTranscriptLayout(rows.slice(0, 1), [], 500).offset, 0);
  assert.deepEqual(initialTranscriptLayout([], [], 500), { offset: 0, measuredViewport: false });
});

test("each conversation remembers its independent reading position and follow state", () => {
  saveTranscriptScrollPosition("a", { offset: 320, following: false });
  saveTranscriptScrollPosition("b", { offset: 800, following: true });
  assert.equal(initialTranscriptLayout(rows, [], 500, readTranscriptScrollPosition("a")).offset, 320);
  assert.equal(initialTranscriptLayout(rows, [], 500, readTranscriptScrollPosition("b")).offset, 10490);
});

test("restoration follows the message anchor when earlier rows change height", () => {
  const position = { offset: 2220, following: false, anchorKey: "row-20", anchorOffset: 20 };
  const cache = [{ key: "row-0", size: 210 }];
  assert.equal(initialTranscriptLayout(rows, cache, 500, position).offset, 2320);
});

test("a removed anchor falls back safely and clamps a shortened conversation", () => {
  assert.equal(initialTranscriptLayout(rows.slice(0, 2), [], 500, {
    offset: 5000, following: false, anchorKey: "deleted",
  }).offset, 0);
});

test("a measured middle viewport skips the loading gate on return", () => {
  const cache = rows.slice(20, 27).map(row => ({ key: row.key, size: 110 }));
  assert.equal(initialTranscriptLayout(rows, cache, 500, {
    offset: 2220, following: false, anchorKey: "row-20", anchorOffset: 20,
  }).measuredViewport, true);
});

test("position storage is bounded and saving refreshes the retained entry", () => {
  for (let i = 0; i < 100; i++) saveTranscriptScrollPosition(`bounded-${i}`, { offset: i, following: false });
  saveTranscriptScrollPosition("bounded-0", { offset: 200, following: false });
  saveTranscriptScrollPosition("bounded-new", { offset: 0, following: true });
  assert.equal(readTranscriptScrollPosition("bounded-1"), undefined);
  assert.equal(readTranscriptScrollPosition("bounded-0").offset, 200);
});

test("switching reveals content without opacity animation and seeds virtualizer geometry", () => {
  const transcript = readFileSync(new URL("../../src/pages/chat/transcript/ChatTranscript.tsx", import.meta.url), "utf8");
  const list = readFileSync(new URL("../../src/pages/chat/transcript/TranscriptList.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(transcript, /transition-opacity|opacity-0/);
  assert.match(list, /initialOffset: initialLayout.offset/);
  assert.match(list, /initialRect:/);
  assert.match(list, /isSending \|\| initialLayout.measuredViewport/);
});
