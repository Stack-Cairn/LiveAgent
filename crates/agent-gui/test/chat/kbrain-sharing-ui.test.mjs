import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const conversation = {
  id: "local-conversation", title: "Shared example", providerId: "backend-provider",
  model: "model", createdAt: 1, updatedAt: 2,
};
const remote = { enabled: false, gatewayUrl: "https://legacy.invalid", gatewayPort: 9443, token: "" };
const calls = { invoke: [], listen: [], get: [], set: [], list: [], copied: [] };
let status, gatewayStatus, mutationError;
let env;
const Box = ({ children }) => env.React.createElement("div", null, children);
env = await createDomTestEnv({ mocks: {
  "@liveagent/app/shims/tauriCore": {
    async invoke(command) { calls.invoke.push(command); return gatewayStatus; },
  },
  "@liveagent/app/shims/tauriEvent": {
    async listen(event) { calls.listen.push(event); return () => {}; },
  },
  "../../../lib/chat/history/chatHistory": {
    async getChatHistoryShare(id) { calls.get.push(id); return { ...status }; },
    async setChatHistoryShare(id, enabled, options) {
      calls.set.push({ id, enabled, options });
      if (mutationError) throw new Error(mutationError);
      status = { ...status, enabled, token: enabled ? "public-token" : undefined, ...options };
      return { ...status };
    },
    async listSharedChatHistory(page, pageSize) {
      calls.list.push({ page, pageSize });
      return { items: status.enabled ? [{ ...conversation, isShared: true }] : [], totalCount: status.enabled ? 1 : 0 };
    },
  },
  "@liveagent/ui/components/IconSet": Object.fromEntries(
    "AlertCircle Check Copy ExternalLink Eye EyeOff Link2 Loader2 RefreshCw Search Share2".split(" ").map(name => [name, () => null]),
  ),
  "@liveagent/ui/components/ui/dialog": Object.fromEntries(
    "Dialog DialogBody DialogContent DialogDescription DialogHeader DialogTitle".split(" ").map(name => [name, Box]),
  ),
  "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en", t: key => key }) },
} });
after(() => env.cleanup());
const { React, act, createRoot, loadModule } = env;
const { HistoryShareModal } = loadModule("@liveagent/ui/components/chat/HistoryShareModal.tsx");
const { SharedHistoryManagerModal } = loadModule("@liveagent/ui/components/chat/SharedHistoryManagerModal.tsx");

const runtimeConnection = loadModule("src/lib/kbrain/runtimeConnection.ts");
const { useSharedHistory } = loadModule("src/pages/chat/history/useSharedHistory.ts");
const { useGatewayStatus } = loadModule("src/pages/chat/gateway/useGatewayStatus.ts");

