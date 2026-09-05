import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);
const dialogSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ConversationSearchDialog.tsx", import.meta.url),
  "utf8",
);
const chatPageSource = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
const shortcutSource = readFileSync(
  new URL("../../src/lib/shortcuts/globalShortcuts.ts", import.meta.url),
  "utf8",
);
const rustAppSource = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const gatewayShimSource = readFileSync(
  new URL("../../../agent-gateway/web/src/shims/tauriCore.ts", import.meta.url),
  "utf8",
);
const gatewayBridgeSource = readFileSync(
  new URL("../../src-tauri/src/services/gateway_bridge.rs", import.meta.url),
  "utf8",
);

test("sidebar exposes a Codex-style conversation search entry", () => {
  assert.match(sidebarSource, /chat-history-search-button/);
  assert.match(sidebarSource, /t\("chat\.searchConversations"\)/);
  assert.match(sidebarSource, /conversationSearchRequestKey/);
  assert.match(sidebarSource, /setConversationSearchOpen\(true\)/);
  assert.match(sidebarSource, /<ConversationSearchDialog/);
  assert.doesNotMatch(sidebarSource, /conversationSearchShortcutLabel|<kbd/);
  assert.doesNotMatch(sidebarSource, /⌘K \/ Ctrl\+K|event\.key\.toLowerCase\(\) !== "k"/);
});

test("conversation search uses the configurable desktop shortcut action end to end", () => {
  assert.match(shortcutSource, /"searchConversations"/);
  assert.match(chatPageSource, /case "search-conversations"/);
  assert.match(chatPageSource, /setConversationSearchRequestKey/);
  assert.match(rustAppSource, /"searchConversations" => AppAction::SearchConversations/);
  assert.match(
    rustAppSource,
    /forward_app_action\(app, "search-conversations", None, None, true\)/,
  );
});

test("conversation search opens history directly instead of creating a composer reference", () => {
  assert.match(dialogSource, /searchPersistedConversations/);
  assert.match(dialogSource, /onSelectConversation\(id\)/);
  assert.match(dialogSource, /chat\.pinnedConversations/);
  assert.match(dialogSource, /chat\.recentConversation/);
  assert.match(dialogSource, /item\.searchPreview/);
  assert.doesNotMatch(dialogSource, /conversationMention|ReadConversation|MentionComposer/);
});

test("global conversation search is routed by both Desktop and Gateway", () => {
  assert.match(dialogSource, /searchPersistedConversations/);
  assert.match(gatewayShimSource, /case "chat_history_search"/);
  assert.match(gatewayBridgeSource, /"chat_history_search" =>/);
  assert.match(gatewayBridgeSource, /search_chat_history_sync/);
});
