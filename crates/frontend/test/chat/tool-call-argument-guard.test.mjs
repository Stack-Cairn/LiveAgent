import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const loader = createTsModuleLoader({ rootDir });
const { wrapStreamWithToolCallArgumentGuard } = loader.loadModule(
  "src/lib/chat/runner/toolCallArgumentGuard.ts",
);

const piAiJsonParse = await import(
  new URL("../../node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js", import.meta.url)
    .href
);

function toolCall(id, args) {
  return { type: "toolCall", id, name: "Write", arguments: args };
}

function assistantWith(content) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {},
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function streamOf(events, finalMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return finalMessage;
    },
  };
}

async function collectFlags(events, finalMessage) {
  const flags = [];
  const wrapped = wrapStreamWithToolCallArgumentGuard(streamOf(events, finalMessage), (call, reason) =>
    flags.push({ id: call.id, reason }),
  );
  const seen = [];
  for await (const event of wrapped) seen.push(event);
  return { flags, seen };
}

function toolCallEvents(call, fragments, { omitEnd = false } = {}) {
  const message = assistantWith([call]);
  return {
    events: [
      { type: "start", partial: assistantWith([]) },
      { type: "toolcall_start", contentIndex: 0, partial: message },
      ...fragments.map((fragment) => ({
        type: "toolcall_delta",
        contentIndex: 0,
        delta: fragment,
        partial: message,
      })),
      ...(omitEnd ? [] : [{ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message }]),
      { type: "done", reason: "toolUse", message },
    ],
    message,
  };
}

test("complete raw argument JSON is not flagged", async () => {
  const args = { path: "test2/new-write-test.md", content: "hello" };
  const raw = JSON.stringify(args);
  const call = toolCall("call-complete", args);
  const { events } = toolCallEvents(call, [raw.slice(0, 18), raw.slice(18)]);
  const { flags, seen } = await collectFlags(events);
  assert.deepEqual(flags, []);
  assert.equal(seen.length, events.length);
});

test("truncated buffer whose lenient repair equals the final arguments is flagged", async () => {
  const truncated = '{"content": "# Temp\\n", "path": "test2';
  const call = toolCall("call-truncated", piAiJsonParse.parseStreamingJson(truncated));
  assert.deepEqual(call.arguments, { content: "# Temp\n", path: "test2" });
  const { events } = toolCallEvents(call, [truncated.slice(0, 21), truncated.slice(21)]);
  const { flags } = await collectFlags(events);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, "call-truncated");
  assert.match(flags[0].reason, /ended before it was complete/);
});

test("single complete-JSON delta (DSML/Google shape) is not flagged", async () => {
  const args = { path: "skill://demo/SKILL.md", content: "body" };
  const call = toolCall("call-dsml", args);
  const { events } = toolCallEvents(call, [JSON.stringify(args)]);
  const { flags } = await collectFlags(events);
  assert.deepEqual(flags, []);
});

test("cumulative-snapshot deltas with an independent complete end are not flagged", async () => {
  const args = { path: "report.html", content: "<html></html>" };
  const call = toolCall("call-snapshots", args);
  const { events } = toolCallEvents(call, [
    JSON.stringify({}),
    JSON.stringify({ path: "report.html" }),
    JSON.stringify(args),
  ]);
  const { flags } = await collectFlags(events);
  assert.deepEqual(flags, []);
});

test("no deltas at all (arguments delivered whole on the end event) is not flagged", async () => {
  const call = toolCall("call-no-deltas", { path: "a.txt", content: "x" });
  const { events } = toolCallEvents(call, []);
  const { flags } = await collectFlags(events);
  assert.deepEqual(flags, []);
});

test("a toolCall block in done without a toolcall_end is flagged (salvage shape)", async () => {
  const call = toolCall("call-dangling", { path: "/", content: "" });
  const { events } = toolCallEvents(call, ['{"path": "/'], { omitEnd: true });
  const { flags } = await collectFlags(events);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].id, "call-dangling");
  assert.match(flags[0].reason, /stream ended before this tool call finished/);
});

test("duplicated identical complete-JSON deltas are not flagged", async () => {
  const args = { path: "a.md" };
  const call = toolCall("call-duplicated", args);
  const { events } = toolCallEvents(call, [JSON.stringify(args), JSON.stringify(args)]);
  const { flags } = await collectFlags(events);
  assert.deepEqual(flags, []);
});

test("repeated empty-object deltas for a zero-arg call are not flagged", async () => {
  const call = toolCall("call-zero-arg", {});
  const { events } = toolCallEvents(call, ["{}", "{}"]);
  const { flags } = await collectFlags(events);
  assert.deepEqual(flags, []);
});

test("each incomplete call is reported once even when done repeats it", async () => {
  const truncated = '{"path": "test2';
  const call = toolCall("call-once", piAiJsonParse.parseStreamingJson(truncated));
  const message = assistantWith([call]);
  const events = [
    { type: "toolcall_start", contentIndex: 0, partial: message },
    { type: "toolcall_delta", contentIndex: 0, delta: truncated, partial: message },
    { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message },
    { type: "done", reason: "toolUse", message },
  ];
  const { flags } = await collectFlags(events);
  assert.equal(flags.length, 1);
});
