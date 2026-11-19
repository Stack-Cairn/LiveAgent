import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const source = { workdir: "/project", path: "large.log", projectPathKey: "/project" };

test("workspace text ranges distinguish the final page from a legacy full-file response", async () => {
  const sizeBytes = 101 * 1024 * 1024;
  const last = sizeBytes - 3;
  const responses = [
    { content: "end", previewOffset: last, previewNextOffset: null, sizeBytes, mtimeMs: 1 },
    { content: "legacy", sizeBytes: 6, mtimeMs: 1 },
  ];
  const { loadModule } = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/lib/tools/fsBackend": {
        async invokeFs(command, parameters) {
          assert.equal(command, "fs_read_editable_text");
          assert.equal(parameters.preview_offset, last);
          return responses.shift();
        },
      },
    },
  });
  const { readWorkspaceTextRange } = loadModule(
    "@liveagent/ui/components/workspace-editor/workspaceTextRange.ts",
  );
  assert.deepEqual(await readWorkspaceTextRange(source, last), {
    content: "end",
    offset: last,
    nextOffset: sizeBytes,
    sizeBytes,
    mtimeMs: 1,
  });
  assert.equal(await readWorkspaceTextRange(source, last), null);
});

test("dense text pages mount only visible rows and update on scroll", async () => {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
      "@liveagent/ui/components/ui/button": { Button: () => null },
    },
  });
  const { WorkspaceTextRangePreview } = env.loadModule(
    "@liveagent/ui/components/workspace-editor/WorkspaceTextRangePreview.tsx",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  try {
    const content = "x\n".repeat(65_536) + "end-marker";
    const sizeBytes = content.length;
    await env.act(async () => root.render(env.React.createElement(WorkspaceTextRangePreview, {
      initialPage: { content, offset: 0, nextOffset: sizeBytes, sizeBytes, mtimeMs: 1 },
      editable: false,
      readPage: async () => null,
    })));
    const viewport = host.querySelector("[data-workspace-text-range]");
    const rows = viewport.firstElementChild;
    assert.ok(rows.children.length > 0 && rows.children.length < 100);
    assert.doesNotMatch(rows.textContent, /end-marker/);
    await env.act(async () => {
      viewport.scrollTop = 65_536 * 20;
      viewport.dispatchEvent(new Event("scroll"));
    });
    assert.ok(rows.children.length < 100);
    assert.match(rows.textContent, /end-marker/);
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});


test("range wrap follows viewport width without changing the source or mounting the whole page", async () => {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
      "@liveagent/ui/components/ui/button": { Button: () => null },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  let resize;
  let width = 96;
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  };
  const { HTMLElement, HTMLCanvasElement } = env.dom.window;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { get: () => 80 });
  HTMLElement.prototype.getBoundingClientRect = () => ({ width: 8 });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: () => ({ width: 16 }) });
  const { WorkspaceTextRangePreview } = env.loadModule(
    "@liveagent/ui/components/workspace-editor/WorkspaceTextRangePreview.tsx",
  );
  const content = "1234" + String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb) + "abcd" + "X".repeat(100_000);
  const sizeBytes = Buffer.byteLength(content);
  const render = async (wordWrap) => env.act(async () => root.render(env.React.createElement(WorkspaceTextRangePreview, {
    initialPage: { content, offset: 0, nextOffset: sizeBytes, sizeBytes, mtimeMs: 1 },
    wordWrap,
    editable: true,
    readPage: async () => { throw new Error("Wrapping should not reload the page"); },
  })));
  try {
    await render(false);
    const viewport = host.querySelector("[data-workspace-text-range]");
    const rows = viewport.firstElementChild;
    assert.equal(rows.childElementCount, 1);
    assert.equal(rows.firstElementChild.lastElementChild.textContent, content);
    await render(true);
    assert.equal(rows.children[0].lastElementChild.textContent, "1234");
    assert.equal(rows.children[1].lastElementChild.textContent, content.slice(4, 12));
    assert.equal(rows.children[0].firstElementChild.textContent, "1");
    assert.equal(rows.children[1].firstElementChild.textContent, "");
    assert.ok(rows.childElementCount < 30);
    assert.equal(viewport.style.overflowX, "hidden");
    width = 112;
    await env.act(async () => resize());
    assert.equal(rows.children[0].lastElementChild.textContent, content.slice(0, 10));
    await render(false);
    assert.equal(rows.childElementCount, 1);
    assert.equal(rows.firstElementChild.lastElementChild.textContent, content);
    assert.equal(viewport.style.overflowX, "auto");
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});

test("plain text shows line numbers and the total, while a partial range labels its own count", async () => {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => ({
        "workspaceFilePreview.lineCount": "{count} lines",
        "workspaceFilePreview.rangeLineCount": "{count} lines in this range",
      })[key] ?? key }) },
      "@liveagent/ui/components/ui/button": { Button: () => null },
    },
  });
  const { WorkspaceTextRangePreview } = env.loadModule(
    "@liveagent/ui/components/workspace-editor/WorkspaceTextRangePreview.tsx",
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  const render = (key, content, offset, nextOffset, sizeBytes, paged) => env.act(async () => {
    root.render(env.React.createElement(WorkspaceTextRangePreview, {
      key,
      initialPage: { content, offset, nextOffset, sizeBytes, mtimeMs: 1 },
      readPage: paged ? async () => null : undefined,
    }));
  });
  const labels = () => Array.from(host.querySelector('[data-workspace-text-range]').firstElementChild.children,
    (row) => row.firstElementChild.textContent);
  try {
    await render("full", "one\r\ntwo\n", 0, 9, 9, false);
    assert.deepEqual(labels(), ["1", "2", "3"]);
    assert.equal(host.querySelector('[role="status"]').textContent, "3 lines");
    assert.equal(host.querySelector('form'), null);
    await render("partial", "one\r\ntwo\n", 256, 265, 1000, true);
    assert.deepEqual(labels(), ["1", "2"]);
    assert.match(host.querySelector('[role="status"]').textContent, /2 lines in this range/);
    await render("empty", "", 0, 0, 0, false);
    assert.deepEqual(labels(), []);
    assert.equal(host.querySelector('[role="status"]').textContent, "0 lines");
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});
