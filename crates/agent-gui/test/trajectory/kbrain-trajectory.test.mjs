import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import * as jsxRuntime from "react/jsx-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { startTrajectoryFixture, runTrajectoryPrompt } from "../helpers/kbrain-trajectory-fixture.mjs";

const loader = createTsModuleLoader();
const { createKBrainTrajectoryHost } = loader.loadModule("src/lib/kbrain/trajectory.ts");

test("trajectory host preserves HTTP errors and rejects invalid cursors", async () => {
  const host = createKBrainTrajectoryHost({
    fetch: async () => new Response(JSON.stringify({ error: "journal corrupt" }), { status: 500 }),
  });
  await assert.rejects(host.loadWindow("deadbeef"), (error) => error.status === 500 && error.message === "journal corrupt");
  await assert.rejects(host.loadWindow("deadbeef", -1), /pagination cursor/);
  await assert.rejects(host.loadSections("deadbeef", ["unknown"]), /journal corrupt/);
  assert.deepEqual(await host.loadSections("session", []), []);
});

test("trajectory host rejects malformed success instead of hiding missing data", async () => {
  const host = createKBrainTrajectoryHost({ fetch: async () => new Response("{}") });
  await assert.rejects(host.loadWindow("deadbeef"), /Malformed/);
});

function createLocalStorage() {
  const values = new Map();
  return {
    get length() {
      return values.size;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
  };
}

const emptyWindow = {
  version: "kbrain.agent.v1",
  conversationId: "backend-session",
  eventsJson: "[]",
  rawEvents: [],
  oldestSegmentIndex: 0,
  returnedSegmentCount: 0,
  totalSegmentCount: 0,
  hasMoreBefore: false,
  truncated: false,
};

async function withLocalStorage(callback) {
  const previous = globalThis.localStorage;
  const storage = createLocalStorage();
  globalThis.localStorage = storage;
  try {
    return await callback(storage);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
}

async function withHttpServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("trajectory host does not poll an unsent local conversation", async () => {
  let calls = 0;
  await withHttpServer((_req, _res) => {
    calls += 1;
  }, async (baseUrl) => {
    const host = createKBrainTrajectoryHost({ baseUrl });
    const localId = "63e2121b-1234-4234-8234-123456789abc";
    const window = await host.loadWindow(localId);
    assert.equal(window.eventsJson, "[]");
    assert.deepEqual(await host.loadSections(localId, ["section"]), []);
    assert.deepEqual(await host.loadSubagentRuns(localId, ["run"]), []);
    assert.equal((await host.loadStats(localId)).eventCount, 0);
  });
  assert.equal(calls, 0);
});

test("trajectory host uses mapped backend IDs and accepts backend IDs directly", async () => {
  await withLocalStorage(async () => {
    const { setKBrainSessionId } = loader.loadModule("src/lib/kbrain/mapping.ts");
    const localId = "63e2121b-1234-4234-8234-123456789abc";
    const requests = [];
    await withHttpServer((req, res) => {
      requests.push(req.url);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(emptyWindow));
    }, async (baseUrl) => {
      setKBrainSessionId(localId, "backend-session", baseUrl);
      const host = createKBrainTrajectoryHost({ baseUrl });
      await host.loadWindow(localId);
      await host.loadWindow("deadbeef");
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0], "/v1/sessions/backend-session/trajectory?max_segments=8");
    assert.equal(requests[1], "/v1/sessions/deadbeef/trajectory?max_segments=8");
  });
});

test("trajectory host preserves a stale mapped-session 404", async () => {
  await withLocalStorage(async () => {
    const { setKBrainSessionId } = loader.loadModule("src/lib/kbrain/mapping.ts");
    let calls = 0;
    await withHttpServer((_req, res) => {
      calls += 1;
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "session not found" }));
    }, async (baseUrl) => {
      setKBrainSessionId("local-stale", "backend-stale", baseUrl);
      const host = createKBrainTrajectoryHost({ baseUrl });
      await assert.rejects(
        host.loadWindow("local-stale"),
        (error) => error.status === 404 && error.message === "session not found",
      );
    });
    assert.equal(calls, 1);
  });
});

