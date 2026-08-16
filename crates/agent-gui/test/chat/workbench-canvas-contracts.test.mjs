import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const paneChromeSource = readSource(
  "../../../agent-ui/src/components/workbench/PaneChrome.tsx",
);
const paneFrameSource = readSource("../../../agent-ui/src/components/workbench/PaneFrame.tsx");
const paneSurfaceLayerSource = readSource(
  "../../../agent-ui/src/components/workbench/PaneSurfaceLayer.tsx",
);
const dividerLayerSource = readSource(
  "../../../agent-ui/src/components/workbench/DividerLayer.tsx",
);
const workbenchCanvasSource = readSource(
  "../../../agent-ui/src/components/workbench/WorkbenchCanvas.tsx",
);
const chatPageSource = readSource("../../src/pages/ChatPage.tsx");

test("pane chrome never carries the native window drag region", () => {
  // A pane drag handle marked as a Tauri drag region would turn pane moves
  // into native window moves.
  assert.equal(paneChromeSource.includes("data-tauri-drag-region"), false);
  assert.match(paneChromeSource, /data-workbench-pane-drag-handle/);
});

test("pane frames are keyed by paneId and positioned with integer rects", () => {
  assert.match(paneSurfaceLayerSource, /key=\{paneId\}/);
  // Stable render order independent of tree structure keeps DOM alive on move.
  assert.match(paneSurfaceLayerSource, /localeCompare/);
  // Stable state uses left/top/width/height, not transform-based layout.
  assert.match(paneFrameSource, /left: rect\.left/);
  assert.equal(paneFrameSource.includes("transform"), false);
});

test("dividers use pointer capture and commit once per gesture", () => {
  assert.match(dividerLayerSource, /setPointerCapture/);
  assert.match(dividerLayerSource, /releasePointerCapture/);
  assert.match(dividerLayerSource, /requestAnimationFrame/);
  assert.match(dividerLayerSource, /role="separator"/);
  assert.match(dividerLayerSource, /onResizeCommit/);
});

test("workbench canvas separates preview geometry from committed geometry", () => {
  assert.match(workbenchCanvasSource, /committedGeometry/);
  assert.match(workbenchCanvasSource, /ResizeObserver/);
});

test("chat page keeps the legacy single-pane path behind the feature flag", () => {
  assert.match(chatPageSource, /sessionWorkbench\.enabled\s*\?/);
  // Legacy path keeps the stable root pane id; the workbench path owns pane
  // ids through useWindowWorkbench.
  assert.match(chatPageSource, /root-conversation-pane/);
  assert.match(chatPageSource, /useWindowWorkbench\(/);
  assert.match(chatPageSource, /WorkbenchCanvas/);
});

test("workbench drops route through a revision-checked commit", () => {
  // Stale layout revision cancels the transaction instead of replaying it.
  assert.match(chatPageSource, /commit\.revision !== workbench\.layoutRef\.current\.revision/);
  // Focusing a pane selects its conversation through the legacy pipeline.
  assert.match(chatPageSource, /handleSelectConversation\(conversationId\)/);
});

test("workspace drops create the conversation before the pane, verified by workdir", () => {
  // Directory check happens inside the legacy new-conversation pipeline; the
  // pane opens only after the fresh draft's workdir matches the intent.
  assert.match(chatPageSource, /pendingWorkspaceOpenRef/);
  assert.match(chatPageSource, /handleNewConversationForProject\(project\)/);
  assert.match(
    chatPageSource,
    /workspaceProjectPathKey\(draftWorkdir\) === pendingWorkspaceOpen\.projectPathKey/,
  );
});

test("archived and missing workspaces block panes and never rebind the dock", () => {
  assert.match(chatPageSource, /workbench\.projectArchived/);
  assert.match(chatPageSource, /workbench\.projectMissing/);
  assert.match(chatPageSource, /!archivedWorkspaceProjectPathKeys\.has\(projectPathKey\)/);
});

test("native file drags focus the hovered pane so drops land in it", () => {
  assert.match(chatPageSource, /workbenchNativeDropHoverRef/);
  assert.match(chatPageSource, /onDropPositionChange/);
});

test("single pane renders chromeless and frames draw no border ring", () => {
  const paneSurfaceLayerSource = readSource(
    "../../../agent-ui/src/components/workbench/PaneSurfaceLayer.tsx",
  );
  assert.match(paneSurfaceLayerSource, /chromeless=\{paneCount < 2\}/);
  const paneFrameSource = readSource("../../../agent-ui/src/components/workbench/PaneFrame.tsx");
  assert.equal(paneFrameSource.includes("ring-"), false);
});

test("pane chrome is a minimal strip: grab pill plus close, no title text or border", () => {
  // The strip renders no visible title/path and no border; the title only
  // survives as tooltip/aria metadata on the grab pill.
  assert.equal(paneChromeSource.includes("border-"), false);
  assert.equal(paneChromeSource.includes("{title}"), false);
  assert.match(paneChromeSource, /data-workbench-pane-close/);
  assert.match(paneChromeSource, /rounded-full/);
});
