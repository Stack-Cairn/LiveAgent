import assert from "node:assert/strict";
import test, { before } from "node:test";
import { renderComposerQueue } from "../helpers/composer-queue-render.mjs";
import { edgeMeasureSkip as skip, measureInEdge } from "../helpers/edge-measure.mjs";

// 真实几何：目标栏与等待队列在最窄 Pane（320）到宽屏（1280）下的排布。
// 目标栏一行 = 图标 + 状态标签 + 目标正文 + 按钮；队列项 = 序号 + 预览 + 附件数 + 按钮。

const MEASURE = `(() => {
  const r = (el) => el.getBoundingClientRect();
  const goal = document.querySelector("[data-composer-goal-bar]");
  const [, label, text] = goal.firstElementChild.children;
  const right = r(goal).right;
  const buttons = [...goal.querySelectorAll("button")];
  const item = document.querySelector("ul.chat-queue-scroll li");
  const countRow = item.querySelector("div");
  const [preview, count] = countRow.children;
  const root = document.documentElement;
  return {
    overflowX: root.scrollWidth - root.clientWidth,
    buttonsOutside: Math.max(0, ...buttons.map((b) => r(b).right - right)),
    label: { text: label.textContent, cw: label.clientWidth, sw: label.scrollWidth },
    textWidth: r(text).width,
    count: { text: count.textContent, cw: count.clientWidth, sw: count.scrollWidth },
    previewWidth: r(preview).width,
    countRowWidth: countRow.clientWidth,
  };
})()`;

const GOALS = {
  active: { goal: "Ship the queue panel fix", status: "active", round: 2, maxRounds: 10 },
  waiting: {
    goal: "Ship the queue panel fix",
    status: "paused",
    reason: "awaiting_input",
    round: 2,
    maxRounds: 10,
  },
};
const QUEUE = [
  { id: "q1", previewText: "Refactor the settings page and add tests", fileCount: 12 },
  { id: "q2", previewText: "Summarize the diff for review", fileCount: 0 },
];
const STATES = [
  { lang: "en-US", goal: "active" },
  { lang: "en-US", goal: "waiting" },
  { lang: "zh-CN", goal: "active" },
  { lang: "zh-CN", goal: "waiting" },
  { lang: "en-US", goal: "active", editing: true },
];
const CASES = ["desktop", "web"].flatMap((surface) =>
  STATES.flatMap((state) => [1280, 390, 320].map((width) => ({ surface, width, ...state }))),
);
const key = (c) => `${c.surface}|${c.lang}|${c.goal}${c.editing ? "+edit" : ""}|${c.width}`;
let results = new Map();

before(async () => {
  if (skip) return;
  const markup = new Map();
  for (const c of CASES) {
    const k = key({ ...c, width: 0 });
    if (markup.has(k)) continue;
    const { html } = await renderComposerQueue({
      surface: c.surface,
      lang: c.lang,
      withGoal: true,
      goalState: GOALS[c.goal],
      goalEditing: Boolean(c.editing),
      queuedTurns: QUEUE,
    });
    markup.set(k, html);
  }
  results = await measureInEdge(
    CASES.map((c) => ({
      key: key(c),
      surface: c.surface,
      width: c.width,
      html: markup.get(key({ ...c, width: 0 })),
    })),
    MEASURE,
  );
});

test("goal bar actions stay inside the bar and the page never scrolls sideways", { skip }, () => {
  for (const c of CASES) {
    const m = results.get(key(c));
    assert.ok(m.overflowX <= 0 && m.buttonsOutside <= 0.5, `${key(c)}: ${JSON.stringify(m)}`);
  }
});

test("goal text keeps a readable width even in the narrowest pane", { skip }, () => {
  for (const c of CASES) {
    const m = results.get(key(c));
    // 40px ≈ 三个 12px 汉字或一个短英文单词：至少能认出是哪个目标。
    assert.ok(m.textWidth >= 40, `${key(c)}: goal text ${m.textWidth}px ${JSON.stringify(m.label)}`);
  }
});

test("the goal state label is shown in full outside the narrowest pane", { skip }, () => {
  for (const c of CASES.filter((x) => x.width > 320)) {
    const m = results.get(key(c));
    assert.ok(m.label.sw <= m.label.cw, `${key(c)}: ${JSON.stringify(m.label)}`);
  }
});

test("a two-digit attachment count is not clipped on wide screens", { skip }, () => {
  for (const c of CASES.filter((x) => x.width === 1280)) {
    const m = results.get(key(c));
    assert.ok(m.count.sw <= m.count.cw, `${key(c)}: ${JSON.stringify(m.count)}`);
  }
});

test("in the narrowest pane the attachment count yields half the row to the preview", { skip }, () => {
  for (const c of CASES.filter((x) => x.width === 320)) {
    const m = results.get(key(c));
    // 预览自己有 min-w-6（24px）保底；这里要的是附件数主动让位：不超过一半，预览多于保底。
    assert.ok(
      m.count.cw <= m.countRowWidth / 2 + 0.5 && m.previewWidth > 24,
      `${key(c)}: row ${m.countRowWidth}px, preview ${m.previewWidth}px, count ${JSON.stringify(m.count)}`,
    );
  }
});
