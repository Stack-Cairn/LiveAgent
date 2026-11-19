import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Deliberately model Monaco's two clocks: undo restores an alternative version,
// but the ordinary version keeps increasing (including edit-then-undo races).
function createMonacoFake() {
  const models = [];
  const createCalls = [];
  const optionUpdates = [];
  const effectiveOptions = {};
  let currentModel = null;
  const editor = {
    disposed: false,
    getModel: () => currentModel,
    setModel: model => { currentModel = model; },
    saveViewState: () => ({}),
    restoreViewState() {},
    updateOptions(options) { optionUpdates.push(options); Object.assign(effectiveOptions, options); },
    focus() {},
    trigger(_source, command) {
      if (command === "undo") currentModel?.undo();
      if (command === "redo") currentModel?.redo();
    },
    dispose() { this.disposed = true; currentModel = null; },
  };
  return {
    models, createCalls, optionUpdates, effectiveOptions,
    instance: editor,
    module: {
      Uri: { from: parts => ({ toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }) },
      languageForPath: path => path.endsWith(".ts") ? "typescript" : "plaintext",
      editor: {
        create: (_container, options) => { createCalls.push(options); Object.assign(effectiveOptions, options); return editor; },
        setTheme() {},
        setModelLanguage(model, language) { model.language = language; },
        createModel(content, language, uri) {
          assert.equal(typeof content, "string", "a lazy model needs the original read buffer");
          const bom = content.startsWith("﻿") ? "﻿" : "";
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          const normalize = text => text.replace(/^﻿/, "").replace(/\r\n|\r|\n/g, eol);
          let history = [{ text: normalize(content), id: 1 }];
          let cursor = 0, version = 1, nextId = 1;
          const listeners = new Set();
          const notify = (previous, changes) => {
            version += 1;
            const lines = previous.split(/\r\n|\r|\n/);
            const event = { changes: changes ?? [{
              rangeOffset: 0, rangeLength: previous.length, text: history[cursor].text,
              range: { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1).length + 1 },
            }] };
            for (const listener of listeners) listener(event);
          };
          const model = {
            uri, language, disposed: false, getValueCalls: [], setValueCalls: [], stackBoundaries: 0,
            peek: () => history[cursor].text,
            getValue(...args) {
              this.getValueCalls.push(args);
              const [preference, preserveBOM] = args;
              const targetEol = preference === 1 ? "\n" : preference === 2 ? "\r\n" : eol;
              return (preserveBOM ? bom : "") + this.peek().replace(/\r\n|\r|\n/g, targetEol);
            },
            getAlternativeVersionId: () => history[cursor].id,
            getVersionId: () => version,
            getValueLength() { return this.peek().length; },
            getLineCount() { return this.peek().split(/\r\n|\r|\n/).length; },
            getLineLength(line) { return this.peek().split(/\r\n|\r|\n/)[line - 1].length; },
            getPositionAt(offset) {
              const lines = this.peek().slice(0, offset).split(/\r\n|\r|\n/);
              return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
            },
            getLanguageId() { return this.language; },
            onDidChangeContent(listener) {
              listeners.add(listener);
              return { dispose: () => listeners.delete(listener) };
            },
            pushStackElement() { this.stackBoundaries += 1; },
            edit(text) {
              const previous = this.peek();
              history = history.slice(0, cursor + 1);
              history.push({ text: normalize(text), id: ++nextId });
              cursor += 1;
              notify(previous);
            },
            batchEdit(changes) {
              const previous = this.peek();
              let text = previous;
              for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
                text = text.slice(0, change.rangeOffset) + change.text + text.slice(change.rangeOffset + change.rangeLength);
              }
              history = history.slice(0, cursor + 1);
              history.push({ text: normalize(text), id: ++nextId });
              cursor += 1;
              notify(previous, changes);
            },
            undo() { if (cursor > 0) { const previous = this.peek(); cursor -= 1; notify(previous); } },
            redo() { if (cursor + 1 < history.length) { const previous = this.peek(); cursor += 1; notify(previous); } },
            setValue(text) {
              const previous = this.peek();
              this.setValueCalls.push(text);
              history = [{ text: normalize(text), id: ++nextId }];
              cursor = 0;
              notify(previous);
            },
            dispose() { this.disposed = true; listeners.clear(); history = []; },
          };
          models.push(model);
          return model;
        },
      },
    },
  };
}

