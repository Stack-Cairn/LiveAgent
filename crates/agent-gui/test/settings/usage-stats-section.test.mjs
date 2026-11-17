// Settings → 用量统计: the page's states (loading, unavailable, error, empty, ready),
// refresh, the heatmap tooltip, page registration, locale parity and the desktop
// adapter. Assertions compare strings and booleans only: a failing assert on a DOM
// node would print the whole jsdom tree.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const stats = {
  generatedAt: "2026-11-15T08:00:00Z",
  timezone: "UTC",
  days: 371,
  totals: { input: 900_000, output: 300_000, cacheRead: 0, cacheWrite: 0, total: 1_200_000, turns: 42, sessions: 7, costUSD: null },
  summary: { activeDays: 2, currentStreak: 1, longestStreak: 1, topModel: "model-a", longestSession: { id: "s1", title: "Refactor", total: 800_000 } },
  daily: [
    { date: shift(-2), input: 150_000, output: 50_000, cacheRead: 0, cacheWrite: 0, total: 200_000, turns: 12, models: { "model-b": 200_000 } },
    { date: today, input: 750_000, output: 250_000, cacheRead: 0, cacheWrite: 0, total: 1_000_000, turns: 30, models: { "model-a": 1_000_000 } },
  ],
  models: [
    { model: "model-a", provider: "p1", input: 750_000, output: 250_000, cacheRead: 0, cacheWrite: 0, total: 1_000_000, turns: 30, costUSD: null },
    { model: "model-b", provider: "p2", input: 150_000, output: 50_000, cacheRead: 0, cacheWrite: 0, total: 200_000, turns: 12, costUSD: null },
  ],
};

async function fixture(answer, task) {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/components/ui/button": { Button: ({ children, size, variant, ...props }) => env.React.createElement("button", props, children) },
  } });
  const { UsageStatsSection } = env.loadModule("@liveagent/ui/pages/settings/UsageStatsSection.tsx");
  const calls = [];
  let next = answer;
  const kbrain = {
    getConnection: () => null,
    getUsageStats: async (query) => { calls.push(query); return typeof next === "function" ? next() : next; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () => env.act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  const testId = (id) => host.querySelector(`[data-testid="${id}"]`);
  try {
    await env.act(async () => root.render(env.React.createElement(UsageStatsSection, { kbrain })));
    await settle();
    await task({ env, host, calls, settle, testId, setAnswer: (value) => { next = value; } });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("loads 371 days for the browser time zone and shows the cards and charts", async () => {
  await fixture({ available: true, stats }, async ({ calls, testId }) => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].days, 371);
    assert.equal(calls[0].timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const id of ["usage-metrics", "usage-heatmap", "usage-trend", "usage-models"]) assert.ok(testId(id), id);
    assert.match(testId("usage-metric-total").textContent, /120\s*万/);
    assert.match(testId("usage-metric-sessions").textContent, /7/);
    assert.match(testId("usage-metric-top-model").textContent, /model-a/);
    assert.match(testId("usage-metric-longest-session").textContent, /Refactor/);
    // No price from K-brain: no cost card.
    assert.equal(testId("usage-metric-cost"), null);
    assert.match(testId("usage-models").textContent, /model-b/);
  });
});

