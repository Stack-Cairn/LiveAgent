import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseTypeScriptSource, transpileTypeScriptModule } from "../../../../scripts/typescript-source-tools.mjs";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Use the real pane host and memo boundary; replace its heavy leaf imports.
const hostSource = readFileSync(new URL("../../src/pages/chat/surfaces/ConversationPaneHost.tsx", import.meta.url), "utf8");
const mocks = {};
for (const node of parseTypeScriptSource(hostSource, "host.tsx").program.body) {
  if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
  const name = node.source.value;
  if (name === "react" || name === "./ConversationPaneHostEnvironment" || name === "./paneComposerDraftSession") continue;
  mocks[name] = Object.fromEntries(node.specifiers.filter(s => s.type === "ImportSpecifier").map(s => [s.imported.name, () => null]));
}
let surfaceRenders = 0;
mocks["./ConversationSurface"] = { ConversationSurface: () => { surfaceRenders++; return null; } };
const env = await createDomTestEnv({ mocks });
const { React, act, createRoot } = env;
const { useHasConversationReply } = env.loadModule("src/pages/chat/hooks/useHasConversationReply.ts");
const { createLiveTranscriptStore } = env.loadModule("src/lib/chat/conversation/liveTranscriptStore.ts");
const { ConversationPaneHost } = env.loadModule("src/pages/chat/surfaces/ConversationPaneHost.tsx");
const { ConversationPaneHostEnvironmentProvider: Provider, createConversationPaneHostEnvironment: makeEnvironment } = env.loadModule("src/pages/chat/surfaces/ConversationPaneHostEnvironment.tsx");

async function withRoot(run) {
  const container = env.dom.window.document.createElement("div");
  env.dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  try { await run(root, container); }
  finally { await act(async () => root.unmount()); container.remove(); }
}

test("reply availability ignores token updates and unsubscribes once history has a reply", async () => {
  const store = createLiveTranscriptStore();
  let subscriptions = 0, renders = 0;
  const tracked = { ...store, subscribe(listener) { subscriptions++; const stop = store.subscribe(listener); return () => { subscriptions--; stop(); }; } };
  const empty = [];
  function Page({ items = empty, liveStore = tracked, draft = false }) {
    renders++;
    return React.createElement("span", null, String(useHasConversationReply(items, liveStore, draft)));
  }
  await withRoot(async (root, container) => {
    await act(async () => root.render(React.createElement(Page)));
    assert.equal(container.textContent, "false");
    await act(async () => store.updateLiveRounds(() => [{ text: "first" } ]));
    assert.equal(container.textContent, "true");
    const afterFirst = renders;
    for (let i = 0; i < 100; i++) {
      await act(async () => store.updateLiveRounds(() => [{ text: `token ${i}` } ]));
    }
    assert.equal(renders, afterFirst, "100 token updates must not render the page");
    const history = [{ kind: "assistant", rounds: [] }];
    await act(async () => root.render(React.createElement(Page, { items: history })));
    assert.equal(subscriptions, 0);
    await act(async () => store.settle());
    assert.equal(container.textContent, "true");
    const nextStore = createLiveTranscriptStore();
    await act(async () => root.render(React.createElement(Page, { liveStore: nextStore })));
    assert.equal(container.textContent, "false", "conversation switch must not retain previous reply");
    await act(async () => nextStore.updateLiveRounds(() => [{ text: "reply" }]));
    assert.equal(container.textContent, "true");
    await act(async () => nextStore.reset());
    assert.equal(container.textContent, "false");
    await act(async () => root.render(React.createElement(Page, { items: history, draft: true })));
    assert.equal(container.textContent, "false", "drafts preserve the conversation-only view");
  });
  assert.equal(subscriptions, 0);
});

test("real pane host stops unchanged context broadcasts but accepts bindings, identities and refs", async () => {
  const project = { projectId: "project", projectPathKey: "/project" };
  const controller = conversationId => ({ conversationId, getSnapshot: () => ({ draft: null }), setDraft: () => {} });
  let binding = { controller: controller("a"), transcript: { contentWidth: 800 } };
  let conversationId = "a";
  const firstRef = React.createRef(), secondRef = React.createRef();
  const render = (ref = firstRef) => React.createElement(Provider, {
    value: makeEnvironment([{ identity: { paneId: "pane", conversationId, project }, binding }]),
  }, React.createElement(ConversationPaneHost, { paneId: "pane", ref }));
  await withRoot(async root => {
    surfaceRenders = 0;
    binding.controller.conversationId = conversationId;
    await act(async () => root.render(render()));
    assert.equal(surfaceRenders, 1);
    for (let i = 0; i < 20; i++) await act(async () => root.render(render()));
    assert.equal(surfaceRenders, 1, "new context/registration wrappers must not render unchanged content");
    binding = { ...binding, transcript: { contentWidth: 900 }, composer: { onSend: () => {} } };
    await act(async () => root.render(render()));
    assert.equal(surfaceRenders, 2);
    conversationId = "b";
    binding = { ...binding, controller: controller(conversationId) };
    await act(async () => root.render(render()));
    assert.equal(surfaceRenders, 3);
    await act(async () => root.render(render(secondRef)));
    assert.equal(firstRef.current, null);
    assert.ok(secondRef.current, "memo must not suppress ref ownership changes");
  });
});

test("model options retain identity across theme changes and update with providers", async () => {
  const source = readFileSync(new URL("../../src/pages/chat/runtime/useChatModelSelection.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  const modelOptions ="), source.indexOf("  const activeSelectedModel ="));
  const compute = new Function("useMemo", "buildModelOptions", "settings", transpileTypeScriptModule(block + "\nreturn modelOptions;", "/tmp/options.ts"));
  let builds = 0, result;
  const build = settings => { builds++; return settings.customProviders.slice(); };
  function Page({ settings }) { result = compute(React.useMemo, build, settings); return null; }
  await withRoot(async root => {
    const customProviders = [{ id: "a" }];
    await act(async () => root.render(React.createElement(Page, { settings: { customProviders, theme: "light" } })));
    const original = result;
    await act(async () => root.render(React.createElement(Page, { settings: { customProviders, theme: "dark" } })));
    assert.equal(result, original);
    assert.equal(builds, 1);
    await act(async () => root.render(React.createElement(Page, { settings: { customProviders: [{ id: "b" }], theme: "dark" } })));
    assert.equal(builds, 2);
    assert.equal(result[0].id, "b");
  });
});