function pendingCall(args) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { args, promise, resolve, reject };
}

function readResult(path, content = "baseline", revision = 1) {
  return {
    path, content, mtimeMs: revision, contentHash: `hash-${revision}`,
    sizeBytes: Buffer.byteLength(content), totalLines: content ? content.split("\n").length : 0,
  };
}

function writeResult(call, revision = 2) {
  return {
    kind: "ok", mtimeMs: revision, contentHash: `hash-${revision}`,
    sizeBytes: Buffer.byteLength(call.args.content), totalLines: null,
  };
}

async function setup(t) {
  const monaco = createMonacoFake();
  const reads = [], writes = [];
  const io = {
    read(args) { const call = pendingCall(args); reads.push(call); return call.promise; },
    write(args) { const call = pendingCall(args); writes.push(call); return call.promise; },
  };
  let React;
  const passthrough = ({ children }) => children;
  const button = ({ children, variant: _variant, size: _size, ...props }) =>
    React.createElement("button", props, children);
  const icon = () => null;
  const translate = key => key;
  const previousMonacoEnvironment = Object.getOwnPropertyDescriptor(globalThis, "MonacoEnvironment");
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/adapters/workspacePreview": {
      WorkspaceOverlayTitleBar: icon, workspaceOverlayStackClassName: "", readWorkspaceClipboardText: async () => "",
    },
    "@liveagent/ui/components/IconSet": Object.fromEntries(
      "AlertTriangle ClipboardPaste Cloud Copy Eye FilePenLine Loader2 MessageSquareText Redo2 RefreshCw Replace Save Scissors Search TextSelect Undo2 WrapText X"
        .split(" ").map(name => [name, icon]),
    ),
    "@liveagent/ui/components/ui/alert-dialog": {
      AlertDialog: ({ open, children }) => open ? React.createElement("div", { role: "alertdialog" }, children) : null,
      ...Object.fromEntries(
        "AlertDialogActions AlertDialogContent AlertDialogDescription AlertDialogFooter AlertDialogHeader AlertDialogTitle"
          .split(" ").map(name => [name, passthrough]),
      ),
    },
    "@liveagent/ui/components/ui/button": { Button: button, RefreshButton: button },
    "@liveagent/ui/components/ui/context-menu": { ContextMenuPopup: passthrough, ContextMenuItem: button },
    "@liveagent/ui/components/ui/empty-state": { EmptyState: passthrough },
    "@liveagent/ui/components/ui/kbd": { KbdShortcut: icon },
    "@liveagent/ui/components/workspace-editor/workspaceImagePreview": { isWorkspacePreviewPath: () => false },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: translate }) },
    "@liveagent/ui/lib/chat/commandPalette": { isMacLikePlatform: () => false },
    "@liveagent/ui/lib/chat/mentionReferences": { createCodeMentionReference: () => null },
    "@liveagent/ui/lib/monacoEditor": monaco.module,
    "@liveagent/ui/lib/shared/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
    "./workspaceEditorFileIo": {
      localEditorFileIo: io,
      createRemoteSftpEditorFileIo: () => io,
      isEditorFileTooLarge: () => false,
    },
    ...Object.fromEntries([
      "editor/editor.worker.js", "languages/features/css/css.worker.js", "languages/features/html/html.worker.js",
      "languages/features/json/json.worker.js", "languages/features/typescript/ts.worker.js",
    ].map(path => [`monaco-editor/${path}?worker`, { __esModule: true, default: class {} }])),
  }});
  React = env.React;
  const { act } = env;
  // Own only the overlay's window timers. No wall-clock waits are needed to
  // exercise the close animation's final safety check.
  const timers = new Map();
  let timerId = 0;
  env.dom.window.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  env.dom.window.clearTimeout = id => timers.delete(id);
  env.dom.window.requestAnimationFrame = () => ++timerId;
  env.dom.window.cancelAnimationFrame = () => {};
  const { WorkspaceCodeEditorOverlay } = env.loadModule(
    "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay.tsx",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    await act(async () => root.unmount());
    mounted = false;
  };
  let requestId = 0, closeCount = 0;
  let props = {
    openRequest: null, closeRequestId: 0, isOpen: true, theme: "dark",
    onPreviewFile() {}, onHide() {}, onClose() { closeCount += 1; },
  };
  t.after(async () => {
    try { await unmount(); }
    finally {
      host.remove();
      env.cleanup();
      if (previousMonacoEnvironment) Object.defineProperty(globalThis, "MonacoEnvironment", previousMonacoEnvironment);
      else delete globalThis.MonacoEnvironment;
    }
  });
  const render = async (patch = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(React.createElement(WorkspaceCodeEditorOverlay, props)));
  };
  const request = path => ({ id: ++requestId, projectPathKey: "project", workdir: "/work", path });
  const open = async (path = "/work/a.txt", content = "baseline") => {
    const count = reads.length;
    await render({ openRequest: request(path) });
    assert.equal(reads.length, count + 1);
    await act(async () => reads.at(-1).resolve(readResult(path, content)));
    return monaco.instance.getModel();
  };
  const toolbar = action => host.querySelector(`button[aria-label="workspaceEditor.${action}"]`);
  const dialog = () => host.querySelector('[role="alertdialog"]');
  const dialogButton = action => [...(dialog()?.querySelectorAll("button") ?? [])]
    .find(node => node.textContent === `workspaceEditor.${action}`);
  const click = async node => {
    assert.ok(node, "expected a rendered control");
    assert.equal(node.disabled, false, "expected an enabled control");
    await act(async () => node.click());
  };
  const shortcutSave = () => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "s", ctrlKey: true, bubbles: true, cancelable: true,
  }));
  const save = async () => act(async () => { shortcutSave(); });
  const closeTab = () => click(host.querySelector('button[title="workspaceEditor.closeTab"]'));
  const dirty = () => host.textContent.includes("workspaceEditor.unsaved");
  const flushExit = async () => act(async () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  });
  await render();
  return {
    ...env, host, monaco, reads, writes, render, request, open, unmount, toolbar, dialog, dialogButton,
    click, shortcutSave, save, closeTab, dirty, flushExit, closeCount: () => closeCount,
  };
}

