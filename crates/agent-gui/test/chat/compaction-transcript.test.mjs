import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { clipMiddle, serializeTranscript } = loader.loadModule(
  "src/lib/chat/compaction/transcript.ts",
);
const { attachCheckpointBridge } = loader.loadModule("src/lib/chat/compaction/bridge.ts");
const { deterministicSummary } = loader.loadModule("src/lib/chat/compaction/checkpoint.ts");

const BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function user(content, timestamp = 1, extra = {}) {
  return { role: "user", content, timestamp, ...extra };
}

function assistant(content, timestamp = 2) {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp,
  };
}

function toolResult(toolName, content, isError = false) {
  return { role: "toolResult", toolCallId: "t1", toolName, content, isError, timestamp: 3 };
}

function storedSummary() {
  return {
    role: "summary",
    id: "summary-1",
    timestamp: 100,
    content: "## Goal\nship the bridge",
    summaryMeta: {
      format: "plain-text-v1",
      strategy: "cumulative-checkpoint",
      coversThroughMessageId: "m-9",
      coveredMessageCount: 9,
      generatedBy: { providerId: "anthropic", model: "claude" },
    },
  };
}

const BUDGET = { budgetTokens: 64_000 };

test("tags every role, drops thinking, caps tool args / results and never leaks base64", () => {
  const text = serializeTranscript(
    [
      user([
        { type: "text", text: "look at this" },
        { type: "image", data: BASE64, mimeType: "image/png" },
        { type: "file", name: "spec.pdf" },
      ]),
      assistant([
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "Reading it." },
        { type: "toolCall", id: "t1", name: "Read", arguments: { path: "a".repeat(2_000) } },
        { type: "text", text: "Then summarizing." },
      ]),
      toolResult("Read", [
        { type: "text", text: `${"h".repeat(3_000)}${"t".repeat(3_000)}` },
        { type: "image", data: BASE64, mimeType: "image/png" },
      ]),
      toolResult("Bash", [{ type: "text", text: "exit 1" }], true),
    ],
    BUDGET,
  );

  assert.doesNotMatch(text, /iVBORw0KGgo|secret chain of thought/);
  assert.match(text, /^\[User\]\nlook at this\n\[image\]\n\[attachment\]/);
  assert.match(text, /\[Assistant\]\nReading it\.\n\[Tool call\] Read\(\{"path":"a+\n\[… truncated …\]\na+"\}\)\n\[Assistant\]\nThen summarizing\./);
  const args = /\[Tool call\] Read\((.*?)\)\n/s.exec(text)[1];
  assert.equal(args.replace("\n[… truncated …]\n", "").length, 500);
  const result = /\[Tool result Read\]\n([\s\S]*?)\n\n\[Tool error Bash\]/.exec(text)[1];
  assert.equal(result.replace("\n[… truncated …]\n", "").length, 2_000);
  // 图片在结果里只留占位，同样计入截断窗口。
  assert.match(result, /^h{1400}\n\[… truncated …\]\nt+\n\[image\]$/);
  assert.match(text, /\[Tool error Bash\]\nexit 1$/);
});

test("checkpoint bridge (standalone or merged) is emitted uncapped as <previous_checkpoint>", () => {
  const summary = storedSummary();
  const merged = serializeTranscript(attachCheckpointBridge([user("next ask", 5)], summary), BUDGET);
  assert.match(merged, /^<previous_checkpoint>\n<context_checkpoint>\n[\s\S]*ship the bridge[\s\S]*<\/context_checkpoint>\n[\s\S]*\n<\/previous_checkpoint>\n\n\[User\]\nnext ask$/);
  assert.equal((merged.match(/<context_checkpoint>/g) ?? []).length, 1);

  const standalone = serializeTranscript(
    attachCheckpointBridge([assistant([{ type: "text", text: "resumed" }])], summary),
    BUDGET,
  );
  assert.match(standalone, /^<previous_checkpoint>\n<context_checkpoint>[\s\S]*<\/previous_checkpoint>\n\n\[Assistant\]\nresumed$/);
});

test("fills newest-first within the budget behind an omission marker", () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    user(`message ${index} ${"w".repeat(400)}`, index),
  );
  const text = serializeTranscript(messages, { budgetTokens: 1_000 });
  const kept = text.match(/message \d+/g);
  assert.equal(kept.at(-1), "message 29");
  const omitted = Number(/^\[… (\d+) earlier messages omitted …\]/.exec(text)[1]);
  assert.equal(omitted + kept.length, 30);
  assert.equal(kept[0], `message ${omitted}`);
  assert.ok(omitted > 20);

  // 最新一条本身超出预算：截断收下，而不是只剩省略标注。
  const huge = serializeTranscript([user("old"), user(`latest ${"z".repeat(40_000)}`, 2)], {
    budgetTokens: 2_000,
  });
  assert.match(huge, /^\[… 1 earlier messages omitted …\]\n\n\[User\]\nlatest z+\n\[… truncated …\]\nz+$/);

  assert.equal(serializeTranscript(messages.slice(0, 2), BUDGET).startsWith("[User]"), true);
});

test("clipMiddle keeps 70% head / 30% tail and never splits a surrogate pair", () => {
  assert.equal(clipMiddle("short", 10), "short");
  assert.equal(clipMiddle("abcdefghij", 5), "abc\n[… truncated …]\nij");
  for (let offset = 0; offset < 4; offset += 1) {
    const clipped = clipMiddle(`${"a".repeat(offset)}${"😀".repeat(200)}`, 101);
    assert.doesNotMatch(JSON.stringify(clipped), /\\ud[89a-f][0-9a-f]{2}/i);
  }
});

test("deterministicSummary keeps the previous summary and appends unsummarized activity", () => {
  const text = deterministicSummary({
    previousSummary: "## Goal\nold goal\n",
    messages: [
      user("do the thing"),
      toolResult("Bash", [{ type: "text", text: "x".repeat(1_000) }]),
    ],
    reason: "fork stall: stream stalled",
  });
  assert.match(
    text,
    /^## Goal\nold goal\n\n## Unsummarized activity\n\n\(Automatic summary unavailable: fork stall: stream stalled; re-read files as needed\.\)\n\n\[User\]\ndo the thing\n\n\[Tool result Bash\]\nx{210}\n\[… truncated …\]\nx{90}$/,
  );
  assert.match(
    deterministicSummary({ messages: [], reason: "r" }),
    /^## Unsummarized activity\n\n\(Automatic summary unavailable: r;/,
  );
});