test("actual Agent HTTP capture reaches original trajectory ledger, rows and usage", { timeout: 240_000 }, async (t) => {
  const fixture = await startTrajectoryFixture(t);
  const isolatedLoader = createTsModuleLoader();
  const { createTauriTrajectoryHost } = isolatedLoader.loadModule("src/agent-ui-adapters/trajectory.ts");
  isolatedLoader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl: fixture.baseUrl,
    token: "owner",
    protocolVersion: "kbrain.agent.v1",
  });
  const host = createTauriTrajectoryHost();
  const { createKBrainClient } = isolatedLoader.loadModule("src/lib/kbrain/client.ts");
  const client = createKBrainClient();
  const session = await client.createSession({ cwd: fixture.workspace, model: { provider: "fixture", model: "fixture-model" } });
  const captured = [];
  for (const decision of ["allow_once", "reject", "allow_once"]) {
    const events = await runTrajectoryPrompt(client, session.id, "execute the trajectory command", decision);
    assert.ok(events.some((event) => event.type === "permission.requested"));
    const result = events.find((event) => event.type === "tool.result")?.payload.tool_result;
    assert.ok(result, "real Agent must publish its tool result");
    assert.equal(result.failed ?? false, decision === "reject");
    assert.ok(result.output.includes(decision === "reject" ? "Permission denied" : fixture.marker));
    captured.push(...events);
  }
  assert.equal(fixture.requests.length, 6, "each real turn makes a tool request and a follow-up request");
  assert.equal(fixture.requests.filter(({ input }) => input.messages.at(-1).role === "tool" &&
    JSON.stringify(input.messages.at(-1)).includes(fixture.marker)).length, 2);
  const window = await host.loadWindow(session.id);
  assert.deepEqual(window.rawEvents, captured, "HTTP trajectory must retain the actual SSE journal");
  assert.equal(window.totalSegmentCount, 3);
  assert.equal(window.truncated, false);
  assert.equal(window.rawEvents.filter((event) => event.type === "trajectory.request.started").length, 6);
  const { parseTrajectoryEvents, buildTrajectoryLedger } = loader.loadModule("@liveagent/ui/lib/trajectory/eventLog.ts");
  const { deriveTrajectoryLayout, flattenTrajectoryRecords } = loader.loadModule("@liveagent/ui/lib/trajectory/layout.ts");
  const ledger = buildTrajectoryLedger(parseTrajectoryEvents(window.eventsJson));
  const records = flattenTrajectoryRecords(deriveTrajectoryLayout({ ledger }));
  assert.equal(ledger.turns.length, 3);
  const tools = records.filter((record) => record.kind === "tool");
  assert.equal(tools.length, 3);
  assert.ok(tools.some((record) => record.result?.includes("trajectory-real-tool-output")));
  assert.ok(tools.some((record) => record.isError && record.result?.includes("Permission denied")));
  const stats = await host.loadStats(session.id);
  assert.equal(stats.toolCallCount, 3);
  assert.equal(stats.errorCount, 1);
  assert.equal(stats.usage.input_tokens, 72);
  assert.equal(stats.usage.output_tokens, 18);
  assert.equal(stats.usage.cached_tokens, 24);
  const messages = records.filter((record) => record.kind === "message");
  assert.equal(messages.length, 6);
  assert.equal(messages.reduce((sum, record) => sum + (record.usage?.input ?? 0), 0), 48);
  const { aggregateTrajectoryStats } = loader.loadModule("@liveagent/ui/lib/trajectory/stats.ts");
  const aggregate = aggregateTrajectoryStats(ledger);
  assert.equal(aggregate.inputTokens, 72, "cached input must not be counted twice");
  assert.equal(aggregate.outputTokens, 18);
  assert.ok(messages.every((record) => record.timeSeconds !== null), "recorded request timing is available");
  const ids = [...ledger.headers.values()].flatMap((header) => header.sections.filter(Boolean));
  const sections = await host.loadSections(session.id, ids);
  const system = sections.find((section) => section.slot === "base");
  const providerSystem = fixture.requests[0].input.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content).join("\n\n");
  assert.ok(system?.content.length > 0);
  assert.equal(system.content, providerSystem, "section content must be the actual provider prompt");
  const catalog = sections.find((section) => section.slot === "toolCatalog");
  assert.ok(catalog?.content.includes("bash"));
  const { toolSchemaFromCatalog } = loader.loadModule("@liveagent/ui/components/trajectory/details/sectionData.ts");
  assert.ok(toolSchemaFromCatalog(catalog.content, "bash")?.includes("command"));

  const rowLoader = createTsModuleLoader({ mocks: {
    [loader.resolveLocal("@liveagent/ui/i18n/index")]: { useLocale: () => ({ locale: "en", t: (key) => key }) },
    "react/jsx-runtime": jsxRuntime,
    [loader.resolveLocal("@liveagent/ui/components/Markdown")]: { Markdown: () => { throw new Error("UsageTab must not render Markdown"); } },
  } });
  const { TrajectoryRow } = rowLoader.loadModule("@liveagent/ui/components/trajectory/TrajectoryRow.tsx");
  const rendered = tools.map((record) => renderToStaticMarkup(createElement(TrajectoryRow, { record, selected: false, focused: false, dimmed: false, onSelect() {} })));
  const renderedText = rendered.join("\n");
  assert.match(renderedText, /trajectory-real-tool-output/);
  assert.match(renderedText, /Permission denied/);
  const { UsageTab } = rowLoader.loadModule("@liveagent/ui/components/trajectory/details/tabs/UsageTab.tsx");
  const usageHtml = renderToStaticMarkup(createElement(UsageTab, { record: messages.at(-1), locale: "en", t: (key) => key }));
  assert.equal(messages.at(-1).cumulativeUsage.totalTokens, 90);
  assert.match(usageHtml, /90/);
  assert.match(usageHtml, /48/);
  assert.match(usageHtml, /cacheRead/);
  t.diagnostic(`actual Go Agent/provider/bash/SSE -> authenticated HTTP -> shipped client/adapter/host -> original ledger/layout/TrajectoryRow: ${records.length} records, ${tools.length} tools`);
});