test("typing and undo/redo track the saved version without materializing full text", async t => {
  const h = await setup(t);
  const model = await h.open();
  assert.equal(h.dirty(), false);
  assert.equal(h.toolbar("save").disabled, true);
  await h.act(async () => {
    for (let index = 0; index < 30; index += 1) model.edit(`edit ${index}\nsecond line`);
  });
  assert.equal(h.dirty(), true);
  assert.equal(h.toolbar("save").disabled, false);
  assert.equal(model.getValueCalls.length, 0, "content-change events must not copy the file");
  await h.act(async () => { for (let index = 0; index < 30; index += 1) model.undo(); });
  assert.equal(h.dirty(), false, "undo to the disk baseline is clean");
  assert.equal(h.toolbar("save").disabled, true);
  await h.act(async () => model.redo());
  assert.equal(h.dirty(), true);
  await h.save();
  assert.equal(h.writes.length, 1);
  await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0])));
  assert.equal(h.dirty(), false);
  await h.act(async () => model.undo());
  assert.equal(h.dirty(), true, "the previous disk baseline is dirty after a successful save");
  await h.act(async () => model.redo());
  assert.equal(h.dirty(), false, "redo to the newly saved version is clean");
  assert.deepEqual(model.getValueCalls, [[undefined, true]], "only saving takes a text snapshot");
});

test("save takes one BOM-preserving CRLF snapshot with the original conflict baseline", async t => {
  const h = await setup(t);
  const initial = "﻿first\r\nsecond\r\n";
  const model = await h.open("/work/a.txt", initial);
  await h.act(async () => model.edit("first\r\nchanged\r\n"));
  await h.save();
  assert.deepEqual(model.getValueCalls, [[undefined, true]]);
  assert.equal(model.stackBoundaries, 1, "separate edits made after the snapshot in Monaco's undo stack");
  assert.deepEqual(h.writes[0].args, {
    workdir: "/work", path: "/work/a.txt", content: "﻿first\r\nchanged\r\n",
    expectedMtimeMs: 1, expectedContentHash: "hash-1", expectedSizeBytes: Buffer.byteLength(initial),
  });
  await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0])));
  assert.equal(h.dirty(), false);
});

