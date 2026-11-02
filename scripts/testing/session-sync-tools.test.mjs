import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildBridgeRequest,
  buildMetricSummary,
  classifyProcessRole,
  countSessionTranscripts,
  createSessionDataset,
  stableDirectoryDigest,
} from "./session-sync-tools.mjs";

test("createSessionDataset writes deterministic valid transcripts at the requested scale", async (context) => {
  const first = await mkdtemp(join(tmpdir(), "session-sync-dataset-a-"));
  const second = await mkdtemp(join(tmpdir(), "session-sync-dataset-b-"));
  context.after(async () => {
    await Promise.all([
      rm(first, { force: true, recursive: true }),
      rm(second, { force: true, recursive: true }),
    ]);
  });

  const options = {
    count: 3,
    totalBytes: 24_000,
    seed: "baseline-seed",
    workdirCount: 2,
  };
  const a = await createSessionDataset(first, options);
  const b = await createSessionDataset(second, options);

  assert.equal(a.sessionCount, 3);
  assert.equal(a.transcriptBytes, 24_000);
  assert.equal(a.digest, b.digest);
  assert.equal(await stableDirectoryDigest(first), a.digest);

  const firstTranscript = join(first, "sessions", "bench-00000000", "session.jsonl");
  assert.equal((await stat(firstTranscript)).size > 0, true);
  const records = (await readFile(firstTranscript, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records[0].type, "session_meta");
  assert.equal(records[0].payload.id, "bench-00000000");
  assert.equal(records[1].type, "message");
  assert.equal(records[1].payload.message.role, "user");
  assert.equal(records[2].payload.message.role, "assistant");
  assert.equal(await countSessionTranscripts(first), 3);
});

test("buildMetricSummary reports rates, deltas, peaks, and leak slope", () => {
  const samples = [
    {
      atMs: 0,
      processes: [
        {
          pid: 10,
          role: "kbrain",
          cpu100ns: 100,
          readBytes: 1_000,
          writeBytes: 100,
          workingSetBytes: 10_000,
          privateBytes: 8_000,
          handles: 20,
          threads: 4,
        },
      ],
    },
    {
      atMs: 1_000,
      processes: [
        {
          pid: 10,
          role: "kbrain",
          cpu100ns: 2_000_100,
          readBytes: 5_000,
          writeBytes: 300,
          workingSetBytes: 12_000,
          privateBytes: 9_000,
          handles: 21,
          threads: 5,
        },
      ],
    },
    {
      atMs: 2_000,
      processes: [
        {
          pid: 10,
          role: "kbrain",
          cpu100ns: 4_000_100,
          readBytes: 9_000,
          writeBytes: 500,
          workingSetBytes: 14_000,
          privateBytes: 10_000,
          handles: 22,
          threads: 6,
        },
      ],
    },
  ];

  const result = buildMetricSummary(samples, { logicalProcessors: 8 });
  const metric = result.roles.kbrain;
  assert.equal(metric.elapsedMs, 2_000);
  assert.equal(metric.cpuTimeDeltaMs, 400);
  assert.equal(metric.cpuAveragePercentTotalCapacity, 2.5);
  assert.equal(metric.cpuSampledPeakPercentTotalCapacity, 2.5);
  assert.equal(metric.readBytesDelta, 8_000);
  assert.equal(metric.writeBytesDelta, 400);
  assert.equal(metric.workingSetPeakBytes, 14_000);
  assert.equal(metric.privateBytesDelta, 2_000);
  assert.equal(metric.privateBytesStart, 8_000);
  assert.equal(metric.privateBytesEnd, 10_000);
  assert.equal(metric.handleDelta, 2);
  assert.equal(metric.threadDelta, 2);
  assert.equal(metric.privateBytesSlopePerMinute, 60_000);
});

test("buildMetricSummary retains cumulative work from processes that exit during sampling", () => {
  const samples = [
    {
      atMs: 0,
      processes: [
        { pid: 1, role: "webview", cpu100ns: 100, readBytes: 10, writeBytes: 5, workingSetBytes: 10, privateBytes: 8, handles: 2, threads: 1 },
      ],
    },
    {
      atMs: 1_000,
      processes: [
        { pid: 1, role: "webview", cpu100ns: 1_000_100, readBytes: 110, writeBytes: 25, workingSetBytes: 20, privateBytes: 18, handles: 3, threads: 2 },
        { pid: 2, role: "webview", cpu100ns: 50, readBytes: 2, writeBytes: 1, workingSetBytes: 5, privateBytes: 4, handles: 1, threads: 1 },
      ],
    },
    {
      atMs: 2_000,
      processes: [
        { pid: 2, role: "webview", cpu100ns: 500_050, readBytes: 52, writeBytes: 11, workingSetBytes: 6, privateBytes: 5, handles: 1, threads: 1 },
      ],
    },
  ];
  const metric = buildMetricSummary(samples).roles.webview;
  assert.equal(metric.cpuTimeDeltaMs, 150);
  assert.equal(metric.readBytesDelta, 150);
  assert.equal(metric.writeBytesDelta, 30);
  assert.equal(metric.workingSetPeakBytes, 25);
  assert.equal(metric.privateBytesDelta, -3);
  assert.equal(metric.processesObserved, 2);
});

test("buildMetricSummary keeps a sampled CPU spike separate from the interval average", () => {
  const processAt = (cpu100ns) => ({
    pid: 1,
    role: "kbrain",
    cpu100ns,
    readBytes: 0,
    writeBytes: 0,
    workingSetBytes: 1,
    privateBytes: 1,
    handles: 1,
    threads: 1,
  });
  const metric = buildMetricSummary([
    { atMs: 0, processes: [processAt(0)] },
    { atMs: 1_000, processes: [processAt(1_000_000)] },
    { atMs: 2_000, processes: [processAt(8_000_000)] },
  ], { logicalProcessors: 4 }).roles.kbrain;
  assert.equal(metric.cpuAveragePercentTotalCapacity, 10);
  assert.equal(metric.cpuSampledPeakPercentTotalCapacity, 17.5);
});

test("buildBridgeRequest validates supported commands and targets a window", () => {
  assert.deepEqual(buildBridgeRequest("list_windows", {}, "a"), {
    id: "a",
    command: "list_windows",
    args: {},
  });
  assert.deepEqual(
    buildBridgeRequest("execute_js", { script: "document.title", windowLabel: "main" }, "b"),
    {
      id: "b",
      command: "execute_js",
      args: { script: "document.title", windowLabel: "main" },
    },
  );
  assert.throws(() => buildBridgeRequest("delete_everything", {}, "c"), /unsupported bridge command/);
});

test("classifyProcessRole separates the desktop, K-brain, Gateway, and WebView", () => {
  assert.equal(classifyProcessRole("liveagent.exe"), "liveagent");
  assert.equal(classifyProcessRole("k-brain.exe"), "kbrain");
  assert.equal(classifyProcessRole("liveagent-gateway-x86_64-pc-windows-msvc.exe"), "gateway");
  assert.equal(classifyProcessRole("msedgewebview2.exe"), "webview");
  assert.equal(classifyProcessRole("node.exe"), "support");
});
