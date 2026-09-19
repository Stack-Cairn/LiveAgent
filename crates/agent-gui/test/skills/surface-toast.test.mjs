import assert from "node:assert/strict";
import test from "node:test";
import { createToastTestEnv } from "../helpers/toast-test-env.mjs";

test("root result notices remain persistent, announce details, and run undo exactly once", async () => {
  const env = await createToastTestEnv();
  const { toast, act } = env;
  const actions = [];
  try {
    await env.mount();
    await act(async () => toast.error("Import failed", {
      id: "result", appearance: "notice", duration: 0, description: "file A: unavailable\nfile B: invalid",
      action: { label: "Undo", onClick: () => actions.push("undo") },
    }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 180)));
    const card = document.querySelector('[role="alertdialog"]');
    assert.ok(card.classList.contains("bg-background"));
    assert.equal(card.classList.contains("shadow-lg"), false);
    assert.match(card.textContent, /file A: unavailable/);
    assert.equal(document.getElementById(card.getAttribute("aria-labelledby")).textContent, "Import failed");
    await act(async () => [...card.querySelectorAll("button")].find(n => n.textContent === "Undo").click());
    assert.deepEqual(actions, ["undo"]);
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
  } finally { await env.cleanup(); }
});

test("repeated scan refreshes the same toast lifetime without accumulating notices", async (context) => {
  const env = await createToastTestEnv();
  const { toast, act } = env;
  const closed = [];
  const wait = ms => act(async () => context.mock.timers.tick(ms));
  try {
    await env.mount();
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const scan = () => toast.success("Scan complete", { id: "scan", appearance: "notice", duration: 180, onDismiss: () => closed.push("scan") });
    await act(async () => scan()); await wait(100);
    await act(async () => scan()); await wait(100);
    assert.deepEqual(closed, []);
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    await wait(130); assert.deepEqual(closed, ["scan"]);
  } finally { await env.cleanup(); }
});

test("root toaster preserves each notification position across mounting and updates", async () => {
  const env = await createToastTestEnv();
  const { toast, act } = env;
  const closed = [];
  const viewport = position => document.querySelector(`[data-toast-position="${position}"]`);
  try {
    toast.success("Scan complete", { id: "scan", position: "bottom-right", duration: 0 });
    toast.success("Undo changes", { id: "undo", position: "bottom-center", duration: 0 });
    toast.error("Upload failed", { id: "upload", duration: 0 });
    await env.mount();
    assert.match(viewport("bottom-right").textContent, /Scan complete/);
    assert.match(viewport("bottom-center").textContent, /Undo changes/);
    assert.match(viewport("top-right").textContent, /Upload failed/);
    await act(async () => toast.success("Scan refreshed", { id: "scan", duration: 0, onDismiss: () => closed.push("scan") }));
    assert.match(viewport("bottom-right").textContent, /Scan refreshed/);
    assert.doesNotMatch(viewport("top-right").textContent, /Scan/);
    await act(async () => toast.dismiss("scan"));
    assert.deepEqual(closed, ["scan"]);
    assert.match(viewport("bottom-center").textContent, /Undo changes/);
    assert.match(viewport("top-right").textContent, /Upload failed/);
    await act(async () => toast.dismiss());
    assert.equal(document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length, 0);
  } finally { await env.cleanup(); }
});