async function mount(values, run, { online = false } = {}) {
  for (const entries of Object.values(calls)) entries.length = 0;
  status = { conversationId: conversation.id, enabled: false, redactToolContent: false };
  gatewayStatus = { online, enabled: online, configured: online, gatewayUrl: remote.gatewayUrl };
  mutationError = undefined;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { async writeText(text) { calls.copied.push(text); } },
  });
  runtimeConnection.setKBrainRuntimeConnection({
    baseUrl: values.VITE_KBRAIN_URL ?? "http://127.0.0.1:47321",
    token: "sharing-token", protocolVersion: "kbrain.agent.v1",
  });
  const rows = new Map([[conversation.id, { ...conversation }]]);
  const sidebarStore = { peek: id => rows.get(id), upsertLocal: row => rows.set(row.id, row) };
  let snapshot;
  function Page() {
    const gateway = useGatewayStatus({ remote });
    const [, setErrorMessage] = React.useState(null);
    const sharing = useSharedHistory({
      remoteSettings: remote, ...gateway, sidebarStore, setErrorMessage,
    });
    snapshot = sharing;
    const origins = {
      shareOrigin: sharing.sharedManagerShareOrigin,
      shareOriginPort: sharing.sharedManagerShareOriginPort,
      shareBackendUrl: sharing.shareBackendUrl,
      shareOriginLoading: sharing.sharedManagerGatewayUrlLoading,
    };
    return React.createElement(React.Fragment, null,
      React.createElement("button", { "data-action": "share", disabled: !sharing.canShareHistory, onClick: () => sharing.handleOpenShareModal(conversation) }, "Share"),
      React.createElement("button", { "data-action": "manage", onClick: sharing.handleOpenSharedHistoryManager }, "Manage"),
      sharing.shareConversation && React.createElement(HistoryShareModal, {
        ...origins, conversation: sharing.shareConversation, share: sharing.shareStatus,
        isLoading: sharing.shareLoading, isUpdating: sharing.shareUpdating, errorMessage: sharing.shareError,
        onToggle: sharing.handleToggleHistoryShare, onRedactToolContentChange: sharing.handleSetShareRedactToolContent,
        onClose: sharing.handleCloseShareModal,
      }),
      sharing.sharedManagerOpen && React.createElement(SharedHistoryManagerModal, {
        ...origins, conversations: sharing.sharedHistoryItems, statuses: sharing.sharedManagerStatuses,
        loadingIds: sharing.sharedManagerLoadingIds, updatingIds: sharing.sharedManagerUpdatingIds,
        errors: sharing.sharedManagerErrors, onRefresh: sharing.handleRefreshSharedHistoryStatuses,
        onLoadStatus: sharing.handleLoadSharedHistoryStatus, onDisableShare: sharing.handleDisableSharedHistory,
        onSetRedactToolContent: sharing.handleSetSharedHistoryRedactToolContent,
        onClose: () => sharing.setSharedManagerOpen(false),
      }),
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = async selector => {
    const node = host.querySelector(selector);
    assert.ok(node, `Missing ${selector}`);
    assert.equal(node.disabled, false, `${selector} must be enabled`);
    await act(async () => node.click());
  };
  try {
    await act(async () => root.render(React.createElement(Page)));
    await run({ host, click, rows, snapshot: () => snapshot });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    runtimeConnection.clearKBrainRuntimeConnection();
  }
}

for (const [name, baseUrl, expected] of [
  ["default URL", undefined, "http://127.0.0.1:47321/share/public-token"],
  ["configured backend URL", "http://kbrain.test:48123/proxy/", "http://kbrain.test:48123/proxy/share/public-token"],
]) {
  test(`K-brain sharing uses ${name}, enables/disables and copies in both shipped dialogs without gateway calls`, async () => {
    await mount({ VITE_KBRAIN_URL: baseUrl }, async ({ host, click, rows, snapshot }) => {
      assert.equal(snapshot().canShareHistory, true, "disabled legacy Remote must not gate K-brain sharing");
      await click('[data-action="share"]');
      assert.deepEqual(calls.get, [conversation.id]);
      await click('[aria-label="开启分享"]');
      assert.equal(rows.get(conversation.id).isShared, true);
      assert.equal(snapshot().sharedHistoryItems.length, 1);
      assert.equal(host.querySelector('a[title]').getAttribute("href"), expected);
      await click('[aria-label="复制链接"]');
      assert.deepEqual(calls.copied, [expected]);
      await click('[aria-label="关闭分享"]');
      assert.equal(rows.get(conversation.id).isShared, false);
      assert.equal(snapshot().sharedHistoryItems.length, 0);
      assert.equal(host.querySelector('[aria-label="复制链接"]'), null);
      assert.deepEqual(calls.set.map(call => call.enabled), [true, false]);
      await click('[aria-label="开启分享"]');
      await act(async () => snapshot().handleCloseShareModal());
      await click('[data-action="manage"]');
      await click('[aria-label="sharedHistory.refresh"]');
      await click('[aria-label="sharedHistory.copyLink"]');
      assert.deepEqual(calls.copied, [expected, expected]);
      assert.ok(calls.list.length >= 3);
      await click('[aria-label="sharedHistory.disableShare"]');
      assert.equal(snapshot().sharedHistoryItems.length, 0);
      assert.equal(rows.get(conversation.id).isShared, false);
      assert.equal(host.querySelector('[aria-label="sharedHistory.copyLink"]'), null);
      assert.deepEqual(calls.invoke, [], "K-brain sharing must not invoke gateway_status or Tauri");
      assert.deepEqual(calls.listen, [], "K-brain must not subscribe to legacy gateway events");
    });
  });
}

test("K-brain share mutation errors are rendered without claiming success", async () => {
  await mount({}, async ({ host, click, snapshot }) => {
    await click('[data-action="share"]');
    mutationError = "Backend share unavailable";
    await click('[aria-label="开启分享"]');
    assert.match(host.textContent, /Backend share unavailable/);
    assert.equal(snapshot().shareStatus.enabled, false);
    assert.equal(snapshot().sharedHistoryItems.length, 0);
    assert.deepEqual(calls.invoke, []);
  });
});

test("default K-brain sharing never requires Remote Gateway readiness", async () => {
  await mount({}, async ({ host, snapshot }) => {
    assert.equal(host.querySelector('[data-action="share"]').disabled, false);
    assert.equal(snapshot().canShareHistory, true);
    assert.match(snapshot().shareBackendUrl, /127\.0\.0\.1:47321/);
    assert.deepEqual(calls.invoke, []);
    assert.deepEqual(calls.listen, []);
  });
});
