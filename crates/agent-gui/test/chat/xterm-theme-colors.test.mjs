import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归护栏:xterm 6 的 css.toColor 不支持关键字 "transparent"(canvas 回退
// 路径对 alpha<255 直接 throw),主题里任何 "transparent" 都会静默落回默认色
// #ffffff。overview ruler 每帧用 overviewRulerBorder 画一条 1px 竖线,落回
// 白色后就是终端右缘的白线(深色主题下肉眼可见)。透明必须写 8 位 hex
// (#RRGGBBAA 分支不校验 alpha)。

const source = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/XTermViewport.tsx", import.meta.url),
  "utf8",
);

test("xterm theme never uses the 'transparent' keyword", () => {
  assert.equal(
    source.includes(': "transparent"'),
    false,
    "xterm css.toColor throws on non-opaque colors and falls back to #ffffff — use #RRGGBBAA",
  );
});

test("overview ruler border stays fully transparent via 8-digit hex", () => {
  const hits = source.match(/overviewRulerBorder: "#00000000"/g) ?? [];
  assert.equal(hits.length, 2, "both dark and light themes must zero out the ruler border");
});
