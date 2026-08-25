/**
 * CUA-039 regression test: CuaInstallerPanel 安装日志折叠按钮 chevron 旋转动画
 *
 * 关键要求：
 *   - 收起时 chevron span 的 inline style.transform 应为空（rotate(0)）
 *   - 展开时 chevron span 的 inline style.transform 必须是 "rotate(180deg)"
 *   - 两种状态下 chevron span 的 inline style.transition 必须是 "transform 150ms"
 *
 * 为什么必须用 inline `transform: rotate(180deg)`（CSS transform 属性），
 * 而不是 Tailwind 的 `rotate-180`（CSS `rotate` 属性）：
 *   - Tailwind v4 把 `rotate-180` 编译成 `rotate: 180deg`，这是单独的 CSS 属性。
 *   - `.transition-transform` 在某些级联顺序下不会 transition `rotate` 属性，
 *     导致 expand 路径 chevron 卡在 0deg（CUA-039）。
 *   - 改用 inline `transform: rotate(180deg)` + `transition: transform 150ms`，
 *     由浏览器原生处理 transition，行为可靠。
 *
 * 验证策略（两层）：
 *   1. **静态源码检查**：grep 确认 CuaInstallerPanel.tsx 已切到 inline style，
 *      不再依赖 `rotate-180` className。
 *   2. **运行时 React 行为**：用 React 在 jsdom 下挂载一个最小复刻 chevron span，
 *      验证 inline style 真的渲染到 DOM 且 transition/transform 属性正确。
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

test("CUA-039 静态源码: chevron span 必须使用 inline style.transform + transition", () => {
  // 抓 chevron 容器 span 的 JSX 块：logExpanded ? "rotate(180deg)" : undefined 是其特征。
  const inlineStyleBlock = panelSource.match(
    /className="inline-flex"\s*\n\s*style=\{\{[\s\S]*?\}\s*\}/,
  );
  assert.ok(
    inlineStyleBlock,
    "expected chevron span to use inline style with 'transform' / 'transition'",
  );
  const block = inlineStyleBlock[0];

  // 不允许再依赖 Tailwind 的 rotate-180 class（这是 CUA-039 卡死的根源）。
  assert.ok(
    !block.includes("rotate-180"),
    `chevron span still uses 'rotate-180' class — would re-trigger CUA-039: ${block.slice(0, 200)}`,
  );
  assert.ok(
    !block.includes("transition-transform"),
    `chevron span still uses 'transition-transform' Tailwind class — switch to inline style: ${block.slice(0, 200)}`,
  );

  // 必须显式声明 inline transition: transform 150ms。
  assert.ok(
    /transition:\s*"transform 150ms"/.test(block),
    `expected inline transition: "transform 150ms" on chevron span, got: ${block.slice(0, 200)}`,
  );
  // 必须根据 logExpanded 切换 transform 值。
  assert.ok(
    /transform:\s*logExpanded\s*\?\s*"rotate\(180deg\)"\s*:\s*undefined/.test(block),
    `expected transform ternary on logExpanded: ${block.slice(0, 200)}`,
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
 * 最小复刻 CuaInstallerPanel 的 chevron span：用同一个 inline style 模式。
 * 验证该 JSX 模式在浏览器侧真的会渲染出 transition + transform。
 */
function ChevronSpan({ expanded }) {
  return React.createElement(
    "span",
    {
      className: "inline-flex",
      style: {
        transform: expanded ? "rotate(180deg)" : undefined,
        transition: "transform 150ms",
      },
    },
    React.createElement("svg", { width: 12, height: 12 }),
  );
}

// 共享 root：createRoot 只能对同一个 container 调用一次。
const container = document.getElementById("root");
const root = ReactDOMClient.createRoot(container);

// React 19 的 commit 是异步的；用 React.act 强制同步 flush 避免跨测试脏读。
// React.act 在开发模式下会把 state 更新排入当前微任务队列并 flush。
function setExpanded(expanded) {
  return React.act(() => {
    root.render(React.createElement(ChevronSpan, { expanded }));
  });
}

test("CUA-039 运行时: 收起时 chevron span style.transform 为空、transition 含 transform 150ms", async () => {
  await setExpanded(false);
  const span = container.querySelector("span");
  assert.ok(span, "chevron span should be in DOM");
  // jsdom 把 undefined 解析成空字符串
  assert.equal(span.style.transform, "");
  assert.equal(span.style.transition, "transform 150ms");
  assert.equal(span.className, "inline-flex");
});

test("CUA-039 运行时: 展开后 chevron span style.transform == 'rotate(180deg)'，transition 仍是 'transform 150ms'", async () => {
  await setExpanded(true);
  const span = container.querySelector("span");
  assert.ok(span);
  assert.equal(span.style.transform, "rotate(180deg)");
  assert.equal(span.style.transition, "transform 150ms");
  assert.equal(span.className, "inline-flex");
});

test("CUA-039 运行时: 收起→展开→收起，transform 来回正确切换", async () => {
  await setExpanded(false);
  let span = container.querySelector("span");
  assert.ok(span);
  assert.equal(span.style.transform, "");

  await setExpanded(true);
  span = container.querySelector("span");
  assert.equal(span.style.transform, "rotate(180deg)");
  assert.equal(span.style.transition, "transform 150ms");

  await setExpanded(false);
  span = container.querySelector("span");
  assert.equal(span.style.transform, "");
  assert.equal(span.style.transition, "transform 150ms");
});
