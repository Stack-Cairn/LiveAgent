import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createInvokeTrajectoryHost } = loader.loadModule(
  "@liveagent/ui/lib/trajectory/host.ts",
);

test("host accepts snake_case window responses from Gateway WebUI", async () => {
  const calls = [];
  const host = createInvokeTrajectoryHost(async (command, args) => {
    calls.push({ command, args });
    return {
      events_json: '[{"k":"user","t":1,"at":1}]',
      truncated: false,
      oldest_segment_index: 4,
      returned_segment_count: 8,
      total_segment_count: 12,
      has_more_before: true,
    };
  });
  assert.deepEqual(await host.loadWindow("c1", 12), {
    eventsJson: '[{"k":"user","t":1,"at":1}]',
    truncated: false,
    oldestSegmentIndex: 4,
    returnedSegmentCount: 8,
    totalSegmentCount: 12,
    hasMoreBefore: true,
  });
  assert.deepEqual(calls[0], {
    command: "trajectory_get_window",
    args: { conversationId: "c1", maxSegments: 8, beforeSegmentIndex: 12 },
  });
});

test("host loads aggregated subagent snapshots through the shared command", async () => {
  const calls = [];
  const host = createInvokeTrajectoryHost(async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, "trajectory_get_subagent_runs");
    return {
      subagent_runs_json: JSON.stringify([
        {
          run: {
            id: "run-1",
            agentId: "reviewer",
            mode: "run",
            status: "completed",
            startedAt: 10,
            endedAt: 20,
          },
          segments: [],
        },
      ]),
    };
  });
  const runs = await host.loadSubagentRuns("c1", ["run-1"]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, "run-1");
  assert.equal(runs[0].agentId, "reviewer");
  assert.equal(runs[0].status, "complete");
  assert.deepEqual(calls, [
    {
      command: "trajectory_get_subagent_runs",
      args: { conversationId: "c1", runIds: ["run-1"] },
    },
  ]);
});


test("host chunks large explicit subagent run-id requests without dropping old runs", async () => {
  const calls = [];
  const host = createInvokeTrajectoryHost(async (_command, args) => {
    calls.push(args.runIds);
    return {
      runsJson: JSON.stringify(
        args.runIds.map((id) => ({
          run: { id, agentId: id, status: "completed" },
          segments: [],
        })),
      ),
    };
  });
  const ids = Array.from({ length: 300 }, (_, index) => `run-${index}`);
  const runs = await host.loadSubagentRuns("c1", ids);
  assert.equal(runs.length, 300);
  assert.deepEqual(calls.map((batch) => batch.length), [128, 128, 44]);
  assert.equal(runs[0].runId, "run-0");
  assert.equal(runs.at(-1).runId, "run-299");
});

test("host forwards refresh subscriptions without coupling the shared view to transport", () => {
  let subscribed;
  let unsubscribed = false;
  const host = createInvokeTrajectoryHost(async () => ({}), {
    subscribeRefresh(listener) {
      subscribed = listener;
      return () => {
        unsubscribed = true;
      };
    },
  });
  let calls = 0;
  const unsubscribe = host.subscribeRefresh(() => {
    calls += 1;
  });
  subscribed();
  assert.equal(calls, 1);
  unsubscribe();
  assert.equal(unsubscribed, true);
});

test("host requests only subagent runs referenced by the current trajectory window", async () => {
  const calls = [];
  const host = createInvokeTrajectoryHost(async (command, args) => {
    calls.push({ command, args });
    return { runsJson: "[]" };
  });

  const runs = await host.loadSubagentRuns("c1", ["run-b", "run-a"]);

  assert.deepEqual(runs, []);
  assert.deepEqual(calls, [
    {
      command: "trajectory_get_subagent_runs",
      args: { conversationId: "c1", runIds: ["run-b", "run-a"] },
    },
  ]);
});

test("a transient subagent transport failure is propagated so the view can retry", async () => {
  const host = createInvokeTrajectoryHost(async (command) => {
    assert.equal(command, "trajectory_get_subagent_runs");
    throw new Error("temporary gateway outage");
  });

  await assert.rejects(
    host.loadSubagentRuns("c1", ["run-retry"]),
    /temporary gateway outage/,
  );
});
