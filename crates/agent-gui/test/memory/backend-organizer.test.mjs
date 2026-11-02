import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const calls = [];
let runs = null;
let reject = false;
let release;
const env = await createDomTestEnv({ mocks: {
  "@liveagent/app/shims/tauriCore": { invoke: async (command, args) => {
    assert.equal(command, "memory_organizer"); calls.push(args);
    if (reject) throw Error("backend offline");
    if (args.action === "history") return { runs };
    if (args.action === "run") {
      await new Promise(resolve => { release = resolve; });
      runs = [
        { runId: "old-no-op", createdAt: "2026-10-23T00:00:00Z", status: "completed", phase: "complete", scanned: 0 },
        { runId: "proposal", createdAt: Date.parse("2026-10-24T00:00:00Z"), status: "pending_review", phase: "gate", scanned: 2, pending: [{ op: "delete", scope: "global", slug: "duplicate" }] },
      ];
    } else { runs = runs.map(run => run.runId === args.runId ? { ...run, status: "completed", pending: [] } : run); }
    return runs[0];
  } },
} });
after(() => env.cleanup());
const { React, act, createRoot, loadModule } = env;
const { BackendMemoryOrganizer } = loadModule("@liveagent/ui/pages/settings/memory/BackendMemoryOrganizer.tsx");

test("backend organizer reviews proposals, serializes mutations, applies once, and reports failures", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(BackendMemoryOrganizer, { workdir: "/project", t: x => x })));
    assert.deepEqual(calls[0], { action: "history", workdir: "/project" });
    const button = key => [...container.querySelectorAll("button")].find(b => b.textContent === key);
    await act(async () => { button("settings.memoryOrganizerRunNow").click(); button("settings.memoryOrganizerRunNow").click(); });
    assert.equal(calls.filter(c => c.action === "run").length, 1);
    assert.ok(button("settings.memoryOrganizerRunNow").disabled);
    await act(async () => release());
    assert.equal(container.querySelector(".font-mono").textContent, "proposal");
    assert.match(container.textContent, /delete · global · duplicate/);
    await act(async () => button("settings.memoryOrganizerApplyProposal").click());
    assert.deepEqual(calls.find(c => c.action === "apply"), { action: "apply", runId: "proposal", workdir: "/project" });
    assert.match(container.textContent, /completed/);
    assert.equal(button("settings.memoryOrganizerApplyProposal"), undefined);
    reject = true;
    await act(async () => button("settings.memoryRefresh").click());
    assert.match(container.querySelector('[role="alert"]').textContent, /backend offline/);
    assert.equal(button("settings.memoryRefresh").disabled, false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
