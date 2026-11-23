// A lazy chunk that fails to load (offline, a deploy replaced the files) shows
// a retry row instead of a blank area, and Retry loads it again.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const messages = {
  "app.chunkLoadFailed": "This part of the page could not be loaded.",
  "app.chunkLoadRetry": "Retry",
};
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => messages[key] ?? key }) },
  },
});
const { React, act, createRoot } = env;
const { onDemand } = env.loadModule("@liveagent/ui/components/OnDemand.tsx");
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

test("a failed chunk offers a retry that loads it again", async () => {
  let attempts = 0;
  const Panel = onDemand(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("Failed to fetch dynamically imported module");
    return ({ label }) => React.createElement("p", { "data-panel": "" }, label);
  }, React.createElement("span", { "data-fallback": "" }));

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalError = console.error;
  console.error = () => {}; // React reports the caught load error
  try {
    act(() => root.render(React.createElement(Panel, { label: "loaded" })));
    assert.ok(container.querySelector("[data-fallback]"), "the fallback shows while loading");
    await settle();

    const alert = container.querySelector("[data-chunk-load-error]");
    assert.ok(alert, "a failed load shows the retry row");
    assert.match(alert.textContent, /could not be loaded/);
    assert.equal(container.querySelector("[data-panel]"), null);

    act(() => alert.querySelector("button").click());
    await settle();
    assert.equal(attempts, 2);
    assert.equal(container.querySelector("[data-chunk-load-error]"), null);
    assert.equal(container.querySelector("[data-panel]")?.textContent, "loaded");
  } finally {
    console.error = originalError;
    act(() => root.unmount());
    container.remove();
  }
});

test("a retry that fails again reloads the page", async () => {
  const Panel = onDemand(async () => {
    throw new TypeError("Failed to fetch dynamically imported module");
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  // jsdom cannot navigate; it reports the reload attempt as "Not implemented".
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  const reloads = () => errors.filter((line) => /Not implemented: navigation/.test(line)).length;
  try {
    act(() => root.render(React.createElement(Panel)));
    await settle();
    assert.equal(reloads(), 0, "the first failure offers Retry instead");
    act(() => container.querySelector("[data-chunk-load-error] button").click());
    await settle();
    assert.equal(reloads(), 1);
  } finally {
    console.error = originalError;
    act(() => root.unmount());
  }
});

test("a render error that is not a chunk failure is not swallowed", async () => {
  const Broken = onDemand(async () => () => {
    throw new Error("render bug");
  });
  class Outer extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
      return { error };
    }
    render() {
      return this.state.error ? `outer: ${this.state.error.message}` : this.props.children;
    }
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const originalError = console.error;
  console.error = () => {};
  try {
    act(() => root.render(React.createElement(Outer, null, React.createElement(Broken))));
    await settle();
    assert.equal(container.textContent, "outer: render bug");
  } finally {
    console.error = originalError;
    act(() => root.unmount());
  }
});
