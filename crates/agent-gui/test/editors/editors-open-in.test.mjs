import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// "Open in <Editor>": the detected-editor store, the shared menu entries, the
// file tree context menu and the chat file link menu. The Tauri bridge is
// mocked; nothing launches a real editor.

const invokeCalls = [];
let editorListResult = [];
const noopIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule" ? true : String(key).endsWith("_SVG_MARKUP") ? "<svg></svg>" : () => null,
  },
);
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": noopIcons,
    "@liveagent/ui/components/chat/fileTypeIcons": noopIcons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command, args) => {
        invokeCalls.push({ command, args });
        if (command === "editor_list") return editorListResult;
        return { editorId: args?.editor_id, kind: "file" };
      },
    },
    "@liveagent/app/shims/tauriOpener": { openUrl() {} },
    "@streamdown/cjk": { cjk: {} },
    "@streamdown/code": { code: {} },
    "@streamdown/math": { math: {} },
    "@streamdown/mermaid": { mermaid: {} },
    streamdown: {
      Streamdown: () => null,
      defaultRemarkPlugins: {},
      defaultRehypePlugins: { raw: () => {}, sanitize: [() => {}, {}], harden: () => {} },
    },
  },
});
globalThis.DOMRect = window.DOMRect;
// Node ships its own (file-less, non-persistent) localStorage global; the
// browser's globalThis is the window, so use jsdom's storage here.
Object.defineProperty(globalThis, "localStorage", {
  value: window.localStorage,
  writable: true,
  configurable: true,
});
// Desktop host: must be set before the file tree model computes its flag.
window.__TAURI_INTERNALS__ = {};
const { React, act, createRoot } = env;
const editors = env.loadModule("@liveagent/ui/lib/editors/editors.ts");
const { FileTreeContextMenu } = env.loadModule(
  "@liveagent/ui/components/project-tools/file-tree/ContextMenu.tsx",
);
const { ChatFileLinkContextMenuHost } = env.loadModule(
  "@liveagent/ui/components/chat/ChatFileLinkContextMenu.tsx",
);
const markdown = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { useChatFileLinkNavigation } = env.loadModule(
  "@liveagent/ui/lib/chat/useChatFileLinkNavigation.ts",
);

const VS_CODE = { id: "vscode", name: "VS Code" };
const ZED = { id: "zed", name: "Zed" };
const XCODE = { id: "xcode", name: "Xcode" };

async function resetWith(list) {
  globalThis.localStorage.clear();
  editors.resetEditorsForTests();
  invokeCalls.length = 0;
  editorListResult = list;
  await act(async () => {
    await editors.loadDetectedEditors();
  });
}

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const menuLabels = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent);
const menuItem = (label) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === label);

test("preferred editor: stored choice when installed, else the first detected editor", () => {
  assert.equal(editors.resolvePreferredEditor([], "zed"), null);
  assert.equal(editors.resolvePreferredEditor([VS_CODE, ZED], null).id, "vscode");
  assert.equal(editors.resolvePreferredEditor([VS_CODE, ZED], "zed").id, "zed");
  assert.equal(editors.resolvePreferredEditor([VS_CODE, ZED], "sublime").id, "vscode");
  assert.deepEqual(
    editors.otherEditors([VS_CODE, ZED, XCODE], ZED).map((editor) => editor.id),
    ["vscode", "xcode"],
  );
  assert.equal(editors.openInEditorLabel("Open in {name}", "Zed"), "Open in Zed");
});

test("detection runs once per session, drops malformed rows and refreshes on demand", async () => {
  await resetWith([VS_CODE, { id: "", name: "Blank" }, { id: "vscode", name: "Dup" }, 7, ZED]);
  assert.deepEqual(
    editors.getDetectedEditorsSnapshot().editors.map((editor) => editor.id),
    ["vscode", "zed"],
  );
  await editors.loadDetectedEditors();
  assert.equal(invokeCalls.filter((call) => call.command === "editor_list").length, 1);

  editorListResult = [ZED];
  await act(async () => {
    await editors.loadDetectedEditors({ refresh: true });
  });
  assert.deepEqual(invokeCalls.at(-1), { command: "editor_list", args: { refresh: true } });
  assert.deepEqual(
    editors.getDetectedEditorsSnapshot().editors.map((editor) => editor.id),
    ["zed"],
  );
});

test("the preferred editor persists on this device and clears back to the default", async () => {
  await resetWith([VS_CODE, ZED]);
  editors.writePreferredEditorId("zed");
  assert.equal(globalThis.localStorage.getItem(editors.PREFERRED_EDITOR_STORAGE_KEY), "zed");
  editors.resetEditorsForTests();
  assert.equal(editors.readPreferredEditorId(), "zed");
  editors.writePreferredEditorId(null);
  assert.equal(globalThis.localStorage.getItem(editors.PREFERRED_EDITOR_STORAGE_KEY), null);
  assert.equal(editors.readPreferredEditorId(), null);
});

test("openPathInEditor forwards the request to the host command", async () => {
  await resetWith([VS_CODE]);
  await editors.openPathInEditor({
    editorId: "vscode",
    workdir: "/work/app",
    path: "src/main.ts",
    line: 12,
    column: 3,
  });
  assert.deepEqual(invokeCalls.at(-1), {
    command: "editor_open_path",
    args: { editor_id: "vscode", workdir: "/work/app", path: "src/main.ts", line: 12, column: 3 },
  });
});

