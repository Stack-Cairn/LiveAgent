import { parse } from "@babel/parser";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// web 验证反馈：桌面端拖宽正文时输入框跟随（ChatComposerBar 桌面分支的卡片列
// 直接读 --chat-transcript-content-width），web 端却停在固定 768px——
// .gateway-composer-layer 的网格列此前刻意读独立的 --gateway-chat-column-width。
// 现在两端一致：composer 列与转录列共用同一个变量。composer 层挂在
// .gateway-transcript-stage 内部，TranscriptWidthControls 写在 stage 上的内联值
// （含拖拽逐帧更新）由 CSS 继承直接到达。本文件锁住这组耦合。

const webStyleClassesSource = readFileSync(
  new URL("../src/lib/webStyleClasses.ts", import.meta.url),
  "utf8",
);
const appViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const paneHostSource = readFileSync(
  new URL("../src/app/workbench/GatewayConversationPaneHost.tsx", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);

test("composer 列与转录列读同一个宽度变量", () => {
  assert.match(composerSource, /grid-cols-\[[^"\n]*--chat-transcript-content-width/);
  assert.match(webStyleClassesSource, /GATEWAY_TRANSCRIPT_SHELL_CLASS[\s\S]*?--chat-transcript-content-width/);
  assert.doesNotMatch(
    `${composerSource}\n${webStyleClassesSource}`,
    /--gateway-chat-column-width/,
    "固定列宽变量已退役，不允许再引入第二个宽度来源",
  );
});

test("两条路径的 ChatComposerBar 都渲染在 stage 之内，宽度变量可继承", () => {
  for (const [name, source] of [
    ["GatewayAppView", appViewSource],
    ["GatewayConversationPaneHost", paneHostSource],
  ]) {
    const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
    const stages = [];
    function walk(node, visit) {
      if (!node || typeof node !== "object") return;
      visit(node);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
        else if (value && typeof value === "object") walk(value, visit);
      }
    }
    walk(ast, (node) => {
      if (node.type !== "JSXElement") return;
      const attr = node.openingElement.attributes.find((attr) => attr.name?.name === "className");
      if (attr?.value?.type === "StringLiteral" && attr.value.value.split(/\s+/).includes("gateway-transcript-stage")) stages.push(node);
    });
    assert.ok(stages.length > 0, `${name} 应有 gateway-transcript-stage`);
    for (const stage of stages) {
      let hasComposer = false;
      walk(stage, (node) => {
        if (node.type === "JSXOpeningElement" && node.name.name === "ChatComposerBar") hasComposer = true;
      });
      assert.ok(hasComposer, `${name} 的 ChatComposerBar 必须是 stage 的后代`);
    }
  }
  // 桌面分支对照：卡片列 max-width 读同一变量，web 端行为以此为准。
  assert.match(
    composerSource,
    /max-w-transcript-gui/,
  );
});

test("层底部的实底条两端共用：盖住 16px 悬浮留白，正文不能从裙边下方漏出", () => {
  const start = composerSource.indexOf("ref={composerLayerRef}");
  const end = composerSource.indexOf("ref={composerColumnRef}");
  assert.ok(start > 0 && end > start, "composer 层与卡片列的锚点存在");
  const region = composerSource.slice(start, end);
  assert.ok(
    region.includes('className="pointer-events-none absolute inset-x-0 bottom-0 bg-background"'),
    "层底部应有全宽实底条",
  );
  assert.ok(!region.includes('surface === "desktop" ? ('), "实底条不许退回桌面独占");
});
