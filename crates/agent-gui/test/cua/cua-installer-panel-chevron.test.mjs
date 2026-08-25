/**
 * CUA-041 regression test: CuaInstallerPanel 安装日志折叠按钮 chevron 旋转动画
 *
 * 关键要求：
 *   - chevron span 必须改用 Web Animations API（element.animate(...)）驱动旋转，
 *     而非 inline-style + CSS transition。CUA-041 复现：Tauri WebView（WKWebView）
 *     中，async setState 后再 click 时 inline-style transition 不推进，
 *     computed transform 停在 matrix(1,0,0,1,0,0)。
 *   - expand 时 keyframes = [{rotate(0deg)}, {rotate(180deg)}]
 *   - collapse 时 keyframes = [{rotate(180deg)}, {rotate(0deg)}]
 *   - duration = 150ms
 *   - chevron span 不再依赖 inline style.transform / style.transition
 *
 * 为什么走 Web Animations API 而不是 CSS transition：
 *   - CUA-038 用 Tailwind .rotate-180 + .transition-transform，卡在 currentTime=0；
 *   - CUA-039 切到 inline style.transform + transition: "transform 150ms"，但
 *     WKWebView 在 async setState 后触发 transition 不可靠。
 *   - element.animate(...) 直接驱动动画，不依赖 CSS transition 管线。
 *
 * 验证策略（两层）：
 *   1. **静态源码检查**：grep 确认 CuaInstallerPanel.tsx 已切到 Web Animations API：
 *      - chevron span 有 ref + data-chevron-expanded 属性；
 *      - 不再有 inline style.transform / style.transition；
 *      - useEffect 用 chevronRef.current.animate(...) 调动画，duration: 150。
 *   2. **运行时 React 行为**：用 React 在 jsdom 下挂载一个最小复刻 chevron span，
 *      stub Element.prototype.animate 收集调用参数。
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

test("CUA-041 静态源码: chevron span 必须使用 ref + data-chevron-expanded，不再用 inline style.transform/transition", () => {
  // 抓 chevron 容器 span 的 JSX 块：ref={chevronRef} 与 data-chevron-expanded 是新特征。
  const chevronBlock = panelSource.match(
    /<span\s*\n\s*ref=\{chevronRef\}[\s\S]*?<\/span>/,
  );
  assert.ok(
    chevronBlock,
    "expected chevron span to use ref={chevronRef} + data-chevron-expanded",
  );
  const block = chevronBlock[0];

  // 必须绑定 chevronRef。
  assert.ok(
    /ref=\{chevronRef\}/.test(block),
    `chevron span missing ref={chevronRef}: ${block.slice(0, 200)}`,
  );
  // 必须暴露 data-chevron-expanded 供 AX / CUA driver 验证。
  assert.ok(
    /data-chevron-expanded=\{logExpanded\s*\?\s*"true"\s*:\s*"false"\}/.test(block),
    `chevron span missing data-chevron-expanded attribute: ${block.slice(0, 200)}`,
  );
  // CUA-041 修复不允许再依赖 inline style.transform——正是这个 inline-style
  // 路径在 WKWebView async setState 后 click 卡死。
  assert.ok(
    !/style=\{\{[\s\S]*?transform:[\s\S]*?\}\s*\}/.test(block),
    `chevron span still uses inline style.transform — would re-trigger CUA-041: ${block.slice(0, 200)}`,
  );
  // CUA-041 修复不允许再写 inline transition。
  assert.ok(
    !/style=\{\{[\s\S]*?transition:[\s\S]*?\}\s*\}/.test(block),
    `chevron span still uses inline style.transition — should switch to element.animate(): ${block.slice(0, 200)}`,
  );
  // 不允许再依赖 Tailwind 的 rotate-180 class（CUA-038/039 双重回归保护）。
  assert.ok(
    !block.includes("rotate-180"),
    `chevron span still uses 'rotate-180' class — switch to Web Animations API: ${block.slice(0, 200)}`,
  );
  assert.ok(
    !block.includes("transition-transform"),
    `chevron span still uses 'transition-transform' Tailwind class — switch to element.animate(): ${block.slice(0, 200)}`,
  );
});

test("CUA-041 静态源码: 必须有 useEffect 用 el.animate(...) 驱动旋转，duration: 150", () => {
  // 抓用 chevronRef 的 useEffect 块，验证其调用 element.animate(...)。
  const effectBlock = panelSource.match(
    /useEffect\(\(\)\s*=>\s*\{[\s\S]*?chevronRef\.current[\s\S]*?\}\s*,\s*\[logExpanded\]\)/,
  );
  assert.ok(
    effectBlock,
    "expected a useEffect watching [logExpanded] that calls chevronRef.current.animate(...)",
  );
  const block = effectBlock[0];

  // 必须用 element.animate(...)。
  assert.ok(
    /\.animate\(/.test(block),
    `chevron animation effect should call .animate(...): ${block.slice(0, 200)}`,
  );
  // 必须包含 expand 路径 keyframes（0 → 180）。
  assert.ok(
    /\{\s*transform:\s*"rotate\(0deg\)"\s*\}\s*,\s*\{\s*transform:\s*"rotate\(180deg\)"\s*\}/.test(block),
    `expand animation keyframes missing: ${block.slice(0, 200)}`,
  );
  // 必须包含 collapse 路径 keyframes（180 → 0）。
  assert.ok(
    /\{\s*transform:\s*"rotate\(180deg\)"\s*\}\s*,\s*\{\s*transform:\s*"rotate\(0deg\)"\s*\}/.test(block),
    `collapse animation keyframes missing: ${block.slice(0, 200)}`,
  );
  // duration 必须为 150ms。
  assert.ok(
    /duration:\s*150/.test(block),
    `chevron animation duration should be 150ms: ${block.slice(0, 200)}`,
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

// jsdom 30 不实现 Web Animations API；注入最小 stub 仅用于「验证 animate 被调用、参数正确」。
const animationCalls = [];
const ElementProto = dom.window.Element.prototype;
ElementProto.animate = function (keyframes, options) {
  const call = { target: this, keyframes, options };
  animationCalls.push(call);
  this._animations = this._animations || [];
  const anim = {
    playState: "running",
    cancel() {
      this.playState = "cancelled";
    },
  };
  this._animations.push(anim);
  return anim;
};
ElementProto.getAnimations = function () {
  return (this._animations || []).filter((a) => a.playState === "running");
};

const req = createRequire(import.meta.url);
const React = req("react");
const ReactDOMClient = req("react-dom/client");

/**
 * 最小复刻 CuaInstallerPanel 的 chevron span + animation effect：
 * 用 ref 绑定 span，useEffect 监听 expanded 调 element.animate(...)。
 * 验证该模式在浏览器侧真的会按 expand/collapse 触发对应 keyframes 的动画。
 */
