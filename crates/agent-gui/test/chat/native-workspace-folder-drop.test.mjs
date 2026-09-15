import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function mountDropHook(t) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    navigator: { userAgent: "Macintosh; Intel Mac OS X" },
    devicePixelRatio: 2,
  };
  globalThis.document = {
    querySelectorAll(selector) {
      return selector === "[data-workspace-folder-drop-zone]"
        ? [{ getBoundingClientRect: () => ({ left: 0, top: 300, right: 272, bottom: 680 }) }]
        : [{
            getBoundingClientRect: () => ({ left: 400, top: 500, right: 1100, bottom: 660 }),
            getAttribute: () => "conversation-b",
          }];
    },
  };
  const refs = [];
  let refIndex = 0;
  let handler;
  let cleanup;
  let registrations = 0;
  let internalDrag = null;
  const imports = [];
  const uploads = [];
  const mentions = [];
  const activeTargets = [];
  const loader = createTsModuleLoader({
    mocks: {
      react: {
        useRef(initialValue) {
          const index = refIndex++;
          refs[index] ??= { current: initialValue };
          return refs[index];
        },
        useState: (initialValue) => [initialValue, (target) => activeTargets.push(target)],
        useEffect(effect) {
          if (!cleanup) cleanup = effect();
        },
      },
      "@tauri-apps/api/core": { isTauri: () => true },
      "@tauri-apps/api/webview": {
        getCurrentWebview: () => ({
          onDragDropEvent: async (callback) => {
            registrations += 1;
            handler = callback;
            return () => {};
          },
        }),
      },
      "@liveagent/ui/lib/chat/workspacePathDrag": {
        getActiveWorkspacePathDrag: () => internalDrag,
        clearActiveWorkspacePathDrag: () => { internalDrag = null; },
        clearActiveWorkspacePathNativeHover: () => {},
        dispatchActiveWorkspacePathNativeHover: () => {},
        dispatchActiveWorkspacePathDrop: (position) => { mentions.push(position); },
        absoluteWorkspacePath: (payload) => `${payload.cwd}/${payload.relativePath}`,
      },
    },
  });
  const { useTauriFileDrop } = loader.loadModule("src/pages/chat/hooks/useTauriFileDrop.ts");
  const params = {
    importWorkspaceFolderPaths: async (paths) => { imports.push(paths); },
    importUploadZonePaths: async (paths, conversationId) => { uploads.push({ paths, conversationId }); },
  };
  const render = (overrides = {}) => {
    refIndex = 0;
    useTauriFileDrop({ ...params, ...overrides });
  };
  render();
  t.after(() => {
    cleanup?.();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  return {
    imports,
    activeTargets,
    uploads,
    mentions,
    render,
    registrations: () => registrations,
    setInternalDrag(entryKind = "dir") {
      internalDrag = { entryKind, cwd: "/workspace", relativePath: "nested" };
    },
    emit(type, position, paths = []) { handler({ payload: { type, position, paths } }); },
  };
}

test("native folders dropped on workspace rows and empty margins import as workspaces", (t) => {
  const hook = mountDropHook(t);
  for (const position of [{ x: 2, y: 350 }, { x: 150, y: 450 }, { x: 270, y: 678 }]) {
    hook.emit("drop", position, ["/new/workspace"]);
  }
  assert.deepEqual(hook.imports, Array(3).fill(["/new/workspace"]));
  assert.deepEqual(hook.uploads, []);
  assert.deepEqual(hook.mentions, []);
});

test("release over the workspace wins over earlier composer hover", (t) => {
  const hook = mountDropHook(t);
  hook.emit("enter", { x: 700, y: 600 }, ["/new/workspace"]);
  hook.emit("drop", { x: 150, y: 450 }, ["/new/workspace"]);
  assert.deepEqual(hook.imports, [["/new/workspace"]]);
  assert.deepEqual(hook.uploads, []);
});

test("a folder dragged from the file tree into the sidebar creates a workspace", (t) => {
  const hook = mountDropHook(t);
  hook.setInternalDrag();
  hook.emit("over", { x: 150, y: 450 });
  hook.emit("drop", { x: 150, y: 450 });
  assert.deepEqual(hook.imports, [["/workspace/nested"]]);
  assert.deepEqual(hook.uploads, []);
  assert.deepEqual(hook.mentions, []);
});

test("a file-tree file dropped into the sidebar is neither a workspace nor a mention", (t) => {
  const hook = mountDropHook(t);
  hook.setInternalDrag("file");
  hook.emit("drop", { x: 150, y: 450 });
  assert.deepEqual(hook.imports, []);
  assert.deepEqual(hook.uploads, []);
  assert.deepEqual(hook.mentions, []);
});

test("composer drops preserve the conversation-specific upload and internal mention routes", (t) => {
  const hook = mountDropHook(t);
  hook.emit("drop", { x: 700, y: 600 }, ["/new/workspace"]);
  assert.deepEqual(hook.uploads, [{ paths: ["/new/workspace"], conversationId: "conversation-b" }]);
  hook.setInternalDrag();
  hook.emit("drop", { x: 700, y: 600 });
  assert.deepEqual(hook.mentions, [{ x: 700, y: 600 }]);
  assert.deepEqual(hook.imports, []);
});

test("an external drop is not claimed by stale internal drag data", (t) => {
  const hook = mountDropHook(t);
  hook.setInternalDrag();
  hook.emit("drop", { x: 150, y: 450 }, ["/finder/folder"]);
  assert.deepEqual(hook.imports, [["/finder/folder"]]);
  assert.deepEqual(hook.mentions, []);
});

test("native subscription stays stable while drop callbacks receive fresh state", (t) => {
  const hook = mountDropHook(t);
  const updatedImports = [];
  hook.render({ importWorkspaceFolderPaths: async (paths) => { updatedImports.push(paths); } });
  hook.emit("drop", { x: 150, y: 450 }, ["/new/workspace"]);
  assert.equal(hook.registrations(), 1);
  assert.deepEqual(hook.imports, []);
  assert.deepEqual(updatedImports, [["/new/workspace"]]);
});

test("empty OS drops and drops above the workspace area are ignored", (t) => {
  const hook = mountDropHook(t);
  hook.emit("drop", { x: 150, y: 450 });
  hook.emit("drop", { x: 150, y: 100 }, ["/new/workspace"]);
  assert.deepEqual(hook.imports, []);
  assert.deepEqual(hook.uploads, []);
});


test("internal sidebar/text drags never show import feedback, while real files still do", (t) => {
  const hook = mountDropHook(t);
  const position = { x: 150, y: 450 };
  hook.emit("enter", position);
  hook.emit("over", position);
  assert.ok(hook.activeTargets.every((target) => target === null));
  hook.emit("enter", position, ["/finder/folder"]);
  hook.emit("over", position);
  assert.equal(hook.activeTargets.at(-1), "workspace");
  hook.emit("leave", position);
  hook.emit("over", position);
  assert.equal(hook.activeTargets.at(-1), null);
  hook.emit("drop", position);
  assert.deepEqual(hook.imports, []);
});
