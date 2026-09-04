import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 不变量:窄 Pane 下转录区随 Pane(容器)退化,而不是随视口
// (docs/design/session-workbench-pane-architecture.md §22)。分屏里 360px 的
// Pane 在 2560px 的窗口上,楼层导航与宽度手柄必须表现得像一个 360px 的窗口。
//
// 三道闸:
// 1. 桌面转录根是 @container,Pane 内 overlay 的容器查询有挂靠点;
// 2. FloorNavRail 展开面板按 cqw 钳宽(而不是 100vw),极窄容器整条隐藏;
// 3. gateway 的转录 stage 声明 container-type,共享组件在两端语义一致。
// (TranscriptWidthControls 无需容器查询:它的 maxWidth 本就按转录根实测
//  宽度计算,areWidthControlsUsable 在窄 Pane 下已经自然隐藏手柄。)

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("desktop transcript root is a container for pane-relative degradation", () => {
  const source = read("../../src/pages/chat/transcript/ChatTranscript.tsx");
  const rootClass = source.match(/ref=\{transcriptRootRef\}[\s\S]{0,400}?className="([^"]+)"/);
  assert.ok(rootClass, "transcript root className not found");
  assert.match(rootClass[1], /(^| )@container( |$)/);
});

test("composer derives its body-aligned width from the live transcript width", () => {
  const surfaceSource = read("../../src/pages/chat/surfaces/ConversationSurface.tsx");
  const paneHostSource = read("../../src/pages/chat/surfaces/ConversationPaneHost.tsx");
  const widthControlsSource = read(
    "../../../agent-ui/src/pages/chat/transcript/TranscriptWidthControls.tsx",
  );
  const composerSource = read("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx");

  assert.match(surfaceSource, /data-chat-width-owner=""/);
  assert.match(surfaceSource, /\[CHAT_TRANSCRIPT_WIDTH_CSS_VAR\]: `\$\{contentWidth\}px`/);
  assert.match(paneHostSource, /contentWidth=\{transcript\.contentWidth\}/);
  assert.match(widthControlsSource, /closest<HTMLElement>\("\[data-chat-width-owner\]"\)/);
  assert.match(
    composerSource,
    /max-w-\[calc\(var\(--chat-transcript-content-width,768px\)-4\.75rem\)\]/,
  );
  assert.match(composerSource, /w-\[calc\(100%-2\.25rem\)\]/);
  assert.match(composerSource, /translate-x-\[18px\]/);
});

test("FloorNavRail clamps its panel to the container, not the viewport", () => {
  const source = read("../../../agent-ui/src/pages/chat/transcript/FloorNavRail.tsx");
  assert.match(source, /max-w-\[calc\(100cqw-2rem\)\]/);
  assert.equal(
    source.includes("max-w-[calc(100vw"),
    false,
    "viewport-based clamp must not return",
  );
  // 极窄 Pane 整条隐藏,而不是把标记列压在正文上。
  assert.match(source, /@max-\[280px\]:hidden/);
});

test("gateway transcript stage declares containment for the shared rail", () => {
  const source = read("../../../agent-gateway/web/src/styles/base-chat.css");
  const stageRule = source.match(/\.gateway-transcript-stage \{[\s\S]*?\}/);
  assert.ok(stageRule, ".gateway-transcript-stage rule not found");
  assert.match(stageRule[0], /container-type: inline-size/);
});
