import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Regression coverage for the startup screen that never left: a backend step that stops
// answering must end on its own, and the user must always have a way into the app.

const loader = createTsModuleLoader();
const { withDeadline } = loader.loadModule("src/lib/kbrain/deadline.ts");
const { createStartupRenderer, STARTUP_STALL_MS } = loader.loadModule("src/lib/startup/render.ts");

const never = () => new Promise(() => {});
const SHORT = { requestMs: 50, pageMs: 50, importBaseMs: 50, importPerMiBMs: 0, importMaxMs: 50 };

test("withDeadline settles at the deadline even when the step ignores its signal", async () => {
  let seen;
  const started = Date.now();
  await assert.rejects(
    withDeadline((signal) => {
      seen = signal;
      return never();
    }, 30, "Stuck step"),
    (error) => error.name === "TimeoutError" && /Stuck step did not finish/.test(error.message),
  );
  assert.equal(seen.aborted, true);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(await withDeadline(async () => "ok", 1_000, "Quick step"), "ok");
});

test("withDeadline follows the parent signal, including one aborted before the start", async () => {
  const parent = new AbortController();
  const pending = withDeadline(never, 60_000, "Long step", parent.signal);
  parent.abort(new Error("user restarted"));
  await assert.rejects(pending, /user restarted/);
  await assert.rejects(withDeadline(never, 60_000, "Late step", parent.signal), /user restarted/);
});

function oldConversation(id) {
  return { id, title: "t", providerId: "p", model: "m", createdAt: 1000, updatedAt: 2000, isPinned: false, isShared: false, redactToolContent: false, contextMetaJson: "{}", checkpoint: { status: "not_found" }, segments: [{ segmentIndex: 0, segmentId: "first", messagesJson: JSON.stringify([{ id: "u", role: "user", content: "hi", timestamp: 1000 }]) }] };
}

function isolatedMigration(t, invoke) {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  t.after(() => delete globalThis.localStorage);
  const isolated = createTsModuleLoader({ mocks: {
    "@liveagent/app/shims/tauriCore": { invoke },
    "../host": { isTauriHost: () => true },
  } });
  const migration = isolated.loadModule("src/lib/kbrain/historyMigration.ts");
  const runtime = isolated.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: "http://migration.test", token: "", protocolVersion: "kbrain.agent.v1" });
  t.after(() => runtime.clearKBrainRuntimeConnection());
  return migration;
}

test("an import the backend never answers ends the pass as a transient failure", async (t) => {
  const migration = isolatedMigration(t, async (command) => ({
    complete: true,
    conversations: command === "legacy_history_migration_page" ? [oldConversation("stuck")] : [],
  }));
  const events = [];
  const started = Date.now();
  // A fetch that never settles and ignores its abort signal, as a stopped backend process does.
  const result = await migration.migrateAllHistoryOnce({ fetch: never, timeouts: SHORT, onProgress: (event) => events.push(event) });
  assert.ok(Date.now() - started < 5_000, "the pass must end on its own");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].sourceId, "stuck");
  assert.match(result.failures[0].error, /did not finish within/);
  assert.equal(events.filter((event) => event.operation === "settled" && event.outcome === "failed").length, 1);
  assert.equal(events.filter((event) => event.operation === "done").length, 2);
});

test("a legacy page read that never returns marks the source as error and the pass still ends", async (t) => {
  const migration = isolatedMigration(t, (command) =>
    command === "legacy_history_migration_page" ? never() : Promise.resolve({ complete: true, conversations: [] }),
  );
  const events = [];
  const result = await migration.migrateAllHistoryOnce({ fetch: never, timeouts: SHORT, onProgress: (event) => events.push(event) });
  assert.equal(result.complete, false);
  assert.equal(events.some((event) => event.source === "legacy" && event.operation === "error"), true);
  assert.equal(events.some((event) => event.source === "pi" && event.operation === "done"), true);
});

function bootDocument(t) {
  const dom = new JSDOM(readFileSync(new URL("../../index.html", import.meta.url), "utf8"), { url: "http://localhost" });
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem("liveagent.ui-settings.v1", JSON.stringify({ locale: "en" }));
  const originalNow = Date.now;
  const clock = { now: 1_000 };
  Date.now = () => clock.now;
  t.after(() => {
    Date.now = originalNow;
    dom.window.close();
    delete globalThis.localStorage;
  });
  return { doc: dom.window.document, clock };
}

test("a stalled startup step offers skip and restart, and only the first choice counts", (t) => {
  const { doc, clock } = bootDocument(t);
  const screen = createStartupRenderer(doc);
  t.after(() => screen.dispose());
  const retryButton = doc.querySelector("[data-boot-retry]");
  const skipButton = doc.querySelector("[data-boot-skip]");
  const choices = [];
  screen.offerEscapes({ skip: () => choices.push("skip"), retry: () => choices.push("retry") });
  screen.phase("checking");
  screen.progress({ source: "pi", operation: "done" });
  clock.now += STARTUP_STALL_MS - 1;
  // Repeating an operation is not progress; it only forces a paint.
  screen.progress({ source: "pi", operation: "done" });
  assert.equal(retryButton.hidden, true, "no escape while work is still progressing");
  assert.equal(skipButton.hidden, true);
  clock.now += 1;
  screen.progress({ source: "pi", operation: "done" });
  assert.equal(skipButton.hidden, false);
  assert.equal(skipButton.textContent, "Skip and open LiveAgent");
  assert.equal(retryButton.hidden, false);
  assert.equal(retryButton.textContent, "Restart local service and retry");
  assert.match(doc.querySelector("[data-boot-waiting]").textContent, /continues in the background/);
  skipButton.click();
  skipButton.click();
  retryButton.click();
  assert.deepEqual(choices, ["skip"]);
  assert.equal(retryButton.disabled, true);
});

test("a failed startup can still skip into the app once connected, and a new screen resets the buttons", (t) => {
  const { doc } = bootDocument(t);
  const screen = createStartupRenderer(doc);
  const choices = [];
  screen.offerEscapes({ skip: () => choices.push("skip"), retry: () => choices.push("stalled-retry") });
  screen.fail(() => choices.push("retry"));
  const retryButton = doc.querySelector("[data-boot-retry]");
  const skipButton = doc.querySelector("[data-boot-skip]");
  assert.equal(retryButton.hidden, false);
  assert.equal(retryButton.textContent, "Retry");
  assert.equal(skipButton.hidden, false);
  retryButton.click();
  skipButton.click();
  assert.deepEqual(choices, ["retry"]);
  const next = createStartupRenderer(doc);
  t.after(() => next.dispose());
  assert.equal(retryButton.hidden, true);
  assert.equal(skipButton.hidden, true);
  assert.equal(retryButton.disabled, false);
  assert.equal(skipButton.disabled, false);
});

test("before the backend connects a failure offers only retry", (t) => {
  const { doc } = bootDocument(t);
  const screen = createStartupRenderer(doc);
  t.after(() => screen.dispose());
  screen.fail(() => {});
  assert.equal(doc.querySelector("[data-boot-retry]").hidden, false);
  assert.equal(doc.querySelector("[data-boot-skip]").hidden, true);
});
