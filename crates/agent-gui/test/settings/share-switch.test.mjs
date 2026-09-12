import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("large share switch keeps a native button and waits for controlled state", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { Switch } = env.loadModule("@liveagent/ui/components/ui/switch.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = React.createRef();
  const changes = [];
  let submits = 0;
  const render = async (checked, disabled = false) => {
    await act(async () => root.render(React.createElement("form", {
      onSubmit: (event) => { event.preventDefault(); submits++; },
    }, React.createElement(Switch, {
      ref, size: "lg", nativeButton: true,
      render: React.createElement("button", { type: "button" }),
      checked, disabled, title: "Share", "aria-label": "Share",
      onCheckedChange: (value) => changes.push(value),
    }))));
    return host.querySelector('button[role="switch"]');
  };
  try {
    let button = await render(false);
    assert.equal(ref.current, button);
    assert.equal(button.title, "Share");
    assert.equal(button.type, "button");
    await act(async () => button.click());
    assert.deepEqual(changes, [true]);
    assert.equal(button.getAttribute("aria-checked"), "false");
    button = await render(true);
    assert.equal(button.getAttribute("aria-checked"), "true");
    await act(async () => button.click());
    assert.deepEqual(changes, [true, false]);
    // The managed-share list remains checked until its owner removes/updates it.
    assert.equal(button.getAttribute("aria-checked"), "true");
    button = await render(true, true);
    assert.equal(button.disabled, true);
    await act(async () => button.click());
    assert.deepEqual(changes, [true, false]);
    assert.equal(submits, 0);
    assert.equal(host.querySelector('input[type="checkbox"]').name, "");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});

test("adding large switches preserves the existing size and tone contracts", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { Switch } = env.loadModule("@liveagent/ui/components/ui/switch.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (const [size, track, thumb] of [
      ["default", "h-5 w-9", "size-4 data-[checked]:translate-x-18px"],
      ["sm", "h-4 w-7", "size-3 data-[checked]:translate-x-14px"],
      ["lg", "h-6 w-11", "size-5 translate-x-0 data-[checked]:translate-x-5"],
    ]) {
      await act(async () => root.render(React.createElement(Switch, { size, checked: true })));
      const control = host.querySelector('[role="switch"]');
      const indicator = control.querySelector('[data-slot="switch-thumb"]');
      for (const token of track.split(" ")) assert.ok(control.classList.contains(token));
      for (const token of thumb.split(" ")) assert.ok(indicator.classList.contains(token));
      assert.equal(control.tagName, "SPAN");
      assert.equal(control.getAttribute("aria-checked"), "true");
    }
    await act(async () => root.render(React.createElement(Switch, { tone: "success", checked: true })));
    assert.ok(host.querySelector('[role="switch"]').classList.contains('data-[checked]:bg-sky-500'));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
