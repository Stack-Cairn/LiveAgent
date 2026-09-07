import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const UI = "../../../agent-ui/src/components/ui/";

test("dialogs publish their font-scale zone and portaled popups pick it up", () => {
  // --zone-font-scale 是 CSS 自定义属性，到 portal 边界就断了：对话框里打开的
  // Select/Dropdown 渲染在 body 下，会退回 1.0，而触发器按对话框的 0.9 绘制。
  // React context 能穿过 portal：对话框经 context 发布档位，弹层 Positioner 把它
  // 写回内联变量，.layer-popover 负责按该变量重声明字号变量。
  for (const file of ["dialog.tsx", "alert-dialog.tsx"]) {
    const source = read(UI + file);
    assert.match(source, /resolveZoneFontScale\(style, (ALERT_)?DIALOG_FONT_SCALE\)/, file);
    assert.match(source, /<ZoneFontScaleContext\.Provider value=\{zoneFontScale\}>/, file);
  }
  for (const file of ["select.tsx", "dropdown-menu.tsx", "popover.tsx", "tooltip.tsx"]) {
    const source = read(UI + file);
    const positioners = source.match(/className="layer-popover( isolate)?"/g) ?? [];
    const zoned = source.match(/className="layer-popover( isolate)?"\s+style=\{zoneStyle\}/g) ?? [];
    assert.ok(positioners.length > 0, `${file} has a popover positioner`);
    assert.equal(zoned.length, positioners.length, `${file}: every positioner carries the zone`);
  }
  const css = read("../../../agent-ui/src/styles/common-components.css");
  assert.match(css, /\.zone-font-scale,\n\s*\.layer-popover \{/);
});

test("scroll-fade hides the native scrollbar only where the fade is applied", () => {
  const css = read("../../../agent-ui/src/styles/base.css");
  const block = css.match(/@utility scroll-fade \{[\s\S]*?\n\}\n/);
  assert.ok(block, "scroll-fade utility exists");
  const supports = block[0].match(
    /@supports \(animation-timeline: scroll\(self y\)\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(supports, "@supports block exists");
  // 没有滚动驱动动画的引擎既不渐隐也不该藏滚动条，否则溢出没有任何提示。
  assert.match(supports[0], /scrollbar-width: none;/);
  assert.doesNotMatch(block[0].replace(supports[0], ""), /scrollbar-width: none;/);
  assert.doesNotMatch(css, /@utility no-scrollbar/);

  const sidebar = read("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx");
  assert.doesNotMatch(sidebar, /no-scrollbar/);
  assert.ok((sidebar.match(/\bscroll-fade\b/g) ?? []).length >= 2);
});
