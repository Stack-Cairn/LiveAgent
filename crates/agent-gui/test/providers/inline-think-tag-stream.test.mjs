import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { wrapInlineThinkTagStream } = loader.loadModule(
  "src/lib/providers/runtime/inlineThinkTagStream.ts",
);

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(content, overrides = {}) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "qwen3",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

/**
 * Replays a text block the way pi-ai's openai-completions adapter does: a
 * text_start, one text_delta per chunk with a partial that reflects everything
 * accumulated so far, then a text_end carrying the authoritative full text.
 */
function createTextSource(chunks, options = {}) {
  const { trailing = [], terminal = "done", extraContent = [] } = options;
  const full = chunks.join("");
  const finalMessage = createAssistant(
    [{ type: "text", text: full }, ...extraContent],
    terminal === "error" ? { stopReason: "aborted", errorMessage: "Cancelled" } : {},
  );
  const partialAt = (soFar) => createAssistant([{ type: "text", text: soFar }, ...extraContent]);

  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: createAssistant([]) };
      yield { type: "text_start", contentIndex: 0, partial: partialAt("") };
      let soFar = "";
      for (const chunk of chunks) {
        soFar += chunk;
        yield { type: "text_delta", contentIndex: 0, delta: chunk, partial: partialAt(soFar) };
      }
      if (options.omitTextEnd !== true) {
        yield { type: "text_end", contentIndex: 0, content: full, partial: partialAt(full) };
      }
      for (const event of trailing) yield event;
      if (terminal === "done") {
        yield { type: "done", reason: "stop", message: finalMessage };
      } else if (terminal === "error") {
        yield { type: "error", reason: "aborted", error: finalMessage };
      }
    },
    async result() {
      return finalMessage;
    },
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function concatDeltas(events, type, contentIndex) {
  return events
    .filter((event) => event.type === type && event.contentIndex === contentIndex)
    .map((event) => event.delta)
    .join("");
}

test("inline think: tag split across chunks becomes a separate thinking block", async () => {
  const events = await collect(
    wrapInlineThinkTagStream(
      createTextSource(["<th", "ink>rea", "son", "</thi", "nk> Ans", "wer"]),
    ),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ],
  );
  assert.equal(concatDeltas(events, "thinking_delta", 0), "reason");
  assert.equal(concatDeltas(events, "text_delta", 1), "Answer");
  assert.equal(events.find((event) => event.type === "thinking_end").content, "reason");

  const done = events.at(-1);
  assert.deepEqual(done.message.content, [
    { type: "thinking", thinking: "reason" },
    { type: "text", text: "Answer" },
  ]);
});

test("inline think: plain answers pass through with identical event objects", async () => {
  const source = createTextSource(["Hello ", "world"]);
  const sourceEvents = [];
  const tapped = {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        sourceEvents.push(event);
        yield event;
      }
    },
    result: () => source.result(),
  };

  const events = await collect(wrapInlineThinkTagStream(tapped));

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
  );
  // The probe withholds text_start and replays a copy once it rejects the tag,
  // so identity only has to hold from the next source event onward.
  for (const event of events.slice(3)) {
    assert.ok(sourceEvents.includes(event), `expected identity passthrough for ${event.type}`);
  }
  assert.equal(events.at(-1).message.content[0].text, "Hello world");
});

test("inline think: an ambiguous head that is later rejected emits the buffered text once", async () => {
  const events = await collect(wrapInlineThinkTagStream(createTextSource(["<th", "anks!"])));

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_end", "done"],
  );
  assert.equal(concatDeltas(events, "text_delta", 0), "<thanks!");
  assert.equal(events.at(-1).message.content.length, 1);
  assert.equal(events.at(-1).message.content[0].text, "<thanks!");
});

test("inline think: an unclosed tag never creates an answer block", async () => {
  const events = await collect(
    wrapInlineThinkTagStream(createTextSource(["<think>still ", "reasoning"])),
  );

  assert.equal(
    events.some((event) => event.type === "text_start" || event.type === "text_end"),
    false,
  );
  assert.equal(concatDeltas(events, "thinking_delta", 0), "still reasoning");
  assert.deepEqual(events.at(-1).message.content, [
    { type: "thinking", thinking: "still reasoning" },
  ]);
});

test("inline think: whitespace after the close tag is dropped and text_end matches the deltas", async () => {
  const events = await collect(
    wrapInlineThinkTagStream(createTextSource(["<think>why</think>", "\n\n", "  Final answer"])),
  );

  const textDeltas = events.filter((event) => event.type === "text_delta");
  assert.equal(textDeltas[0].delta, "Final answer");
  const textEnd = events.find((event) => event.type === "text_end");
  assert.equal(textEnd.contentIndex, 1);
  // The downstream reconciler diffs text_end against the deltas it already saw;
  // any mismatch re-injects raw tag text into the transcript.
  assert.equal(textEnd.content, concatDeltas(events, "text_delta", 1));
  assert.equal(textEnd.content, "Final answer");
});

