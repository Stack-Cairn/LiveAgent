// WebUI transcript store: per-event cost of streaming tokens into the last
// run after `turns` earlier runs (each run_started folds the settled ones), commits flushed
// once per 16 events like rAF would.
//   node perf/store-bench.mjs
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../agent-gateway/test/helpers/load-web-module.mjs";
const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../../agent-gateway/web/", import.meta.url)),
});
globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
const { createTranscriptStore } = loader.loadModule("src/lib/chat/transcript/transcriptStore.ts");
for (const turnCount of [200, 2000]) {
  const store = createTranscriptStore();
  let seq = 1;
  for (let t = 0; t < turnCount; t++) {
    const run = `run-${t}`;
    store.applyEvent({ type: "run_started", conversation_id: "c", run_id: run, seq: seq++ });
    store.applyEvent({ type: "token", conversation_id: "c", run_id: run, seq: seq++, text: `reply ${t}` });
    store.applyEvent({ type: "run_finished", conversation_id: "c", run_id: run, seq: seq++, status: "completed" });
  }
  // The run that streams.
  store.applyEvent({ type: "run_started", conversation_id: "c", run_id: "live", seq: seq++ });
  store.flush();
  const events = 4000;
  const t0 = performance.now();
  for (let i = 0; i < events; i++) {
    store.applyEvent({ type: "token", conversation_id: "c", run_id: "live", seq: seq++, text: "ab " });
    if (i % 16 === 15) store.flush();
  }
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ turns: turnCount, events, usPerEvent: +(ms * 1000 / events).toFixed(1) }));
}
process.exit(0);
