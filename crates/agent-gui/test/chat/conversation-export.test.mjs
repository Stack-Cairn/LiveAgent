import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const mod = loader.loadModule("src/lib/chat/conversationExport.ts");

const {
  extractMessagePlainText,
  collectExportMessages,
  collectMessagesFromTranscriptRows,
  collectActiveContextFromTranscriptRows,
  extractUiRoundText,
  conversationToMarkdown,
  buildConversationExportFilename,
  sumConversationCost,
  formatUsdCost,
} = mod;

test("extractMessagePlainText handles string and block content", () => {
  assert.equal(extractMessagePlainText({ role: "user", content: " hi " }), "hi");
  assert.equal(
    extractMessagePlainText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "answer" },
        { type: "toolCall", name: "Read" },
      ],
    }),
    "answer\n[tool:Read]",
  );
});

test("extractMessagePlainText prefers display content and attachments", () => {
  assert.equal(
    extractMessagePlainText({
      role: "user",
      content: "Please read the attached file.\n\nFile: uploads/a.ts\n...",
      liveAgentDisplayContent: "please check",
      liveAgentAttachments: [{ fileName: "a.ts", relativePath: "uploads/a.ts" }],
    }),
    "please check\n[attachment:a.ts]",
  );
  assert.equal(
    extractMessagePlainText({
      role: "user",
      content: "internal file prompt",
      liveAgentDisplayContent: "",
      liveAgentAttachments: [{ fileName: "shot.png" }],
    }),
    "[attachment:shot.png]",
  );
});

test("collectExportMessages skips tool results and empty rows", () => {
  const rows = collectExportMessages([
    { role: "user", content: "q" },
    { role: "toolResult", content: [{ type: "text", text: "noise" }] },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [] },
  ]);
  assert.deepEqual(rows, [
    { role: "user", text: "q" },
    { role: "assistant", text: "a" },
  ]);
});

test("conversationToMarkdown formats title and turns", () => {
  const md = conversationToMarkdown({
    title: "Demo",
    exportedAt: new Date("2026-01-02T03:04:05.000Z"),
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ],
  });
  assert.match(md, /^# Demo\n/);
  assert.match(md, /Exported: 2026-01-02T03:04:05.000Z/);
  assert.match(md, /## User\n\nhello/);
  assert.match(md, /## Assistant\n\nworld/);
});

test("conversationToMarkdown empty export", () => {
  const md = conversationToMarkdown({ title: "", messages: [] });
  assert.match(md, /# Conversation/);
  assert.match(md, /_No messages\._/);
});

test("buildConversationExportFilename sanitizes title", () => {
  const name = buildConversationExportFilename('a/b:c*', new Date("2026-07-18T12:00:00.000Z"));
  assert.match(name, /^a b c-2026-07-18T12-00-00\.md$/);
});

test("sumConversationCost aggregates assistant usage", () => {
  const summary = sumConversationCost([
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: [{ type: "text", text: "a" }],
      usage: { cost: { total: 0.0123 } },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "b" }],
      usage: { cost: { total: 0.004 } },
    },
  ]);
  assert.equal(summary.hasCost, true);
  assert.ok(Math.abs(summary.total - 0.0163) < 1e-9);
  assert.match(formatUsdCost(summary.total), /^\$0\.0163$/);
});

test("extractUiRoundText reads blocks and skips thinking by default", () => {
  const text = extractUiRoundText({
    blocks: [
      { kind: "thinking", text: "secret" },
      { kind: "text", text: "hello" },
      { kind: "tool", text: "ignored" },
      { kind: "text", text: "world" },
    ],
  });
  assert.equal(text, "hello\nworld");
});

