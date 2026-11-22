// Event-stream parsing micro-benchmark: one large event (default 8 MB of
// JSON) arriving in 16 KB network chunks, parsed by the previous
// whole-buffer split and by the incremental splitter.
//
//   node perf/sse-bench.mjs [--mb=8] [--chunk=16384] [--runs=5] [--parsers=previous,incremental]
import { performance } from "node:perf_hooks";
import { createTsModuleLoader } from "../test/helpers/load-ts-module.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
const megabytes = Number(args.mb ?? 8);
const chunkBytes = Number(args.chunk ?? 16384);
const runs = Number(args.runs ?? 5);
const parsers = (args.parsers ?? "previous,incremental").split(",");

const { createSseRecordSplitter } = createTsModuleLoader().loadModule("src/lib/kbrain/sseRecords.ts");

const payload = JSON.stringify({ text: "x".repeat(megabytes * 1024 * 1024) });
const bytes = new TextEncoder().encode(`data: ${payload}\n\ndata: {"small":true}\n\n`);
const chunks = [];
for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
  chunks.push(bytes.subarray(offset, offset + chunkBytes));
}

function previous() {
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  for (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() ?? "";
    count += records.length;
  }
  return count;
}

function incremental() {
  const decoder = new TextDecoder();
  const splitter = createSseRecordSplitter();
  let count = 0;
  for (const chunk of chunks) count += splitter.push(decoder.decode(chunk, { stream: true })).length;
  return count;
}

const selected = [
  ["previous split", previous, "previous"],
  ["incremental", incremental, "incremental"],
].filter(([, , id]) => parsers.includes(id));
for (const [name, run] of selected) {
  const times = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const count = run();
    times.push(performance.now() - started);
    if (count !== 2) throw new Error(`${name}: expected 2 records, got ${count}`);
  }
  times.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      parser: name,
      mb: megabytes,
      chunkBytes,
      medianMs: Number(times[Math.floor(runs / 2)].toFixed(1)),
      // Interference (other processes, GC of earlier runs) only adds time,
      // so the fastest run is the most stable estimate of the work itself.
      minMs: Number(times[0].toFixed(2)),
    }),
  );
}
