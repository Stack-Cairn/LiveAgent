import assert from "node:assert/strict";
import test from "node:test";
import { createToastTestEnv } from "../helpers/toast-test-env.mjs";

test("root toast functions buffer startup calls, preserve order and upsert, and survive page changes", async () => {
  const env = await createToastTestEnv();
  const { toast, React, act } = env;
  const closed = [];
  try {
    toast.success("first", { id: "first", duration: 0 });
    const cancelled = toast.error("cancelled before mount"); toast.dismiss(cancelled);
    function Page() {
      React.useEffect(() => { toast.error("second", { id: "second", duration: 0, onDismiss: () => closed.push("second") }); }, []);
      return React.createElement("main", null, "page");
    }
    await env.mount(React.createElement(Page));
    const cards = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
    assert.deepEqual(cards().map(n => n.querySelector("p").textContent), ["first", "second"]);
    assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1);
    const first = cards()[0];
    assert.equal(document.getElementById(first.getAttribute("aria-describedby")).textContent, "first");
    await act(async () => toast.success("updated", { id: "first", duration: 0 }));
    assert.equal(cards().length, 2);
    assert.equal(cards()[0].querySelector("p").textContent, "updated");
    await env.mount(React.createElement("main", null, "another page"));
    assert.equal(cards().length, 2);
    await act(async () => document.querySelector('[role="alertdialog"] button').click());
    assert.deepEqual(closed, ["second"]);
    await act(async () => toast.dismiss("second"));
    assert.deepEqual(closed, ["second"]);
    await act(async () => toast.dismiss());
    assert.equal(cards().length, 0);
  } finally { await env.cleanup(); }
});

test("root toast timer pauses for hover and keyboard focus and resumes afterwards", async (context) => {
  const env = await createToastTestEnv();
  const { toast, act } = env;
  const closed = [];
  const wait = () => act(async () => context.mock.timers.tick(180));
  try {
    await env.mount();
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    await act(async () => toast.success("timed", { duration: 120, onDismiss: () => closed.push("timer") }));
    const viewport = document.querySelector('.layer-toast');
    await act(async () => viewport.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await wait(); assert.deepEqual(closed, []);
    await act(async () => viewport.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true })));
    await wait(); assert.deepEqual(closed, []);
    await act(async () => document.activeElement.blur());
    await wait(); assert.deepEqual(closed, ["timer"]);
  } finally { await env.cleanup(); }
});
