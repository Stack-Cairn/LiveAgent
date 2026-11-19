import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 对抗性复审：fix-kbrain-stats-bar-empty（tailCursor / reloadNonce / tailKick）。
// 全部用真实 hook / 真实桌面宿主组件 + 真实 react-dom 渲染，只替换后端 I/O。

const EMPTY_LIVE = Object.freeze([]);
const hostState = { loadStats: null, loadWindow: null };
const seenStats = { current: undefined };

const env = await createDomTestEnv({
  mocks: {
    // 桌面宿主组件的三个 I/O 依赖；被测的轮询与 hook 逻辑保持真实。
    "../../../agent-ui-adapters/trajectory": {
      createTauriTrajectoryHost: () => ({
        loadWindow: (...args) => hostState.loadWindow(...args),
        loadStats: (...args) => hostState.loadStats(...args),
      }),
    },
    "../../../lib/host": { isKBrainBackendEnabled: () => true },
    "../../../lib/trajectory/liveTrajectory": {
      subscribeDesktopLiveTrajectory: () => () => {},
      desktopLiveTrajectoryEvents: () => EMPTY_LIVE,
      desktopTrajectoryReloadVersion: () => 0,
    },
    "@liveagent/ui/components/chat/ConversationStatsBar": {
      ConversationStatsBar: (props) => {
        seenStats.current = props.stats;
        return null;
      },
    },
  },
});
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

const hookModule = env.loadModule(
  "@liveagent/ui/lib/trajectory/useConversationStats.ts",
);
const { useConversationStats, clearConversationStatsCache } = hookModule;

let clock = 1_000;
function at() {
  clock += 10;
  return clock;
}

function turnEvents(turn) {
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
      u: { input: 500, output: 100, cacheRead: 1_500, cacheWrite: 0 },
    },
    { k: "turn_end", t: turn, at: start + 270, st: "complete" },
  ];
}

