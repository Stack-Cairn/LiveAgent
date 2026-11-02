import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// useConversationStats 的加载/缓存/节流验收
// (docs/design/composer-context-stats-bar.md §4.1 行为 1-5、§9 hook 层)。
// 用真实 react-dom 渲染，宿主 loadWindow 由假实现驱动：首窗 + 后台分页拼接、
// live 与 persisted 重叠去重、authoritativeRevision 失效重载、1s 节流。

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

const { useConversationStats, clearConversationStatsCache, STATS_REBUILD_THROTTLE_MS } =
  env.loadModule("@liveagent/ui/lib/trajectory/useConversationStats.ts");

let clock = 1_000;
function at() {
  clock += 10;
  return clock;
}

/** 一轮完整回合：user → step_start → first_token → step_end → turn_end。 */
function turnEvents(turn, { outputTokens = 100 } = {}) {
  const start = at();
  return [
    { k: "user", t: turn, at: start, mi: turn },
    { k: "step_start", t: turn, s: 1, at: start + 10 },
    { k: "first_token", t: turn, s: 1, at: start + 60 },
    {
      k: "step_end",
      t: turn,
      s: 1,
      at: start + 260,
      st: "complete",
      u: { input: 500, output: outputTokens, cacheRead: 1_500, cacheWrite: 0 },
    },
    { k: "turn_end", t: turn, at: start + 270, st: "complete" },
  ];
}

/** 把事件按 segment 分页的假宿主；页从尾向前给，与后端 loadWindow 语义一致。 */
function createFakeHost(pages, { truncated = false } = {}) {
  const calls = [];
  return {
    calls,
    host: {
      loadWindow: async (conversationId, beforeSegmentIndex) => {
        calls.push({ conversationId, beforeSegmentIndex });
        const index = beforeSegmentIndex === undefined ? pages.length - 1 : beforeSegmentIndex - 1;
        const page = pages[index] ?? [];
        return {
          eventsJson: JSON.stringify(page),
          truncated,
          oldestSegmentIndex: index,
          returnedSegmentCount: 1,
          totalSegmentCount: pages.length,
          hasMoreBefore: index > 0,
        };
      },
    },
  };
}

