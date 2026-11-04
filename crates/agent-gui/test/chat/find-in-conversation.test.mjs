import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const iconProxy = () =>
  new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });

function createEnv() {
  return createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": iconProxy(),
      "@liveagent/ui/i18n/index": {
        useLocale: () => ({
          t: (key) =>
            ({ "chat.find.count": "{current}/{total}", "chat.find.noResults": "No results" })[key] ??
            key,
          locale: "en",
        }),
      },
    },
  });
}

const frames = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

test("find model counts case-insensitive matches per row and wraps navigation", async () => {
  const env = await createEnv();
  try {
    const model = env.loadModule("@liveagent/ui/lib/transcript-find/transcriptFind.ts");
    const entries = [
      { rowKey: "u1", text: "Deploy the API" },
      { rowKey: "a1", text: "api, Api and APIs" },
      { rowKey: "a2", text: "nothing here" },
    ];
    assert.deepEqual(model.buildTranscriptFindMatches(entries, "  API "), [
      { rowKey: "u1", occurrence: 0 },
      { rowKey: "a1", occurrence: 0 },
      { rowKey: "a1", occurrence: 1 },
      { rowKey: "a1", occurrence: 2 },
    ]);
    assert.deepEqual(model.buildTranscriptFindMatches(entries, "   "), []);
    assert.deepEqual(model.findOccurrenceOffsets("aaaa", "aa"), [0, 2], "matches never overlap");

    assert.equal(
      model.stripMarkdownForFind("## Title\nSee [the docs](https://x.test/api) and **bold** `code`"),
      "Title\nSee the docs and bold code",
    );
    assert.equal(model.stripMarkdownForFind("snake_case_name"), "snake_case_name");

    assert.equal(model.stepTranscriptFindIndex(0, 3, 1), 1);
    assert.equal(model.stepTranscriptFindIndex(2, 3, 1), 0, "next wraps to the first match");
    assert.equal(model.stepTranscriptFindIndex(0, 3, -1), 2, "previous wraps to the last match");
    assert.equal(model.stepTranscriptFindIndex(-1, 3, -1), 2);
    assert.equal(model.stepTranscriptFindIndex(0, 0, 1), -1);
  } finally {
    env.cleanup();
  }
});

test("Cmd/Ctrl+F is routed to one transcript and never stolen from editors, terminals or other fields", async () => {
  const env = await createEnv();
  try {
    const { isTranscriptFindShortcut, shouldTranscriptHandleFindShortcut } = env.loadModule(
      "@liveagent/ui/lib/transcript-find/transcriptFind.ts",
    );
    const key = (overrides) => ({
      key: "f",
      code: "KeyF",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 70,
      ...overrides,
    });
    assert.equal(isTranscriptFindShortcut(key({ metaKey: true }), true), true);
    assert.equal(isTranscriptFindShortcut(key({ ctrlKey: true }), true), false, "macOS Ctrl+F is a caret binding");
    assert.equal(isTranscriptFindShortcut(key({ ctrlKey: true }), false), true);
    assert.equal(isTranscriptFindShortcut(key({ metaKey: true }), false), false);
    assert.equal(isTranscriptFindShortcut(key({ ctrlKey: true, shiftKey: true }), false), false);
    assert.equal(isTranscriptFindShortcut(key({ ctrlKey: true, isComposing: true }), false), false);

    document.body.innerHTML = `
      <div data-slot="sidebar-wrapper">
        <aside><button id="sidebar-row">Chat</button><input id="sidebar-rename" /></aside>
        <section data-workbench-pane="a" data-workbench-pane-focused="true">
          <div data-workbench-pane-id="a">
            <div id="root-a"><p id="text-a">hello</p><div class="monaco-editor"><textarea id="monaco"></textarea></div></div>
            <textarea id="composer-a"></textarea>
          </div>
        </section>
        <section data-workbench-pane="b">
          <div data-workbench-pane-id="b">
            <div id="root-b"><div class="xterm"><textarea id="xterm"></textarea></div></div>
            <textarea id="composer-b"></textarea>
          </div>
          <button id="chrome-b">close</button>
        </section>
      </div>
      <div id="settings"><input id="settings-field" /><button id="settings-button">x</button></div>
      <div role="dialog"><button id="dialog-button">ok</button></div>`;
    const $ = (id) => document.getElementById(id);
    const owners = (target) =>
      ["root-a", "root-b"].filter((root) => shouldTranscriptHandleFindShortcut(target, $(root)));

    assert.deepEqual(owners(document.body), ["root-a"], "nothing focused: the focused pane owns it");
    assert.deepEqual(owners($("composer-a")), ["root-a"], "the pane's own composer may open find");
    assert.deepEqual(owners($("composer-b")), ["root-b"], "a press inside a pane belongs to that pane");
    assert.deepEqual(owners($("text-a")), ["root-a"]);
    assert.deepEqual(owners($("chrome-b")), ["root-b"], "pane chrome routes to its own pane");
    assert.deepEqual(owners($("monaco")), [], "Monaco keeps its own find widget");
    assert.deepEqual(owners($("xterm")), [], "xterm keeps Cmd/Ctrl+F");
    assert.deepEqual(owners($("sidebar-rename")), [], "other text fields keep the key");
    assert.deepEqual(owners($("settings-field")), []);
    assert.deepEqual(owners($("settings-button")), [], "overlays outside the chat shell keep it");
    assert.deepEqual(owners($("dialog-button")), []);
    assert.deepEqual(owners($("sidebar-row")), ["root-a"], "a focused sidebar row routes to the focused pane");
  } finally {
    env.cleanup();
  }
});