test("actual child HTTP expands original subtool layout", { timeout: 240_000 }, async (t) => {
  const fixture = await startTrajectoryFixture(t, { includeChild: true });
  const isolatedLoader = createTsModuleLoader();
  isolatedLoader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl: fixture.baseUrl, token: "owner", protocolVersion: "kbrain.agent.v1",
  });
  const { createKBrainClient } = isolatedLoader.loadModule("src/lib/kbrain/client.ts");
  const { createTauriTrajectoryHost } = isolatedLoader.loadModule("src/agent-ui-adapters/trajectory.ts");
  const client = createKBrainClient();
  const host = createTauriTrajectoryHost();
  const session = await client.createSession({ cwd: fixture.workspace, model: { provider: "fixture", model: "fixture-model" } });
  const events = await runTrajectoryPrompt(client, session.id, "delegate tool");
  const starts = events.filter((event) => event.type === "trajectory.request.started" && event.payload.task_id);
  assert.equal(starts.length, 2, "foreground child makes two actual provider requests");
  const runId = starts[0].payload.task_id;
  assert.ok(starts.every((event) => event.payload.task_id === runId));
  const childResult = events.find((event) => event.type === "trajectory.child.tool_end");
  assert.ok(childResult?.payload.output.includes(fixture.marker), "child must really execute bash");
  assert.equal(childResult.payload.failed, false);
  assert.equal(fixture.requests.filter((request) => request.child).length, 2);
  assert.equal(fixture.requests.filter((request) => !request.child).length, 2);
  const window = await host.loadWindow(session.id);
  assert.deepEqual(window.rawEvents, events);
  const { parseTrajectoryEvents, buildTrajectoryLedger } = loader.loadModule("@liveagent/ui/lib/trajectory/eventLog.ts");
  const { deriveTrajectoryLayout, flattenTrajectoryRecords } = loader.loadModule("@liveagent/ui/lib/trajectory/layout.ts");
  const ledger = buildTrajectoryLedger(parseTrajectoryEvents(window.eventsJson));
  const parent = ledger.turns.flatMap((turn) => turn.steps.flatMap((step) => step.tools))
    .find((tool) => tool.name === "subagent");
  assert.deepEqual(parent.subagentRunIds, [runId], "child ID must come from the parent HTTP projection");
  assert.equal(flattenTrajectoryRecords(deriveTrajectoryLayout({ ledger })).filter((record) => record.kind === "subtool").length, 0);
  const runs = await host.loadSubagentRuns(session.id, [...parent.subagentRunIds, runId]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, runId);
  assert.equal(runs[0].status, "complete");
  assert.equal(runs[0].steps.length, 2);
  assert.ok(runs[0].steps.every((step) => typeof step.startedAt === "number" && typeof step.endedAt === "number"));
  const tool = runs[0].steps[0].tools[0];
  assert.equal(tool.name, "bash");
  assert.equal(tool.isError, false);
  assert.equal(tool.startedAt, Date.parse(events.find((event) => event.type === "trajectory.child.tool_start").created_at));
  assert.equal(tool.endedAt, Date.parse(childResult.created_at));
  const records = flattenTrajectoryRecords(deriveTrajectoryLayout({ ledger, subagentRuns: runs }));
  const subtools = records.filter((record) => record.kind === "subtool");
  assert.equal(subtools.length, 1);
  assert.equal(subtools[0].toolName, "bash");
  assert.equal(subtools[0].subagentRunId, runId);
  assert.equal(subtools[0].status, "complete");
  assert.equal(subtools[0].timeSeconds, (tool.endedAt - tool.startedAt) / 1000);
  const parentRecord = records.find((record) => record.kind === "tool" && record.toolName === "subagent");
  assert.equal(subtools[0].index, parentRecord.index + 1);
  assert.equal(subtools[0].turn, parentRecord.turn);
  assert.equal(subtools[0].step, parentRecord.step);
  t.diagnostic("actual Go foreground subagent -> child bash -> SSE journal -> HTTP /subagents -> shipped adapter -> nested subtool layout");
});