function windowOf(events, lastSeq, extra = {}) {
  return {
    eventsJson: JSON.stringify(events),
    truncated: false,
    oldestSegmentIndex: 0,
    returnedSegmentCount: 1,
    totalSegmentCount: 1,
    hasMoreBefore: false,
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...extra,
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
    seen.current = useConversationStats(props);
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

async function drain(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// ---------------------------------------------------------------------------
// 发现 1：桌面宿主把游标做成只进不退，hook 也用 max 记已读位置。
// K-brain 会话被重建（turn.ts startRun 404 → createSession，把同一个本地会话
// 映射到新的后端会话）后 journal 的 lastSeq 从头计数，游标追不上旧的最大值，
// 尾部刷新不再触发。基线（lastSeq 与上次不同就 +1 revision）在这条路径上会刷新。
// ---------------------------------------------------------------------------
test("[宿主] 后端会话重建导致 lastSeq 变小后，统计条仍要并入新回合", async () => {
  clearConversationStatsCache();
  const { ConversationStatsBarHost } = env.loadModule(
    "src/pages/chat/components/ConversationStatsBarHost.tsx",
  );
  const oldTurns = [...turnEvents(1), ...turnEvents(2), ...turnEvents(3)];
  const backend = { events: oldTurns, lastSeq: 30 };
  const windowCalls = [];
  hostState.loadStats = async () => ({ lastSeq: backend.lastSeq });
  hostState.loadWindow = async (_id, before) => {
    windowCalls.push(before);
    return windowOf(backend.events, backend.lastSeq);
  };

  // 接管 2s 轮询定时器，手动触发，避免真实等待。
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const ticks = [];
  globalThis.setInterval = (callback) => {
    ticks.push(callback);
    return ticks.length;
  };
  globalThis.clearInterval = () => {};

  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(ConversationStatsBarHost, { conversationId: "c-recreated" }));
    });
    await drain();
    assert.equal(seenStats.current?.turns, 3, "打开旧会话读到三轮");
    assert.equal(ticks.length, 1, "宿主注册了一个轮询定时器");

    // 后端会话丢失后被重建：新 journal 只有新一轮，lastSeq 从头计数。
    backend.events = turnEvents(4);
    backend.lastSeq = 6;
    await act(async () => {
      ticks[0]();
    });
    await drain();
    assert.equal(
      seenStats.current?.turns,
      4,
      `新回合必须并入读数（实际 ${seenStats.current?.turns} 轮，窗口请求 ${windowCalls.length} 次）`,
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

test("[hook] 游标回落（后端会话重建）后尾部刷新仍要取窗", async () => {
  clearConversationStatsCache();
  const backend = { events: [...turnEvents(1), ...turnEvents(2)], lastSeq: 30 };
  const calls = [];
  const host = {
    loadWindow: async (_id, before) => {
      calls.push(before);
      return windowOf(backend.events, backend.lastSeq);
    },
  };
  const probe = mountHook({
    conversationId: "c-cursor-regress",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 30,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain();
    assert.equal(probe.seen.current.stats.turns, 2);
    backend.events = turnEvents(3);
    backend.lastSeq = 6;
    await probe.update({ tailCursor: 6 });
    await drain();
    assert.equal(calls.length, 2, "游标变化（哪怕变小）也说明 journal 变了，必须取一窗");
    assert.equal(probe.seen.current.stats.turns, 3);
  } finally {
    await probe.unmount();
  }
});

// ---------------------------------------------------------------------------
// 发现 2：首窗失败的恢复只在「失败之后游标还会再变」时成立。
// 打开一个空闲的旧会话：stats 轮询先回来（游标 30），首窗随后失败。
// 游标之后不再变化，没有任何路径重试——统计条一直为空。
// ---------------------------------------------------------------------------
test("[hook] 游标先到、首窗后失败：之后游标不变也必须能恢复", async () => {
  clearConversationStatsCache();
  let rejectFirst;
  const calls = [];
  const events = [...turnEvents(1), ...turnEvents(2)];
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      if (calls.length === 1) {
        await new Promise((_, reject) => {
          rejectFirst = reject;
        });
      }
      return windowOf(events, 30);
    },
  };
  const probe = mountHook({
    conversationId: "c-fail-after-cursor",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    enabled: true,
  });
  const warn = console.warn;
  try {
    console.warn = () => {};
    await probe.mount();
    // 第一次 stats 轮询先于首窗返回。
    await probe.update({ tailCursor: 30 });
    await drain(2);
    await act(async () => {
      rejectFirst(new Error("测试首窗超时"));
    });
    await drain();
    // 空闲会话：后续轮询一直是 30，宿主的 setState 被 React 跳过，hook 不再重渲染。
    await probe.update({ tailCursor: 30 });
    await drain();
    assert.equal(calls.length >= 2, true, `首窗失败后必须有重试（实际请求 ${calls.length} 次）`);
    assert.equal(probe.seen.current.stats?.turns, 2);
  } finally {
    console.warn = warn;
    await probe.unmount();
  }
});

// ---------------------------------------------------------------------------
// 发现 3：首窗为空且窗口响应的 lastSeq 持续落后于游标时，
// tailKick → 删缓存 → reloadNonce → 首窗落地 → tailKick … 无退避循环。
// ---------------------------------------------------------------------------
test("[hook] 窗口位置持续落后于游标且为空时不得形成请求循环", async () => {
  clearConversationStatsCache();
  const calls = [];
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      // 响应走宏任务（真实后端是网络往返）；纯微任务响应会让循环卡死在一次 act 里。
      await new Promise((resolve) => setTimeout(resolve, 0));
      return windowOf([], 0, { returnedSegmentCount: 0, totalSegmentCount: 0 });
    },
  };
  const probe = mountHook({
    conversationId: "c-loop",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 0,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain();
    assert.equal(calls.length, 1);
    // 游标只前进一次，之后保持不变。
    await probe.update({ tailCursor: 13 });
    await drain(40);
    assert.ok(
      calls.length <= 3,
      `一次游标前进最多允许有限次重载，实际在 40 个 tick 内发出 ${calls.length} 次请求`,
    );
  } finally {
    await probe.unmount();
  }
});

// ---------------------------------------------------------------------------
// 以下为验证性用例（预期通过）：作者风险清单里没有用例的路径。
// ---------------------------------------------------------------------------
test("[验证] 尾部请求期间向前分页替换了条目：两边的事件都保留", async () => {
  clearConversationStatsCache();
  const older = turnEvents(1);
  const tail = turnEvents(2);
  const newer = turnEvents(3);
  let releasePage;
  let releaseTail;
  let tailRequests = 0;
  const host = {
    loadWindow: async (_id, before) => {
      if (before !== undefined) {
        await new Promise((resolve) => {
          releasePage = resolve;
        });
        return windowOf(older, 9, { oldestSegmentIndex: 0 });
      }
      tailRequests += 1;
      if (tailRequests === 1) {
        return windowOf(tail, 9, { oldestSegmentIndex: 1, hasMoreBefore: true, totalSegmentCount: 2 });
      }
      await new Promise((resolve) => {
        releaseTail = resolve;
      });
      return windowOf([...tail, ...newer], 15, {
        oldestSegmentIndex: 1,
        hasMoreBefore: true,
        totalSegmentCount: 2,
      });
    },
  };
  const probe = mountHook({
    conversationId: "c-tail-vs-paging",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 9,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain(3);
    assert.equal(probe.seen.current.stats.turns, 1, "首窗一轮，向前分页在途");
    await probe.update({ tailCursor: 15 });
    await drain(2);
    // 向前分页先落地并替换条目，尾部响应随后到达。
    await act(async () => {
      releasePage();
    });
    await drain(2);
    await act(async () => {
      releaseTail();
    });
    await drain();
    assert.equal(probe.seen.current.stats.turns, 3);
    assert.equal(probe.seen.current.stats.approximate, false);
    assert.equal(probe.seen.current.loading, false);
  } finally {
    await probe.unmount();
  }
});

test("[验证] 不传任何 tail 选项（WebUI 宿主）：空会话只在 authoritativeRevision 变化时重载", async () => {
  clearConversationStatsCache();
  const calls = [];
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      return windowOf([], undefined);
    },
  };
  const probe = mountHook({
    conversationId: "c-webui-empty",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    authoritativeRevision: 0,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain(12);
    assert.equal(calls.length, 1);
    assert.equal(probe.seen.current.stats, null);
    await probe.update({ authoritativeRevision: 1 });
    await drain(12);
    assert.equal(calls.length, 2, "authoritativeRevision 每变一次整窗重载一次，不多不少");
  } finally {
    await probe.unmount();
  }
});

test("[验证] 卸载后迟到的首窗响应不触发重渲染也不报错", async () => {
  clearConversationStatsCache();
  const releases = [];
  const host = {
    loadWindow: async () => {
      await new Promise((resolve) => releases.push(resolve));
      return windowOf(turnEvents(1), 5);
    },
  };
  const probe = mountHook({
    conversationId: "c-late-after-unmount",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 5,
    enabled: true,
  });
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await probe.mount();
    await drain(2);
    const renders = probe.seen.renders;
    await probe.unmount();
    for (const release of releases) release();
    await drain();
    assert.equal(probe.seen.renders, renders);
    assert.deepEqual(errors, []);
  } finally {
    console.error = error;
  }
});