for (const target of ["tab", "overlay"]) {
  test(`save-and-close ${target} leaves later edits open and saves against the completed write`, async t => {
    const h = await setup(t);
    const model = await h.open();
    await h.act(async () => model.edit("snapshot"));
    if (target === "overlay") await h.render({ closeRequestId: 1 });
    else await h.closeTab();
    await h.click(h.dialogButton(target === "overlay" ? "saveAll" : "save"));
    assert.equal(h.writes.length, 1);
    await h.act(async () => model.edit("typed while saving"));
    await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0], 2)));
    await h.flushExit();
    assert.equal(model.disposed, false);
    assert.equal(model.peek(), "typed while saving");
    assert.equal(h.dirty(), true);
    assert.ok(h.dialog(), "save-and-close must retain its confirmation when the snapshot is stale");
    assert.equal(h.closeCount(), 0);
    await h.click(h.dialogButton("cancel"));
    await h.save();
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes[1].args.content, "typed while saving");
    assert.equal(h.writes[1].args.expectedMtimeMs, 2);
    assert.equal(h.writes[1].args.expectedContentHash, "hash-2");
    assert.equal(h.writes[1].args.expectedSizeBytes, Buffer.byteLength("snapshot"));
    await h.act(async () => h.writes[1].resolve(writeResult(h.writes[1], 3)));
    await h.closeTab();
    assert.equal(model.disposed, true);
  });
}

test("duplicate save and close await the pending write even after undo makes the old baseline clean", async t => {
  const h = await setup(t);
  const model = await h.open();
  await h.act(async () => {
    model.edit("snapshot");
    h.shortcutSave();
    h.shortcutSave();
  });
  assert.equal(h.writes.length, 1);
  await h.act(async () => model.undo());
  await h.closeTab();
  assert.ok(h.dialog(), "a write in flight still needs confirmation after undo");
  await h.click(h.dialogButton("save"));
  await h.save();
  assert.equal(h.writes.length, 1, "save-and-close must join the pending write");
  assert.equal(model.disposed, false, "joining a write cannot report success before it settles");
  await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0])));
  assert.equal(model.disposed, false, "undo differs from the snapshot that actually reached disk");
  assert.equal(h.dirty(), true);
  assert.ok(h.dialog());
  assert.deepEqual(model.getValueCalls, [[undefined, true]]);
  await h.click(h.dialogButton("save"));
  assert.equal(h.writes.length, 2, "the pending-save guard must be released on completion");
  assert.equal(h.writes[1].args.content, "baseline");
  await h.act(async () => h.writes[1].resolve(writeResult(h.writes[1], 3)));
  assert.equal(model.disposed, true);
  assert.equal(h.dialog(), null);
});

test("duplicate saves and overlay close wait for one unchanged snapshot to reach disk", async t => {
  const h = await setup(t);
  const model = await h.open();
  await h.act(async () => model.edit("snapshot"));
  await h.save();
  await h.save();
  await h.render({ closeRequestId: 1 });
  await h.click(h.dialogButton("saveAll"));
  await h.flushExit();
  assert.equal(h.writes.length, 1);
  assert.equal(h.closeCount(), 0, "close must await the existing transport promise");
  assert.equal(model.disposed, false);
  assert.ok(h.dialog());
  await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0])));
  await h.flushExit();
  assert.equal(h.writes.length, 1);
  assert.equal(h.closeCount(), 1);
  assert.equal(h.dirty(), false);
  assert.equal(h.dialog(), null);
  assert.deepEqual(model.getValueCalls, [[undefined, true]]);
});

test("a failed write keeps edits and permits retry without advancing the disk baseline", async t => {
  const h = await setup(t);
  const model = await h.open();
  await h.act(async () => model.edit("unsaved"));
  await h.save();
  await h.act(async () => h.writes[0].reject(new Error("disk unavailable")));
  assert.equal(h.dirty(), true);
  assert.match(h.host.textContent, /disk unavailable/);
  await h.save();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].args.expectedContentHash, "hash-1");
  await h.act(async () => h.writes[1].resolve(writeResult(h.writes[1])));
  assert.equal(h.dirty(), false);
  assert.doesNotMatch(h.host.textContent, /disk unavailable/);
});

