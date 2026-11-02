import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const BRIDGE_COMMANDS = new Set([
  "capture_native_screenshot",
  "execute_js",
  "get_backend_state",
  "get_window_info",
  "invoke_tauri",
  "list_windows",
  "resize_window",
]);

function stableTimestamp(index) {
  return new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
}

function jsonLine(type, payload) {
  return `${JSON.stringify({ type, payload })}\n`;
}

function transcriptFor(index, bytes, workdirCount, seed) {
  const id = `bench-${String(index).padStart(8, "0")}`;
  const timestamp = stableTimestamp(index);
  const cwd = `C:/session-sync-benchmark/workdir-${index % workdirCount}`;
  const metadata = jsonLine("session_meta", {
    version: 1,
    id,
    title: `Benchmark ${index}`,
    model: "fixture-model",
    provider: "fixture-provider",
    cwd,
    goal: "",
    forked_from: "",
    fork_seq: 0,
    tags: [seed],
    pinned: index % 17 === 0,
    archived: false,
    shared: false,
    effort: "medium",
    usage_in: 0,
    usage_cached: 0,
    usage_out: 0,
    sub_usage: {},
    updated_at: timestamp,
    task_id: "",
    created_at: timestamp,
  });
  const user = jsonLine("message", {
    seq: 0,
    message: {
      id: `${id}-user`,
      role: "user",
      content: `fixture prompt ${index}`,
      authored: true,
      sent_at: timestamp,
    },
  });
  const assistantPrefix = JSON.stringify({
    type: "message",
    payload: {
      seq: 1,
      message: {
        id: `${id}-assistant`,
        role: "assistant",
        content: "",
        model: "fixture-model @ fixture-provider",
      },
    },
  });
  const marker = '"content":""';
  if (!assistantPrefix.includes(marker)) throw new Error("assistant fixture has no content marker");
  const assistantBase = `${assistantPrefix}\n`;
  const fixedBytes = Buffer.byteLength(metadata) + Buffer.byteLength(user) + Buffer.byteLength(assistantBase);
  if (bytes < fixedBytes) {
    throw new Error(`target transcript is too small: ${bytes} < ${fixedBytes}`);
  }
  return {
    id,
    content: `${metadata}${user}${assistantPrefix.replace(
      marker,
      `"content":"${"x".repeat(bytes - fixedBytes)}"`,
    )}\n`,
  };
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function stableDirectoryDigest(root) {
  const hash = createHash("sha256");
  for (const path of await listFiles(root)) {
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function countSessionTranscripts(root) {
  return (await listFiles(root)).filter((path) => path.endsWith("session.jsonl")).length;
}

export async function createSessionDataset(root, options = {}) {
  const count = options.count ?? 248;
  const totalBytes = options.totalBytes ?? 251 * 1024 * 1024;
  const seed = options.seed ?? "session-sync-v1";
  const workdirCount = options.workdirCount ?? 12;
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  if (!Number.isSafeInteger(totalBytes) || totalBytes < count * 512) {
    throw new Error("totalBytes is too small for the requested sessions");
  }
  if (!Number.isInteger(workdirCount) || workdirCount < 1) {
    throw new Error("workdirCount must be a positive integer");
  }

  const sessionsRoot = resolve(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(resolve(sessionsRoot, ".lock"), "");
  const perSession = Math.floor(totalBytes / count);
  let transcriptBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const target = perSession + (index < totalBytes % count ? 1 : 0);
    const transcript = transcriptFor(index, target, workdirCount, seed);
    const directory = resolve(sessionsRoot, transcript.id);
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, "session.jsonl");
    await writeFile(path, transcript.content);
    transcriptBytes += (await stat(path)).size;
  }
  return {
    seed,
    sessionCount: count,
    transcriptBytes,
    digest: await stableDirectoryDigest(root),
  };
}

function sumRole(sample, role) {
  const rows = sample.processes.filter((process) => process.role === role);
  return {
    cpu100ns: rows.reduce((sum, process) => sum + process.cpu100ns, 0),
    user100ns: rows.reduce((sum, process) => sum + (process.user100ns ?? 0), 0),
    privileged100ns: rows.reduce((sum, process) => sum + (process.privileged100ns ?? 0), 0),
    readBytes: rows.reduce((sum, process) => sum + process.readBytes, 0),
    writeBytes: rows.reduce((sum, process) => sum + process.writeBytes, 0),
    workingSetBytes: rows.reduce((sum, process) => sum + process.workingSetBytes, 0),
    privateBytes: rows.reduce((sum, process) => sum + process.privateBytes, 0),
    handles: rows.reduce((sum, process) => sum + process.handles, 0),
    threads: rows.reduce((sum, process) => sum + process.threads, 0),
  };
}

export function buildMetricSummary(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error("at least two samples are required");
  const logicalProcessors = options.logicalProcessors ?? 1;
  if (!Number.isInteger(logicalProcessors) || logicalProcessors < 1) {
    throw new Error("logicalProcessors must be a positive integer");
  }
  const roles = new Set(samples.flatMap((sample) => sample.processes.map((process) => process.role)));
  const result = {};
  for (const role of roles) {
    const values = samples.map((sample) => ({ atMs: sample.atMs, ...sumRole(sample, role) }));
    const first = values[0];
    const last = values.at(-1);
    const elapsedMs = last.atMs - first.atMs;
    if (elapsedMs <= 0) throw new Error("sample timestamps must increase");
    const processLifetimes = new Map();
    for (const sample of samples) {
      for (const process of sample.processes.filter((candidate) => candidate.role === role)) {
        const existing = processLifetimes.get(process.pid);
        if (existing) existing.last = process;
        else processLifetimes.set(process.pid, { first: process, last: process });
      }
    }
    const positiveDelta = (key) =>
      [...processLifetimes.values()].reduce(
        (sum, lifetime) => sum + Math.max(0, lifetime.last[key] - lifetime.first[key]),
        0,
      );
    const cpuTimeDeltaMs = positiveDelta("cpu100ns") / 10_000;
    let sampledCpuPeakPercentTotalCapacity = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const next = samples[index];
      const intervalMs = next.atMs - previous.atMs;
      if (intervalMs <= 0) continue;
      const previousProcesses = new Map(
        previous.processes
          .filter((process) => process.role === role)
          .map((process) => [process.pid, process]),
      );
      let intervalCpuMs = 0;
      for (const process of next.processes.filter((candidate) => candidate.role === role)) {
        const before = previousProcesses.get(process.pid);
        if (before) intervalCpuMs += Math.max(0, process.cpu100ns - before.cpu100ns) / 10_000;
      }
      sampledCpuPeakPercentTotalCapacity = Math.max(
        sampledCpuPeakPercentTotalCapacity,
        (intervalCpuMs / intervalMs / logicalProcessors) * 100,
      );
    }
    const privateBytesDelta = last.privateBytes - first.privateBytes;
    result[role] = {
      elapsedMs,
      cpuTimeDeltaMs,
      cpuAveragePercentTotalCapacity:
        Math.round((cpuTimeDeltaMs / elapsedMs / logicalProcessors) * 10_000) / 100,
      cpuSampledPeakPercentTotalCapacity:
        Math.round(sampledCpuPeakPercentTotalCapacity * 100) / 100,
      readBytesDelta: positiveDelta("readBytes"),
      writeBytesDelta: positiveDelta("writeBytes"),
      workingSetPeakBytes: Math.max(...values.map((value) => value.workingSetBytes)),
      privateBytesPeakBytes: Math.max(...values.map((value) => value.privateBytes)),
      privateBytesStart: first.privateBytes,
      privateBytesEnd: last.privateBytes,
      privateBytesDelta,
      privateBytesSlopePerMinute: Math.round(privateBytesDelta / (elapsedMs / 60_000)),
      handlePeak: Math.max(...values.map((value) => value.handles)),
      handleDelta: last.handles - first.handles,
      threadPeak: Math.max(...values.map((value) => value.threads)),
      threadDelta: last.threads - first.threads,
      processesObserved: processLifetimes.size,
    };
  }
  return { logicalProcessors, roles: result };
}

export function buildBridgeRequest(command, args = {}, id = `session-sync-${Date.now()}`) {
  if (!BRIDGE_COMMANDS.has(command)) throw new Error(`unsupported bridge command: ${command}`);
  return { id, command, args };
}

export function classifyProcessRole(name) {
  const normalized = name.trim().toLowerCase();
  if (normalized === "liveagent.exe" || normalized === "liveagent") return "liveagent";
  if (normalized === "k-brain.exe" || normalized === "k-brain" || normalized === "kn.exe") {
    return "kbrain";
  }
  if (normalized.startsWith("liveagent-gateway")) return "gateway";
  if (normalized === "msedgewebview2.exe" || normalized === "webkitwebprocess") return "webview";
  return "support";
}
