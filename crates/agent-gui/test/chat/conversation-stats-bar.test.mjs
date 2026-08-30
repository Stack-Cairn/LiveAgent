import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// ConversationStatsBar 组件行为验收
// (docs/design/composer-context-stats-bar.md §4.2、§9 组件层)：
// 空态占位（保留高度，不 null）、四档容器收缩、≈ 前缀、role="status" 完整 aria-label、
// 运行中心跳折算、approvalBar 互斥（插槽源码断言）。

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

const { ConversationStatsBar } = env.loadModule(
  "@liveagent/ui/components/chat/ConversationStatsBar.tsx",
);
const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
const { EMPTY_CONVERSATION_STATS } = env.loadModule("@liveagent/ui/lib/trajectory/stats.ts");

const enLocale = { locale: "en-US", t: (key) => translate(key, "en-US") };

function sampleStats(overrides = {}) {
  return {
    ...EMPTY_CONVERSATION_STATS,
    turns: 51,
    steps: 672,
    llmMs: 754_000,
    toolMs: 42_000,
    ttftAvgMs: 20_900,
    ttftSamples: 300,
    decodeTokPerSec: 170.4,
    cacheHitRatio: 0.85,
    inputTokens: 111_000_000,
    outputTokens: 2_300_000,
    ...overrides,
  };
}

async function render(statsValue, extraProps = {}) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        LocaleContext.Provider,
        { value: enLocale },
        React.createElement(ConversationStatsBar, { stats: statsValue, ...extraProps }),
      ),
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

test("空态与全零读数渲染为占位容器（保留高度，避免统计浮现时布局跳动）", async () => {
  for (const statsValue of [null, EMPTY_CONVERSATION_STATS]) {
    const { container, unmount } = await render(statsValue);
    const placeholder = container.firstElementChild;
    assert.ok(placeholder, `stats=${JSON.stringify(statsValue)} 应渲染占位容器`);
    assert.equal(placeholder.getAttribute("role"), null, "占位态不带 role=status");
    assert.match(placeholder.className, /h-5/, "占位容器高度需与有数据态一致");
    await unmount();
  }
});

test("完整读数：role=status + aria-label 拼出全部分组", async () => {
  const { container, unmount } = await render(sampleStats());
  const bar = container.querySelector('[role="status"]');
  assert.ok(bar, "必须有 role=status 容器");
  assert.equal(bar.getAttribute("aria-live"), "off", "数字变化不做 aria-live 播报");

  const label = bar.getAttribute("aria-label");
  assert.equal(
    label,
    "51 turns · 672 steps ｜ LLM 12m34s · Tools 42s ｜ In 111M tok · Out 2.3M tok ｜ Avg TTFT 20.9s · 170 tok/s · Cache hit 85%",
  );
  await unmount();
});

test("容器分档：时间/token/性能分组分别挂 28/40/52rem 断点", async () => {
  const { container, unmount } = await render(sampleStats());
  // 按 data-stats-group 定位，不依赖 DOM 层级：整条可点击时会多包一层 button。
  const classesOf = (group) =>
    container.querySelector(`[data-stats-group="${group}"]`)?.className ?? "";

  assert.match(classesOf("scale"), /flex/);
  assert.doesNotMatch(classesOf("scale"), /@min-/, "轮·步恒显，不挂断点");
  assert.match(classesOf("time"), /hidden @min-\[28rem\]:flex/);
  assert.match(classesOf("tokens"), /hidden @min-\[40rem\]:flex/);
  assert.match(classesOf("perf"), /hidden @min-\[52rem\]:flex/);
  await unmount();
});

test("提供 contextWindow 时 context 分组恒显，与 scale 同级不挂断点", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 50_000,
    contextWindow: 200_000,
  });
  const label = container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.equal(
    label,
    "51 turns · 672 steps ｜ Context 25% ｜ LLM 12m34s · Tools 42s ｜ In 111M tok · Out 2.3M tok ｜ Avg TTFT 20.9s · 170 tok/s · Cache hit 85%",
  );
  const contextEl = container.querySelector('[data-stats-group="context"]');
  assert.ok(contextEl, "应渲染 context 分组");
  assert.match(contextEl.className, /flex/);
  assert.doesNotMatch(contextEl.className, /@min-/, "上下文占用恒显，不挂断点，移动端才能露出");
  await unmount();
});

test("未提供合法 contextWindow 时 context 分组不存在（不影响其余分组的 aria-label）", async () => {
  for (const contextWindow of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { container, unmount } = await render(sampleStats(), {
      contextUsageTokens: 50_000,
      contextWindow,
    });
    const label = container.querySelector('[role="status"]').getAttribute("aria-label");
    assert.doesNotMatch(
      label,
      /Context/,
      `contextWindow=${contextWindow} 时不应出现 context 分组，实际：${label}`,
    );
    assert.equal(container.querySelector('[data-stats-group="context"]'), null);
    await unmount();
  }
});

test("contextWindow 有效但 contextUsageTokens 缺省时 context 分组按 0% 展示", async () => {
  const { container, unmount } = await render(sampleStats(), { contextWindow: 200_000 });
  const label = container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.match(label, /Context 0%/, `未提供 tokens 时应按 0% 展示：${label}`);
  await unmount();
});

test("approximate 读数带 ≈ 前缀；精确读数不带", async () => {
  const approx = await render(sampleStats({ approximate: true }));
  const label = approx.container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.ok(label.startsWith("≈ "), `近似读数应带前缀，实际：${label}`);
  await approx.unmount();

  const exact = await render(sampleStats());
  const exactLabel = exact.container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.equal(exactLabel.startsWith("≈"), false);
  await exact.unmount();
});

