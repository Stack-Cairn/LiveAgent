import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const { filterLayoutToLiveSurfaces, WORKBENCH_LAYOUT_STORAGE_KEY } = loader.loadModule(
  "src/pages/chat/workbench/useWindowWorkbench.ts",
);
const {
  readRestorableWorkbenchLayoutCrashShadow,
  readWorkbenchLayoutCrashShadow,
} = loader.loadModule("src/pages/chat/workbench/layoutStorage.ts");

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

test("restore filtering keeps terminal panes for launchSpec auto-recreation", () => {
  const filtered = filterLayoutToLiveSurfaces(mixedLayout(), {
    validConversationIds: new Set(["conv-a"]),
  });
  // launchSpec is the recovery identity; the host recreates the PTY after
  // layout filtering. Unsupported panes pass through unchanged.
  assert.deepEqual(Object.keys(filtered.panes).sort(), ["pane-a", "pane-b", "pane-c"]);
  assert.equal(filtered.panes["pane-b"].surface.kind, "localTerminal");
  assert.equal(filtered.panes["pane-c"].surface.kind, "unsupported");
  // The focused terminal pane keeps focus; conversation selection is the
  // caller's concern (attemptRestore falls back to the first conversation).
  assert.equal(filtered.focusedPaneId, "pane-b");
});

test("restore filtering drops terminal panes whose cwd escaped their project", () => {
  // 布局 JSON 不是授权凭据:持久化文件被改成「project 声称 /w/term-b、
  // cwd 指向 /etc」时,该 Pane 不能作为可重建终端活下来。
  const layout = mixedLayout();
  layout.panes["pane-b"].surface.launchSpec.cwd = "/etc";
  const filtered = filterLayoutToLiveSurfaces(layout, {
    validConversationIds: new Set(["conv-a"]),
  });
  assert.deepEqual(Object.keys(filtered.panes).sort(), ["pane-a", "pane-c"]);
  assert.equal(workbench.isWorkbenchLayoutValid(filtered), true);
});

test("restore filtering rejects cwd that only shares a string prefix with the project", () => {
  const layout = mixedLayout();
  layout.panes["pane-b"].surface.launchSpec.cwd = "/w/term-b-evil";
  const filtered = filterLayoutToLiveSurfaces(layout, {
    validConversationIds: new Set(["conv-a"]),
  });
  assert.equal(filtered.panes["pane-b"], undefined);
});

test("restore filtering keeps terminal panes rooted in a project subdirectory", () => {
  const layout = mixedLayout();
  layout.panes["pane-b"].surface.launchSpec.cwd = "/w/term-b/packages/app";
  const filtered = filterLayoutToLiveSurfaces(layout, {
    validConversationIds: new Set(["conv-a"]),
  });
  assert.equal(filtered.panes["pane-b"].surface.kind, "localTerminal");
});

test("layout validation reports a terminal cwd outside its project", () => {
  const layout = mixedLayout();
  layout.panes["pane-b"].surface.launchSpec.cwd = "/w/term-b/../../etc";
  const issues = workbench.collectWorkbenchLayoutIssues(layout);
  assert.equal(
    issues.some((entry) => entry.code === "terminal-cwd-outside-project"),
    true,
  );
  assert.equal(workbench.isWorkbenchLayoutValid(layout), false);
});

test("persisted layout round-trips through the codec", () => {
  const layout = threePaneLayout();
  const decoded = workbench.decodeWorkbenchLayout(workbench.encodeWorkbenchLayout(layout));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.layout, layout);
  assert.equal(typeof WORKBENCH_LAYOUT_STORAGE_KEY, "string");
});

