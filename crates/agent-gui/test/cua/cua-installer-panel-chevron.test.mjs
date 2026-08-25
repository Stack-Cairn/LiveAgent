/**
 * CUA-044 regression test: CuaInstallerPanel 安装日志折叠按钮 chevron 旋转动画
 *
 * 关键要求（CUA-044 修复后）：
 *   - 不再依赖 inline style.transform（CUA-042 证明 inline style 会被 WKWebView
 *     丢弃——aria-expanded / data-chevron-expanded 已切，但 getComputedStyle
 *     .transform 永远 matrix(1,0,0,1,0,0)）。
 *   - 改用 Tailwind className 切换 + transition-transform + duration-150：
 *       className={cn("... transition-transform duration-150",
 *                     logExpanded ? "rotate-180" : "rotate-0")}
 *     className 由 React commit 同步写入，浏览器 CSS transition 通过样式表
 *     pipeline 推进，不依赖 WAAPI 时钟（CUA-041 已证 WAAPI playback clock
 *     在 WKWebView 全程冻结）。
 *   - chevron span 必须暴露 data-chevron-expanded 供 AX / CUA driver 验证。
 *   - 用 useLayoutEffect 读取 offsetWidth 强制 layout flush——给 WKWebView
 *     一个明确的 reflow 触发点，避免 className 切换被下一帧 batch 掉。
 *
 * 失败历史：
 *   - CUA-038：Tailwind rotate-180 + transition-transform 在 SVG 上 WAAPI
 *     时钟冻结；
 *   - CUA-039：inline style.transform + transition，expand 路径 transition
 *     不推进；
 *   - CUA-041：Web Animations API，WKWebView 整页 hidden 时
 *     animation.currentTime 永远 0；
 *   - CUA-042：inline style.transform 写在统一 style 对象里，computed
 *     transform 永远单位矩阵——inline style 被 WKWebView 丢弃；
 *   - CUA-044：className 切换 + useLayoutEffect + offsetWidth flush（当前）。
 *
 * 验证策略（两层）：
 *   1. **静态源码检查**：grep 确认 CuaInstallerPanel.tsx 已切到 className
 *      驱动，并移除 inline style.transform / style.transition；
 *   2. **运行时 React 行为**：用 React 在 jsdom 下挂载一个最小复刻 chevron
 *      span，验证 toggle 时 className 跟随 React state 同步切换
 *      rotate-180 / rotate-0。
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

test("CUA-044 静态源码: chevron span 必须用 className 驱动 rotate-180/rotate-0", () => {
  // 抓 chevron 容器 span 的 JSX 块：通过 ref={chevronRef} 锚点定位起始 <span，
  // 再匹配下一个 </span>，避免 JSX 嵌套导致单正则跨多个 span。
  const chevronRefIdx = panelSource.indexOf("ref={chevronRef}");
  assert.ok(chevronRefIdx > 0, "panel source must contain ref={chevronRef}");
  const beforeChevron = panelSource.slice(0, chevronRefIdx);
  const lastSpanStart = beforeChevron.lastIndexOf("<span");
  assert.ok(lastSpanStart > 0, "expected a <span tag before ref={chevronRef}");
  const closeSpanIdx = panelSource.indexOf("</span>", chevronRefIdx);
  assert.ok(closeSpanIdx > chevronRefIdx, "expected a </span> closing tag after ref={chevronRef}");
  const block = panelSource.slice(lastSpanStart, closeSpanIdx + "</span>".length);

  // 必须暴露 data-chevron-expanded 供 AX / CUA driver 验证。
  assert.ok(
    /data-chevron-expanded=\{logExpanded\s*\?\s*"true"\s*:\s*"false"\}/.test(block),
    `chevron span missing data-chevron-expanded attribute: ${block.slice(0, 200)}`,
  );
  // 必须用 className 切换 rotate-180（不依赖 inline style.transform）。
  assert.ok(
    /className=\{cn\([\s\S]*?logExpanded\s*\?\s*"rotate-180"\s*:\s*"rotate-0"[\s\S]*?\)\s*\}/.test(
      block,
    ),
    `chevron span must toggle rotate-180 via className: ${block.slice(0, 200)}`,
  );
  // 必须有 Tailwind transition + duration 类（让 CSS transition 管线推进旋转）。
  assert.ok(
    /transition-transform/.test(block) && /duration-150/.test(block),
    `chevron span must declare transition-transform + duration-150: ${block.slice(0, 200)}`,
  );
  // 不允许再有 inline style.transform / style.transition（CUA-044 关键要求）。
  assert.ok(
    !/style=\{\{[\s\S]*?transform:\s*logExpanded/.test(block),
    `chevron span still has inline style.transform — CUA-044 forbids it: ${block.slice(0, 200)}`,
  );
  assert.ok(
    !/style=\{\{[\s\S]*?transition:\s*"transform\s+150ms/.test(block),
    `chevron span still has inline style.transition — should use Tailwind classes: ${block.slice(0, 200)}`,
  );
});

test("CUA-044 静态源码: 必须用 useLayoutEffect + offsetWidth 强制 layout flush", () => {
  // 必须有 chevronRef（指向 chevron span）。
  assert.ok(
    /chevronRef\s*=\s*useRef<HTMLSpanElement[^>]*>/.test(panelSource),
    `panel is missing chevronRef for layout flush anchor`,
  );
  // 必须有 useLayoutEffect 读 offsetWidth 强制 reflow。
  assert.ok(
    /useLayoutEffect\(\(\)\s*=>\s*\{[\s\S]*?offsetWidth[\s\S]*?\}\s*,\s*\[logExpanded\]\)/.test(
      panelSource,
    ),
    `panel is missing useLayoutEffect + offsetWidth flush`,
  );
});

test("CUA-044 静态源码: 必须移除 WAAPI .animate(...) 与旧的 inline-style 注释锚点", () => {
  assert.ok(
    !/\.animate\(/.test(panelSource),
    `panel still calls .animate(...) on an element — should switch to className: ${
      panelSource.match(/[^\n]*\.animate\([^\n]*/)?.[0]?.slice(0, 200) ?? ""
    }`,
  );
  // 不允许再有「CUA-041」注释锚点（CUA-041 是被 CUA-042 取代的 WAAPI 路径）；
  // CUA-042 可以出现在注释里作为 inline-style 路径被否决的历史，但本测试只
  // 校验 WAAPI 路径已彻底移除。
  assert.ok(
    !/CUA-041/.test(panelSource),
    `panel still references CUA-041 — should be CUA-044 now`,
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
 * 最小复刻 CuaInstallerPanel 的 chevron span（CUA-044 className 驱动版）：
 * 用 React state 直接驱动 className 上的 rotate-180 / rotate-0 切换。
 */
function ChevronSpan({ expanded }) {
  return React.createElement(
    "span",
    {
      "data-chevron-expanded": expanded ? "true" : "false",
      className: [
        "inline-flex",
        "transition-transform",
        "duration-150",
        expanded ? "rotate-180" : "rotate-0",
      ]
        .filter(Boolean)
        .join(" "),
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

function readClasses(span) {
  return (span.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

test("CUA-044 运行时: 收起时 chevron span 有 rotate-0、无 rotate-180", async () => {
  await setExpanded(false);
  const span = container.querySelector("span");
  assert.ok(span, "chevron span should be in DOM");
  assert.equal(span.getAttribute("data-chevron-expanded"), "false");
  const classes = readClasses(span);
  assert.ok(
    classes.includes("rotate-0"),
    `chevron span should have rotate-0 when collapsed: ${classes.join(" ")}`,
  );
  assert.ok(
    !classes.includes("rotate-180"),
    `chevron span should NOT have rotate-180 when collapsed: ${classes.join(" ")}`,
  );
  assert.ok(
    classes.includes("transition-transform") && classes.includes("duration-150"),
    `chevron span should declare transition-transform + duration-150: ${classes.join(" ")}`,
  );
});

test("CUA-044 运行时: 展开后 chevron span 有 rotate-180、无 rotate-0", async () => {
  await setExpanded(true);
  const span = container.querySelector("span");
  assert.ok(span);
  assert.equal(span.getAttribute("data-chevron-expanded"), "true");
  const classes = readClasses(span);
  assert.ok(
    classes.includes("rotate-180"),
    `chevron span should have rotate-180 when expanded: ${classes.join(" ")}`,
  );
  assert.ok(
    !classes.includes("rotate-0"),
    `chevron span should NOT have rotate-0 when expanded: ${classes.join(" ")}`,
  );
});

test("CUA-044 运行时: 收起→展开→收起，每次都触发对应方向的 className 切换", async () => {
  await setExpanded(false);
  let classes = readClasses(container.querySelector("span"));
  assert.ok(
    classes.includes("rotate-0") && !classes.includes("rotate-180"),
    `collapsed classes: ${classes.join(" ")}`,
  );

  await setExpanded(true);
  classes = readClasses(container.querySelector("span"));
  assert.ok(
    classes.includes("rotate-180") && !classes.includes("rotate-0"),
    `expanded classes: ${classes.join(" ")}`,
  );

  await setExpanded(false);
  classes = readClasses(container.querySelector("span"));
  assert.ok(
    classes.includes("rotate-0") && !classes.includes("rotate-180"),
    `re-collapsed classes: ${classes.join(" ")}`,
  );
});