for (const undo of [false, true]) {
  test(`reload cannot replace text after an intervening edit${undo ? " followed by undo" : ""}`, async t => {
    const h = await setup(t);
    const model = await h.open();
    await h.click(h.toolbar("reload"));
    assert.equal(h.reads.length, 2);
    await h.act(async () => { model.edit("local edit"); if (undo) model.undo(); });
    await h.act(async () => h.reads[1].resolve(readResult("/work/a.txt", "disk replacement", 2)));
    assert.equal(model.peek(), undo ? "baseline" : "local edit");
    assert.deepEqual(model.setValueCalls, [], "even edit-then-undo invalidates an outstanding reload");
    assert.ok(h.dialog());
    assert.match(h.dialog().textContent, /workspaceEditor.reloadDirtyTitle/);
    assert.equal(h.dirty(), !undo);
    await h.click(h.dialogButton("cancel"));
    // A refused response must not leave reloadToken or the loading indicator stuck.
    await h.click(h.toolbar("reload"));
    if (!undo) await h.click(h.dialogButton("discard"));
    assert.equal(h.reads.length, 3);
    await h.act(async () => h.reads[2].resolve(readResult("/work/a.txt", "confirmed replacement", 3)));
    assert.equal(model.peek(), "confirmed replacement");
    assert.equal(h.dirty(), false);
    assert.equal(h.toolbar("save").disabled, true);
    assert.equal(model.getValueCalls.length, 0, "reload uses model metadata rather than copying text back out");
  });
}

for (const failStaleRead of [false, true]) {
  test(`a stale reload ${failStaleRead ? "failure" : "response"} cannot affect a closed and reopened path`, async t => {
    const h = await setup(t);
    const oldModel = await h.open();
    await h.click(h.toolbar("reload"));
    const stale = h.reads[1];
    await h.closeTab();
    assert.equal(oldModel.disposed, true);
    const newModel = await h.open("/work/a.txt", "reopened");
    assert.notEqual(newModel, oldModel);
    await h.click(h.toolbar("reload"));
    assert.equal(h.reads.length, 4);
    await h.act(async () => {
      if (failStaleRead) stale.reject(new Error("stale reload failure"));
      else stale.resolve(readResult("/work/a.txt", "obsolete", 9));
    });
    assert.equal(newModel.peek(), "reopened");
    assert.deepEqual(newModel.setValueCalls, []);
    assert.equal(h.dialog(), null);
    assert.doesNotMatch(h.host.textContent, /stale reload failure/);
    assert.equal(h.toolbar("reload").disabled, true, "old finally must not clear the new reload's busy state");
    await h.act(async () => h.reads[3].resolve(readResult("/work/a.txt", "fresh reload", 3)));
    assert.equal(newModel.peek(), "fresh reload");
    assert.equal(h.toolbar("reload").disabled, false);
    assert.equal(h.dirty(), false);
    await h.act(async () => newModel.edit("next edit"));
    await h.save();
    assert.equal(h.writes[0].args.expectedContentHash, "hash-3", "stale metadata cannot become the new baseline");
    await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0], 4)));
  });
}

test("closing the overlay rechecks edits received during its exit animation", async t => {
  const h = await setup(t);
  const model = await h.open();
  await h.render({ closeRequestId: 1 });
  assert.equal(h.closeCount(), 0);
  await h.act(async () => model.edit("late keystroke"));
  await h.flushExit();
  assert.equal(h.closeCount(), 0);
  assert.ok(h.dialog());
  assert.match(h.dialog().textContent, /workspaceEditor.closeDirtyTitle/);
  assert.equal(model.peek(), "late keystroke");
  assert.equal(h.dirty(), true);
  await h.click(h.dialogButton("saveAll"));
  await h.act(async () => h.writes[0].resolve(writeResult(h.writes[0])));
  await h.flushExit();
  assert.equal(h.closeCount(), 1);
});

