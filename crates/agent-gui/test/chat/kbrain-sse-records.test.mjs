import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The event-stream splitter must find exactly the records the old
// whole-buffer split did, wherever the network cuts the bytes: inside a
// separator ("\n\n", "\r\n\r\n"), inside a multi-byte UTF-8 character, or in
// one-byte chunks.

const loader = createTsModuleLoader();
const { createSseRecordSplitter } = loader.loadModule("src/lib/kbrain/sseRecords.ts");
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

/** The previous parser: split the whole buffer, keep the unterminated tail. */
function referenceSplit(text) {
  const records = text.split(/\r?\n\r?\n/);
  const rest = records.pop() ?? "";
  return { records, rest };
}

function splitInChunks(text, cuts) {
  const splitter = createSseRecordSplitter();
  const records = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    records.push(...splitter.push(text.slice(from, cut)));
    from = cut;
  }
  return { records, rest: splitter.rest() };
}

const samples = [
  "data: a\n\ndata: b\n\n",
  "data: a\r\n\r\ndata: b\r\n\r\npartial",
  "id: 1\r\ndata: x\n\r\ndata: y\r\n\ndata: z\n\n\n\ndata: after blank lines\n\n",
  "data: \r\r\n\ndata: lone cr\rstays\n\n",
  "\n\ndata: leading separator\n\n",
  "data: 中文🙂 multi-byte\n\ndata: ok\n\n",
  "no separator at all",
];

test("every single cut position yields the reference records", () => {
  for (const sample of samples) {
    const expected = referenceSplit(sample);
    for (let cut = 0; cut <= sample.length; cut += 1) {
      assert.deepEqual(splitInChunks(sample, [cut]), expected, `${JSON.stringify(sample)} @${cut}`);
    }
    // One character at a time, and two cuts around every position.
    const each = Array.from({ length: sample.length }, (_, index) => index);
    assert.deepEqual(splitInChunks(sample, each), expected);
    for (let cut = 1; cut < sample.length; cut += 1) {
      assert.deepEqual(splitInChunks(sample, [cut - 1, cut]), expected);
    }
  }
});

function streamResponse(bytes, cuts) {
  let from = 0;
  const chunks = [];
  for (const cut of [...cuts, bytes.length]) {
    chunks.push(bytes.slice(from, cut));
    from = cut;
  }
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function eventBytes(texts, separator) {
  const records = texts.map((text, index) => {
    const event = {
      version: "kbrain.agent.v1",
      conversation_id: "c1",
      seq: index + 1,
      type: "assistant.delta",
      text,
    };
    return `data: ${JSON.stringify(event)}${separator}`;
  });
  return new TextEncoder().encode(records.join(""));
}

test("the client decodes events cut inside UTF-8 characters and separators", async () => {
  const texts = ["héllo 世界", "🙂🙂 emoji", "plain", "末尾"];
  for (const separator of ["\n\n", "\r\n\r\n"]) {
    const bytes = eventBytes(texts, separator);
    const separatorBytes = new TextEncoder().encode(separator);
    // Cut positions: inside every multi-byte character and every separator.
    const cuts = [];
    for (let index = 1; index < bytes.length; index += 1) {
      const continuation = (bytes[index] & 0xc0) === 0x80;
      const inSeparator =
        bytes[index - 1] === separatorBytes[0] || bytes[index - 1] === 0x0a;
      if (continuation || inSeparator) cuts.push(index);
    }
    for (const plan of [cuts, cuts.filter((_, index) => index % 3 === 0)]) {
      const received = [];
      const client = createKBrainClient({
        baseUrl: "http://127.0.0.1:9",
        token: "test",
        fetch: async () => streamResponse(bytes, plan),
      });
      await client.subscribe("c1", 0, { onEvent: (event) => received.push(event.text) });
      assert.deepEqual(received, texts, `separator ${JSON.stringify(separator)}`);
    }
  }
});

test("an unterminated final event is still reported as incomplete", async () => {
  const bytes = new TextEncoder().encode('data: {"version":"kbrain.agent.v1"');
  const client = createKBrainClient({
    baseUrl: "http://127.0.0.1:9",
    token: "test",
    fetch: async () => streamResponse(bytes, [5]),
  });
  await assert.rejects(
    client.subscribe("c1", 0, { onEvent: () => {} }),
    /incomplete event/,
  );
});
