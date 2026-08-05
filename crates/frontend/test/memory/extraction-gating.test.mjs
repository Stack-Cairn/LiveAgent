import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const gating = loader.loadModule("src/lib/memory/extraction/gating.ts");
const { extractionSkipReason, isShortMemoryConfirmationText, isConfirmationDeferral, graphemeLength } =
  gating;

const base = { hasConfirmableHypothesis: false, now: 1_000_000 };

test("empty and punctuation-only messages are skipped", () => {
  assert.equal(extractionSkipReason({ ...base, latestUserText: "" }), "empty-user-message");
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "   " }),
    "empty-user-message",
  );
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "！？。。。！！？" }),
    "punctuation-only-user-message",
  );
});

test("short messages skip, including CJK grapheme counting", () => {
  assert.equal(extractionSkipReason({ ...base, latestUserText: "好啊" }), "user-message-too-short");
  assert.equal(extractionSkipReason({ ...base, latestUserText: "ok!" }), "user-message-too-short");
  // 6+ CJK graphemes pass the length gate
  assert.equal(extractionSkipReason({ ...base, latestUserText: "我以后都用中文写代码注释" }), null);
});

test("greetings, thanks, and acks are skipped only when short", () => {
  assert.equal(extractionSkipReason({ ...base, latestUserText: "你好呀今天怎么样" }), "greeting");
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "谢谢你帮我搞定" }),
    "acknowledgement-thanks",
  );
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: "好的收到明白" }),
    "acknowledgement-ok",
  );
  // long tail after the ack carries new instructions → must reach the LLM
  assert.equal(
    extractionSkipReason({
      ...base,
      latestUserText: "谢谢你，请以后默认用中文回答我的所有问题，包括代码注释和提交信息",
    }),
    null,
  );
});

test("short confirmations pass only with a confirmable hypothesis", () => {
  const text = "是的";
  assert.equal(
    extractionSkipReason({ latestUserText: text, hasConfirmableHypothesis: false, now: 1 }),
    "user-message-too-short",
  );
  assert.equal(
    extractionSkipReason({ latestUserText: text, hasConfirmableHypothesis: true, now: 1 }),
    null,
  );
  // unknown → deferred, not rejected (controller claims; engine re-checks)
  assert.equal(extractionSkipReason({ latestUserText: text, now: 1 }), null);
});

test("isConfirmationDeferral identifies the deferral shape", () => {
  assert.equal(isConfirmationDeferral("user-message-too-short", "是的"), true);
  assert.equal(isConfirmationDeferral("user-message-too-short", "随便什么"), false);
  assert.equal(isConfirmationDeferral(null, "是的"), false);
});

test("min-interval throttle uses injected state", () => {
  const text = "我以后都用中文写代码注释";
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: text, lastRunAt: 995_000 }),
    "throttled-min-interval",
  );
  assert.equal(
    extractionSkipReason({ ...base, latestUserText: text, lastRunAt: 900_000 }),
    null,
  );
});

test("no-new-user-message skips re-extraction of the same turn", () => {
  const text = "我以后都用中文写代码注释";
  assert.equal(
    extractionSkipReason({
      ...base,
      latestUserText: text,
      lastExtractedUserKey: "k1",
      currentUserKey: "k1",
    }),
    "no-new-user-message",
  );
  assert.equal(
    extractionSkipReason({
      ...base,
      latestUserText: text,
      lastExtractedUserKey: "k1",
      currentUserKey: "k2",
    }),
    null,
  );
});

test("confirmation word list is normalized against punctuation", () => {
  assert.equal(isShortMemoryConfirmationText("  是的。 "), true);
  assert.equal(isShortMemoryConfirmationText("Yes!"), true);
  assert.equal(isShortMemoryConfirmationText("也许吧"), false);
});

test("grapheme length counts emoji clusters as single units", () => {
  assert.equal(graphemeLength("abc"), 3);
  assert.equal(graphemeLength("你好"), 2);
  assert.ok(graphemeLength("👍🏻👍🏻") <= 4);
});
