import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const sharedSource = (name) => fileURLToPath(new URL(`../../../agent-ui/src/${name}`, import.meta.url));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalWindow = globalThis.window;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    globalThis.window = originalWindow;
  });
  const requests = [];
  const runs = new Map();
  const container = document.createElement("div");
  const passthrough = ({ children }) => React.createElement("div", null, children);
  const loader = createWebModuleLoader({ mocks: {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: translate }) },
    "@liveagent/ui/lib/shared/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
    [sharedSource("components/ui/button.tsx")]: { Button: passthrough },
    [sharedSource("components/ui/dialog.tsx")]: {
      Dialog: passthrough, DialogContent: passthrough, DialogTitle: passthrough, DialogClose: passthrough,
    },
    [sharedSource("pages/settings/shared.tsx")]: {
      ConfirmActionPopover: ({ children }) => children(() => {}),
    },
    [sharedSource("lib/automation/index.ts")]: {
      ...createWebModuleLoader().loadModule("@liveagent/ui/lib/automation/types.ts"),
      useAutomation: () => ({ cron: { tasks: ["a", "b"].map((id) => ({
        id, name: id, type: "bash", script: "true", cron: "0 * * * * *", enabled: true,
      })) } }),
      listCronRuns: async (taskId) => runs.get(taskId) ?? [],
      canCancelCronRun: () => true,
      runCronNow: (taskId) => request("run_now", taskId),
      cancelCronRun: (taskId, executionId) => request("cancel_run", taskId, executionId),
    },
  } });
  function request(action, taskId, executionId) {
    const pending = deferred();
    requests.push({ action, taskId, executionId, ...pending });
    return pending.promise;
  }
  const { CronTaskViewModal } = loader.loadModule("@liveagent/ui/pages/settings/CronTaskViewModal.tsx");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  const render = async (taskId) => act(async () => root.render(
    React.createElement(CronTaskViewModal, { taskId, onClose() {} }),
  ));
  const button = (label) => container.querySelector(`[aria-label="settings.${label}"]`);
  const click = async (label) => {
    const target = button(label);
    assert.ok(target, `missing ${label}: ${container.innerHTML}`);
    assert.equal(target.disabled, false);
    await act(async () => target.click());
  };
  await render("a");
  return { render, button, click, requests, runs, container };
}

const translate = (key) => key;
const runRecord = (startedAt, state = "leased", id = `run-${startedAt}`) => ({
  id, taskId: "a", state, counted: false, startedAt,
  success: state === "done", durationMs: 0, output: "",
});

for (const outcome of ["success", "error"]) {
  test(`Cron task A→B→A ignores the first view's late run-now ${outcome}`, async (t) => {
    const h = await harness(t);
    await h.click("cronViewRunNow");
    const first = h.requests[0];
    await h.render("b");
    await h.render("a");
    await h.click("cronViewRunNow");
    const current = h.requests[1];
    await act(async () => {
      if (outcome === "success") first.resolve({ startedAt: 100 });
      else first.reject(new Error("old run failed"));
    });
    assert.ok(h.button("cronViewRunningNow"), "current request remains pending without a stale timestamp");
    assert.doesNotMatch(h.container.textContent, /old run failed/);
    await act(async () => current.resolve({ startedAt: 200, executionId: "current-run" }));
    assert.ok(h.button("cronViewCancelRun"), "current response enables cancellation");
    await h.click("cronViewCancelRun");
    assert.equal(h.requests[2].executionId, "current-run");
    assert.deepEqual(h.requests.map(({ action, taskId }) => [action, taskId]), [["run_now", "a"], ["run_now", "a"], ["cancel_run", "a"]]);
  });
}

test("Cron revisiting a task hydrates active history and ignores the prior view's cancel failure", async (t) => {
  const h = await harness(t);
  await h.click("cronViewRunNow");
  h.runs.set("a", [runRecord(100, "leased", "execution-100")]);
  await act(async () => h.requests[0].resolve({ startedAt: 100 }));
  await act(async () => h.requests[0].resolve({ startedAt: 100, executionId: "execution-100" }));
  await h.click("cronViewCancelRun");
  const firstCancel = h.requests[1];
  await h.render("b");
  await h.render("a");
  await h.click("cronViewCancelRun");
  const currentCancel = h.requests[2];
  await act(async () => firstCancel.reject(new Error("old cancellation failed")));
  assert.doesNotMatch(h.container.textContent, /old cancellation failed/);
  assert.equal(h.button("cronViewCancelRun").disabled, true, "new cancellation remains pending");
  await act(async () => currentCancel.reject(new Error("current cancellation failed")));
  assert.match(h.container.textContent, /current cancellation failed/);
  assert.equal(h.button("cronViewCancelRun").disabled, false, "current errors still allow retry");
});