test("startup accepts only a valid multi-pane crash shadow", () => {
  const previousWindow = globalThis.window;
  const layout = threePaneLayout();
  globalThis.window = {
    localStorage: {
      getItem(key) {
        assert.equal(key, WORKBENCH_LAYOUT_STORAGE_KEY);
        return workbench.encodeWorkbenchLayout(layout);
      },
    },
  };
  try {
    assert.equal(readWorkbenchLayoutCrashShadow(), workbench.encodeWorkbenchLayout(layout));
    assert.deepEqual(readRestorableWorkbenchLayoutCrashShadow(), layout);

    const singlePane = {
      ...layout,
      root: { type: "leaf", paneId: "pane-a" },
      panes: { "pane-a": layout.panes["pane-a"] },
      focusedPaneId: "pane-a",
    };
    globalThis.window.localStorage.getItem = () => workbench.encodeWorkbenchLayout(singlePane);
    assert.equal(readRestorableWorkbenchLayoutCrashShadow(), null);

    globalThis.window.localStorage.getItem = () => "{broken";
    assert.equal(readRestorableWorkbenchLayoutCrashShadow(), null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("layout changes write a synchronous crash shadow before the debounce", () => {
  const hookSource = readFileSync(
    new URL("../../src/pages/chat/workbench/useWindowWorkbench.ts", import.meta.url),
    "utf8",
  );
  const effectStart = hookSource.indexOf("persistCrashShadowNow(layout)");
  const debounceStart = hookSource.indexOf("window.setTimeout", effectStart);
  assert.notEqual(effectStart, -1);
  assert.notEqual(debounceStart, -1);
  assert.ok(effectStart < debounceStart);
  const dispatchStart = hookSource.indexOf("const dispatch = useCallback");
  const refCommit = hookSource.indexOf("layoutRef.current = result.layout", dispatchStart);
  const crashCommit = hookSource.indexOf("persistCrashShadowNow(result.layout)", dispatchStart);
  const reactCommit = hookSource.indexOf("setLayout(result.layout)", dispatchStart);
  assert.ok(refCommit < crashCommit && crashCommit < reactCommit);
  assert.match(hookSource, /window\.addEventListener\("pagehide", flush\)/);
  assert.match(hookSource, /document\.addEventListener\("visibilitychange", flushWhenHidden\)/);
});

test("native restore chooses a newer crash shadow over sqlite", () => {
  const persistenceSource = readFileSync(
    new URL("../../src/pages/chat/workbench/layoutPersistence.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    persistenceSource,
    /payloadRevision\(localPayload\) > record\.revision\s*\? localPayload\s*: record\.payloadJson/,
  );
  assert.match(persistenceSource, /saveCrashShadow\(payloadJson\)[\s\S]{0,80}writeLocalStorage/);
});

test("startup paints theme and shell before progressively hydrating pane contents", () => {
  const htmlSource = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const chatSource = readFileSync(
    new URL("../../src/pages/ChatPage.tsx", import.meta.url),
    "utf8",
  );
  const transcriptLoadingSource = readFileSync(
    new URL("../../src/pages/chat/transcript/TranscriptLoadingStates.tsx", import.meta.url),
    "utf8",
  );

  const themeScript = htmlSource.indexOf('localStorage.getItem("liveagent.ui-settings.v1")');
  const appScript = htmlSource.indexOf('src="/src/main.tsx"');
  assert.ok(themeScript >= 0 && themeScript < appScript);
  assert.match(htmlSource, /--liveagent-boot-background/);
  assert.match(appSource, /if \(!settingsReady\)[\s\S]{0,220}<AppBootShell/);
  assert.match(chatSource, /if \(!workbench\.restoreReady\)[\s\S]{0,180}<PaneLoadingSkeleton/);
  assert.match(chatSource, /void resolveLiveTerminalSurfaceIds\([\s\S]{0,260}attemptRestore/);
  assert.doesNotMatch(chatSource, /await resolveLiveTerminalSurfaceIds/);
  assert.match(transcriptLoadingSource, /<PaneLoadingSkeleton/);
  assert.doesNotMatch(transcriptLoadingSource, /LoaderCircle/);
});