test("provider 未返回 usage 时 token 与性能分组整组隐藏", async () => {
  const { container, unmount } = await render(
    sampleStats({
      ttftAvgMs: null,
      decodeTokPerSec: null,
      cacheHitRatio: null,
      inputTokens: 0,
      outputTokens: 0,
    }),
  );
  const label = container.querySelector('[role="status"]').getAttribute("aria-label");
  assert.equal(label, "51 turns · 672 steps ｜ LLM 12m34s · Tools 42s");
  await unmount();
});

test("运行中把 RunningSinceAt 折算进显示值并启动心跳", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;
  globalThis.setInterval = (...args) => {
    intervalCount += 1;
    return originalSetInterval(...args);
  };
  try {
    const startedAt = Date.now() - 90_000;
    const { container, unmount } = await render(
      sampleStats({
        llmMs: 60_000,
        llmRunningSinceAt: startedAt,
        toolMs: 0,
        toolRunningSinceAt: null,
      }),
    );
    const label = container.querySelector('[role="status"]').getAttribute("aria-label");
    // 60s 已完成 + 约 90s 运行中 ≈ 2m30s；容许秒级误差。
    assert.match(label, /LLM 2m(29|30|31)s/, `折算后的 LLM 时长不对：${label}`);
    assert.equal(intervalCount, 1, "运行中必须注册 1s 心跳");
    await unmount();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("空闲时零定时器：无运行段不注册心跳 interval", async () => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCount = 0;
  globalThis.setInterval = (...args) => {
    intervalCount += 1;
    return originalSetInterval(...args);
  };
  try {
    const { unmount } = await render(sampleStats());
    assert.equal(intervalCount, 0, "无 RunningSinceAt 时不应注册任何 interval");
    await unmount();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test("占用 ≥50% 且提供 onManualCompactConfirm 时整条渲染为确认弹层触发按钮", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 150_000,
    contextWindow: 200_000, // 75%，越过 canManualCompact 的 50% 门槛
    onManualCompactConfirm: () => {},
  });

  const button = container.querySelector("button");
  assert.ok(button, "应渲染为可点击按钮");
  assert.equal(button.getAttribute("aria-label"), "Compact context manually?");
  // 读数由外层 role=status 播报，内层行对辅助技术隐藏，避免同串数字读两遍。
  assert.equal(button.querySelector("[aria-hidden]")?.getAttribute("aria-hidden"), "true");
  // Base UI Popover 在此 jsdom 测试环境下点击展开会抛错（ContextUsageRing 用
  // 同样的 ConfirmActionPopover 复现同一崩溃，与本次改动无关，context-usage.
  // test.mjs 也因此从未真的点开过那层），故不在此驱动真实点击；用下面的源码
  // 断言代替，验证压缩只能从弹层内部确认触发，不会被整行点击绕过。
  const source = readFileSync(
    new URL("../../../agent-ui/src/components/chat/ConversationStatsBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /onConfirm=\{\(\) => void onManualCompactConfirm\?\.\(\)\}/,
    "压缩必须经 ConfirmActionPopover 的 onConfirm 触发，而不是按钮 onClick 直接调用",
  );
  assert.match(
    source,
    /<button[\s\S]*?onClick=\{open\}/,
    "触发按钮的 onClick 只应打开确认弹层（open），不能直接调用压缩回调",
  );

  await unmount();
});

test("占用 <50% 时是纯展示，不渲染按钮（即使提供了 onManualCompactConfirm）", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 50_000,
    contextWindow: 200_000, // 25%，未达 canManualCompact 的 50% 门槛
    onManualCompactConfirm: () => {},
  });
  assert.equal(container.querySelector("button"), null, "占用未达门槛时不应有按钮");
  // 分组仍在，只是不可点。
  assert.ok(container.querySelector('[data-stats-group="scale"]'));
  await unmount();
});

test("未提供 onManualCompactConfirm 时是纯展示，不渲染按钮（即使占用达标）", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 150_000,
    contextWindow: 200_000,
  });
  assert.equal(container.querySelector("button"), null, "未提供回调时不应有按钮");
  await unmount();
});

test("manualCompactBlocked 为 true 时即使占用达标也不可点", async () => {
  const { container, unmount } = await render(sampleStats(), {
    contextUsageTokens: 150_000,
    contextWindow: 200_000,
    onManualCompactConfirm: () => {},
    manualCompactBlocked: true,
  });
  assert.equal(container.querySelector("button"), null, "压缩被阻塞时不应有按钮");
  await unmount();
});

test("压缩次数只在 tooltip 露出，不占用单行宽度", async () => {
  const withCompactions = await render(sampleStats({ compactions: 3 }));
  const label = withCompactions.container
    .querySelector('[role="status"]')
    .getAttribute("aria-label");
  assert.doesNotMatch(label, /compactions/, "单行不展示压缩次数");
  // tooltip 内容由 Base UI 按需挂载，这里断言其数据来源：hover 前不在 DOM 里。
  assert.equal(
    withCompactions.container.textContent.includes("3 compactions"),
    false,
    "未悬停时 tooltip 内容不应已渲染",
  );
  await withCompactions.unmount();
});

test("approvalBar 可见时状态栏让位（ChatComposerBar 插槽互斥）", () => {
  const composerSource = readFileSync(
    new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    composerSource,
    /\{statsBar && approvalBar == null && contextDisplayMode !== "ring" \? statsBar : null\}/,
    "statsBar 插槽必须保持 approvalBar 互斥，且只在 ring 展示模式下不挂载（§4.7 三档）",
  );
});