test("collectMessagesFromTranscriptRows uses blocks and meta.usage", () => {
  const messages = collectMessagesFromTranscriptRows([
    { kind: "user", text: "q" },
    {
      kind: "assistant",
      rounds: [
        {
          blocks: [{ kind: "text", text: "answer" }],
          meta: { usage: { cost: { total: 0.02 } } },
        },
      ],
    },
    { kind: "checkpoint", content: "summary body" },
  ]);
  assert.deepEqual(
    messages.map((m) => ({ role: m.role, content: m.content })),
    [
      { role: "user", content: "q" },
      { role: "assistant", content: "answer" },
      { role: "assistant", content: "summary body" },
    ],
  );
  const cost = sumConversationCost(messages);
  assert.equal(cost.hasCost, true);
  assert.ok(Math.abs(cost.total - 0.02) < 1e-9);
});

test("collectMessagesFromTranscriptRows keeps attachment-only users and usage-only assistants", () => {
  const messages = collectMessagesFromTranscriptRows([
    {
      kind: "user",
      text: "",
      attachments: [{ fileName: "img.png", relativePath: "uploads/img.png" }],
    },
    {
      kind: "assistant",
      rounds: [
        {
          blocks: [{ kind: "tool", item: { toolCall: { name: "Read" } } }],
          meta: { usage: { cost: { total: 0.01 } } },
        },
        {
          blocks: [{ kind: "text", text: "done" }],
          meta: { usage: { cost: { total: 0.02 } } },
        },
      ],
    },
  ]);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /attachment:img\.png/);
  // Usage-only tool round keeps empty content for cost, not a fake placeholder.
  assert.equal(messages[1].content, "");
  assert.equal(messages[2].content, "done");
  const cost = sumConversationCost(messages);
  assert.ok(Math.abs(cost.total - 0.03) < 1e-9);
  const exported = collectExportMessages(messages);
  assert.deepEqual(
    exported.map((m) => m.text),
    ["[attachment:img.png]", "done"],
  );
});

test("collectActiveContextFromTranscriptRows attaches usage once after tool rounds", () => {
  const active = collectActiveContextFromTranscriptRows([
    {
      kind: "assistant",
      rounds: [
        {
          blocks: [
            {
              kind: "tool",
              item: {
                toolCall: { name: "Read", arguments: { path: "a.ts" } },
                toolResult: { content: "x".repeat(400) },
              },
            },
            { kind: "text", text: "done" },
          ],
          meta: { usage: { totalTokens: 5_000 } },
        },
      ],
    },
  ]);
  const withUsage = active.messages.filter((m) => m.usage != null);
  assert.equal(withUsage.length, 1, "usage should attach once, not after toolResult as a second anchor");
  // Tool result must remain after the usage-bearing assistant so meter can count it
  // when estimating post-anchor deltas (or when no earlier usage exists).
  const toolIdx = active.messages.findIndex((m) => m.role === "toolResult");
  const usageIdx = active.messages.findIndex((m) => m.usage != null);
  assert.ok(toolIdx >= 0);
  assert.ok(usageIdx >= 0);
});

test("collectActiveContextFromTranscriptRows drops pre-checkpoint history and keeps tools", () => {
  const active = collectActiveContextFromTranscriptRows([
    { kind: "user", text: "old q" },
    {
      kind: "assistant",
      rounds: [{ blocks: [{ kind: "text", text: "old answer" }] }],
    },
    { kind: "checkpoint", content: "compacted summary" },
    { kind: "user", text: "new q" },
    {
      kind: "assistant",
      rounds: [
        {
          blocks: [
            { kind: "thinking", text: "plan" },
            {
              kind: "tool",
              item: {
                toolCall: { name: "Read", arguments: { path: "a.ts" } },
                toolResult: { content: "file body" },
              },
            },
            { kind: "text", text: "done" },
          ],
        },
      ],
    },
  ]);
  assert.equal(active.summaryText, "compacted summary");
  assert.equal(active.messages[0].role, "user");
  assert.equal(active.messages[0].content, "new q");
  const roles = active.messages.map((m) => m.role);
  assert.ok(roles.includes("toolResult"));
  assert.ok(roles.includes("assistant"));
  const hasThinking = active.messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((block) => block && block.type === "thinking" && block.thinking === "plan"),
  );
  assert.equal(hasThinking, true);
  assert.ok(!JSON.stringify(active.messages).includes("old answer"));
});
