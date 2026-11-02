import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { RollingStatText } = env.loadModule("@liveagent/ui/components/chat/RollingStatText.tsx");

async function mount(text) {
  const container = env.dom.window.document.createElement("div");
  env.dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const update = async (value) => {
    await act(async () => root.render(React.createElement(RollingStatText, { text: value })));
  };
  await update(text);
  return {
    container,
    update,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("数字更新保留标签和未变位的节点，仅数字条改变位置", async () => {
  const probe = await mount("Context 12.3% · ↑1.2M");
  try {
    const labels = [...probe.container.querySelectorAll("[data-stat-label]")];
    const digits = [...probe.container.querySelectorAll("[data-current-digit]")];
    const positions = digits.map((digit) => digit.style.transform);
    assert.equal(probe.container.textContent, "Context 12.3% · ↑1.2M");
    await probe.update("Context 12.4% · ↑1.2M");
    assert.equal(probe.container.textContent, "Context 12.4% · ↑1.2M");
    const next = [...probe.container.querySelectorAll("[data-current-digit]")];
    for (let i = 0; i < next.length; i += 1) {
      assert.equal(next[i], digits[i], "数字位更新不能重新挂载");
      assert.equal(next[i].style.transform === positions[i], i !== 2);
    }
    assert.deepEqual([...probe.container.querySelectorAll("[data-stat-label]")], labels);
    assert.equal(next[2].style.transform, "translateY(-4em)");
    assert.equal(probe.container.querySelectorAll("[data-digit]").length, 50);
  } finally {
    await probe.unmount();
  }
});

test("跨位数和单位变化保持右侧数字位身份，数字下降也正确", async () => {
  const probe = await mount("Time 9s");
  try {
    const ones = probe.container.querySelector("[data-current-digit]");
    await probe.update("Time 10s");
    const digits = [...probe.container.querySelectorAll("[data-current-digit]")];
    assert.equal(digits[1], ones);
    assert.equal(probe.container.textContent, "Time 10s");
    await probe.update("Time 2m");
    assert.equal(probe.container.querySelector("[data-current-digit]"), ones);
    assert.equal(ones.style.transform, "translateY(-2em)");
    assert.equal(probe.container.textContent, "Time 2m");
    await probe.update("上下文 0.0%");
    assert.equal(probe.container.textContent, "上下文 0.0%");
  } finally {
    await probe.unmount();
  }
});

test("减少动态偏好禁用数字位移过渡，样式只过渡 transform", () => {
  const css = readFileSync(new URL("../../../agent-ui/src/styles/animations.css", import.meta.url), "utf8");
  assert.match(css, /\.stat-digit-ready\s*\{\s*transition: transform var\(--ui-duration-160ms\) var\(--ease-ui-enter\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.stat-digit-ready\s*\{\s*transition: none;/);
});
