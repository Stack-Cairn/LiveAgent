import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const { filterLayoutToLiveSurfaces, WORKBENCH_LAYOUT_STORAGE_KEY } = loader.loadModule(
  "src/pages/chat/workbench/useWindowWorkbench.ts",
);

function pane(paneId, conversationId) {
  return {
    paneId,
    surface: {
      kind: "conversation",
      conversationId,
      project: { projectId: `p-${conversationId}`, projectPathKey: `/w/${conversationId}` },
    },
    view: {},
  };
}

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: { projectId: `p-${surfaceId}`, projectPathKey: `/w/${surfaceId}` },
      launchSpec: { cwd: `/w/${surfaceId}` },
    },
    view: {},
  };
}

function unsupportedPane(paneId) {
  return {
    paneId,
    surface: {
      kind: "unsupported",
      originalKind: "future-kind",
      raw: { kind: "future-kind" },
    },
    view: {},
  };
}

function threePaneLayout() {
  return {
    schemaVersion: workbench.WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision: 7,
    root: {
      type: "split",
      splitId: "s1",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-a" },
      second: {
        type: "split",
        splitId: "s2",
        axis: "vertical",
        ratio: 0.5,
        first: { type: "leaf", paneId: "pane-b" },
        second: { type: "leaf", paneId: "pane-c" },
      },
    },
    panes: {
      "pane-a": pane("pane-a", "conv-a"),
      "pane-b": pane("pane-b", "conv-b"),
      "pane-c": pane("pane-c", "conv-c"),
    },
    focusedPaneId: "pane-b",
  };
}

function mixedLayout() {
  const layout = threePaneLayout();
  layout.panes["pane-b"] = terminalPane("pane-b", "term-b");
  layout.panes["pane-c"] = unsupportedPane("pane-c");
  return layout;
}

test("restore filtering drops panes for missing conversations and collapses splits", () => {
  const filtered = filterLayoutToLiveSurfaces(threePaneLayout(), {
    validConversationIds: new Set(["conv-a", "conv-c"]),
  });
  assert.deepEqual(Object.keys(filtered.panes).sort(), ["pane-a", "pane-c"]);
  assert.equal(filtered.root.type, "split");
  assert.equal(filtered.root.second.type, "leaf");
  assert.equal(filtered.root.second.paneId, "pane-c");
  // The dropped focused pane falls back to the first surviving leaf.
  assert.equal(filtered.focusedPaneId, "pane-a");
  assert.equal(workbench.isWorkbenchLayoutValid(filtered), true);
});

test("restore filtering keeps a fully valid layout untouched", () => {
  const layout = threePaneLayout();
  const filtered = filterLayoutToLiveSurfaces(layout, {
    validConversationIds: new Set(["conv-a", "conv-b", "conv-c"]),
  });
  assert.deepEqual(filtered.root, layout.root);
  assert.equal(filtered.focusedPaneId, "pane-b");
});

test("restore filtering empties the layout when nothing survives", () => {
  const filtered = filterLayoutToLiveSurfaces(threePaneLayout(), {
    validConversationIds: new Set(),
  });
  assert.equal(filtered.root, null);
  assert.deepEqual(filtered.panes, {});
  assert.equal(filtered.focusedPaneId, null);
});

test("restore filtering drops terminal panes when no live-session information exists", () => {
  const filtered = filterLayoutToLiveSurfaces(mixedLayout(), {
    validConversationIds: new Set(["conv-a"]),
  });
  // Terminal pane drops (no liveTerminalSurfaceIds); unsupported pane survives.
  assert.deepEqual(Object.keys(filtered.panes).sort(), ["pane-a", "pane-c"]);
  assert.equal(filtered.panes["pane-c"].surface.kind, "unsupported");
});

test("restore filtering keeps terminal panes whose surfaceId is confirmed live", () => {
  const filtered = filterLayoutToLiveSurfaces(mixedLayout(), {
    validConversationIds: new Set(["conv-a"]),
    liveTerminalSurfaceIds: new Set(["term-b"]),
  });
  assert.deepEqual(Object.keys(filtered.panes).sort(), ["pane-a", "pane-b", "pane-c"]);
  assert.equal(filtered.panes["pane-b"].surface.kind, "localTerminal");
  // The focused terminal pane keeps focus; conversation selection is the
  // caller's concern (attemptRestore falls back to the first conversation).
  assert.equal(filtered.focusedPaneId, "pane-b");
});

test("persisted layout round-trips through the codec", () => {
  const layout = threePaneLayout();
  const decoded = workbench.decodeWorkbenchLayout(workbench.encodeWorkbenchLayout(layout));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.layout, layout);
  assert.equal(typeof WORKBENCH_LAYOUT_STORAGE_KEY, "string");
});
