import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const invokeCalls = [];
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command, args) {
        invokeCalls.push({ command, args });
        return Promise.resolve({
          data: [{ planName: "Balance", remaining: 4.2, unit: "USD" }],
          queriedAt: 123,
          error: null,
          isStale: false,
        });
      },
    },
  },
});
const usage = loader.loadModule("src/lib/providers/usageQuery.ts");

test("failed refresh retains prior values and marks result stale", () => {
  const state = usage.reduceUsageState(
    {},
    {
      providerId: "p",
      result: {
        data: [{ planName: "Balance", remaining: 4.2, unit: "USD" }],
        queriedAt: 123,
        error: null,
        isStale: false,
      },
    },
  );
  const next = usage.reduceUsageState(state, { providerId: "p", error: "timeout" });

  assert.equal(next.p.data[0].remaining, 4.2);
  assert.equal(next.p.error, "timeout");
  assert.equal(next.p.isStale, true);
});

test("failed refresh does not mark an earlier failed placeholder as stale", () => {
  const state = {
    p: { data: [], queriedAt: null, error: "offline", isStale: false },
  };
  const next = usage.reduceUsageState(state, { providerId: "p", error: "timeout" });

  assert.equal(next.p.isStale, false);
});

test("a legacy result without data is coerced to an empty array", () => {
  const state = usage.reduceUsageState(
    {},
    { providerId: "p", result: { queriedAt: 1, error: null, isStale: false } },
  );

  assert.deepEqual(state.p.data, []);
});

test("manual refresh queries only the requested provider", async () => {
  invokeCalls.length = 0;

  await usage.queryProviderUsage("provider-a", true);

  assert.deepEqual(invokeCalls, [
    {
      command: "provider_usage_query",
      args: { providerId: "provider-a", refresh: true },
    },
  ]);
});

test("draft test sends the editor config verbatim regardless of the enable switch", async () => {
  invokeCalls.length = 0;

  await usage.testProviderUsage("provider-a", {
    enabled: false,
    mode: "custom",
    script: "({ request: {}, extractor: () => ({}) })",
  });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].command, "provider_usage_test");
  assert.equal(invokeCalls[0].args.providerId, "provider-a");
  const draft = JSON.parse(invokeCalls[0].args.configJson);
  assert.equal(draft.mode, "custom");
  // 草稿原样传输,启用与否由桌面端测试路径忽略。
  assert.equal(draft.enabled, false);
});

test("batch refresh targets every provider with usage query enabled", () => {
  const providers = [
    { id: "enabled-a", usageQuery: { enabled: true } },
    { id: "disabled", usageQuery: { enabled: false } },
    { id: "enabled-b", usageQuery: { enabled: true } },
    { id: "no-config" },
  ];

  assert.deepEqual(usage.getEnabledUsageProviderIds(providers), ["enabled-a", "enabled-b"]);
});

test("coordinator ignores an older overlapping response and keeps loading until the current request ends", async () => {
  const deferred = [];
  const coordinator = usage.createProviderUsageCoordinator(() => {
    const next = {};
    next.promise = new Promise((resolve) => {
      next.resolve = resolve;
    });
    deferred.push(next);
    return next.promise;
  });
  const provider = { id: "p", usageQuery: { enabled: true } };
  coordinator.syncProviders([provider]);

  const first = coordinator.request("p", false);
  const second = coordinator.request("p", true);
  assert.equal(coordinator.getSnapshot().refreshingProviderIds.has("p"), true);

  deferred[0].resolve({
    data: [{ planName: "USD", remaining: 1 }],
    queriedAt: 1,
    error: null,
    isStale: false,
  });
  await first;
  assert.equal(coordinator.getSnapshot().usageByProvider.p, undefined);
  assert.equal(coordinator.getSnapshot().refreshingProviderIds.has("p"), true);

  deferred[1].resolve({
    data: [{ planName: "USD", remaining: 2 }],
    queriedAt: 2,
    error: null,
    isStale: false,
  });
  await second;
  assert.equal(coordinator.getSnapshot().usageByProvider.p.data[0].remaining, 2);
  assert.equal(coordinator.getSnapshot().refreshingProviderIds.has("p"), false);
});

test("coordinator prunes deleted and replaced provider requests before they can write", async () => {
  const deferred = [];
  const coordinator = usage.createProviderUsageCoordinator(() => {
    const next = {};
    next.promise = new Promise((resolve) => {
      next.resolve = resolve;
    });
    deferred.push(next);
    return next.promise;
  });
  const original = { id: "p", usageQuery: { enabled: true } };
  const replacement = { id: "p", usageQuery: { enabled: true } };
  coordinator.syncProviders([original]);

  const oldRequest = coordinator.request("p", false);
  coordinator.syncProviders([replacement]);
  deferred[0].resolve({ data: [{ planName: "USD", remaining: 1 }], isStale: false });
  await oldRequest;
  assert.equal(coordinator.getSnapshot().usageByProvider.p, undefined);

  const replacementRequest = coordinator.request("p", true);
  coordinator.syncProviders([]);
  deferred[1].resolve({ data: [{ planName: "USD", remaining: 2 }], isStale: false });
  await replacementRequest;
  assert.equal(coordinator.getSnapshot().usageByProvider.p, undefined);
  assert.equal(coordinator.getSnapshot().refreshingProviderIds.has("p"), false);
});

