import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildTranscriptLayoutKey, createTranscriptMeasurementsLru } = loader.loadModule(
  "@liveagent/ui/lib/transcript-virtual/measurementsLru.ts",
);
const { SCROLL_FOLLOW_IGNORE_KEYS_ATTRIBUTE } = loader.loadModule(
  "@liveagent/ui/lib/chat-scroll/scrollFollowCore.ts",
);
const width = loader.loadModule("@liveagent/ui/lib/transcript-width/transcriptWidthModel.ts");
const transcriptWidthControlsSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx", import.meta.url),
  "utf8",
);

const item = (key, size) => ({ index: 0, key, start: 0, size, end: size, lane: 0 });

const layoutKey = buildTranscriptLayoutKey;

test("layout keys separate viewport width from transcript content width", () => {
  assert.equal(buildTranscriptLayoutKey(800, 768), "800:768");
  assert.notEqual(buildTranscriptLayoutKey(800, 768), buildTranscriptLayoutKey(800, 960));
  assert.notEqual(buildTranscriptLayoutKey(800, 768), buildTranscriptLayoutKey(900, 768));
  // Subpixel viewport widths must not fragment the cache.
  assert.equal(buildTranscriptLayoutKey(800.4, 768), buildTranscriptLayoutKey(800, 768));
});

test("unmeasured layouts produce a blank key so nothing is cached", () => {
  assert.equal(buildTranscriptLayoutKey(0, 768), "");
  assert.equal(buildTranscriptLayoutKey(800, 0), "");
  assert.equal(buildTranscriptLayoutKey(Number.NaN, 768), "");
  assert.equal(buildTranscriptLayoutKey(-1, 768), "");

  const lru = createTranscriptMeasurementsLru();
  lru.save("conv-1", buildTranscriptLayoutKey(0, 768), [item("a", 120)]);
  assert.equal(lru.restore("conv-1", buildTranscriptLayoutKey(0, 768)), null);
});

test("keyboard width controls do not detach transcript scroll follow", () => {
  // Derived from the follow engine's own constant, so renaming the attribute
  // in one place and not the other fails here instead of silently detaching
  // bottom-follow on every arrow-key resize.
  assert.ok(transcriptWidthControlsSource.includes(SCROLL_FOLLOW_IGNORE_KEYS_ATTRIBUTE));
});

