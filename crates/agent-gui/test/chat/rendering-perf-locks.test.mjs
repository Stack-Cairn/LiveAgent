import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 渲染进程长会话性能的反漂移锁（见 issue：3.7 小时会话把 WebContent 顶到 88~124% CPU）。
//
// 1. Intl formatter 必须按 (variant, locale) 复用：`sample` 抓到的热点栈是
//    timerFired → JSEventListener::handleEvent → constructIntlDateTimeFormat →
//    udat_open，即渲染/tick 路径里反复新建 formatter（每次一次 ICU 初始化）。
// 2. 可见性判定必须同时认 `document.hidden` 与 `visibilityState`：Tauri/WKWebView
//    后台启动出现过两者不同步；据此收敛的定时器不能在隐藏时继续跑。
const loader = createTsModuleLoader();
const intl = loader.loadModule("@liveagent/ui/lib/shared/intlFormatters.ts");
const visibility = loader.loadModule("@liveagent/ui/lib/shared/documentVisibility.ts");
const stats = loader.loadModule("@liveagent/ui/lib/trajectory/stats.ts");
const presentation = loader.loadModule("@liveagent/ui/lib/trajectory/presentation.ts");

/** 统计期间构造了多少个 Intl 实例。 */
function countConstructions(kind, run) {
  const Original = Intl[kind];
  let built = 0;
  class Counting extends Original {
    constructor(...args) {
      super(...args);
      built += 1;
    }
  }
  Intl[kind] = Counting;
  try {
    const result = run();
    return { built, result };
  } finally {
    Intl[kind] = Original;
  }
}

test("cachedNumberFormat constructs once per variant and locale", () => {
  intl.clearIntlFormatterCaches();
  const { built } = countConstructions("NumberFormat", () => {
    for (let index = 0; index < 25; index += 1) {
      intl.cachedNumberFormat("zh-CN", "integer-0", { maximumFractionDigits: 0 }).format(index);
    }
    // 同一个 variant 换 locale 是新的一档。
    intl.cachedNumberFormat("en-US", "integer-0", { maximumFractionDigits: 0 }).format(1);
    // 同一个 locale 换 variant 也是新的一档。
    intl.cachedNumberFormat("zh-CN", "decimal-2", { maximumFractionDigits: 2 }).format(1);
  });
  assert.equal(built, 3);
});

test("cachedNumberFormat returns the same instance for repeated lookups", () => {
  intl.clearIntlFormatterCaches();
  const first = intl.cachedNumberFormat("zh-CN", "count");
  const second = intl.cachedNumberFormat("zh-CN", "count");
  assert.equal(first, second);
});

test("cached formatters keep the uncached formatting output", () => {
  intl.clearIntlFormatterCaches();
  const cases = [
    { locale: "zh-CN", variant: "integer-0", options: { maximumFractionDigits: 0 }, value: 12345.678 },
    { locale: "en-US", variant: "decimal-2", options: { maximumFractionDigits: 2 }, value: 1.239 },
  ];
  for (const item of cases) {
    const expected = new Intl.NumberFormat(item.locale, item.options).format(item.value);
    assert.equal(intl.cachedNumberFormat(item.locale, item.variant, item.options).format(item.value), expected);
  }

  const stamp = Date.UTC(2026, 8, 12, 3, 4, 5);
  const expectedClock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(new Date(stamp));
  assert.equal(
    intl
      .cachedDateTimeFormat("zh-CN", "clock-ms", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      })
      .format(new Date(stamp)),
    expectedClock,
  );
});

test("trajectory stats formatters reuse one formatter per locale", () => {
  intl.clearIntlFormatterCaches();
  const { built, result } = countConstructions("NumberFormat", () => {
    const values = [];
    for (let index = 0; index < 20; index += 1) {
      values.push(stats.formatStatTokens(index * 900, "zh-CN"));
      values.push(stats.formatStatCount(index, "zh-CN"));
    }
    return values;
  });
  // compact-whole / compact-1 / count —— 三档，与调用次数无关。
  assert.equal(built, 3);
  assert.equal(result.length, 40);
});

test("trajectory presentation formatters reuse one formatter per locale", () => {
  intl.clearIntlFormatterCaches();
  const { built } = countConstructions("NumberFormat", () => {
    for (let index = 0; index < 30; index += 1) {
      presentation.formatTrajectoryDuration(index * 120, "zh-CN");
      presentation.formatTrajectoryCount(index, "zh-CN");
    }
  });
  assert.equal(built, 2);
});

test("isDocumentHidden treats both hidden signals as hidden", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    assert.equal(visibility.isDocumentHidden(), false, "no document (plain node) is not hidden");

    globalThis.document = { hidden: true, visibilityState: "visible" };
    assert.equal(visibility.isDocumentHidden(), true, "hidden=true wins over a stale visibilityState");

    globalThis.document = { hidden: false, visibilityState: "hidden" };
    assert.equal(visibility.isDocumentHidden(), true, "visibilityState=hidden counts too");

    globalThis.document = { hidden: false, visibilityState: "visible" };
    assert.equal(visibility.isDocumentHidden(), false);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "document", original);
    } else {
      delete globalThis.document;
    }
  }
});
