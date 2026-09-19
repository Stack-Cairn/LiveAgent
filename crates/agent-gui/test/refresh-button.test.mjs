import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "./helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { Button, RefreshButton } = env.loadModule("@liveagent/ui/components/ui/button.tsx");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(Component = RefreshButton, initialProps = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (props) => act(() => root.render(React.createElement(Component, props, "Refresh")));
  render(initialProps);
  return {
    button: container.querySelector("button"), render,
    cleanup() { act(() => root.unmount()); container.remove(); },
  };
}

test("fast refresh runs immediately and holds feedback while blocking repeated clicks", async () => {
  let calls = 0;
  const view = mount(RefreshButton, { onClick: () => { calls++; } });
  try {
    act(() => { view.button.click(); view.button.click(); });
    assert.equal(calls, 1);
    assert.equal(view.button.getAttribute("aria-busy"), "true");
    assert.equal(view.button.disabled, true);
    await act(async () => wait(100));
    assert.equal(view.button.disabled, true);
    await act(async () => wait(450));
    assert.equal(view.button.getAttribute("aria-busy"), "false");
    assert.equal(view.button.disabled, false);
    act(() => view.button.click());
    assert.equal(calls, 2);
  } finally { view.cleanup(); }
});

test("slow refresh stays busy until the real operation completes", async () => {
  const view = mount();
  try {
    act(() => view.button.click());
    view.render({ "aria-busy": true });
    await act(async () => wait(550));
    assert.equal(view.button.disabled, true);
    assert.equal(view.button.getAttribute("aria-busy"), "true");
    view.render({ "aria-busy": false });
    assert.equal(view.button.disabled, false);
  } finally { view.cleanup(); }
});

test("failure result is delivered immediately and feedback never manufactures success", async () => {
  let error = null;
  const view = mount(RefreshButton, {
    onClick: async () => {
      try { await Promise.reject(new Error("offline")); }
      catch (failure) { error = failure; }
    },
  });
  try {
    await act(async () => view.button.click());
    assert.equal(error.message, "offline");
    assert.equal(view.button.getAttribute("aria-busy"), "true");
    await act(async () => wait(550));
    assert.equal(view.button.disabled, false);
    assert.equal(view.button.textContent, "Refresh");
  } finally { view.cleanup(); }
});

test("ordinary buttons and disabled refresh actions retain their behavior", () => {
  let calls = 0;
  const plain = mount(Button, { onClick: () => { calls++; } });
  const disabled = mount(RefreshButton, { disabled: true, onClick: () => { calls++; } });
  try {
    act(() => { plain.button.click(); plain.button.click(); disabled.button.click(); });
    assert.equal(calls, 2);
    assert.equal(plain.button.disabled, false);
    assert.equal(plain.button.hasAttribute("aria-busy"), false);
    assert.equal(disabled.button.getAttribute("aria-busy"), "false");
  } finally { plain.cleanup(); disabled.cleanup(); }
});

test.after(() => env.cleanup());