// ---------------------------------------------------------------------------
// 第二轮：游标回落靠组件实例级的 seenCursorRef 识别，而已读位置记在模块级缓存里。
// 重挂载（切走再切回，宿主按 key 重建）后 ref 为空，缓存里旧 journal 的位置还在：
// 新后端会话的游标被判成「已覆盖」，直到它超过旧值才会取窗。
// ---------------------------------------------------------------------------
test("[hook] 重挂载后才看到回落的游标：缓存里的旧位置不得挡住取窗", async () => {
  clearConversationStatsCache();
  const backend = { events: [...turnEvents(1), ...turnEvents(2)], lastSeq: 30 };
  const calls = [];
  const host = {
    loadWindow: async (_id, before) => {
      calls.push(before);
      return windowOf(backend.events, backend.lastSeq);
    },
  };
  const options = {
    conversationId: "c-regress-after-remount",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 30,
    enabled: true,
  };
  const first = mountHook(options);
  await first.mount();
  await drain();
  assert.equal(first.seen.current.stats.turns, 2);
  await first.unmount();

  // 切走期间后端会话被重建：新 journal 只有新一轮，lastSeq 从头计数。
  backend.events = turnEvents(3);
  backend.lastSeq = 6;
  // 切回：挂载时轮询还没返回，随后第一次轮询拿到 6。
  const second = mountHook({ ...options, tailCursor: undefined });
  try {
    await second.mount();
    await drain();
    await second.update({ tailCursor: 6 });
    await drain();
    assert.equal(calls.length, 2, `回落的游标必须触发一次取窗（实际请求 ${calls.length} 次）`);
    assert.equal(second.seen.current.stats.turns, 3);
  } finally {
    await second.unmount();
  }
});

