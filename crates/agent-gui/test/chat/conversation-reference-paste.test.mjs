import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 粘贴路径必须与 @ 菜单/拖拽共享同一组会话引用约束（去重、上限 3、自引用）。
// 违反约束的段不能静默丢弃，而是降级为序列化 token 文本保留粘贴内容。

const env = await createDomTestEnv();
const internals = env.loadModule("@liveagent/ui/components/chat/MentionComposerInternals.tsx");
const {
  CONVERSATION_MENTION_ID_ATTR,
  MAX_CONVERSATION_MENTIONS,
  parseSerializedComposerText,
  sanitizeConversationMentionSegments,
} = internals;
const { formatConversationMentionToken } = env.loadModule(
  "@liveagent/ui/lib/chat/mentionReferences.ts",
);

function conversationSegment(id, title = `Conversation ${id}`) {
  return { type: "conversationMention", conversation: { id, title } };
}

function editorWithChips(ids) {
  const editor = document.createElement("div");
  for (const id of ids) {
    const chip = document.createElement("span");
    chip.setAttribute(CONVERSATION_MENTION_ID_ATTR, id);
    editor.appendChild(chip);
  }
  return editor;
}

function downgradedText(segment) {
  return { type: "text", text: formatConversationMentionToken(segment.conversation) };
}

test("pasted duplicates collapse to text: editor chips and in-paste repeats both count", () => {
  const editor = editorWithChips(["conv-existing"]);
  const duplicateOfEditor = conversationSegment("conv-existing");
  const fresh = conversationSegment("conv-new");
  const repeatInPaste = conversationSegment("conv-new", "Renamed duplicate");

  const result = sanitizeConversationMentionSegments(editor, [
    { type: "text", text: "before " },
    duplicateOfEditor,
    fresh,
    repeatInPaste,
  ]);

  assert.deepEqual(result, [
    { type: "text", text: "before " },
    downgradedText(duplicateOfEditor),
    fresh,
    downgradedText(repeatInPaste),
  ]);
});

test("pasted references beyond the cap collapse to text, counting existing chips", () => {
  assert.equal(MAX_CONVERSATION_MENTIONS, 3);
  const editor = editorWithChips(["conv-a", "conv-b"]);
  const kept = conversationSegment("conv-c");
  const overCap = conversationSegment("conv-d");

  const result = sanitizeConversationMentionSegments(editor, [kept, overCap]);

  assert.deepEqual(result, [kept, downgradedText(overCap)]);
});

test("pasted self-reference collapses to text when the current conversation id is known", () => {
  const editor = editorWithChips([]);
  const selfReference = conversationSegment("conv-self");
  const other = conversationSegment("conv-other");

  const withId = sanitizeConversationMentionSegments(
    editor,
    [selfReference, other],
    " conv-self ",
  );
  assert.deepEqual(withId, [downgradedText(selfReference), other]);

  // 宿主未提供当前会话 ID 时保持宽松（发送边界仍会归一化过滤）。
  const withoutId = sanitizeConversationMentionSegments(editor, [selfReference, other]);
  assert.deepEqual(withoutId, [selfReference, other]);
});

test("non-conversation segments pass through untouched", () => {
  const editor = editorWithChips(["conv-a", "conv-b", "conv-c"]);
  const fileSegment = { type: "fileMention", reference: { path: "src/app.ts", kind: "file" } };
  const textSegment = { type: "text", text: "tail" };

  const result = sanitizeConversationMentionSegments(editor, [fileSegment, textSegment]);

  assert.deepEqual(result, [fileSegment, textSegment]);
});

test("a pasted token flood ends up with at most the cap as structured chips", () => {
  const tokens = ["conv-1", "conv-2", "conv-1", "conv-3", "conv-4"]
    .map((id) => formatConversationMentionToken({ id, title: `Conversation ${id}` }))
    .join(" ");
  const segments = parseSerializedComposerText(tokens, []);
  assert.ok(segments, "tokens parse into composer segments");

  const sanitized = sanitizeConversationMentionSegments(editorWithChips([]), segments);
  const chips = sanitized.filter((segment) => segment.type === "conversationMention");
  const downgraded = sanitized.filter(
    (segment) => segment.type === "text" && segment.text.includes("conversation:"),
  );

  assert.deepEqual(
    chips.map((segment) => segment.conversation.id),
    ["conv-1", "conv-2", "conv-3"],
  );
  // 重复的 conv-1 与超限的 conv-4 都降级为文本，粘贴内容一字不丢。
  assert.equal(downgraded.length, 2);
});