test("inline think: tool calls after an answer shift up by one index", async () => {
  const toolCall = { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/" } };
  const source = createTextSource(["<think>plan</think>Doing it"], {
    extraContent: [toolCall],
    trailing: [
      {
        type: "toolcall_start",
        contentIndex: 1,
        partial: createAssistant([
          { type: "text", text: "<think>plan</think>Doing it" },
          toolCall,
        ]),
      },
      {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall,
        partial: createAssistant([
          { type: "text", text: "<think>plan</think>Doing it" },
          toolCall,
        ]),
      },
    ],
  });

  const events = await collect(wrapInlineThinkTagStream(source));
  const start = events.find((event) => event.type === "toolcall_start");
  const end = events.find((event) => event.type === "toolcall_end");

  assert.equal(start.contentIndex, 2);
  assert.equal(end.contentIndex, 2);
  // agentRunner normalizes tool calls via partial.content[contentIndex]; a stale
  // index there makes the call silently vanish.
  assert.equal(end.partial.content[2], toolCall);
  assert.deepEqual(events.at(-1).message.content, [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "Doing it" },
    toolCall,
  ]);
});

test("inline think: a truncated think block keeps following indices unshifted", async () => {
  const toolCall = { type: "toolCall", id: "call_2", name: "ls", arguments: {} };
  const partial = createAssistant([{ type: "text", text: "<think>cut off" }, toolCall]);
  const source = createTextSource(["<think>cut off"], {
    extraContent: [toolCall],
    trailing: [{ type: "toolcall_end", contentIndex: 1, toolCall, partial }],
  });

  const events = await collect(wrapInlineThinkTagStream(source));
  const end = events.find((event) => event.type === "toolcall_end");

  assert.equal(end.contentIndex, 1);
  assert.equal(end.partial.content[1], toolCall);
});

test("inline think: a tag in the middle of an answer is left alone", async () => {
  const events = await collect(
    wrapInlineThinkTagStream(createTextSource(["Use ", "<think> to reason"])),
  );

  assert.equal(concatDeltas(events, "text_delta", 0), "Use <think> to reason");
  assert.equal(
    events.some((event) => event.type === "thinking_start"),
    false,
  );
});

test("inline think: native thinking blocks at index 0 stay untouched", async () => {
  const partial = createAssistant([
    { type: "thinking", thinking: "native" },
    { type: "text", text: "answer" },
  ]);
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: "thinking_start", contentIndex: 0, partial };
      yield { type: "thinking_delta", contentIndex: 0, delta: "native", partial };
      yield { type: "thinking_end", contentIndex: 0, content: "native", partial };
      yield { type: "text_start", contentIndex: 1, partial };
      yield { type: "text_delta", contentIndex: 1, delta: "answer", partial };
      yield { type: "text_end", contentIndex: 1, content: "answer", partial };
      yield { type: "done", reason: "stop", message: partial };
    },
    async result() {
      return partial;
    },
  };

  const events = await collect(wrapInlineThinkTagStream(source));

  assert.deepEqual(
    events.map((event) => [event.type, event.contentIndex]),
    [
      ["thinking_start", 0],
      ["thinking_delta", 0],
      ["thinking_end", 0],
      ["text_start", 1],
      ["text_delta", 1],
      ["text_end", 1],
      ["done", undefined],
    ],
  );
  assert.equal(events.at(-1).message, partial);
});

test("inline think: a stream that ends without a terminal event still rewrites result()", async () => {
  const stream = wrapInlineThinkTagStream(
    createTextSource(["<think>r</think>a"], { terminal: "none" }),
  );
  const events = await collect(stream);
  const result = await stream.result();

  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "r" },
    { type: "text", text: "a" },
  ]);
  assert.equal(events.at(-1).type, "text_end");
});

test("inline think: aborting mid-thought flushes the reasoning and rewrites the error message", async () => {
  const stream = wrapInlineThinkTagStream(
    createTextSource(["<think>half way"], { terminal: "error", omitTextEnd: true }),
  );
  const events = await collect(stream);
  const error = events.at(-1);

  assert.equal(error.type, "error");
  assert.equal(concatDeltas(events, "thinking_delta", 0), "half way");
  assert.equal(events.some((event) => event.type === "thinking_end"), true);
  assert.deepEqual(error.error.content, [{ type: "thinking", thinking: "half way" }]);
  assert.equal(error.error.stopReason, "aborted");
});

// 两个 OpenAI 兼容协议都要挂上：本地 llama.cpp 既可以走 /v1/chat/completions，
// 也可以经 codex 预设走 /v1/responses，两条路都会内联 <think>。
for (const api of ["openai-completions", "openai-responses"]) {
  test(`inline think: streamSimpleByApi mounts the wrapper on ${api}`, async () => {
    const message = createAssistant([{ type: "text", text: "<think>hmm</think>hi" }]);
    const scopedLoader = createTsModuleLoader({
      mocks: {
        [`@earendil-works/pi-ai/api/${api}`]: {
          stream() {
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "<think>hmm</think>hi",
                  partial: message,
                };
                yield { type: "done", reason: "stop", message };
              },
              async result() {
                return message;
              },
            };
          },
        },
      },
    });
    const { streamSimpleByApi } = scopedLoader.loadModule(
      "src/lib/providers/runtime/streamByApi.ts",
    );

    const stream = streamSimpleByApi(
      {
        id: "qwen3",
        api,
        provider: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        maxTokens: 1024,
      },
      { messages: [] },
      { streamRetry: { disabled: true } },
    );
    const events = await collect(stream);
    const result = await stream.result();

    assert.equal(concatDeltas(events, "thinking_delta", 0), "hmm");
    assert.equal(concatDeltas(events, "text_delta", 1), "hi");
    assert.deepEqual(result.content, [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi" },
    ]);
  });
}