test("relative time buckets queried-at into just-now/minutes/hours/days", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(usage.getUsageRelativeTime(now - 10_000, now), { kind: "justNow" });
  assert.deepEqual(usage.getUsageRelativeTime(now - 5 * 60_000, now), {
    kind: "minutesAgo",
    value: 5,
  });
  assert.deepEqual(usage.getUsageRelativeTime(now - 3 * 3_600_000, now), {
    kind: "hoursAgo",
    value: 3,
  });
  assert.deepEqual(usage.getUsageRelativeTime(now - 49 * 3_600_000, now), {
    kind: "daysAgo",
    value: 2,
  });
  // 未来时间戳(时钟偏移)按"刚刚"处理。
  assert.deepEqual(usage.getUsageRelativeTime(now + 60_000, now), { kind: "justNow" });
});

test("plan titles map window tokens and keep unknown names verbatim", () => {
  assert.deepEqual(usage.resolveUsagePlanTitle("window:5h"), { kind: "window", token: "5h" });
  assert.deepEqual(usage.resolveUsagePlanTitle("window:weekly"), {
    kind: "window",
    token: "weekly",
  });
  assert.deepEqual(usage.resolveUsagePlanTitle("window:monthly"), {
    kind: "window",
    token: "monthly",
  });
  assert.deepEqual(usage.resolveUsagePlanTitle("Pro Plan"), { kind: "text", text: "Pro Plan" });
  assert.deepEqual(usage.resolveUsagePlanTitle(undefined), { kind: "none" });
});

test("plan severity flags invalid plans and low remaining quota", () => {
  assert.equal(usage.getUsagePlanSeverity({ isValid: false }), "invalid");
  assert.equal(usage.getUsagePlanSeverity({ remaining: 5, total: 100 }), "low");
  assert.equal(usage.getUsagePlanSeverity({ remaining: 50, total: 100 }), "normal");
  // 无 total 时不判 low;total=-1(无限)同样不判。
  assert.equal(usage.getUsagePlanSeverity({ remaining: 0.1 }), "normal");
  assert.equal(usage.getUsagePlanSeverity({ remaining: 1, total: -1 }), "normal");
});

test("plan display formats amounts, infinity totals, percents, and invalid state", () => {
  const rich = usage.getUsagePlanDisplay({
    planName: "window:5h",
    remaining: 70,
    used: 30,
    total: 100,
    unit: "%",
  });
  assert.equal(rich.amount, "70");
  assert.equal(rich.total, "100");
  assert.equal(rich.percent, 70);
  assert.equal(rich.severity, "normal");

  const unlimited = usage.getUsagePlanDisplay({ planName: "Bonus", remaining: 5.5, total: -1 });
  assert.equal(unlimited.total, "∞");
  assert.equal(unlimited.amount, "5.50");
  assert.equal(unlimited.percent, null);

  const invalid = usage.getUsagePlanDisplay({ isValid: false, invalidMessage: "expired" });
  assert.equal(invalid.invalid, true);
  assert.equal(invalid.invalidMessage, "expired");

  // remaining 缺失时退化到 total-used。
  const derived = usage.getUsagePlanDisplay({ used: 30, total: 100 });
  assert.equal(derived.amount, "70");
});

test("provider card display exposes plans stale error and relative time", () => {
  const now = 1_700_000_000_000;
  const display = usage.getProviderUsageCardDisplay(
    { id: "p", usageQuery: { enabled: true } },
    {
      data: [
        { planName: "window:5h", remaining: 70, total: 100, unit: "%" },
        { planName: "window:weekly", remaining: 4, total: 100, unit: "%" },
      ],
      queriedAt: now - 5 * 60_000,
      error: "timeout",
      isStale: true,
    },
    true,
    now,
  );

  assert.equal(display.show, true);
  assert.equal(display.isStale, true);
  assert.equal(display.error, "timeout");
  assert.equal(display.plans.length, 2);
  assert.equal(display.plans[1].severity, "low");
  assert.deepEqual(display.updatedAt, { kind: "minutesAgo", value: 5 });
  assert.equal(display.refreshDisabled, true);
  assert.equal(display.loading, false);
});

test("provider card display stays in loading until the first result lands", () => {
  const now = 1_700_000_000_000;
  const provider = { id: "p", usageQuery: { enabled: true } };

  // 首个结果未回:无论请求是否已在途,都视为加载中(渲染等高骨架占位)。
  assert.equal(usage.getProviderUsageCardDisplay(provider, undefined, false, now).loading, true);
  assert.equal(usage.getProviderUsageCardDisplay(provider, undefined, true, now).loading, true);

  // 结果落地(即使数据为空/失败形态)即退出加载态;手动刷新不回到骨架。
  const empty = usage.getProviderUsageCardDisplay(
    provider,
    { data: [], queriedAt: now, error: null, isStale: false },
    false,
    now,
  );
  assert.equal(empty.loading, false);
  assert.equal(empty.show, true);

  const refreshing = usage.getProviderUsageCardDisplay(
    provider,
    { data: [{ planName: "Balance", remaining: 4.2, unit: "USD" }], queriedAt: now, error: null, isStale: false },
    true,
    now,
  );
  assert.equal(refreshing.loading, false);
  assert.equal(refreshing.refreshDisabled, true);
});
