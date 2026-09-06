import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// #749 的 WebUI 侧同步：`.gateway-history-switch-overlay` 用 --layer-panel（20）
// 压在共享宽度手柄（z-10）之上。这里不改层级，而是让 GatewayAppView 在遮罩挂载
// 期间挂起手柄，遮罩离开的同一次 commit 里手柄恢复。本文件锁住这组配对。

const appViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const overlaySource = readFileSync(
  new URL("../src/app/HistorySwitchLoadingOverlay.tsx", import.meta.url),
  "utf8",
);
const chatStyles = readFileSync(new URL("../src/styles/base-chat.css", import.meta.url), "utf8");
const controlsSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx", import.meta.url),
  "utf8",
);

test("web suspends the width handles for exactly as long as the history overlay is mounted", () => {
  const usages = appViewSource.match(/<TranscriptWidthControls[\s\S]*?\/>/g) ?? [];
  assert.equal(usages.length, 2, "workbench pane host and legacy stage both mount the controls");
  for (const usage of usages) {
    assert.match(usage, /suspended=\{conversationOpenState\.showOverlay\}/);
  }
  const overlayMounts =
    appViewSource.match(/conversationOpenState\.showOverlay \? \(\s*<HistorySwitchLoadingOverlay/g) ??
    [];
  assert.equal(overlayMounts.length, 2, "the overlay is gated by the same state in both paths");
});

test("web history overlay stays a blocking panel layer above the handles", () => {
  assert.match(
    chatStyles,
    /\.gateway-history-switch-overlay \{[^}]*z-index: var\(--layer-panel\);/,
  );
  assert.doesNotMatch(overlaySource, /pointer-events-none/);
  assert.match(
    controlsSource,
    /"transcript-width-controls pointer-events-none absolute inset-y-0 left-1\/2 z-10/,
  );
});

test("the shared controls keep a readable root while hidden", () => {
  assert.match(controlsSource, /data-transcript-width-state=\{controlsState\}/);
  assert.match(controlsSource, /hidden=\{!handlesVisible\}/);
  assert.match(controlsSource, /suspended\?: boolean;/);
});
