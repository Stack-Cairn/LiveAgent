import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// PR #521 review P1:「多 Pane 下原生文件拖放必须归属落点 Pane 的会话」。
// 几何 hit-test 之外，这里断言真正的 upload 归属:drop 时刻从落点 composer
// 同步取出 conversationId(data-file-upload-conversation-id),沿
// importUploadZonePaths → importReadableFilePaths → captureUploadTarget 显式
// 传递,不再依赖异步的焦点切换(currentConversationIdRef)。

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// 1) drop 点 → conversationId:直接从命中的 composer 元素读取归属标记。
// ---------------------------------------------------------------------------

const routingLoader = createTsModuleLoader();
const routing = routingLoader.loadModule("src/pages/chat/hooks/nativeFileDropRouting.ts");

function composerZone(conversationId, rect) {
  return {
    getAttribute: (name) =>
      name === routing.FILE_UPLOAD_CONVERSATION_ATTRIBUTE ? conversationId : null,
    getBoundingClientRect: () => rect,
  };
}

function twoPaneDocument() {
  // 两个并列 Pane 的 composer:A 在左半屏,B 在右半屏。
  return {
    querySelectorAll(selector) {
      if (selector !== routing.FILE_UPLOAD_DROP_ZONE_SELECTOR) return [];
      return [
        composerZone("conv-a", { left: 40, top: 600, right: 560, bottom: 700 }),
        composerZone("conv-b", { left: 640, top: 600, right: 1160, bottom: 700 }),
      ];
    },
  };
}

test("a drop inside pane B's composer resolves conversation B, never the focused one", () => {
  const doc = twoPaneDocument();
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 900, y: 650 },
      { scaleFactor: 1, document: doc },
    ),
    "conv-b",
  );
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 100, y: 650 },
      { scaleFactor: 1, document: doc },
    ),
    "conv-a",
  );
});

test("a drop outside every composer resolves no upload conversation", () => {
  const doc = twoPaneDocument();
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 600, y: 100 },
      { scaleFactor: 1, document: doc },
    ),
    null,
  );
});

test("physical drop coordinates are normalized before attribution (Windows DPI)", () => {
  const doc = twoPaneDocument();
  // 物理 (1800, 1300) @2x → 逻辑 (900, 650),命中 conv-b。
  assert.equal(
    routing.resolveNativeUploadConversationId(
      { x: 1800, y: 1300 },
      { scaleFactor: 2, document: doc },
    ),
    "conv-b",
  );
});

// ---------------------------------------------------------------------------
// 2) usePendingUploads:显式 target 覆盖焦点会话,文件与 workdir 都跟着落点走。
// ---------------------------------------------------------------------------

function createHookHarness() {
  const refs = [];
  const states = [];
  let refIndex = 0;
  let stateIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setState = (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setState];
    },
    useCallback: (callback) => callback,
    useMemo: (factory) => factory(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: () => undefined,
  };

  return {
    react,
    render(run) {
      refIndex = 0;
      stateIndex = 0;
      return run();
    },
  };
}

function mountPendingUploads({ invokeImpl }) {
  const harness = createHookHarness();
  const invokeCalls = [];
  const loader = createTsModuleLoader({
    mocks: {
      react: harness.react,
      "@tauri-apps/api/core": {
        invoke: async (command, args) => {
          invokeCalls.push({ command, args });
          return invokeImpl(command, args);
        },
      },
    },
  });
  const { usePendingUploads } = loader.loadModule("src/pages/chat/hooks/usePendingUploads.ts");
  const { createConversationUploadStore } = loader.loadModule(
    "src/pages/chat/conversations/conversationUploadStore.ts",
  );

  const uploadStore = createConversationUploadStore();
  const currentConversationIdRef = { current: "conv-a" };
  const notifications = [];
  const errors = [];
  const params = {
    isAgentMode: true,
    workdir: "/ws/a",
    conversationId: "conv-a",
    uploadStore,
    currentConversationIdRef,
    composerRef: { current: null },
    setErrorMessage: (message) => errors.push(message),
    addNotify: (type, message) => notifications.push({ type, message }),
  };
  const hook = harness.render(() => usePendingUploads(params));
  return { hook, uploadStore, currentConversationIdRef, invokeCalls, notifications, errors };
}