test("DOM ranges span inline formatting and skip row chrome", async () => {
  const env = await createEnv();
  try {
    const { findTextRangesInElement, findTranscriptRowElement } = env.loadModule(
      "@liveagent/ui/lib/transcript-find/transcriptFindDom.ts",
    );
    document.body.innerHTML = `
      <div data-row-key="r1">
        <p>Hello <strong>Wor</strong>ld and world</p>
        <button>world</button>
        <span aria-hidden="true">world</span>
      </div>`;
    const row = findTranscriptRowElement(document, "r1");
    assert.ok(row);
    const ranges = findTextRangesInElement(row, "WORLD");
    assert.deepEqual(
      ranges.map((range) => range.toString()),
      ["World", "world"],
    );
    assert.equal(findTranscriptRowElement(document, "missing"), null);
    assert.deepEqual(findTextRangesInElement(row, " "), []);
  } finally {
    env.cleanup();
  }
});

test("desktop row model exposes message text only", async () => {
  const env = await createEnv();
  try {
    const { buildTranscriptFindEntries } = env.loadModule(
      "src/pages/chat/transcript/transcriptFindEntries.ts",
    );
    const textUnit = (text) => ({ kind: "block", block: { kind: "text", key: "b", text } });
    const entries = buildTranscriptFindEntries([
      { kind: "user", key: "u1", item: { text: "Find me" } },
      { kind: "assistant-unit", key: "a1", unit: textUnit("Use **bold** [link](https://x.test)") },
      { kind: "assistant-unit", key: "a2", unit: { kind: "block", block: { kind: "thinking", text: "hidden" } } },
      { kind: "assistant-unit", key: "a3", unit: { kind: "work-trace", entries: [] } },
      {
        kind: "assistant-activity",
        key: "live",
        units: [{ unit: textUnit("first") }, { unit: { kind: "placeholder" } }, { unit: textUnit("second") }],
      },
      { kind: "summary", key: "s1", item: { content: "checkpoint" } },
    ]);
    assert.deepEqual(entries, [
      { rowKey: "u1", text: "Find me" },
      { rowKey: "a1", text: "Use bold link" },
      { rowKey: "live", text: "first\n\nsecond" },
    ]);
  } finally {
    env.cleanup();
  }
});