test("[验证] 首窗持续失败且游标已知：只多一次重试，游标变化后再试一次", async () => {
  clearConversationStatsCache();
  const calls = [];
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("测试后端持续失败");
    },
  };
  const probe = mountHook({
    conversationId: "c-persistent-failure",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 30,
    enabled: true,
  });
  const warn = console.warn;
  try {
    console.warn = () => {};
    await probe.mount();
    await drain(40);
    assert.equal(calls.length, 2, "首窗 + 一次重试");
    assert.equal(probe.seen.current.loading, false);
    await probe.update({ tailCursor: 31 });
    await drain(40);
    assert.equal(calls.length, 3, "游标变化再试一次，不循环");
  } finally {
    console.warn = warn;
    await probe.unmount();
  }
});

test("[验证] 游标回落后的尾部请求被下一次游标变化取消：仍会取窗并入新回合", async () => {
  clearConversationStatsCache();
  const backend = { events: [...turnEvents(1), ...turnEvents(2)], lastSeq: 30 };
  const gates = [];
  let gated = false;
  const host = {
    loadWindow: async () => {
      const snapshot = windowOf(backend.events, backend.lastSeq);
      if (gated) await new Promise((resolve) => gates.push(resolve));
      return snapshot;
    },
  };
  const probe = mountHook({
    conversationId: "c-regress-cancelled",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 30,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain();
    gated = true;
    backend.events = turnEvents(3);
    backend.lastSeq = 6;
    await probe.update({ tailCursor: 6 });
    await drain(2);
    backend.events = [...backend.events, ...turnEvents(4)];
    backend.lastSeq = 9;
    await probe.update({ tailCursor: 9 });
    await drain(2);
    assert.equal(gates.length, 2, "回落后的两次游标变化各发一次尾部请求");
    await act(async () => {
      for (const release of gates) release();
    });
    await drain();
    assert.equal(probe.seen.current.stats.turns, 4);
  } finally {
    await probe.unmount();
  }
});

test("[验证] StrictMode 下新会话首窗为空再出现事件：能恢复且请求有界", async () => {
  clearConversationStatsCache();
  const state = { events: [], lastSeq: 0 };
  const calls = [];
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      return windowOf(state.events, state.lastSeq);
    },
  };
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const seen = { current: null };
  let setProps;
  function Probe(initial) {
    const [props, update] = React.useState(initial.value);
    setProps = update;
    seen.current = useConversationStats(props);
    return null;
  }
  const value = {
    conversationId: "c-strict",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 0,
    enabled: true,
  };
  try {
    await act(async () => {
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(Probe, { value })),
      );
    });
    await drain();
    const afterMount = calls.length;
    state.events = turnEvents(1);
    state.lastSeq = 13;
    await act(async () => {
      setProps((current) => ({ ...current, tailCursor: 13 }));
    });
    await drain(20);
    assert.equal(seen.current.stats?.turns, 1);
    assert.ok(calls.length - afterMount <= 2, `游标前进后请求 ${calls.length - afterMount} 次`);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ---------------------------------------------------------------------------
