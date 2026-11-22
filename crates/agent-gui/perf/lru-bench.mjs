// Measurement snapshot persistence: cost of one save() on the
// conversation-switch path with 12 conversations x 2000 rows cached
// (in-memory localStorage stub).   node perf/lru-bench.mjs
import { createTsModuleLoader } from "../test/helpers/load-ts-module.mjs";
const { createTranscriptMeasurementsLru } = createTsModuleLoader().loadModule("@liveagent/ui/lib/transcript-virtual/measurementsLru.ts");
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const rows = (n, s) => Array.from({ length: n }, (_, i) => ({ index: i, key: "row-" + s + "-" + i, start: 0, size: 40 + (i % 50), end: 0, lane: 0 }));
const lru = createTranscriptMeasurementsLru({ persistNamespace: "bench" });
for (let c = 0; c < 12; c++) lru.save("c" + c, "800:768", rows(2000, c));
lru.flush?.();
const times = [];
for (let k = 0; k < 20; k++) { const r = rows(2000, k); const t = performance.now(); lru.save("c" + (k % 12), "800:768", r); times.push(performance.now() - t); }
lru.flush?.();
times.sort((a, b) => a - b);
console.log(JSON.stringify({ saveMedianMs: +times[10].toFixed(2), saveMaxMs: +times[19].toFixed(2), bytes: [...store.values()][0].length }));
process.exit(0);
