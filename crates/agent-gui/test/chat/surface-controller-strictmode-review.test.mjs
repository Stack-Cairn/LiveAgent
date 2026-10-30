// Independent review probe for 2492574e (dispose() no longer blocks later subscribe/retainView).
// Renders the real useConversationSurfaceSnapshot hook under React.StrictMode with the same
// ownership patterns ChatPage uses: the focused controller from useMemo + effect-cleanup
// dispose, and background pane controllers cached in a ref Map that a layout effect prunes and
// an unmount effect clears. Checks that no disposed controller is revived into a leaked
// registry subscription or an unbalanced registry.getViewCount.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;
const { createConversationRuntimeRegistry } = env.loadModule(
  "src/pages/chat/conversations/createConversationRuntimeRegistry.ts",
);
const { createConversationSurfaceController } = env.loadModule(
  "src/pages/chat/conversations/createConversationSurfaceController.ts",
);
const { useConversationSurfaceSnapshot } = env.loadModule(
  "src/pages/chat/conversations/useConversationSurfaceSnapshot.ts",
);
const { answerToolApproval, requestToolApproval } = env.loadModule(
  "src/lib/tools/toolApproval.ts",
);

const noop = async () => undefined;
const actions = { hydrate: noop, send: noop, stop() {}, compact: noop, retry: noop };
const project = { projectId: "p", projectPathKey: "/workspace/p" };

// Counts live registry subscriptions per conversation across all six channels.
function countingRegistry() {
  const registry = createConversationRuntimeRegistry();
  const live = new Map();
  const wrap = (target) => {
    const original = target.subscribe.bind(target);
    target.subscribe = (conversationId, listener) => {
      live.set(conversationId, (live.get(conversationId) ?? 0) + 1);
      const off = original(conversationId, listener);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        live.set(conversationId, live.get(conversationId) - 1);
        off();
      };
    };
  };
  for (const target of [
    registry,
    registry.drafts,
    registry.uploads,
    registry.queue,
    registry.approvals,
    registry.hydration,
  ])
    wrap(target);
  return { registry, live: (id) => live.get(id) ?? 0 };
}

function Pane({ controller }) {
  const snapshot = useConversationSurfaceSnapshot(controller);
  return React.createElement(
    "span",
    { "data-conversation": snapshot.conversationId },
    String(snapshot.approvals.length),
  );
}

function FocusedPage({ registry, conversationId }) {
  const controller = React.useMemo(
    () => createConversationSurfaceController({ conversationId, project, registry, actions }),
    [registry, conversationId],
  );
  React.useEffect(() => () => controller.dispose(), [controller]);
  return React.createElement(Pane, { controller });
}

function BackgroundPage({ registry, panes }) {
  const mapRef = React.useRef(new Map());
  const get = (conversationId) => {
    const existing = mapRef.current.get(conversationId);
    if (existing) return existing;
    const controller = createConversationSurfaceController({
      conversationId,
      project,
      registry,
      actions,
    });
    mapRef.current.set(conversationId, controller);
    return controller;
  };
  React.useEffect(() => {
    const keep = new Set(panes);
    for (const [conversationId, controller] of mapRef.current) {
      if (!keep.has(conversationId)) {
        controller.dispose();
        mapRef.current.delete(conversationId);
      }
    }
  }, [panes]);
  React.useEffect(
    () => () => {
      for (const controller of mapRef.current.values()) controller.dispose();
      mapRef.current.clear();
    },
    [],
  );
  return React.createElement(
    "div",
    null,
    ...panes.map((id) => React.createElement(Pane, { key: id, controller: get(id) })),
  );
}

const strict = (child) => React.createElement(React.StrictMode, null, child);

test("StrictMode focused controller: approval bar live, conversation switch and unmount balanced", async () => {
  const { registry, live } = countingRegistry();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const text = (id) => container.querySelector(`[data-conversation="${id}"]`)?.textContent;
  try {
    await act(async () =>
      root.render(strict(React.createElement(FocusedPage, { registry, conversationId: "fa" }))),
    );
    assert.equal(registry.getViewCount("fa"), 1);
    assert.equal(live("fa"), 6, "one connection after the StrictMode replay");

    let settlement;
    await act(async () => {
      settlement = requestToolApproval({
        toolCallId: "review-fa",
        toolName: "Bash",
        conversationId: "fa",
        timeoutMs: 10_000,
      });
    });
    assert.equal(text("fa"), "1", "approval bar appears without an unrelated re-render");
    await act(async () => {
      assert.equal(answerToolApproval("review-fa", "approve", { conversationId: "fa" }).ok, true);
      await settlement;
    });
    assert.equal(text("fa"), "0", "and disappears as soon as it is answered");

    await act(async () =>
      root.render(strict(React.createElement(FocusedPage, { registry, conversationId: "fb" }))),
    );
    assert.equal(registry.getViewCount("fa"), 0, "the old conversation is not revived");
    assert.equal(live("fa"), 0, "no leaked subscription on the old controller");
    assert.equal(registry.getViewCount("fb"), 1);
    assert.equal(live("fb"), 6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  assert.equal(registry.getViewCount("fb"), 0);
  assert.equal(live("fb"), 0);
});

test("StrictMode background controllers: pruning and the unmount clear leave nothing behind", async () => {
  const { registry, live } = countingRegistry();
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const render = (panes) =>
    act(async () => root.render(strict(React.createElement(BackgroundPage, { registry, panes }))));
  try {
    await render(["bx", "by"]);
    for (const id of ["bx", "by"]) {
      assert.equal(registry.getViewCount(id), 1, `${id} retained once after the replay`);
      assert.equal(live(id), 6, `${id} connected once after the replay`);
    }
    // The replayed unmount effect cleared the Map, so this render creates fresh controllers
    // while the panes still hold the replay survivors.
    await render(["bx", "by"]);
    for (const id of ["bx", "by"]) {
      assert.equal(registry.getViewCount(id), 1, `${id} retained once after re-render`);
      assert.equal(live(id), 6, `${id} connected once after re-render`);
    }
    await render(["bx"]);
    assert.equal(registry.getViewCount("by"), 0, "a closed pane is not revived");
    assert.equal(live("by"), 0, "a closed pane leaves no subscription");
    assert.equal(registry.getViewCount("bx"), 1);
    assert.equal(live("bx"), 6);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  assert.equal(registry.getViewCount("bx"), 0);
  assert.equal(live("bx"), 0);
});
