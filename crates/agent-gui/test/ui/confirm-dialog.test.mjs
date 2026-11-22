import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// The shared in-app confirmation: a promise that resolves once, a safe default
// focus, Esc as "no", and a tone that only paints the confirm button.

async function mountConfirm(task) {
  const env = await createDomTestEnv({
    mocks: { "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }) },
  });
  const { useConfirmDialog } = env.loadModule("@liveagent/ui/components/ui/confirm-dialog.tsx");
  let api;
  function Harness() {
    const { confirm, dialog } = useConfirmDialog();
    api = confirm;
    return dialog;
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () => env.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const action = (name) => dialog()?.querySelector(`[data-confirm-dialog-action="${name}"]`);
  // Wrapped so the caller gets the pending promise back instead of awaiting it.
  const ask = async (options) => {
    let result;
    await env.act(async () => { result = api(options); });
    await settle();
    return { result };
  };
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    await task({ env, ask, dialog, action, settle });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

const base = { title: "Delete item?", description: "It cannot be restored.", confirmLabel: "Delete", cancelLabel: "Cancel" };

test("confirm resolves true from the confirm button and false from cancel", async () => {
  await mountConfirm(async ({ env, ask, dialog, action, settle }) => {
    const { result: accepted } = await ask(base);
    assert.match(dialog().textContent, /Delete item\?/);
    assert.match(dialog().textContent, /It cannot be restored\./);
    await env.act(async () => action("confirm").click());
    assert.equal(await accepted, true);
    await settle();
    assert.equal(dialog(), null);

    const { result: declined } = await ask(base);
    await env.act(async () => action("cancel").click());
    assert.equal(await declined, false);
  });
});

test("focus starts on the safe cancel button and Esc resolves false", async () => {
  await mountConfirm(async ({ env, ask, dialog, action }) => {
    const { result } = await ask(base);
    assert.equal(document.activeElement, action("cancel"), "Enter must not confirm by default");
    await env.act(async () => {
      document.activeElement.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    assert.equal(await result, false);
    assert.equal(dialog(), null);
  });
});

test("without a cancel button the only action receives focus", async () => {
  await mountConfirm(async ({ env, ask, action }) => {
    const { result } = await ask({ ...base, hideCancel: true });
    assert.equal(action("cancel"), null);
    assert.equal(document.activeElement, action("confirm"));
    await env.act(async () => action("confirm").click());
    assert.equal(await result, true);
  });
});

test("tone defaults to destructive and 'default' renders a primary confirm button", async () => {
  await mountConfirm(async ({ env, ask, action }) => {
    let { result } = await ask(base);
    assert.equal(action("confirm").dataset.tone, "destructive");
    assert.match(action("confirm").className, /bg-destructive/);
    await env.act(async () => action("cancel").click());
    await result;

    ({ result } = await ask({ ...base, tone: "default" }));
    assert.equal(action("confirm").dataset.tone, "default");
    assert.match(action("confirm").className, /bg-primary/);
    assert.doesNotMatch(action("confirm").className, /destructive/);
    await env.act(async () => action("confirm").click());
    assert.equal(await result, true);

    ({ result } = await ask({ ...base, preferCancel: true, tone: "default" }));
    assert.doesNotMatch(action("confirm").className, /destructive/, "a non-destructive ghost stays neutral");
    await env.act(async () => action("cancel").click());
    await result;
  });
});

test("a newer request settles the one it replaces as declined", async () => {
  await mountConfirm(async ({ env, ask, action }) => {
    const { result: first } = await ask(base);
    const { result: second } = await ask({ ...base, title: "Second?" });
    assert.equal(await first, false);
    await env.act(async () => action("confirm").click());
    assert.equal(await second, true);
  });
});
