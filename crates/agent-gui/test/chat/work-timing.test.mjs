import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const { chatDuration, chatTimestamp } = createTsModuleLoader().loadModule("@liveagent/ui/lib/chat/workTiming.ts");
test("work duration rejects row offsets, zero, seconds, invalid values and reversed clocks", () => {
  const end = Date.parse("2026-10-19T10:00:00Z");
  for (const start of [undefined, 0, 1, 2, 3, end / 1000, NaN, Infinity, -1]) {
    assert.equal(chatDuration(start, end), undefined);
    assert.equal(chatTimestamp(start), undefined);
  }
  assert.equal(chatDuration(end, end - 1), undefined);
  assert.equal(chatDuration(end - 8000, end), 8000);
  assert.equal(chatDuration(end - 50 * 3600000, end), 50 * 3600000);
});

test("three agent traces survive missing clocks, independent completion and remount", async () => {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { ChevronDown: () => null },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key === "chat.work.activity" ? "已处理" : "处理中" }) },
  } });
  const { AssistantWorkTrace, formatElapsedTime } = env.loadModule("@liveagent/ui/components/chat/AssistantWorkTrace.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const originalNow = Date.now;
  let now = Date.parse("2026-10-19T10:00:00Z");
  const firstStartedAt = now - 8000;
  Date.now = () => now;
  const render = (running, remount = false) => env.act(async () => root.render(env.React.createElement("div", null,
    ...[firstStartedAt, 2, 3].map((startedAtMs, index) => env.React.createElement(AssistantWorkTrace, {
      key: `${remount}:${index}`, running: running[index], startedAtMs, hasDetails: false,
    }, `agent ${index + 1}`)),
  )));
  try {
    await render([true, true, true]);
    assert.ok(host.textContent.includes("处理中 8s"));
    assert.doesNotMatch(host.textContent, /\d{5,}h|NaN|Infinity/);
    now += 5000;
    await render([false, false, true]);
    assert.ok(host.textContent.includes("已处理 13s"));
    assert.ok(host.textContent.includes("已处理 5s"));
    await render([false, false, false], true);
    assert.doesNotMatch(host.textContent, /\d{5,}h|NaN|Infinity/);
    assert.equal(formatElapsedTime(NaN), "");
    assert.equal(formatElapsedTime(Infinity), "");
    assert.equal(formatElapsedTime(-1000), "");
  } finally {
    await env.act(async () => root.unmount());
    Date.now = originalNow;
    host.remove();
    env.cleanup();
  }
});
