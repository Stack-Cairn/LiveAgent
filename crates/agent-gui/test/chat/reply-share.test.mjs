import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  buildReplyShareFileName,
  buildReplyShareText,
  resolveReplyShareScope,
  textToBase64,
} = loader.loadModule("@liveagent/ui/lib/chat/replyShare.ts");

const labels = { prompt: "提问", answer: "回答" };

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("reply-only scope shares just the trimmed reply", () => {
  const text = buildReplyShareText(
    { reply: "\n结果是 **42**。\n", prompt: "答案是什么？" },
    "answer",
    labels,
  );
  assert.equal(text, "结果是 **42**。");
});

test("prompt+reply scope quotes every prompt line before the reply", () => {
  const text = buildReplyShareText(
    { reply: "第一段\n\n第二段", prompt: "第一行\n\n第三行" },
    "conversation",
    labels,
  );
  assert.equal(text, "**提问**\n\n> 第一行\n>\n> 第三行\n\n**回答**\n\n第一段\n\n第二段");
});

test("prompt+reply falls back to reply-only when there is no prompt", () => {
  assert.equal(resolveReplyShareScope("conversation", { reply: "x" }), "answer");
  assert.equal(resolveReplyShareScope("conversation", { reply: "x", prompt: "  \n" }), "answer");
  assert.equal(resolveReplyShareScope("conversation", { reply: "x", prompt: "q" }), "conversation");
  assert.equal(buildReplyShareText({ reply: "only", prompt: " " }, "conversation", labels), "only");
});

test("file names use the reply time and the format's extension", () => {
  const ts = new Date(2026, 9, 4, 9, 5).getTime();
  assert.equal(buildReplyShareFileName("image", ts), "liveagent-reply-20261004-0905.png");
  assert.equal(buildReplyShareFileName("text", ts), "liveagent-reply-20261004-0905.md");
  assert.match(buildReplyShareFileName("text"), /^liveagent-reply-\d{8}-\d{4}\.md$/);
});

test("text is base64-encoded as UTF-8", () => {
  const encoded = textToBase64("分享 ~~ok~~");
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), "分享 ~~ok~~");
});

test("assistant action bar exposes share inside the hover chrome and both hosts wire it", () => {
  const source = read("../../../agent-ui/src/components/chat/TranscriptMessageActions.tsx");
  const assistantFn = source.slice(source.indexOf("export function TranscriptAssistantMessageActions"));
  const share = assistantFn.indexOf('title={t("chat.share")}');
  const copy = assistantFn.indexOf('title={t("chat.copy")}');
  const retry = assistantFn.indexOf('title={t("chat.retryConfirmTitle")}');
  assert.ok(copy > -1 && share > copy && share < retry, "share sits between copy and retry");
  assert.match(assistantFn, /<AssistantReplyShareDialog source=\{shareSource\}/);

  const desktop = read("../../src/pages/chat/transcript/RowActions.tsx");
  const gateway = read("../../../agent-gateway/web/src/components/GatewayTranscript.tsx");
  for (const host of [desktop, gateway]) {
    assert.match(host, /shareSource=\{shareSource\}/);
    assert.match(host, /prompt: retryPrompt/);
  }
});