function uploadedFile(relativePath) {
  return {
    relativePath,
    fileName: relativePath,
    kind: "text",
    sizeBytes: 1,
  };
}

test("an explicit drop target routes the import to that conversation and workdir", async () => {
  const { hook, uploadStore, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [uploadedFile("dropped.txt")], skipped: [] }),
  });

  // 焦点会话是 conv-a,落点是 conv-b:文件必须只出现在 conv-b。
  await hook.importReadableFilePaths(["/tmp/dropped.txt"], {
    conversationId: "conv-b",
    workdir: "/ws/b",
  });

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].command, "system_import_readable_file_paths");
  assert.equal(invokeCalls[0].args.workdir, "/ws/b");
  assert.deepEqual(
    uploadStore.getSnapshot("conv-b").map((file) => file.relativePath),
    ["dropped.txt"],
  );
  assert.deepEqual(uploadStore.getSnapshot("conv-a"), []);
});

test("without an explicit target the import still lands in the focused conversation", async () => {
  const { hook, uploadStore, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [uploadedFile("plain.txt")], skipped: [] }),
  });

  await hook.importReadableFilePaths(["/tmp/plain.txt"]);

  assert.equal(invokeCalls[0].args.workdir, "/ws/a");
  assert.deepEqual(
    uploadStore.getSnapshot("conv-a").map((file) => file.relativePath),
    ["plain.txt"],
  );
});

test("removing a chip targets the owning conversation, not the focused pane", async () => {
  const { hook, uploadStore, currentConversationIdRef } = mountPendingUploads({
    invokeImpl: () => ({ files: [], skipped: [] }),
  });
  uploadStore.set("conv-a", [uploadedFile("a.txt")]);
  uploadStore.set("conv-b", [uploadedFile("b.txt"), uploadedFile("shared.txt")]);
  currentConversationIdRef.current = "conv-a";

  hook.removePendingUpload("shared.txt", "conv-b");

  assert.deepEqual(
    uploadStore.getSnapshot("conv-b").map((file) => file.relativePath),
    ["b.txt"],
  );
  assert.deepEqual(
    uploadStore.getSnapshot("conv-a").map((file) => file.relativePath),
    ["a.txt"],
  );

  hook.removePendingUpload("a.txt");
  assert.deepEqual(uploadStore.getSnapshot("conv-a"), []);
});

test("the per-conversation upload cap is measured on the drop target, not the focused pane", async () => {
  const { hook, uploadStore, notifications, invokeCalls } = mountPendingUploads({
    invokeImpl: () => ({ files: [], skipped: [] }),
  });
  // 落点会话已满 9 个;焦点会话为空。必须拒绝导入而不是借焦点会话的余量。
  uploadStore.set(
    "conv-b",
    Array.from({ length: 9 }, (_, index) => uploadedFile(`existing-${index}.txt`)),
  );

  await hook.importReadableFilePaths(["/tmp/one-more.txt"], {
    conversationId: "conv-b",
    workdir: "/ws/b",
  });

  assert.equal(invokeCalls.length, 0);
  assert.equal(notifications.some((item) => item.type === "warning"), true);
});

// ---------------------------------------------------------------------------
// 3) 源级防回归:drop 管线不得回退到「焦点会话」路由。
// ---------------------------------------------------------------------------

test("the native drop pipeline resolves its conversation at drop time", () => {
  const tauriFileDrop = readSource("../../src/pages/chat/hooks/useTauriFileDrop.ts");
  // drop 分支必须从最终 drop 坐标解析归属会话,并把它传给 upload 管线。
  assert.match(tauriFileDrop, /resolveNativeUploadConversationId\(event\.payload\.position/);
  assert.match(tauriFileDrop, /importUploadZonePaths\(event\.payload\.paths,\s*targetConversationId\)/);

  const composerBar = readSource("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx");
  // 每个 composer 落区都携带自己的会话归属标记。
  assert.match(composerBar, /data-file-upload-conversation-id=\{conversationId\}/);
});