test("width handle hit targets span the full transcript height", () => {
  // #749 follow-up: the 96px-tall, 12px-wide grips were hard to acquire, so
  // the transparent hit area now spans the whole column edge at 17px wide.
  // Only the hit target grew — the visible pill stays small.
  const handleClass = transcriptWidthControlsSource.match(
    /group pointer-events-auto absolute ([^"]+) touch-none cursor-col-resize/,
  );
  assert.ok(handleClass, "transcript width handle class not found");
  assert.match(handleClass[1], /inset-y-0/);
  assert.match(handleClass[1], /w-\[17px\]/);
  assert.equal(
    handleClass[1].includes("h-24"),
    false,
    "the old localized-height classes must not come back alongside inset-y-0",
  );
});

test("preferred widths round and clamp to the persisted bounds", () => {
  assert.equal(width.normalizePreferredWidth(920.4), 920);
  assert.equal(width.normalizePreferredWidth(100), width.MIN_CHAT_TRANSCRIPT_WIDTH);
  assert.equal(width.normalizePreferredWidth(9000), width.MAX_CHAT_TRANSCRIPT_WIDTH);
  assert.equal(width.normalizePreferredWidth(Number.NaN), width.DEFAULT_CHAT_TRANSCRIPT_WIDTH);
});

test("a narrow stage clamps what is rendered without rewriting the preference", () => {
  const stageMax = width.resolveStageMaxWidth(800);
  assert.equal(stageMax, 800 - width.TRANSCRIPT_HORIZONTAL_SAFE_SPACE);
  assert.equal(width.clampWidthToStage(1200, stageMax), stageMax);
  // Widening the stage again restores the full preference.
  assert.equal(width.clampWidthToStage(1200, width.resolveStageMaxWidth(1600)), 1200);
});

test("an unmeasured stage falls back to the upper bound, not the window", () => {
  assert.equal(width.resolveStageMaxWidth(null), width.MAX_CHAT_TRANSCRIPT_WIDTH);
  assert.equal(width.resolveStageMaxWidth(0), width.MAX_CHAT_TRANSCRIPT_WIDTH);
  assert.equal(width.resolveStageMaxWidth(Number.NaN), width.MAX_CHAT_TRANSCRIPT_WIDTH);
});

test("handles hide once the stage can no longer host more than the minimum", () => {
  assert.equal(width.areWidthControlsUsable(width.resolveStageMaxWidth(600)), false);
  assert.equal(width.areWidthControlsUsable(width.resolveStageMaxWidth(1400)), true);
});

test("dragging either handle keeps it under the pointer", () => {
  // Centered column: one edge moving by d changes the width by 2d.
  assert.equal(width.resolveDragWidth(768, 40, "right"), 848);
  assert.equal(width.resolveDragWidth(768, -40, "right"), 688);
  assert.equal(width.resolveDragWidth(768, -40, "left"), 848);
  assert.equal(width.resolveDragWidth(768, 40, "left"), 688);
});

test("keyboard resizing steps from the rendered width, not the preference", () => {
  // Preference 1200 clamped to a 736px stage: one press must move the column,
  // not spend ~29 presses walking the preference back down to what is shown.
  const rendered = width.clampWidthToStage(1200, width.resolveStageMaxWidth(800));
  assert.equal(width.resolveKeyboardWidth("ArrowLeft", rendered, false), rendered - 16);
  assert.equal(width.resolveKeyboardWidth("ArrowLeft", rendered, true), rendered - 64);
  assert.equal(width.resolveKeyboardWidth("ArrowRight", rendered, false), rendered + 16);
  assert.equal(
    width.resolveKeyboardWidth("Home", rendered, false),
    width.DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  );
  assert.equal(width.resolveKeyboardWidth("ArrowUp", rendered, false), null);
  assert.equal(width.resolveKeyboardWidth("a", rendered, false), null);
});

test("save/restore round-trips measurements at the same layout width", () => {
  const lru = createTranscriptMeasurementsLru();
  const measurements = [item("a", 120), item("b", 300)];
  lru.save("conv-1", layoutKey(800, 768), measurements);
  assert.equal(lru.restore("conv-1", layoutKey(800, 768)), measurements);
});

test("restore is layout-gated and misses unknown conversations", () => {
  const lru = createTranscriptMeasurementsLru();
  lru.save("conv-1", layoutKey(800, 768), [item("a", 120)]);
  assert.equal(lru.restore("conv-1", layoutKey(900, 768)), null);
  assert.equal(lru.restore("conv-1", layoutKey(800, 960)), null);
  assert.equal(lru.restore("conv-2", layoutKey(800, 768)), null);
});

test("empty snapshots, blank ids, and blank layout keys are not stored", () => {
  const lru = createTranscriptMeasurementsLru();
  lru.save("conv-1", layoutKey(800, 768), []);
  lru.save("", layoutKey(800, 768), [item("a", 120)]);
  lru.save("conv-2", "", [item("a", 120)]);
  assert.equal(lru.restore("conv-1", layoutKey(800, 768)), null);
  assert.equal(lru.restore("", layoutKey(800, 768)), null);
  assert.equal(lru.restore("conv-2", ""), null);
});

test("capacity evicts the least recently used entry", () => {
  const lru = createTranscriptMeasurementsLru({ capacity: 2 });
  lru.save("conv-1", layoutKey(800, 768), [item("a", 1)]);
  lru.save("conv-2", layoutKey(800, 768), [item("b", 2)]);
  // Touch conv-1 so conv-2 becomes the eviction candidate.
  assert.ok(lru.restore("conv-1", layoutKey(800, 768)));
  lru.save("conv-3", layoutKey(800, 768), [item("c", 3)]);
  assert.ok(lru.restore("conv-1", layoutKey(800, 768)));
  assert.equal(lru.restore("conv-2", layoutKey(800, 768)), null);
  assert.ok(lru.restore("conv-3", layoutKey(800, 768)));
});

test("re-saving a conversation replaces its snapshot", () => {
  const lru = createTranscriptMeasurementsLru();
  lru.save("conv-1", layoutKey(800, 768), [item("a", 1)]);
  const next = [item("a", 2)];
  lru.save("conv-1", layoutKey(820, 960), next);
  assert.equal(lru.restore("conv-1", layoutKey(800, 768)), null);
  assert.equal(lru.restore("conv-1", layoutKey(820, 960)), next);
});

function withFakeLocalStorage(run) {
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  try {
    run(store);
  } finally {
    if (previous === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previous;
    }
  }
}

test("persisted snapshots round-trip across LRU instances (app restarts)", () => {
  withFakeLocalStorage(() => {
    const first = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    first.save("conv-1", layoutKey(800, 768), [item("a", 120), item("b", 300)]);

    const second = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    const restored = second.restore("conv-1", layoutKey(800, 768));
    assert.equal(restored.length, 2);
    assert.equal(restored[0].key, "a");
    assert.equal(restored[0].size, 120);
    // Layout gating still applies to persisted entries.
    assert.equal(second.restore("conv-1", layoutKey(900, 768)), null);
  });
});

test("persisted payload stores compact [key, size] rows, not full items", () => {
  withFakeLocalStorage((store) => {
    const lru = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    lru.save("conv-1", layoutKey(800, 768), [item("a", 120)]);
    const [raw] = [...store.values()];
    const parsed = JSON.parse(raw);
    assert.deepEqual(parsed.entries[0][1].rows, [["a", 120]]);
  });
});

test("malformed persisted payloads degrade to an empty cache", () => {
  withFakeLocalStorage((store) => {
    const probe = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    probe.save("conv-1", layoutKey(800, 768), [item("a", 120)]);
    const [persistKey] = [...store.keys()];
    store.set(persistKey, "{not json");

    const lru = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    assert.equal(lru.restore("conv-1", layoutKey(800, 768)), null);
    // The cache still works (memory-only) after the failed read.
    lru.save("conv-2", layoutKey(800, 768), [item("b", 60)]);
    assert.ok(lru.restore("conv-2", layoutKey(800, 768)));
  });
});

test("storage write failures degrade to memory-only", () => {
  withFakeLocalStorage(() => {
    globalThis.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    const lru = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    const measurements = [item("a", 120)];
    lru.save("conv-1", layoutKey(800, 768), measurements);
    assert.equal(lru.restore("conv-1", layoutKey(800, 768)), measurements);
  });
});

test("oversized snapshots skip persistence and prune their stale persisted copy", () => {
  withFakeLocalStorage(() => {
    const first = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    first.save("conv-1", layoutKey(800, 768), [item("a", 120)]);
    first.save("conv-2", layoutKey(800, 768), [item("b", 60)]);

    // conv-1 grows past the per-entry cap: memory keeps serving it, but the
    // persisted copy must not stay frozen at the old (now stale) snapshot.
    const oversized = Array.from({ length: 5001 }, (_, i) => item(`row-${i}`, 40));
    first.save("conv-1", layoutKey(800, 768), oversized);
    assert.equal(first.restore("conv-1", layoutKey(800, 768)), oversized);

    const second = createTranscriptMeasurementsLru({ persistNamespace: "test" });
    assert.equal(
      second.restore("conv-1", layoutKey(800, 768)),
      null,
      "a restart must not resurrect the pre-growth snapshot",
    );
    // Small entries in the same namespace survive the oversized save.
    assert.equal(second.restore("conv-2", layoutKey(800, 768)).length, 1);
  });
});
