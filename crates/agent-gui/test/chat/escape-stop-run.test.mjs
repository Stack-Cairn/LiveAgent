import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const MARKUP = `
  <div data-slot="sidebar-wrapper">
    <aside><button id="sidebar-row">Chat</button></aside>
    <section data-workbench-pane="a" data-workbench-pane-focused="true">
      <div data-workbench-pane-id="a" id="scope-a">
        <div id="transcript-a">
          <p id="text-a">hello</p>
          <button id="copy-a">copy</button>
          <textarea id="inline-edit-a"></textarea>
        </div>
        <div id="layer-a">
          <div id="card-a"><div id="composer-a" role="textbox" contenteditable="true"></div></div>
        </div>
      </div>
    </section>
    <section data-workbench-pane="b">
      <div data-workbench-pane-id="b" id="scope-b">
        <div id="layer-b"><div id="card-b"><div id="composer-b" role="textbox" contenteditable="true"></div></div></div>
      </div>
    </section>
  </div>
  <div id="settings"><input id="settings-field" /></div>`;

function mountMarkup() {
  document.body.innerHTML = MARKUP;
  // jsdom has no layout: treat every scope as rendered.
  for (const scope of document.querySelectorAll("[data-workbench-pane-id]")) {
    scope.getClientRects = () => [{}];
  }
  return (id) => document.getElementById(id);
}

const esc = (target, overrides = {}) => ({
  key: "Escape",
  defaultPrevented: false,
  isComposing: false,
  keyCode: 27,
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target,
  ...overrides,
});

test("Esc stops only from its own conversation and yields to editors, IME and overlays", async () => {
  const env = await createDomTestEnv();
  try {
    const { shouldEscapeStopRun } = env.loadModule("@liveagent/ui/lib/chat/escapeStopRun.ts");
    const $ = mountMarkup();
    const ctxA = { scope: $("scope-a"), composerInput: $("card-a") };
    const ctxB = { scope: $("scope-b"), composerInput: $("card-b") };

    assert.equal(shouldEscapeStopRun(esc($("composer-a")), ctxA), true, "composer of the pane");
    assert.equal(shouldEscapeStopRun(esc($("text-a")), ctxA), true, "transcript content");
    assert.equal(shouldEscapeStopRun(esc($("copy-a")), ctxA), true, "transcript button");
    assert.equal(shouldEscapeStopRun(esc($("composer-a")), ctxB), false, "other pane keeps running");

    assert.equal(
      shouldEscapeStopRun(esc($("composer-a"), { isComposing: true }), ctxA),
      false,
      "IME composition owns Esc",
    );
    assert.equal(shouldEscapeStopRun(esc($("composer-a"), { keyCode: 229 }), ctxA), false);
    assert.equal(
      shouldEscapeStopRun(esc($("composer-a"), { defaultPrevented: true }), ctxA),
      false,
      "a popup or panel that consumed Esc wins",
    );
    assert.equal(shouldEscapeStopRun(esc($("composer-a"), { repeat: true }), ctxA), false);
    assert.equal(shouldEscapeStopRun(esc($("composer-a"), { shiftKey: true }), ctxA), false);
    assert.equal(shouldEscapeStopRun(esc($("composer-a"), { key: "Enter" }), ctxA), false);
    assert.equal(
      shouldEscapeStopRun(esc($("inline-edit-a")), ctxA),
      false,
      "inline editors cancel themselves",
    );
    assert.equal(shouldEscapeStopRun(esc($("sidebar-row")), ctxA), false);
    assert.equal(shouldEscapeStopRun(esc($("settings-field")), ctxA), false);

    assert.equal(shouldEscapeStopRun(esc(document.body), ctxA), true, "body focus: focused pane");
    assert.equal(shouldEscapeStopRun(esc(document.body), ctxB), false);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<button id="dialog-button">ok</button>`;
    $("scope-a").append(dialog);
    assert.equal(shouldEscapeStopRun(esc($("dialog-button")), ctxA), false, "dialogs keep Esc");
    assert.equal(
      shouldEscapeStopRun(esc(document.body), ctxA),
      false,
      "an open overlay blocks the body-focus path",
    );
    dialog.remove();

    $("scope-a").getClientRects = () => [];
    assert.equal(shouldEscapeStopRun(esc(document.body), ctxA), false, "hidden scope never stops");
  } finally {
    env.cleanup();
  }
});

test("useEscapeToStopRun stops once per press and only while enabled", async () => {
  const env = await createDomTestEnv();
  try {
    const { useEscapeToStopRun } = env.loadModule("@liveagent/ui/lib/chat/escapeStopRun.ts");
    const $ = mountMarkup();
    const { React, act, createRoot } = env;
    let stops = 0;
    const anchorRef = { current: $("layer-a") };
    const composerInputRef = { current: $("card-a") };
    function Probe({ enabled }) {
      useEscapeToStopRun({ enabled, onStop: () => stops++, anchorRef, composerInputRef });
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const press = (target, init = {}) => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    };

    await act(async () => root.render(React.createElement(Probe, { enabled: true })));
    const event = press($("composer-a"));
    assert.equal(stops, 1);
    assert.equal(event.defaultPrevented, true, "the stop consumes the key");

    // A popup that handles Esc first (preventDefault) wins.
    const popupHandler = (e) => e.preventDefault();
    $("composer-a").addEventListener("keydown", popupHandler);
    press($("composer-a"));
    $("composer-a").removeEventListener("keydown", popupHandler);
    assert.equal(stops, 1);

    press($("composer-b"));
    assert.equal(stops, 1, "another pane's composer does not stop this run");

    await act(async () => root.render(React.createElement(Probe, { enabled: false })));
    press($("composer-a"));
    assert.equal(stops, 1, "disabled (idle or approval pending) does nothing");

    await act(async () => root.unmount());
  } finally {
    env.cleanup();
  }
});
