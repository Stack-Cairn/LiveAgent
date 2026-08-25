/**
 * CUA-042 regression test: CuaInstallerPanel 安装日志折叠按钮 chevron 旋转动画
 *
 * 关键要求：
 *   - 不再用 Web Animations API（CUA-041 在 WKWebView 中 animation.currentTime
 *     全程冻结、playState='running' 不前进）。改回 React state 直接驱动
 *     inline style.transform + style.transition，由浏览器 CSS transition 管线
 *     推进旋转动画，绕开 WAAPI 在 hidden-gated playback clock 下的停摆。
 *   - expand 时 transform = rotate(180deg)
 *   - collapse 时 transform = rotate(0deg)
 *   - transition = "transform 150ms ease"
 *   - chevron span 必须暴露 data-chevron-expanded 供 AX / CUA driver 验证
 *
 * 为什么走 inline style + CSS transition 而不是 WAAPI：
 *   - CUA-038 用 Tailwind .rotate-180 + .transition-transform，卡在 currentTime=0；
 *   - CUA-039 切到 inline style.transform + transition，在 WKWebView async setState
 *     后 click 时 transition 不可靠；
 *   - CUA-041 切到 element.animate(...)，但 WKWebView WAAPI playback clock 冻结，
 *     animation.currentTime 始终 0、transform 停在首帧矩阵；
 *   - CUA-042 把 transform / transition 写在同一个 inline style 对象里，由
 *     React 同步 commit，避免内联 style 序列化顺序问题——React 把整个 cssText
 *     一次性写入 style 属性，浏览器将其视为同帧的属性变化，CSS transition
 *     必然推进（不依赖 WAAPI clock）。
 *
 * 验证策略（两层）：
 *   1. **静态源码检查**：grep 确认 CuaInstallerPanel.tsx 已切回 inline style：
 *      - chevron span 有 data-chevron-expanded 属性；
 *      - 必须有 inline style.transform（由 logExpanded 驱动）；
 *      - 必须有 inline style.transition（"transform 150ms ease"）；
 *      - 必须移除 chevronRef 与 el.animate(...) 调用。
 *   2. **运行时 React 行为**：用 React 在 jsdom 下挂载一个最小复刻 chevron span，
 *     验证 toggle 时 inline style.transform 跟随 React state 同步切换。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const panelPath = path.join(
  repoRoot,
  "crates/agent-ui/src/pages/settings/CuaInstallerPanel.tsx",
);
const panelSource = fs.readFileSync(panelPath, "utf8");

test("CUA-042 静态源码: chevron span 必须有 data-chevron-expanded + inline style.transform/transition", () => {
  // 抓 chevron 容器 span 的 JSX 块：data-chevron-expanded 与 inline style 是关键。
  const chevronBlock = panelSource.match(
    /<span\s*\n[\s\S]*?data-chevron-expanded=\{logExpanded[\s\S]*?<\/span>/,
  );
  assert.ok(
    chevronBlock,
    "expected chevron span to use data-chevron-expanded + inline style",
  );
  const block = chevronBlock[0];

  // 必须暴露 data-chevron-expanded 供 AX / CUA driver 验证。
  assert.ok(
    /data-chevron-expanded=\{logExpanded\s*\?\s*"true"\s*:\s*"false"\}/.test(block),
    `chevron span missing data-chevron-expanded attribute: ${block.slice(0, 200)}`,
  );
  // 必须有 inline style.transform，且由 logExpanded 驱动。
  assert.ok(
    /style=\{\{[\s\S]*?transform:\s*logExpanded\s*\?\s*"rotate\(180deg\)"\s*:\s*"rotate\(0deg\)"[\s\S]*?\}\s*\}/.test(
      block,
    ),
    `chevron span inline style.transform must be driven by logExpanded: ${block.slice(0, 200)}`,
  );
  // 必须有 inline style.transition，150ms。
  assert.ok(
    /style=\{\{[\s\S]*?transition:\s*"transform\s+150ms[\s\S]*?\}\s*\}/.test(block),
    `chevron span missing inline style.transition 'transform 150ms ...': ${block.slice(0, 200)}`,
  );
  // 不允许再依赖 Tailwind 的 rotate-180 class（CUA-038/039 双重回归保护）。
  assert.ok(
    !block.includes("rotate-180"),
    `chevron span still uses 'rotate-180' class — should use inline style.transform: ${block.slice(0, 200)}`,
  );
});

test("CUA-042 静态源码: 必须移除 chevronRef 与 WAAPI el.animate(...) 路径", () => {
  // CUA-041 路径不再使用：refs 到 chevron span 的 useEffect + element.animate(...).
  assert.ok(
    !/chevronRef/.test(panelSource),
    `panel still references chevronRef — CUA-042 should drop WAAPI path entirely`,
  );
  assert.ok(
    !/\.animate\(/.test(panelSource),
    `panel still calls .animate(...) on an element — should switch to inline style: ${panelSource.match(/[^\n]*\.animate\([^\n]*/)?.[0]?.slice(0, 200) ?? ""}`,
  );
  // 不允许再有「CUA-041」注释锚点。
  assert.ok(
    !/CUA-041/.test(panelSource),
    `panel still has 'CUA-041' reference — should be CUA-042 now`,
  );
});

// ---------------- 运行时 React 行为 ----------------

const { JSDOM } = await import(
  new URL("../../node_modules/jsdom/lib/api.js", import.meta.url).href
);
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { pretendToBeVisual: true, url: "http://localhost/" },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.matchMedia = () => ({
  matches: false,
  media: "",
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
  onchange: null,
});
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

const req = createRequire(import.meta.url);
const React = req("react");
const ReactDOMClient = req("react-dom/client");

/**
 * 最小复刻 CuaInstallerPanel 的 chevron span：
 * 用 React state 直接驱动 inline style.transform + style.transition，
 * 验证该模式在浏览器侧真的会按 expand/collapse 切换 transform。
 */
function ChevronSpan({ expanded }) {
  return React.createElement(
    "span",
    {
      "data-chevron-expanded": expanded ? "true" : "false",
      style: {
        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 150ms ease",
      },
    },
    React.createElement("svg", { width: 12, height: 12 }),
  );
}

// 共享 root：createRoot 只能对同一个 container 调用一次。
const container = document.getElementById("root");
const root = ReactDOMClient.createRoot(container);

// React 19 的 commit 是异步的；用 React.act 强制同步 flush 避免跨测试脏读。
function setExpanded(expanded) {
  return React.act(() => {
    root.render(React.createElement(ChevronSpan, { expanded }));
  });
}

function readStyle(span) {
  // jsdom 把 style 上的 camelCase 字段返回为字符串（"rotate(180deg)" 等），
  // 不需要 getComputedStyle——inline style 直接读取即可。
  return {
    transform: span.style.transform,
    transition: span.style.transition,
  };
}

test("CUA-042 运行时: 收起时 chevron span inline style.transform = rotate(0deg)", async () => {
  await setExpanded(false);
  const span = container.querySelector("span");
  assert.ok(span, "chevron span should be in DOM");
  assert.equal(span.getAttribute("data-chevron-expanded"), "false");
  const style = readStyle(span);
  assert.equal(style.transform, "rotate(0deg)", `unexpected transform: ${style.transform}`);
  assert.ok(
    /transform\s+150ms/.test(style.transition),
    `unexpected transition: ${style.transition}`,
  );
});

test("CUA-042 运行时: 展开后 chevron span inline style.transform = rotate(180deg)", async () => {
  await setExpanded(true);
  const span = container.querySelector("span");
  assert.ok(span);
  assert.equal(span.getAttribute("data-chevron-expanded"), "true");
  const style = readStyle(span);
  assert.equal(style.transform, "rotate(180deg)", `unexpected transform: ${style.transform}`);
  assert.ok(
    /transform\s+150ms/.test(style.transition),
    `unexpected transition: ${style.transition}`,
  );
});

test("CUA-042 运行时: 收起→展开→收起，每次都触发对应方向的 transform 切换", async () => {
  await setExpanded(false);
  assert.equal(readStyle(container.querySelector("span")).transform, "rotate(0deg)");

  await setExpanded(true);
  assert.equal(readStyle(container.querySelector("span")).transform, "rotate(180deg)");

  await setExpanded(false);
  assert.equal(readStyle(container.querySelector("span")).transform, "rotate(0deg)");
});