function renderFileTreeMenu({ kind, path, opened }) {
  const containerRef = { current: document.body };
  const noop = () => {};
  return mount(
    React.createElement(FileTreeContextMenu, {
      anchor: { x: 10, y: 10 },
      containerRef,
      path,
      kind,
      canMutate: true,
      canOpenFile: true,
      canInsertMention: false,
      showHidden: false,
      onClose: noop,
      onOpenFile: noop,
      onOpenExternal: noop,
      onOpenInEditor: (target, editorId) => opened.push(`${target}|${editorId}`),
      onOpenContainingDirectory: noop,
      onStartAction: noop,
      onDelete: noop,
      onInsertMention: noop,
      onRefresh: noop,
      onToggleHidden: noop,
      onActionError: noop,
    }),
  );
}

test("file tree menu: files and folders open in the preferred editor, others via the submenu", async () => {
  await resetWith([VS_CODE, ZED, XCODE]);
  editors.writePreferredEditorId("zed");
  const opened = [];
  let view = await renderFileTreeMenu({ kind: "file", path: "src/main.ts", opened });
  try {
    const labels = menuLabels();
    assert.equal(labels.includes("editors.openIn"), true, "preferred entry present");
    assert.equal(labels.includes("editors.openInOther"), true, "submenu present");
    const preferred = document.querySelector('[data-open-in-editor="zed"]');
    assert.equal(Boolean(preferred), true);
    await act(async () => preferred.click());
  } finally {
    await view.unmount();
  }
  view = await renderFileTreeMenu({ kind: "dir", path: "", opened });
  try {
    assert.equal(Boolean(document.querySelector('[data-open-in-editor="zed"]')), true);
    // Submenu contents mount when the submenu opens.
    const trigger = menuItem("editors.openInOther");
    await act(async () => trigger.click());
    const other = document.querySelector('[data-open-in-editor="xcode"]');
    assert.equal(Boolean(other), true, "other editors are listed in the submenu");
    await act(async () => other.click());
  } finally {
    await view.unmount();
  }
  assert.deepEqual(opened, ["src/main.ts|zed", "|xcode"]);
});

test("file tree menu: no detected editor means no Open in entries", async () => {
  await resetWith([]);
  const view = await renderFileTreeMenu({ kind: "file", path: "src/main.ts", opened: [] });
  try {
    const labels = menuLabels();
    assert.equal(labels.length > 0, true, "the menu itself renders");
    assert.equal(labels.includes("editors.openIn"), false);
    assert.equal(labels.includes("editors.openInOther"), false);
  } finally {
    await view.unmount();
  }
});

test("file tree menu: a single editor shows no submenu", async () => {
  await resetWith([VS_CODE]);
  const view = await renderFileTreeMenu({ kind: "file", path: "a.ts", opened: [] });
  try {
    const labels = menuLabels();
    assert.equal(labels.includes("editors.openIn"), true);
    assert.equal(labels.includes("editors.openInOther"), false);
  } finally {
    await view.unmount();
  }
});

function fileLinkNode(href) {
  const node = { type: "element", tagName: "a", properties: { href }, children: [] };
  markdown.rewriteChatFileLinks()({ type: "root", children: [node] });
  return node;
}

test("chat file link: Open in opens the resolved file at its line; plain clicks stay in-app", async () => {
  await resetWith([VS_CODE, ZED]);
  const editorRequests = [];
  const inApp = [];
  const linkRequests = [];
  function Transcript({ canOpenWithDefaultApp }) {
    const handleOpen = useChatFileLinkNavigation({
      conversationId: "conv-1",
      conversationWorkdir: "/work/app",
      terminalProjectPathKey: "",
      notifyError: (message) => inApp.push(`error:${message}`),
      onRevealInFileTree: () => {},
      openWorkspaceEditorFile: (request) => inApp.push(`${request.path}:${request.line}`),
      openWorkspaceFilePreview: () => {},
      openLink: async (request) => {
        linkRequests.push(request);
        return {
          action: "editor",
          kind: "file",
          outsideWorkspace: false,
          workdir: "/work/app",
          path: "src/main.ts",
          line: 42,
          column: 7,
        };
      },
      openInEditor: async (request) => {
        editorRequests.push(request);
      },
    });
    const node = fileLinkNode("src/main.ts#L42");
    return React.createElement(
      "div",
      null,
      React.createElement(markdown.MarkdownFileLink, {
        href: node.properties.href,
        node,
        workdir: "/work/app",
        onOpenFileLink: handleOpen,
        children: "src/main.ts",
      }),
      React.createElement(ChatFileLinkContextMenuHost, { canOpenWithDefaultApp }),
    );
  }

  let view = await mount(React.createElement(Transcript, { canOpenWithDefaultApp: true }));
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await act(async () =>
      link.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }),
      ),
    );
    const item = document.querySelector('[data-open-in-editor="vscode"]');
    assert.equal(Boolean(item), true, "the link menu offers the preferred editor");
    await act(async () => item.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(editorRequests, [
      { editorId: "vscode", workdir: "/work/app", path: "src/main.ts", line: 42, column: 7 },
    ]);
    assert.equal(
      "openInEditor" in linkRequests[0],
      true,
      "the editor choice rides on the link, not on message text",
    );

    await act(async () => link.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(editorRequests.length, 1, "a plain click does not reuse the editor intent");
    assert.deepEqual(inApp, ["src/main.ts:42"]);
  } finally {
    await view.unmount();
  }

  // WebUI viewers (no host integration) never see the entry.
  view = await mount(React.createElement(Transcript, { canOpenWithDefaultApp: false }));
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await act(async () =>
      link.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 }),
      ),
    );
    assert.equal(menuLabels().includes("editors.openIn"), false);
  } finally {
    await view.unmount();
  }
});