test("find bar counts, navigates off-screen rows, highlights and closes", async () => {
  const env = await createEnv();
  const { React, act, createRoot } = env;
  const painted = new Map();
  globalThis.CSS = {
    highlights: {
      set: (name, highlight) => painted.set(name, highlight),
      delete: (name) => painted.delete(name),
    },
  };
  globalThis.Highlight = class {
    constructor(...ranges) {
      this.ranges = ranges;
    }
  };
  const { useTranscriptFind } = env.loadModule(
    "@liveagent/ui/lib/transcript-find/useTranscriptFind.ts",
  );
  const { createTranscriptFindSource } = env.loadModule(
    "@liveagent/ui/lib/transcript-find/transcriptFindSource.ts",
  );
  const { TranscriptFindBar } = env.loadModule("@liveagent/ui/components/chat/TranscriptFindBar.tsx");

  const rows = [
    { key: "r1", text: "Alpha one" },
    { key: "r2", text: "nothing" },
    { key: "r3", text: "alpha and ALPHA" },
  ];
  const source = createTranscriptFindSource();
  source.publish(() => rows.map((row) => ({ rowKey: row.key, text: row.text })));
  const jumps = [];
  let breaks = 0;

  function Harness() {
    const [root, setRoot] = React.useState(null);
    const [viewport, setViewport] = React.useState(null);
    // Virtualization stand-in: r3 is not mounted until the list jumps to it.
    const [mounted, setMounted] = React.useState(["r1", "r2"]);
    const find = useTranscriptFind({
      root,
      scrollViewport: viewport,
      source,
      scrollToRowKey: (rowKey) => {
        jumps.push(rowKey);
        setMounted((keys) => (keys.includes(rowKey) ? keys : [...keys, rowKey]));
      },
      breakFollow: () => {
        breaks += 1;
      },
      isMac: false,
    });
    return React.createElement(
      "div",
      { ref: setRoot },
      React.createElement(
        "div",
        { ref: setViewport },
        rows
          .filter((row) => mounted.includes(row.key))
          .map((row) =>
            React.createElement("div", { key: row.key, "data-row-key": row.key }, row.text),
          ),
      ),
      React.createElement("textarea", { id: "composer" }),
      React.createElement("div", { className: "monaco-editor" }, React.createElement("textarea", { id: "monaco" })),
      React.createElement(TranscriptFindBar, { find }),
    );
  }

  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const input = () => document.querySelector("[data-transcript-find] input");
  const status = () => document.querySelector("[data-transcript-find-status]")?.textContent;
  const press = (target, init) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });
  const type = (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const activeText = () => painted.get("transcript-find-active")?.ranges[0]?.toString();
  const activeRow = () =>
    painted.get("transcript-find-active")?.ranges[0]?.startContainer.parentElement?.dataset.rowKey;

  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(input(), null);

    await press(document.getElementById("monaco"), { key: "f", code: "KeyF", ctrlKey: true });
    assert.equal(input(), null, "Ctrl+F inside Monaco is left alone");

    const composer = document.getElementById("composer");
    composer.focus();
    const shortcut = new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => composer.dispatchEvent(shortcut));
    assert.ok(input(), "Ctrl+F opens the find bar");
    assert.equal(shortcut.defaultPrevented, true);
    assert.equal(document.activeElement, input(), "the find input takes focus");

    await type("ALPHA");
    await act(() => frames());
    // Nothing is laid out in jsdom, so no match counts as on screen and the
    // newest match (bottom of the transcript) becomes active.
    assert.equal(status(), "3/3");
    assert.deepEqual(jumps, ["r3"], "an unmounted row is brought in through the virtual list");
    assert.ok(breaks > 0, "bottom-follow is released before jumping");
    assert.equal(activeRow(), "r3");
    assert.equal(activeText(), "ALPHA", "the second occurrence inside r3 is the active one");
    assert.deepEqual(
      painted.get("transcript-find-match").ranges.map((range) => range.toString()),
      ["Alpha", "alpha"],
      "other mounted matches get the passive highlight",
    );

    await press(input(), { key: "Enter" });
    await act(() => frames(100));
    assert.equal(status(), "1/3", "Enter wraps to the first match");
    assert.equal(activeRow(), "r1");
    assert.deepEqual(jumps, ["r3"], "a mounted row is not re-jumped");

    await press(input(), { key: "Enter", shiftKey: true });
    await act(() => frames(100));
    assert.equal(status(), "3/3", "Shift+Enter goes back");
    await press(input(), { key: "Enter", shiftKey: true });
    await act(() => frames(100));
    assert.equal(status(), "2/3");
    assert.equal(activeText(), "alpha");

    await press(input(), { key: "Enter", isComposing: true });
    assert.equal(status(), "2/3", "confirming an IME composition does not navigate");

    await type("zzz");
    await act(() => frames(100));
    assert.equal(status(), "No results");
    assert.equal(painted.has("transcript-find-active"), false);

    await type("one");
    await act(() => frames());
    assert.equal(status(), "1/1");

    await press(input(), { key: "Escape" });
    assert.equal(input(), null, "Esc closes the bar");
    assert.equal(painted.size, 0, "closing clears the highlights");
    assert.equal(document.activeElement, composer, "focus returns to where it was");

    // Re-opening keeps the last query selected for a quick retype.
    await press(document.body, { key: "f", code: "KeyF", ctrlKey: true });
    assert.equal(input().value, "one");

    // Engines without the Highlight API still count and navigate.
    delete globalThis.CSS;
    delete globalThis.Highlight;
    painted.clear();
    await type("alpha");
    await act(() => frames());
    assert.equal(status(), "3/3");
    await press(input(), { key: "Enter" });
    await act(() => frames(100));
    assert.equal(status(), "1/3");
    assert.equal(painted.size, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete globalThis.CSS;
    delete globalThis.Highlight;
    env.cleanup();
  }
});