function ChevronSpan({ expanded }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    for (const a of el.getAnimations()) a.cancel();
    const keyframes = expanded
      ? [{ transform: "rotate(0deg)" }, { transform: "rotate(180deg)" }]
      : [{ transform: "rotate(180deg)" }, { transform: "rotate(0deg)" }];
    el.animate(keyframes, { duration: 150, easing: "ease", fill: "forwards" });
    return () => {
      for (const a of el.getAnimations()) a.cancel();
    };
  }, [expanded]);
  return React.createElement(
    "span",
    {
      ref,
      "data-chevron-expanded": expanded ? "true" : "false",
    },
    React.createElement("svg", { width: 12, height: 12 }),
  );
}

// 共享 root：createRoot 只能对同一个 container 调用一次。
const container = document.getElementById("root");
const root = ReactDOMClient.createRoot(container);

// React 19 的 commit 是异步的；用 React.act 强制同步 flush 避免跨测试脏读。
function setExpanded(expanded) {
  animationCalls.length = 0;
  return React.act(() => {
    root.render(React.createElement(ChevronSpan, { expanded }));
  });
}

test("CUA-041 运行时: 收起时 chevron span 上调 animate，keyframes 180→0，duration 150", async () => {
  await setExpanded(false);
  const span = container.querySelector("span");
  assert.ok(span, "chevron span should be in DOM");
  assert.equal(span.getAttribute("data-chevron-expanded"), "false");
  assert.equal(animationCalls.length, 1, "animate() should be called once when expanded=false");
  const call = animationCalls[0];
  assert.equal(call.keyframes[0].transform, "rotate(180deg)");
  assert.equal(call.keyframes[1].transform, "rotate(0deg)");
  assert.equal(call.options.duration, 150);
});

test("CUA-041 运行时: 展开后 chevron span 上调 animate，keyframes 0→180，duration 150", async () => {
  await setExpanded(true);
  const span = container.querySelector("span");
  assert.ok(span);
  assert.equal(span.getAttribute("data-chevron-expanded"), "true");
  assert.equal(animationCalls.length, 1, "animate() should be called once when expanded=true");
  const call = animationCalls[0];
  assert.equal(call.keyframes[0].transform, "rotate(0deg)");
  assert.equal(call.keyframes[1].transform, "rotate(180deg)");
  assert.equal(call.options.duration, 150);
});

test("CUA-041 运行时: 收起→展开→收起，每次都触发对应方向的 animate 调用", async () => {
  await setExpanded(false);
  assert.equal(animationCalls[0].keyframes[0].transform, "rotate(180deg)");
  assert.equal(animationCalls[0].keyframes[1].transform, "rotate(0deg)");

  await setExpanded(true);
  assert.equal(animationCalls[0].keyframes[0].transform, "rotate(0deg)");
  assert.equal(animationCalls[0].keyframes[1].transform, "rotate(180deg)");

  await setExpanded(false);
  assert.equal(animationCalls[0].keyframes[0].transform, "rotate(180deg)");
  assert.equal(animationCalls[0].keyframes[1].transform, "rotate(0deg)");
});