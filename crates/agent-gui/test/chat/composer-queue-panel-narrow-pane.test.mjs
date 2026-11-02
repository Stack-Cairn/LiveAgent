import assert from "node:assert/strict";
import test, { before } from "node:test";
import { edgeMeasureSkip as skip, measureInEdge } from "../helpers/edge-measure.mjs";
import { renderComposerQueue } from "../helpers/composer-queue-render.mjs";

// 真实几何：把真实 ChatComposerBar 的渲染结果套上构建产物 CSS，在无头 Edge 里量。
// 320 = MIN_CONVERSATION_PANE_WIDTH（分屏最窄 Pane）；桌面面层 px-5 → 卡片 280px。

const MEASURE = `(() => {
  const rect = (el) => el.getBoundingClientRect();
  const card = document.querySelector(".composer-glass-card");
  const panel = document.querySelector("ul.chat-queue-scroll").closest(".border-b-0");
  const goal = document.querySelector("[data-composer-goal-bar]");
  const title = panel.querySelector("button span");
  const preview = panel.querySelector("li div span");
  return {
    cardRadius: parseFloat(getComputedStyle(card).borderTopLeftRadius),
    insetLeft: rect(panel).left - rect(card).left,
    insetRight: rect(card).right - rect(panel).right,
    panelTopRadius: parseFloat(getComputedStyle(panel).borderTopLeftRadius),
    goalFlushAbove: goal ? Math.abs(rect(goal).bottom - rect(panel).top) < 0.5 && Math.abs(rect(goal).left - rect(panel).left) < 0.5 : false,
    title: { text: title.textContent, cw: title.clientWidth, sw: title.scrollWidth },
    preview: { cw: preview.clientWidth, sw: preview.scrollWidth },
  };
})()`;

const CASES = [
  ...["desktop", "web"].flatMap((surface) =>
    [1280, 390, 320].map((width) => ({ surface, withGoal: false, width })),
  ),
  { surface: "desktop", withGoal: true, width: 1280 },
];
const key = ({ surface, withGoal, width }) => `${surface}|${withGoal}|${width}`;
let results = new Map();

before(async () => {
  if (skip) return;
  const markup = new Map();
  for (const c of CASES) {
    const k = `${c.surface}|${c.withGoal}`;
    if (!markup.has(k)) markup.set(k, (await renderComposerQueue(c)).html);
  }
  results = await measureInEdge(
    CASES.map((c) => ({
      key: key(c),
      surface: c.surface,
      width: c.width,
      html: markup.get(`${c.surface}|${c.withGoal}`),
    })),
    MEASURE,
  );
});

test("queue panel clears the composer corner radius in GUI and WebUI, wide and narrow", { skip }, () => {
  for (const c of CASES.filter((x) => !x.withGoal)) {
    const m = results.get(key(c));
    assert.ok(m.insetLeft > m.cardRadius && m.insetRight > m.cardRadius, `${key(c)}: ${JSON.stringify(m)}`);
    // An empty goal-bar host must not flatten the queue panel's own top corners.
    assert.ok(m.panelTopRadius > 0, `${key(c)}: queue alone keeps its top radius ${JSON.stringify(m)}`);
  }
});

test("at the narrowest GUI pane the queue still shows its count and some preview text", { skip }, () => {
  const m = results.get(key({ surface: "desktop", withGoal: false, width: 320 }));
  // 改动前同一场景：标题 41/41px 完整、首项预览 46px；阈值 24px ≈ 两个 12px 汉字。
  const summary = `title "${m.title.text}" ${m.title.cw}/${m.title.sw}px, first preview ${m.preview.cw}px`;
  assert.ok(m.title.sw <= m.title.cw && m.preview.cw >= 24, summary);
});

test("goal bar flush on the queue panel leaves no rounded notch at the seam", { skip }, () => {
  const m = results.get(key({ surface: "desktop", withGoal: true, width: 1280 }));
  assert.ok(m.goalFlushAbove, `precondition: goal bar flush and aligned above the panel ${JSON.stringify(m)}`);
  assert.equal(m.panelTopRadius, 0, JSON.stringify(m));
});
