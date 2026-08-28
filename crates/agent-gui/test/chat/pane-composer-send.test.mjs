import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// PR #521 review P2:「背景 Pane 的 Send 只聚焦不发送」。修复后背景 Pane 的
// 发送按本 Pane 的 conversationId 路由(与 Stop 一致):运行中入队,空闲直发。
// 本文件覆盖 Pane 侧 send handler 的 clear-on-send / restore-on-failure 语义,
// 以及 ChatPage 源级防回归。

const loader = createTsModuleLoader();
const { createPaneComposerSendHandler } = loader.loadModule(
  "src/pages/chat/surfaces/paneComposerSend.ts",
);

function textDraft(text) {
  return { text, isEmpty: !text.trim(), segments: [], largePastes: [] };
}

function fakeComposer(initialDraft) {
  let draft = initialDraft;
  return {
    getDraft: () => draft,
    setDraft: (next) => {
      draft = next;
    },
    clear: () => {
      draft = textDraft("");
    },
    hasContent: () => Boolean(draft && !draft.isEmpty),
    current: () => draft,
  };
}

function mountHandler({
  sendDraft,
  draft = textDraft("hello from pane B"),
  hasPendingUploads = false,
}) {
  const composer = fakeComposer(draft);
  const clearedDrafts = [];
  const restoredDrafts = [];
  const handler = createPaneComposerSendHandler({
    composerRef: { current: composer },
    clearConversationDraft: () => clearedDrafts.push(true),
    restoreConversationDraft: (value) => restoredDrafts.push(value),
    hasPendingUploads: () => hasPendingUploads,
    sendDraft,
  });
  return { handler, composer, clearedDrafts, restoredDrafts };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an accepted send clears the pane composer and its cached draft", async () => {
  const sent = [];
  const { handler, composer, clearedDrafts, restoredDrafts } = mountHandler({
    sendDraft: async (draft) => {
      sent.push(draft);
      return true;
    },
  });

  handler();
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "hello from pane B");
  assert.equal(composer.hasContent(), false);
  assert.equal(clearedDrafts.length, 1);
  assert.equal(restoredDrafts.length, 0);
});

test("a rejected send restores the draft so no text is lost", async () => {
  const { handler, composer, restoredDrafts } = mountHandler({
    sendDraft: async () => false,
  });

  handler();
  await tick();

  assert.equal(restoredDrafts.length, 1);
  assert.equal(restoredDrafts[0].text, "hello from pane B");
  assert.equal(composer.current().text, "hello from pane B");
});

test("a send that throws restores the draft instead of surfacing an unhandled rejection", async () => {
  const { handler, composer, restoredDrafts } = mountHandler({
    sendDraft: async () => {
      throw new Error("runtime unavailable");
    },
  });

  handler();
  await tick();

  assert.equal(restoredDrafts.length, 1);
  assert.equal(composer.current().text, "hello from pane B");
});

test("an empty composer sends nothing", async () => {
  const sent = [];
  const { handler } = mountHandler({
    draft: textDraft("   "),
    sendDraft: async (draft) => {
      sent.push(draft);
      return true;
    },
  });

  handler();
  await tick();

  assert.equal(sent.length, 0);
});

test("an empty composer still sends when the pane has staged uploads", async () => {
  const sent = [];
  const { handler, composer, clearedDrafts } = mountHandler({
    draft: textDraft(""),
    hasPendingUploads: true,
    sendDraft: async (draft) => {
      sent.push(draft);
      return true;
    },
  });

  handler();
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].isEmpty, true);
  assert.equal(composer.hasContent(), false);
  assert.equal(clearedDrafts.length, 1);
});

test("a second click while the first send is in flight is ignored", async () => {
  let resolveSend;
  const sent = [];
  const { handler } = mountHandler({
    sendDraft: (draft) => {
      sent.push(draft);
      return new Promise((resolve) => {
        resolveSend = resolve;
      });
    },
  });

  handler();
  handler();
  resolveSend(true);
  await tick();

  assert.equal(sent.length, 1);
});

test("restore does not clobber text typed after a failed send", async () => {
  let rejectSend;
  const { handler, composer, restoredDrafts } = mountHandler({
    sendDraft: () =>
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
  });

  handler();
  composer.setDraft(textDraft("newer text"));
  rejectSend(new Error("late failure"));
  await tick();

  // 缓存草稿仍被恢复(会话侧不丢),但 composer 里更新的输入不被覆盖。
  assert.equal(restoredDrafts.length, 1);
  assert.equal(composer.current().text, "newer text");
});

// ---------------------------------------------------------------------------
// 源级防回归:背景 Pane 的发送不得再被 focusGuard 吞掉。
// ---------------------------------------------------------------------------

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("background pane bindings route Send by conversationId, not through focusGuard", () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const buildStart = chatPage.indexOf("const buildBackgroundPaneBinding");
  assert.notEqual(buildStart, -1, "buildBackgroundPaneBinding must exist in ChatPage");
  const buildEnd = chatPage.indexOf("const workbenchRegistrations", buildStart);
  const builder = chatPage.slice(buildStart, buildEnd);

  // Send 与 Stop 同语义:显式按 conversationId 路由。
  assert.doesNotMatch(builder, /onSend:\s*focusGuard/);
  assert.match(builder, /sendDraft: paneSendDraft/);
  assert.match(builder, /conversationIdOverride: conversationId/);
  assert.match(builder, /uploadedFilesOverride: uploads/);
  // 运行中的会话入队,而不是丢弃或串到焦点会话。
  assert.match(builder, /enqueueComposerTurnForConversation\(\{/);

  const paneHost = readSource("../../src/pages/chat/surfaces/ConversationPaneHost.tsx");
  assert.match(paneHost, /createPaneComposerSendHandler/);
  assert.match(paneHost, /hasPendingUploads:\s*\(\)\s*=>\s*controller\.getSnapshot\(\)\.uploads\.length\s*>\s*0/);
  // Chip removal must name this pane's conversation, not the focused one.
  assert.match(builder, /removePendingUpload\(relativePath,\s*conversationId\)/);
  // Paste must pass an explicit conversation + workdir, not the focused ref.
  assert.doesNotMatch(builder, /onPasteFiles:\s*importReadableFiles\s*,/);
  assert.match(builder, /importReadableFiles\(files,\s*\{/);
  assert.match(builder, /workdir:\s*workspaceRoot/);
});

test("focusing another pane does not swap an object composer ref across hosts", () => {
  // Object refs swapped with `ref={isCurrent ? hostRef : undefined}` detach
  // in tree order: the outgoing host can null hostRef after the incoming
  // host attached, so Enter reads a null composer and sends nothing.
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  assert.doesNotMatch(chatPage, /ref=\{isCurrent \? conversationPaneHostRef : undefined\}/);
  assert.match(chatPage, /if \(handle\) conversationPaneHostRef\.current = handle;/);
});

test("multi-pane focus does not freeze the composer during hydration", () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const registrations = chatPage.slice(chatPage.indexOf("const workbenchRegistrations"));
  assert.match(
    registrations,
    /isConversationHydrating &&\s*Object\.keys\(workbench\.layout\.panes\)\.length < 2/,
  );
});

test("pane draft restore is keyed by conversation identity, not controller object", () => {
  const paneHost = readSource("../../src/pages/chat/surfaces/ConversationPaneHost.tsx");
  assert.match(paneHost, /controllerRef\.current = controller;/);
  assert.match(paneHost, /\}, \[conversationId\]\);/);
});