function mountHook(options) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const seen = { current: null, renders: 0 };
  let setProps;

  function Probe(initial) {
    const [props, update] = React.useState(initial.value);
    setProps = update;
    const result = useConversationStats(props);
    seen.current = result;
    seen.renders += 1;
    return null;
  }

  return {
    seen,
    mount: async () => {
      await act(async () => {
        root.render(React.createElement(Probe, { value: options }));
      });
    },
    update: async (next) => {
      await act(async () => {
        setProps((current) => ({ ...current, ...next }));
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 让排定的 idle/timer 回调跑完；分页是链式排定的，需要多轮。 */
async function drain(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

test("同会话刷新等待期间保留读数，完成后允许历史缩减，切会话不串数据", async () => {
  clearConversationStatsCache();
  let release;
  let delayed = false;
  let pages = [turnEvents(1), turnEvents(2)];
  const host = {
    loadWindow: async () => {
      if (delayed) await new Promise((resolve) => { release = resolve; });
      return {
        eventsJson: JSON.stringify(pages.flat()),
        truncated: false,
        oldestSegmentIndex: 0,
        returnedSegmentCount: 1,
        totalSegmentCount: 1,
        hasMoreBefore: false,
      };
    },
  };
  const probe = mountHook({ conversationId: "refresh-stable", host, liveEvents: [], enabled: true });
  try {
    await probe.mount();
    await drain();
    assert.equal(probe.seen.current.stats.turns, 2);
    delayed = true;
    pages = [turnEvents(1)];
    await probe.update({ authoritativeRevision: 1 });
    assert.equal(probe.seen.current.stats?.turns, 2, "请求返回前不能变成空白或部分读数");
    await act(async () => { release(); });
    await drain();
    assert.equal(probe.seen.current.stats.turns, 1, "新数据必须允许历史截断后的下降");
    pages = [];
    await probe.update({ conversationId: "other-empty" });
    assert.equal(probe.seen.current.stats, null, "切会话不能保留旧会话读数");
    await act(async () => { release(); });
    await drain();
    await probe.update({ enabled: false });
    assert.equal(probe.seen.current.stats, null, "禁用必须清空展示");
  } finally {
    await probe.unmount();
  }
});

test("刷新失败保留上次读数，成功返回空历史时才清空", async () => {
  clearConversationStatsCache();
  let fail = false;
  let empty = false;
  const original = createFakeHost([turnEvents(1)]).host;
  const host = {
    loadWindow: async (...args) => {
      if (fail) throw new Error("测试刷新失败");
      const payload = await original.loadWindow(...args);
      return empty ? { ...payload, eventsJson: "[]" } : payload;
    },
  };
  const probe = mountHook({ conversationId: "refresh-error", host, liveEvents: [], enabled: true });
  const warn = console.warn;
  try {
    await probe.mount();
    await drain();
    fail = true;
    console.warn = () => {};
    await probe.update({ authoritativeRevision: 1 });
    await drain();
    assert.equal(probe.seen.current.stats.turns, 1, "请求失败不能清空旧读数");
    fail = false;
    empty = true;
    await probe.update({ authoritativeRevision: 2 });
    await drain();
    assert.equal(probe.seen.current.stats, null, "成功的空历史不能残留旧读数");
  } finally {
    console.warn = warn;
    await probe.unmount();
  }
});

test("首窗读数立即可用，后台分页把更早的段补齐", async () => {
  clearConversationStatsCache();
  const pages = [turnEvents(1), turnEvents(2), turnEvents(3)];
  const { host, calls } = createFakeHost(pages);
  const probe = mountHook({
    conversationId: "c-paging",
    host,
    liveEvents: [],
    enabled: true,
  });

  await probe.mount();
  await drain();

  assert.equal(calls.length, 3, "三段应各拉一次");
  assert.equal(calls[0].beforeSegmentIndex, undefined, "首窗不带游标");
  assert.deepEqual(
    calls.slice(1).map((call) => call.beforeSegmentIndex),
    [2, 1],
    "后续分页沿 oldestSegmentIndex 向前",
  );
  assert.equal(probe.seen.current.stats.turns, 3);
  assert.equal(probe.seen.current.stats.steps, 3);
  assert.equal(probe.seen.current.stats.approximate, false, "读完全部段后不再是近似值");
  assert.equal(probe.seen.current.loading, false);

  await probe.unmount();
});

test("live 事件与 persisted 重叠时按身份去重，不双算", async () => {
  clearConversationStatsCache();
  const shared = turnEvents(1);
  const { host } = createFakeHost([shared]);
  const probe = mountHook({
    conversationId: "c-overlap",
    host,
    // 整轮事件同时出现在实时通道里，模拟断线重连重放。
    liveEvents: shared,
    enabled: true,
  });

  await probe.mount();
  await drain();

  const stats = probe.seen.current.stats;
  assert.equal(stats.turns, 1, "重放不应把同一轮算两次");
  assert.equal(stats.steps, 1);
  assert.equal(stats.outputTokens, 100, "token 也不能双算");

  await probe.unmount();
});

test("authoritativeRevision 变化丢弃缓存整体重载", async () => {
  clearConversationStatsCache();
  const first = createFakeHost([turnEvents(1), turnEvents(2)]);
  const probe = mountHook({
    conversationId: "c-revision",
    host: first.host,
    liveEvents: [],
    enabled: true,
    authoritativeRevision: 0,
  });

  await probe.mount();
  await drain();
  assert.equal(probe.seen.current.stats.turns, 2);
  const callsBefore = first.calls.length;

  // edit-resend 砍掉第二轮：同一 host 现在只剩一段。
  await probe.update({ authoritativeRevision: 1 });
  await drain();

  assert.ok(first.calls.length > callsBefore, "权威版本变化必须重新拉取");
  assert.equal(probe.seen.current.stats.turns, 2, "读数收敛到重载后的历史");

  await probe.unmount();
});

test("缓存命中时切回同一会话不再打后端", async () => {
  clearConversationStatsCache();
  const { host, calls } = createFakeHost([turnEvents(1)]);
  const first = mountHook({
    conversationId: "c-cache",
    host,
    liveEvents: [],
    enabled: true,
  });
  await first.mount();
  await drain();
  const callsAfterFirst = calls.length;
  await first.unmount();

  const second = mountHook({
    conversationId: "c-cache",
    host,
    liveEvents: [],
    enabled: true,
  });
  await second.mount();
  await drain();

  assert.equal(calls.length, callsAfterFirst, "缓存完整时不应再次分页");
  assert.equal(second.seen.current.stats.turns, 1, "读数直接来自缓存");

  await second.unmount();
});

test("连续 live 通知在 1s 窗口内合并为一次重建", async () => {
  clearConversationStatsCache();
  const { host } = createFakeHost([turnEvents(1)]);
  const probe = mountHook({
    conversationId: "c-throttle",
    host,
    liveEvents: [],
    enabled: true,
  });
  await probe.mount();
  await drain();

  const rendersBefore = probe.seen.renders;
  // 三次不同的 live 快照连续到达：只有第一次立即生效，其余合并进节流窗口。
  await probe.update({ liveEvents: [{ k: "user", t: 9, at: 9_000, mi: 9 }] });
  await probe.update({ liveEvents: [{ k: "user", t: 9, at: 9_000, mi: 9 }, { k: "step_start", t: 9, s: 1, at: 9_010 }] });
  await probe.update({
    liveEvents: [
      { k: "user", t: 9, at: 9_000, mi: 9 },
      { k: "step_start", t: 9, s: 1, at: 9_010 },
      { k: "first_token", t: 9, s: 1, at: 9_060 },
    ],
  });

  const rendersAfterBurst = probe.seen.renders;
  assert.ok(
    rendersAfterBurst - rendersBefore <= 4,
    `节流应压制重建次数，实际新增 ${rendersAfterBurst - rendersBefore}`,
  );

  // 等过节流窗口，待处理的最后一份快照必须补上。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, STATS_REBUILD_THROTTLE_MS + 50));
  });
  assert.equal(probe.seen.current.stats.turns, 2, "窗口结束后读数收敛到最新 live 快照");

  await probe.unmount();
});

test("enabled 为 false 时不加载、读数为 null", async () => {
  clearConversationStatsCache();
  const { host, calls } = createFakeHost([turnEvents(1)]);
  const probe = mountHook({
    conversationId: "c-disabled",
    host,
    liveEvents: [],
    enabled: false,
  });

  await probe.mount();
  await drain();

  assert.equal(calls.length, 0, "禁用时不应打后端");
  assert.equal(probe.seen.current.stats, null);
  assert.equal(probe.seen.current.loading, false);

  await probe.unmount();
});

test("truncated 段让读数保持近似", async () => {
  clearConversationStatsCache();
  const { host } = createFakeHost([turnEvents(1)], { truncated: true });
  const probe = mountHook({
    conversationId: "c-truncated",
    host,
    liveEvents: [],
    enabled: true,
  });

  await probe.mount();
  await drain();

  assert.equal(probe.seen.current.stats.approximate, true);

  await probe.unmount();
});

test("无任何事件的会话读数为 null", async () => {
  clearConversationStatsCache();
  const { host } = createFakeHost([[]]);
  const probe = mountHook({
    conversationId: "c-empty",
    host,
    liveEvents: [],
    enabled: true,
  });

  await probe.mount();
  await drain();

  assert.equal(probe.seen.current.stats, null, "老会话/text 模式整条隐藏");

  await probe.unmount();
});

test("liveOwnership 语义沿用轨迹视图：authoritative 空集收敛僵尸，observed 保持运行", async () => {
  // 持久化里有一个没收尾的 step（进程崩溃遗留）。
  const orphan = [
    { k: "user", t: 1, at: 5_000, mi: 1 },
    { k: "step_start", t: 1, s: 1, at: 5_010 },
  ];

  clearConversationStatsCache();
  const desktop = mountHook({
    conversationId: "c-ownership-desktop",
    host: createFakeHost([orphan]).host,
    liveEvents: [],
    liveOwnership: "authoritative",
    enabled: true,
  });
  await desktop.mount();
  await drain();
  assert.equal(
    desktop.seen.current.stats.llmRunningSinceAt,
    null,
    "桌面端空 live 集是权威证据，遗留 running 收敛为 aborted",
  );
  await desktop.unmount();

  clearConversationStatsCache();
  const web = mountHook({
    conversationId: "c-ownership-web",
    host: createFakeHost([orphan]).host,
    liveEvents: [],
    liveOwnership: "observed",
    enabled: true,
  });
  await web.mount();
  await drain();
  assert.equal(
    web.seen.current.stats.llmRunningSinceAt,
    5_010,
    "观察端未收到实时流之前不判中断，运行段保持",
  );
  await web.unmount();
});

for (const failedCursor of [2, 1]) {
  test(`刷新在游标 ${failedCursor} 失败时保留完整读数，下一版本成功后才替换`, async () => {
    clearConversationStatsCache();
    const pages = [turnEvents(1), turnEvents(2), turnEvents(3)];
    let phase = "initial";
    const calls = [];
    const host = {
      loadWindow: async (_id, cursor) => {
        calls.push({ phase, cursor });
        if (phase === "initial" || phase === "recovered" || phase === "empty") {
          const events = phase === "initial" ? pages.flat() : phase === "recovered" ? pages[2] : [];
          return { eventsJson: JSON.stringify(events), oldestSegmentIndex: 0, hasMoreBefore: false, truncated: false };
        }
        if (cursor === failedCursor) throw new Error("测试历史分页失败");
        const index = cursor === undefined ? 2 : cursor - 1;
        return { eventsJson: JSON.stringify(pages[index]), oldestSegmentIndex: index, hasMoreBefore: index > 0, truncated: false };
      },
    };
    const probe = mountHook({ conversationId: `refresh-page-error-${failedCursor}`, host, liveEvents: [], enabled: true });
    const warn = console.warn;
    try {
      await probe.mount(); await drain();
      const previous = probe.seen.current.stats;
      assert.equal(previous.turns, 3);
      phase = "failed"; console.warn = () => {};
      await probe.update({ authoritativeRevision: 1 }); await drain();
      assert.equal(probe.seen.current.stats, previous, "分页错误不能用部分结果覆盖完整快照");
      assert.equal(probe.seen.current.loading, false);
      const callsAfterFailure = calls.length;
      await probe.update({ liveEvents: [] }); await drain();
      assert.equal(probe.seen.current.stats, previous);
      assert.equal(calls.length, callsAfterFailure, "失败后不自动重试");
      phase = "recovered";
      await probe.update({ authoritativeRevision: 2 }); await drain();
      assert.equal(probe.seen.current.stats.turns, 1, "成功刷新允许历史缩减");
      assert.equal(probe.seen.current.stats.approximate, false);
      phase = "empty";
      await probe.update({ authoritativeRevision: 3 }); await drain();
      assert.equal(probe.seen.current.stats, null, "成功空历史清空旧读数");
    } finally { console.warn = warn; await probe.unmount(); }
  });
}

test("首次加载后续分页失败时保留已有窗口并标为近似", async () => {
  clearConversationStatsCache();
  const host = {
    loadWindow: async (_id, cursor) => {
      if (cursor !== undefined) throw new Error("测试首次分页失败");
      return { eventsJson: JSON.stringify(turnEvents(3)), oldestSegmentIndex: 2, hasMoreBefore: true, truncated: false };
    },
  };
  const probe = mountHook({ conversationId: "initial-page-error", host, liveEvents: [], enabled: true });
  const warn = console.warn;
  try {
    console.warn = () => {};
    await probe.mount(); await drain();
    assert.equal(probe.seen.current.stats.turns, 1);
    assert.equal(probe.seen.current.stats.approximate, true);
    assert.equal(probe.seen.current.loading, false);
  } finally { console.warn = warn; await probe.unmount(); }
});
