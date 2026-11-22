// createTranscriptProjection micro-benchmark: 2000 messages with ids, user
// messages of --user-chars characters (pasted text gets long), projected
// fresh and then again over the same message objects.
//
//   node perf/projection-bench.mjs [--count=2000] [--user-chars=2048]
import { performance } from "node:perf_hooks";
import { createTsModuleLoader } from "../test/helpers/load-ts-module.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const count = Number(args.count ?? 2000);
const userChars = Number(args["user-chars"] ?? 2048);
const loader = createTsModuleLoader();
const { createTranscriptProjection } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
const { buildMessages } = loader.loadModule("./perf/fixtures.ts");

const messages = buildMessages(count, 2048).map((message, index) => ({
  ...message,
  id: `m${index}`,
  ...(message.role === "user" ? { content: `${"x".repeat(userChars)} ${index}` } : {}),
}));
const project = (list) =>
  createTranscriptProjection({
    segments: [{ segmentIndex: 0, segmentId: "seg", messages: list, startMessageIndex: 0, createdAt: 1, updatedAt: 2 }],
    activeSegmentIndex: 0,
    oldestMessageOffset: 0,
    hasMoreBefore: false,
    revision: null,
  });

// Fresh objects every run (a history window parsed from the wire).
const fresh = [];
for (let run = 0; run < 5; run += 1) {
  const copy = structuredClone(messages);
  const started = performance.now();
  project(copy);
  fresh.push(performance.now() - started);
}
// The same objects again (a rebuilt view state, a reopened subagent).
project(messages);
const again = [];
for (let run = 0; run < 5; run += 1) {
  const started = performance.now();
  project(messages);
  again.push(performance.now() - started);
}
const median = (values) => Number(values.sort((a, b) => a - b)[2].toFixed(1));
console.log(JSON.stringify({ count, userChars, firstMs: Number(fresh[0].toFixed(1)), freshMedianMs: median(fresh), reprojectMedianMs: median(again) }));