test("only active tabs acquire models; switching reuses edited models and closing releases them", async t => {
  const h = await setup(t);
  const aPath = "/work/a.txt", bPath = "/work/b.txt";
  await h.render({ openRequest: h.request(aPath) });
  await h.render({ openRequest: h.request(bPath) });
  assert.equal(h.monaco.models.length, 0, "pending reads do not allocate Monaco models");
  await h.act(async () => {
    h.reads[0].resolve(readResult(aPath, "buffer a"));
    h.reads[1].resolve(readResult(bPath, "buffer b"));
  });
  assert.equal(h.monaco.models.length, 1, "the inactive read buffer stays lazy");
  const b = h.monaco.instance.getModel();
  assert.equal(b.peek(), "buffer b");
  const selectTab = name => h.click([...h.host.querySelectorAll("button")].find(node => node.textContent === name));
  await selectTab("a.txt");
  const a = h.monaco.instance.getModel();
  assert.equal(a.peek(), "buffer a");
  await h.act(async () => a.edit("edited a"));
  await selectTab("b.txt");
  await selectTab("a.txt");
  assert.equal(h.monaco.instance.getModel(), a);
  assert.equal(a.peek(), "edited a", "activation cannot restore an initial string over the model");
  assert.equal(h.monaco.models.length, 2);
  assert.equal(h.reads.length, 2);
  await h.act(async () => a.undo());
  // Close controls are ordered with the tabs; a is the first tab.
  await h.closeTab();
  assert.equal(a.disposed, true);
  assert.equal(b.disposed, false);
  assert.equal(h.monaco.instance.getModel(), b);
  const reopened = await h.open(aPath, "reread a");
  assert.notEqual(reopened, a);
  assert.equal(reopened.peek(), "reread a", "closing must release the old buffer as well as its model");
  assert.equal(h.monaco.models.length, 3);
  assert.equal(b.getValueCalls.length, 0);
  assert.equal(a.getValueCalls.length, 0);
  await h.act(async () => reopened.edit("edited again"));
  assert.equal(h.dirty(), true);
  // Behavior can prove model reuse/disposal; it cannot prove that the private
  // initialContent string is collectible once the model has been created.
  await h.unmount();
  assert.equal(reopened.disposed, true);
  assert.equal(b.disposed, true);
  assert.equal(h.monaco.instance.disposed, true);
});

test("discarding a snapshot does not discard edits arriving during the exit animation", async t => {
  const h = await setup(t);
  const model = await h.open();
  await h.act(async () => model.edit("discard this"));
  await h.render({ closeRequestId: 1 });
  await h.click(h.dialogButton("discard"));
  await h.act(async () => model.edit("late new edit"));
  await h.flushExit();
  assert.equal(h.closeCount(), 0);
  assert.ok(h.dialog());
  assert.equal(model.peek(), "late new edit");
  assert.equal(model.disposed, false);
});

test("large and long-line tabs use lightweight options and small tabs restore language features", async t => {
  const h = await setup(t);
  assert.equal(h.monaco.createCalls.length, 0, "an empty overlay must not allocate an editor");
  const long = await h.open("/work/long.ts", "x".repeat(10_001));
  assert.equal(long.getLanguageId(), "plaintext");
  assert.equal(h.monaco.optionUpdates.at(-1).minimap.enabled, false);
  assert.equal(h.monaco.effectiveOptions.wordWrap, "off");
  const small = await h.open("/work/small.ts", "const value = 1;");
  assert.equal(small.getLanguageId(), "typescript");
  assert.equal(h.monaco.optionUpdates.at(-1).minimap.enabled, true);
  await h.act(async () => small.edit("x".repeat(1024 * 1024)));
  assert.equal(small.getLanguageId(), "plaintext");
  assert.equal(h.monaco.optionUpdates.at(-1).minimap.enabled, false);
  assert.equal(small.getValueCalls.length, 0);
  assert.equal(long.getValueCalls.length, 0);
  assert.equal(h.monaco.createCalls.length, 1, "tabs share one editor instance");
});

