import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const preferencePath = "@liveagent/ui/lib/externalLinkPreference.ts";
const storageKey = "liveagent:skip-external-link-confirmation:v1";

function installStorage(t, storage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
}

test("external-link preference survives module reload and tolerates unavailable storage", (t) => {
  const values = new Map();
  installStorage(t, {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  const preference = createTsModuleLoader().loadModule(preferencePath);
  assert.equal(preference.shouldSkipExternalLinkConfirmation(), false);
  values.set(storageKey, "false");
  assert.equal(preference.shouldSkipExternalLinkConfirmation(), false);
  preference.rememberExternalLinkConfirmation();
  assert.equal(values.get(storageKey), "true");
  assert.equal(createTsModuleLoader().loadModule(preferencePath).shouldSkipExternalLinkConfirmation(), true);

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("Storage blocked"); },
  });
  const blocked = createTsModuleLoader().loadModule(preferencePath);
  assert.equal(blocked.shouldSkipExternalLinkConfirmation(), false);
  assert.doesNotThrow(() => blocked.rememberExternalLinkConfirmation());
  assert.equal(blocked.shouldSkipExternalLinkConfirmation(), true);
});

test("external-link dialog saves only on checked confirmation and bypasses all mounted links", async (t) => {
  const opened = [];
  const copied = [];
  let failOpener = false;
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": {
      ChevronDown: icon, ChevronUp: icon, Copy: icon, ExternalLink: icon,
      Check: icon, Minus: icon, X: icon,
    },
    "@streamdown/cjk": { cjk: {} },
    "@streamdown/code": { code: {} },
    "@streamdown/math": { math: {} },
    "@streamdown/mermaid": { mermaid: {} },
    streamdown: { Streamdown: () => null, defaultRemarkPlugins: {}, defaultRehypePlugins: {} },
    "@liveagent/app/shims/tauriOpener": { openUrl(url) {
      if (failOpener) throw new Error("Opener unavailable");
      opened.push(url);
    } },
  } });
  installStorage(t, env.dom.window.localStorage);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (url) => copied.push(url) } });
  window.open = (url) => opened.push(url);
  const { markdownComponents, MarkdownLink } = env.loadModule("@liveagent/ui/components/Markdown.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  t.after(async () => { await env.act(() => root.unmount()); env.cleanup(); });
  await env.act(() => root.render(env.React.createElement(env.React.Fragment, null,
    env.React.createElement(markdownComponents.a, { href: "https://example.com/first" }, "First"),
    env.React.createElement(MarkdownLink, { href: "https://example.org/second" }, "Second"),
    env.React.createElement(markdownComponents.a, { href: "streamdown:incomplete-link" }, "Incomplete"),
  )));
  const button = (label) => [...document.querySelectorAll("button")].find((el) => el.textContent === label);
  const click = async (element) => { assert.ok(element); await env.act(() => element.click()); };
  const dialog = () => document.querySelector('[role="dialog"]');
  const checkbox = () => document.querySelector('[role="checkbox"]');

  await click(button("First"));
  assert.ok(dialog());
  assert.equal(dialog().querySelector('[data-slot="dialog-title"]').textContent, "打开外部链接");
  assert.equal(checkbox().getAttribute("aria-checked"), "false");
  await click(checkbox());
  await click(button("复制链接"));
  assert.deepEqual(copied, ["https://example.com/first"]);
  assert.equal(localStorage.getItem(storageKey), null);
  await click(document.querySelector('[aria-label="关闭"]'));
  assert.equal(localStorage.getItem(storageKey), null);

  await click(button("First"));
  assert.equal(checkbox().getAttribute("aria-checked"), "false");
  await click(button("打开链接"));
  assert.deepEqual(opened, ["https://example.com/first"]);
  assert.equal(localStorage.getItem(storageKey), null);

  await click(button("Second"));
  assert.ok(dialog());
  await click(checkbox());
  await click(button("打开链接"));
  assert.equal(localStorage.getItem(storageKey), "true");
  await click(button("First"));
  assert.equal(dialog(), null);
  await click(button("Second"));
  assert.equal(dialog(), null);
  assert.deepEqual(opened, [
    "https://example.com/first", "https://example.org/second",
    "https://example.com/first", "https://example.org/second",
  ]);
  await click(button("Incomplete"));
  assert.equal(opened.length, 4);

  failOpener = true;
  const previousError = console.error;
  console.error = () => {};
  try { await click(button("First")); } finally { console.error = previousError; }
  assert.equal(opened.at(-1), "https://example.com/first");
  assert.equal(opened.length, 5);
});
