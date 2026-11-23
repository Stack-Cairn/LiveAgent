// The typed error row and the stopped marker read K-brain's outcome fields:
// error_detail picks the explanation (with en and zh copy for every kind) and
// cancel_reason "shutdown" says the backend restarted.
//
// Assertions compare strings, never DOM nodes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let locale = "en-US";
let sharedMessage = () => undefined;
const t = (key) => sharedMessage(key, locale) ?? key;
const EmptyIcon = () => null;
const env = await createDomTestEnv({
  mocks: {
    "../../i18n/index": { useLocale: () => ({ locale, t }) },
    "../IconSet": new Proxy({}, { get: () => EmptyIcon }),
  },
});
({ sharedMessage } = env.loadModule("@liveagent/ui/i18n/hostTranslations.ts"));
const { React, act, createRoot } = env;
const { TurnErrorNotice } = env.loadModule("@liveagent/ui/components/chat/TurnErrorNotice.tsx");
const { GenerationStoppedNotice } = env.loadModule("@liveagent/ui/components/chat/AssistantStatus.tsx");

test.after(() => env.cleanup());

function render(element) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(element));
  const read = () => host.textContent ?? "";
  const attr = (selector, name) => host.querySelector(selector)?.getAttribute(name) ?? null;
  return { read, attr, unmount: () => act(() => root.unmount()) };
}

const KINDS = [
  ["timeout", "timeout", "Request timed out", "请求超时"],
  ["context_limit", "context_limit", "Context length exceeded", "超出上下文长度"],
  ["bad_request", "bad_request", "Request rejected", "请求被拒绝"],
  ["invalid_api_key", "auth", "Invalid API key", "API 密钥无效"],
];

for (const [detailKind, kind, en, zh] of KINDS) {
  test(`error_detail ${detailKind} shows its own explanation in both locales`, () => {
    for (const [lang, title] of [["en-US", en], ["zh-CN", zh]]) {
      locale = lang;
      const view = render(
        React.createElement(TurnErrorNotice, {
          // The text alone would read as a rate limit.
          error: "429 Too Many Requests",
          errorDetail: { kind: detailKind, upstreamStatus: 400, providerMessage: "upstream says no" },
        }),
      );
      assert.equal(view.attr("[data-turn-error]", "data-turn-error"), kind);
      assert.ok(view.read().includes(title), `${lang}: ${view.read()}`);
      assert.ok(view.read().includes("HTTP 400"), view.read());
      assert.ok(!view.read().includes("chat.turnError"), `untranslated key: ${view.read()}`);
      view.unmount();
    }
  });
}

test("without error_detail the row still classifies the text", () => {
  locale = "en-US";
  const view = render(React.createElement(TurnErrorNotice, { error: "429 Too Many Requests" }));
  assert.equal(view.attr("[data-turn-error]", "data-turn-error"), "rate_limit");
  view.unmount();
});

test("a turn cut off by a backend restart says so instead of Stopped", () => {
  for (const [lang, interrupted] of [
    ["en-US", "Interrupted (the backend restarted)"],
    ["zh-CN", "已中断（后端已重启）"],
  ]) {
    locale = lang;
    const plain = render(React.createElement(GenerationStoppedNotice, {}));
    assert.notEqual(plain.read(), interrupted);
    assert.equal(plain.attr("[data-generation-stopped]", "data-generation-stopped"), "");
    plain.unmount();
    const view = render(React.createElement(GenerationStoppedNotice, { interrupted: true }));
    assert.equal(view.read(), interrupted);
    assert.equal(view.attr("[data-generation-stopped]", "data-generation-stopped"), "shutdown");
    view.unmount();
  }
});