test("word wrap toggles on a large single line without changing content, undo, or dirty state", async t => {
  const h = await setup(t);
  const toggle = () => h.toolbar("wordWrap");
  assert.equal(toggle().disabled, true);
  assert.equal(toggle().getAttribute("aria-pressed"), "false");
  const original = "x".repeat(5 * 1024 * 1024);
  const model = await h.open("/work/single-line.ts", original);
  assert.equal(model.getLineCount(), 1);
  const version = model.getAlternativeVersionId();
  await h.click(toggle());
  assert.equal(toggle().getAttribute("aria-pressed"), "true");
  assert.equal(toggle().getAttribute("title"), "workspaceEditor.wordWrap");
  assert.equal(h.monaco.effectiveOptions.wordWrap, "on");
  assert.equal(h.monaco.effectiveOptions.wordWrapOverride2, "on");
  assert.equal(h.monaco.effectiveOptions.wrappingStrategy, "simple");
  assert.equal(h.monaco.effectiveOptions.stopRenderingLineAfter, 10_000);
  assert.equal(h.monaco.effectiveOptions.minimap.enabled, false);
  assert.equal(model.getAlternativeVersionId(), version);
  assert.equal(h.dirty(), false);

  await h.act(async () => model.edit(`${original}!`));
  const editedVersion = model.getAlternativeVersionId();
  await h.click(toggle());
  assert.equal(toggle().getAttribute("aria-pressed"), "false");
  assert.equal(h.monaco.effectiveOptions.wordWrap, "off");
  assert.equal(h.monaco.effectiveOptions.wordWrapOverride2, "off");
  assert.equal(model.getAlternativeVersionId(), editedVersion);
  assert.equal(h.dirty(), true);
  assert.equal(model.peek(), `${original}!`);
  assert.equal(h.monaco.instance.getModel(), model);
  assert.equal(h.monaco.models.length, 1);
  assert.equal(h.monaco.createCalls.length, 1);
  assert.deepEqual(model.setValueCalls, []);
  assert.deepEqual(model.getValueCalls, []);
  assert.equal(h.reads.length, 1);
  assert.equal(h.writes.length, 0);
  await h.act(async () => model.undo());
  assert.equal(model.peek(), original);
  assert.equal(h.dirty(), false);
  await h.act(async () => model.redo());
  assert.equal(model.peek(), `${original}!`);
  assert.equal(h.dirty(), true);
});

test("word wrap survives tab switches, hide/show, and promotion to lightweight editing", async t => {
  const h = await setup(t);
  const small = await h.open("/work/small.ts", "const x = 1;");
  await h.click(h.toolbar("wordWrap"));
  const long = await h.open("/work/long.ts", "x".repeat(10_001));
  assert.equal(h.monaco.effectiveOptions.wordWrap, "on");
  assert.equal(h.monaco.effectiveOptions.minimap.enabled, false);
  await h.click([...h.host.querySelectorAll("button")].find(node => node.textContent === "small.ts"));
  assert.equal(h.monaco.instance.getModel(), small);
  assert.equal(h.monaco.effectiveOptions.wordWrap, "on");
  assert.equal(h.monaco.effectiveOptions.minimap.enabled, true);
  await h.act(async () => small.edit("y".repeat(10_001)));
  assert.equal(h.monaco.effectiveOptions.minimap.enabled, false);
  assert.equal(h.monaco.effectiveOptions.wordWrap, "on");
  await h.render({ isOpen: false });
  await h.render({ isOpen: true });
  assert.equal(h.toolbar("wordWrap").getAttribute("aria-pressed"), "true");
  await h.click(h.toolbar("wordWrap"));
  assert.equal(h.monaco.effectiveOptions.wordWrap, "off");
  assert.equal(long.disposed, false);
});

test("batch replacements detect long lines after earlier edits shift their offsets", async t => {
  const h = await setup(t);
  const initial = Array.from({ length: 101 }, (_, index) => `line ${index + 1}`).join("\n");
  const model = await h.open("/work/batch.ts", initial);
  assert.equal(model.getLanguageId(), "typescript");
  const deleteLength = initial.indexOf("line 100\n");
  const replacementOffset = initial.lastIndexOf("line 101");
  await h.act(async () => model.batchEdit([
    // Monaco emits the changes with pre-edit coordinates, from the end backwards.
    { rangeOffset: replacementOffset, rangeLength: 8, text: "x".repeat(10_000), range: { startLineNumber: 101 } },
    { rangeOffset: 0, rangeLength: deleteLength, text: "", range: { startLineNumber: 1 } },
  ]));
  assert.equal(model.getLineCount(), 2);
  assert.equal(model.getLanguageId(), "plaintext");
  assert.equal(h.monaco.optionUpdates.at(-1).minimap.enabled, false);
  assert.equal(model.getValueCalls.length, 0);
});


test("a slower file read cannot steal focus from a newer open", async t => {
  const h = await setup(t);
  const first = "/work/slow.txt", latest = "/work/latest.txt";
  await h.render({ openRequest: h.request(first) });
  await h.render({ openRequest: h.request(latest) });
  await h.act(async () => h.reads[1].resolve(readResult(latest, "latest content")));
  const active = h.monaco.instance.getModel();
  await h.act(async () => h.reads[0].resolve(readResult(first, "slow content")));
  assert.equal(h.monaco.instance.getModel(), active);
  assert.equal(h.monaco.models.length, 1);
});