// 第三轮：向前分页的每一页都用该页响应的 lastSeq 覆盖条目的已读位置。K-brain 的
// lastSeq 取自整份快照，与请求的是哪一页无关：分页期间 journal 前进时，较早页的
// 响应带着较新的 lastSeq，却不含新增的尾部事件。之后相等的游标被判成已覆盖。
// ---------------------------------------------------------------------------
test("[hook] 向前分页的响应带着更新的 lastSeq：不得把没读到的尾部事件算作已覆盖", async () => {
  clearConversationStatsCache();
  const older = [...turnEvents(1), ...turnEvents(2)];
  const tail = turnEvents(3);
  const newer = turnEvents(4);
  let releasePage;
  const tailCalls = [];
  const backend = { tail, lastSeq: 9 };
  const host = {
    loadWindow: async (_id, before) => {
      if (before !== undefined) {
        await new Promise((resolve) => {
          releasePage = resolve;
        });
        // 这一页在 journal 前进之后才被后端读取：位置是新的，内容是旧段。
        return windowOf(older, backend.lastSeq, { oldestSegmentIndex: 0, totalSegmentCount: 2 });
      }
      tailCalls.push(backend.lastSeq);
      return windowOf(backend.tail, backend.lastSeq, {
        oldestSegmentIndex: 1,
        hasMoreBefore: true,
        totalSegmentCount: 2,
      });
    },
  };
  const probe = mountHook({
    conversationId: "c-page-cursor-ahead",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 9,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain(3);
    assert.equal(probe.seen.current.stats.turns, 1, "首窗一轮，向前分页在途");
    // 运行中的会话：分页在途期间 journal 前进到 15，新增第 4 轮。
    backend.tail = [...tail, ...newer];
    backend.lastSeq = 15;
    await act(async () => {
      releasePage();
    });
    await drain();
    assert.equal(probe.seen.current.stats.turns, 3, "更早的段补齐，第 4 轮还没读到");
    // 下一次轮询拿到 15，之后会话空闲，游标不再变化。
    await probe.update({ tailCursor: 15 });
    await drain();
    assert.equal(
      probe.seen.current.stats.turns,
      4,
      `游标 15 的尾部事件必须被读到（尾部请求 ${tailCalls.length} 次）`,
    );
  } finally {
    await probe.unmount();
  }
});

// ---------------------------------------------------------------------------
// 第三轮：首窗在途期间游标回落（首窗读的是旧 journal，位置 30；游标已是新 journal
// 的 6）。首窗落地时只在 wanted > 已读位置 时补跑，回落不补。
// ---------------------------------------------------------------------------
test("[hook] 首窗在途期间游标回落：首窗落地后仍要按新游标取一窗", async () => {
  clearConversationStatsCache();
  let releaseFirst;
  const calls = [];
  const oldJournal = [...turnEvents(1), ...turnEvents(2)];
  const newJournal = turnEvents(3);
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      if (calls.length === 1) {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
        return windowOf(oldJournal, 30);
      }
      return windowOf(newJournal, 6);
    },
  };
  const probe = mountHook({
    conversationId: "c-regress-during-first-window",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    enabled: true,
  });
  try {
    await probe.mount();
    await probe.update({ tailCursor: 6 });
    await drain(2);
    await act(async () => {
      releaseFirst();
    });
    await drain();
    assert.equal(calls.length, 2, `首窗位置 30 与游标 6 不一致，必须补一次（实际 ${calls.length} 次）`);
    assert.equal(probe.seen.current.stats.turns, 3);
  } finally {
    await probe.unmount();
  }
});

test("[验证] 轮询响应比窗口旧（游标 5，已读 9）：只多取一窗，不往复", async () => {
  clearConversationStatsCache();
  const calls = [];
  const events = turnEvents(1);
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return windowOf(events, 9);
    },
  };
  const probe = mountHook({
    conversationId: "c-stale-poll",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    enabled: true,
  });
  try {
    await probe.mount();
    await drain();
    await probe.update({ tailCursor: 5 });
    await drain(30);
    assert.equal(calls.length, 2, "首窗 + 一次多余的尾部请求");
    await probe.update({ tailCursor: 9 });
    await drain(30);
    assert.equal(calls.length, 2, "游标追平后不再请求");
  } finally {
    await probe.unmount();
  }
});

test("[验证] 窗口响应不带 lastSeq 的宿主 + tailCursor：每次游标变化一窗，空会话不循环", async () => {
  clearConversationStatsCache();
  const calls = [];
  const state = { events: [] };
  const host = {
    loadWindow: async () => {
      calls.push(calls.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return windowOf(state.events, undefined);
    },
  };
  const probe = mountHook({
    conversationId: "c-no-window-cursor",
    host,
    liveEvents: [],
    liveOwnership: "observed",
    tailCursor: 0,
    enabled: true,
  });
  try {
    await probe.mount();
    await drain();
    await probe.update({ tailCursor: 4 });
    await drain(30);
    assert.equal(calls.length, 2, "空会话：游标变化一次整段重载一次");
    state.events = turnEvents(1);
    await probe.update({ tailCursor: 8 });
    await drain(30);
    assert.equal(calls.length, 3);
    assert.equal(probe.seen.current.stats.turns, 1);
    await probe.update({ tailCursor: 12 });
    await drain(30);
    assert.equal(calls.length, 4, "有事件后每次游标变化取一窗");
  } finally {
    await probe.unmount();
  }
});
