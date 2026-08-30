import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// useWindowWorkbench 布局落盘防抖:拖动分隔条等高频布局变更不得每次都同步写
// localStorage;合并为尾随一次写入,且卸载(窗口关闭)前 flush 最后状态。

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;

const { useWindowWorkbench } = env.loadModule(
  "@liveagent/ui/lib/workbench/useWindowWorkbench.ts",
);

function recordingStorage() {
  const entries = new Map();
  const writes = [];
  return {
    writes,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(value);
      entries.set(key, value);
    },
    removeItem: (key) => entries.delete(key),
  };
}

function project(id) {
  return { projectId: `project-${id}`, projectPathKey: `/workspace/${id}` };
}

function renderWorkbench(storage) {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);
  const handle = { workbench: null };
  function Harness() {
    const geometryRef = React.useRef(null);
    handle.workbench = useWindowWorkbench({
      initialConversationId: "conversation-a",
      initialProject: project("a"),
      geometryRef,
      dividerSize: 6,
      persistence: { storage, storageKey: "test-layout" },
    });
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
  return { root, container, handle };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rapid layout changes collapse into one trailing storage write", async () => {
  const storage = recordingStorage();
  const { root, container, handle } = renderWorkbench(storage);

  act(() => {
    handle.workbench.syncCurrentConversation("conversation-b", project("b"));
  });
  act(() => {
    handle.workbench.syncCurrentConversation("conversation-c", project("c"));
  });
  act(() => {
    handle.workbench.syncCurrentConversation("conversation-d", project("d"));
  });
  assert.equal(storage.writes.length, 0, "no synchronous write inside the debounce window");

  await sleep(400);
  assert.equal(storage.writes.length, 1, "trailing debounce writes exactly once");
  assert.equal(
    storage.writes[0].includes("conversation-d"),
    true,
    "the write captures the latest layout",
  );

  act(() => {
    root.unmount();
  });
  container.remove();
  assert.equal(storage.writes.length, 1, "unmount without pending changes writes nothing");
});

test("unmount flushes a pending debounced layout write", async () => {
  const storage = recordingStorage();
  const { root, container, handle } = renderWorkbench(storage);

  act(() => {
    handle.workbench.syncCurrentConversation("conversation-final", project("final"));
  });
  assert.equal(storage.writes.length, 0);

  act(() => {
    root.unmount();
  });
  container.remove();
  assert.equal(storage.writes.length, 1, "pending write must flush on unmount");
  assert.equal(storage.writes[0].includes("conversation-final"), true);

  await sleep(400);
  assert.equal(storage.writes.length, 1, "flushed timer must not fire again");
});