// The heat ramp grows away from each theme's surface: darker on the light surface,
// brighter on the dark one, so the busiest days have the most contrast with the
// card and with empty days in both themes.
test("busier heatmap levels stand out more from the surface in both themes", async () => {
  await fixture({ available: true, stats }, async ({ env }) => {
    const { USAGE_PALETTE_CLASS, heatColor } = env.loadModule("@liveagent/ui/pages/settings/usage/usageUi.tsx");
    const luminance = (hex) => {
      const [r, g, b] = hex.match(/\w{2}/g).map((part) => {
        const channel = Number.parseInt(part, 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return r * 0.2126 + g * 0.7152 + b * 0.0722;
    };
    const ramp = (prefix) => {
      const colors = new Map(
        [...USAGE_PALETTE_CLASS.matchAll(/(?<!\S)(dark:)?\[--usage-heat-(\d):#([a-f0-9]{6})\]/g)]
          .filter((match) => (match[1] ?? "") === prefix)
          .map((match) => [`var(--usage-heat-${match[2]})`, match[3]]),
      );
      return [1, 2, 3, 4].map((level) => {
        const color = colors.get(heatColor(level));
        assert.ok(color, `missing ${prefix || "light "}heat color for level ${level}`);
        return luminance(color);
      });
    };
    const light = ramp("");
    const dark = ramp("dark:");
    for (let level = 1; level < 4; level++) {
      assert.ok(light[level] < light[level - 1], `light: level ${level + 1} must be darker than level ${level}`);
      assert.ok(dark[level] > dark[level - 1], `dark: level ${level + 1} must be brighter than level ${level}`);
    }
  });
});

test("a priced answer adds the cost card", async () => {
  await fixture({ available: true, stats: { ...stats, totals: { ...stats.totals, costUSD: 3.5 } } }, async ({ testId }) => {
    assert.match(testId("usage-metric-cost").textContent, /\$3\.50/);
  });
});

test("a K-brain without usage_stats gets the update notice, not an error", async () => {
  await fixture({ available: false }, async ({ testId }) => {
    assert.ok(testId("usage-unavailable"));
    assert.equal(testId("usage-error"), null);
    assert.equal(testId("usage-content"), null);
  });
});

test("no usage yet shows the empty state", async () => {
  await fixture({ available: true, stats: { ...stats, totals: { ...stats.totals, total: 0, turns: 0, sessions: 0 }, daily: [], models: [] } }, async ({ testId }) => {
    assert.ok(testId("usage-empty"));
    assert.equal(testId("usage-content"), null);
  });
});

test("a failure shows the error with retry; refresh loads again", async () => {
  let fail = true;
  const answer = () => {
    if (fail) throw new Error("K-brain is busy");
    return { available: true, stats };
  };
  await fixture(answer, async ({ env, host, calls, settle, testId }) => {
    assert.match(testId("usage-error").textContent, /K-brain is busy/);
    fail = false;
    const retry = testId("usage-error").querySelector("button");
    await env.act(async () => { retry.click(); });
    await settle();
    assert.ok(testId("usage-content"));
    await env.act(async () => { testId("usage-refresh").click(); });
    await settle();
    assert.equal(calls.length, 3);
    assert.equal(host.querySelector('[role="tooltip"]'), null);
  });
});

test("hovering a heatmap day shows its date, tokens and turns; weekly sums the week", async () => {
  await fixture({ available: true, stats }, async ({ env, host, settle, testId }) => {
    const heatmap = testId("usage-heatmap");
    const columns = [...heatmap.querySelectorAll('[aria-hidden="true"] > div')];
    assert.equal(columns.length, 52);
    const todayCell = [...columns.at(-1).children][new Date(`${today}T00:00:00Z`).getUTCDay()];
    const hover = async (element) => {
      await env.act(async () => {
        element.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
      });
      await settle();
    };
    await hover(todayCell);
    const tip = () => host.querySelector('[role="tooltip"]')?.textContent ?? "";
    assert.match(tip(), /100\s*万\s*tokens/);
    assert.match(tip(), /30/);
    const [, month, day] = today.split("-").map(Number);
    assert.match(tip(), new RegExp(`${month}月${day}日`));

    const weekly = [...heatmap.querySelectorAll('[role="radio"]')].find((button) => button.textContent === "每周");
    await env.act(async () => { weekly.click(); });
    await settle();
    assert.equal(tip(), "");
    await hover(todayCell);
    const sameWeek = new Date(`${today}T00:00:00Z`).getUTCDay() >= 2;
    assert.match(tip(), sameWeek ? /120\s*万/ : /100\s*万/);
  });
});

// ---- registration, locales, desktop adapter ----

const settings = {
  stt: { provider: "tencent_cloud" },
  system: { workspaceProjects: [], hiddenWorkspaceProjectPaths: [], archivedWorkspaceProjectPaths: [] },
  customProviders: [],
  customSettings: { fontScale: { sidebar: 1, chat: 1, rightDock: 1, settings: 1 } },
};

async function sectionIds(kbrain) {
  const shared = (name) => fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${name}`, import.meta.url));
  let sections = [];
  const env = await createDomTestEnv({
    mocks: {
      [shared("SettingsShell.tsx")]: { SettingsShell: ({ registry }) => { sections = registry.settingsSections; return null; } },
      [shared("UsageStatsSection.tsx")]: { UsageStatsSection: () => null },
      [shared("PermissionRulesSection.tsx")]: { PermissionRulesSection: () => null },
      [shared("ProvidersSection.tsx")]: { ProvidersSection: () => null },
      [shared("SystemSettingsForm.tsx")]: { SystemSettingsForm: () => null },
      [shared("AgentsSection.tsx")]: { AgentsSection: () => null },
      [shared("ResourceHubSection.tsx")]: { ResourceHubSection: () => null },
      [shared("SystemToolsSection.tsx")]: { SystemToolsSection: () => null },
      [shared("CuaDriverSection.tsx")]: { CuaDriverSection: () => null },
      [shared("RemoteSection.tsx")]: { RemoteSection: () => null },
      [shared("SshSection.tsx")]: { SshSection: () => null },
      [shared("SttSection.tsx")]: { SttSection: () => null },
      [shared("HooksSection.tsx")]: { HooksSection: () => null },
      [shared("CronSection.tsx")]: { CronSection: () => null },
      [shared("AIApprovalSection.tsx")]: { AIApprovalSection: () => null },
      [shared("CalendarSection.tsx")]: { CalendarSection: () => null },
      [shared("memory/MemoryPanel.tsx")]: { MemoryPanel: () => null },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/adapters/settingsExtension": {
        createSettingsExtension: () => ({ surface: "desktop", iconClassName: "", slots: {}, sections: [] }),
      },
      "@liveagent/adapters/providerSettings": { ProviderSettingsExtension: () => null, ProviderCopyConfigButton: () => null },
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": { Button: (props) => env.React.createElement("button", props) },
      "@liveagent/ui/components/ui/input": { Input: (props) => env.React.createElement("input", props) },
    },
  });
  const { SettingsPage } = env.loadModule("@liveagent/ui/pages/settings/SettingsPage.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  try {
    await env.act(async () => root.render(env.React.createElement(SettingsPage, {
      settings, setSettings: () => {}, saveState: { status: "saved" }, onBack: () => {},
      initialSection: "system", sttSettingsService: {},
      settingsHost: { isKbrain: true, kbrain },
    })));
    return sections.map((section) => `${section.id}:${section.groupKey}:${section.labelKey}`);
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

const base = { isKbrain: true, getConnection: () => null, getSettings: async () => ({}), updateSettings: async () => ({}) };

test("the usage page is listed in General only for hosts that can fetch usage", async () => {
  const withUsage = await sectionIds({ ...base, getUsageStats: async () => ({ available: false }) });
  assert.equal(withUsage.includes("usage:settings.groupGeneral:settings.navUsage"), true);
  const without = await sectionIds(base);
  assert.equal(without.some((id) => id.startsWith("usage:")), false);
});

test("both locales carry the same usage page keys", () => {
  const loader = createTsModuleLoader();
  const zh = loader.loadModule("../agent-ui/src/i18n/translations/zhCNSettings.ts").ZH_CN_SETTINGS_TRANSLATIONS;
  const en = loader.loadModule("../agent-ui/src/i18n/translations/enUSSettings.ts").EN_US_SETTINGS_TRANSLATIONS;
  const keys = (table) => Object.keys(table).filter((key) => key === "settings.navUsage" || key.startsWith("settings.usage.")).sort();
  assert.deepEqual(keys(zh), keys(en));
  assert.equal(keys(zh).length >= 40, true);
  assert.equal(zh["settings.navUsage"], "用量统计");
  assert.equal(en["settings.navUsage"], "Usage statistics");
});

test("the desktop adapter checks the capability, then asks K-brain for the stats", async () => {
  const loader = createTsModuleLoader();
  const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const { kbrainSettingsAdapter } = loader.loadModule("src/agent-ui-adapters/kbrainSettings.ts");
  const requests = [];
  let capabilities = {};
  let statsResponse = () => new Response(JSON.stringify(stats), { status: 200 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push([init.method ?? "GET", String(url), init.headers?.Authorization ?? null]);
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") return new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities }), { status: 200 });
    if (path === "/v1/usage/stats") return statsResponse();
    return new Response("{}", { status: 404 });
  };
  setKBrainRuntimeConnection({ baseUrl: "http://kb", token: "tok", protocolVersion: "kbrain.agent.v1" });
  try {
    const query = { days: 371, timezone: "Asia/Shanghai" };
    assert.deepEqual(await kbrainSettingsAdapter.getUsageStats(query), { available: false });
    assert.deepEqual(requests.map((request) => request[1]), ["http://kb/v1/health"]);

    capabilities = { usage_stats: 1 };
    const answer = await kbrainSettingsAdapter.getUsageStats(query);
    assert.equal(answer.available, true);
    assert.equal(answer.stats.totals.total, 1_200_000);
    assert.deepEqual(requests.at(-1), ["GET", "http://kb/v1/usage/stats?days=371&tz=Asia%2FShanghai", "Bearer tok"]);

    // Capability advertised but no route: the update notice, as through the Gateway.
    statsResponse = () => new Response("404 page not found", { status: 404 });
    assert.deepEqual(await kbrainSettingsAdapter.getUsageStats(query), { available: false });

    statsResponse = () => new Response(JSON.stringify({ error: "usage index is rebuilding" }), { status: 503 });
    await assert.rejects(kbrainSettingsAdapter.getUsageStats(query), (error) => error.message === "usage index is rebuilding");
  } finally {
    globalThis.fetch = originalFetch;
    clearKBrainRuntimeConnection();
  }
});

test("same model on two providers keeps independent hover totals", async () => {
  const duplicate = { ...stats, models: [
    { model: "shared-model", provider: "provider-a", total: 200000 },
    { model: "shared-model", provider: "provider-b", total: 100000 },
  ] };
  await fixture({ available: true, stats: duplicate }, async ({env, testId, settle}) => {
    const chart = testId("usage-models");
    const rows = chart.querySelectorAll("tbody tr");
    const hover = async (row) => {
      await env.act(async () => row.dispatchEvent(new window.MouseEvent("mouseover", {bubbles:true, relatedTarget:document.body})));
      await settle();
    };
    await hover(rows[1]);
    assert.match(chart.querySelector(".pointer-events-none").textContent, /10\s*万/);
    assert.equal(rows[0].className.includes("bg-foreground"), false);
    assert.equal(rows[1].className.includes("bg-foreground"), true);
    await hover(rows[0]);
    assert.match(chart.querySelector(".pointer-events-none").textContent, /20\s*万/);
  });
});

test("top model total includes every provider for that model", async () => {
  const env = await createDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":new Proxy({}, {get:()=>()=>null})}});
  const {UsageMetricCards} = env.loadModule("@liveagent/ui/pages/settings/usage/UsageMetricCards.tsx");
  const host=document.body.appendChild(document.createElement("div"));
  const root=env.createRoot(host);
  try {
    await env.act(async()=>root.render(env.React.createElement(UsageMetricCards,{stats:{...stats,summary:{...stats.summary,topModel:"shared"},models:[
      {model:"different",provider:"p",total:250000},
      {model:"shared",provider:"a",total:200000},
      {model:"shared",provider:"b",total:100000},
    ]}})));
    assert.match(host.querySelector('[data-testid="usage-metric-top-model"]').textContent,/30\s*万/);
  } finally {
    await env.act(async()=>root.unmount());host.remove();env.cleanup();
  }
});
