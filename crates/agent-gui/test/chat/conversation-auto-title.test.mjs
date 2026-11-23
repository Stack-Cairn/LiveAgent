import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { buildFallbackConversationTitle, isAutoConversationTitle } = loader.loadModule(
  "src/lib/chat/page/chatPageHelpers.ts",
);

const firstMessage =
  "#slowtitle A rather long first message so that the derived fallback title needs truncation by both sides of the stack.";
const fallback = buildFallbackConversationTitle(firstMessage);

test("a K-brain first-message title still counts as automatic", () => {
  // Sidebar sync replaced the frontend fallback ("..." at 48 chars) with the
  // session title K-brain derived from the same message ("…" at its length).
  const kbrainTitle = "#slowtitle A rather long first message so that the derived fall…";
  assert.notEqual(kbrainTitle, fallback);
  assert.equal(isAutoConversationTitle(kbrainTitle, [fallback, "New conversation"]), true);
});

test("exact defaults count as automatic", () => {
  assert.equal(isAutoConversationTitle(fallback, [fallback]), true);
  assert.equal(isAutoConversationTitle("New conversation", [fallback, "New conversation"]), true);
  assert.equal(isAutoConversationTitle("Short message", ["Short message"]), true);
});

test("a manual rename is never treated as automatic", () => {
  assert.equal(isAutoConversationTitle("Release planning", [fallback, "New conversation"]), false);
  // A rename that merely starts like the message is still a rename unless it
  // is visibly truncated.
  assert.equal(isAutoConversationTitle("#slowtitle A rather long", [fallback]), false);
  assert.equal(isAutoConversationTitle("Short", ["Short message"]), false);
});
