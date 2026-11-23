import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// jsdom has no layout: treat every element as rendered.
function stubLayout(env) {
  env.dom.window.HTMLElement.prototype.getClientRects = () => [{}];
  env.dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  env.dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
}

const settle = (env) =>
  env.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

function press(env, target, key, init = {}) {
  return env.act(async () => {
    target.dispatchEvent(
      new env.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

async function renderRovingSidebar(env) {
  const { useSidebarRovingFocus } = env.loadModule(
    "@liveagent/ui/lib/sidebar/useSidebarRovingFocus.ts",
  );
  const h = env.React.createElement;
  const menuClicks = [];
  const row = (id, current = false) =>
    h(
      "div",
      { key: id, className: "chat-history-row", "data-conversation-id": id },
      h(
        "button",
        { id: `title-${id}`, "data-sidebar": "menu-button", "aria-current": current ? "page" : undefined },
        id,
      ),
      h("button", { id: `pin-${id}`, "data-sidebar": "menu-action" }, "Pin"),
      h(
        "button",
        { id: `more-${id}`, "aria-haspopup": "menu", onClick: () => menuClicks.push(id) },
        "More",
      ),
    );
  function Harness() {
    const roving = useSidebarRovingFocus("Arrow keys move between conversations");
    return h(
      "div",
      roving,
      h("button", { id: "new-chat" }, "New conversation"),
      h(
        "div",
        { role: "group", "data-sidebar-reorder-key": "project:demo" },
        h("button", { id: "title-project", "data-sidebar": "menu-button" }, "demo"),
        h("input", { id: "rename-project", "aria-label": "Rename" }),
      ),
      row("a"),
      row("b", true),
      row("c"),
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  await env.act(async () => root.render(h(Harness)));
  await settle(env);
  return { root, menuClicks, $: (id) => document.getElementById(id) };
}

test("sidebar rows form one Tab stop with roving arrow-key focus", async () => {
  const env = await createDomTestEnv();
  try {
    stubLayout(env);
    const { root, menuClicks, $ } = await renderRovingSidebar(env);
    const stops = () =>
      [...document.querySelectorAll('[data-sidebar="menu-button"]')]
        .filter((element) => element.getAttribute("tabindex") === "0")
        .map((element) => element.id);

    // The open conversation holds the single stop; every row action is out of the Tab order.
    assert.deepEqual(stops(), ["title-b"]);
    for (const id of ["pin-a", "more-a", "pin-b", "more-b", "pin-c", "more-c"]) {
      assert.equal($(id).getAttribute("tabindex"), "-1", id);
    }
    assert.equal($("new-chat").hasAttribute("tabindex"), false, "non-row controls are untouched");
    assert.equal($("rename-project").hasAttribute("tabindex"), false, "inputs keep their Tab stop");
    assert.match($("title-b").getAttribute("aria-keyshortcuts"), /ArrowDown.*ArrowRight.*Shift\+F10/);
    assert.equal($("title-b").getAttribute("aria-description"), "Arrow keys move between conversations");

    $("title-b").focus();
    await press(env, $("title-b"), "ArrowDown");
    assert.equal(document.activeElement, $("title-c"));
    assert.deepEqual(stops(), ["title-c"], "the stop follows focus");
    await press(env, $("title-c"), "ArrowDown");
    assert.equal(document.activeElement, $("title-c"), "no wrap past the last row");
    await press(env, $("title-c"), "Home");
    assert.equal(document.activeElement, $("title-project"), "project rows take part");
    await press(env, $("title-project"), "End");
    assert.equal(document.activeElement, $("title-c"));
    await press(env, $("title-c"), "ArrowUp");
    assert.equal(document.activeElement, $("title-b"));

    // Right walks into the row actions, Left/Escape walk back out.
    await press(env, $("title-b"), "ArrowRight");
    assert.equal(document.activeElement, $("pin-b"));
    await press(env, $("pin-b"), "ArrowRight");
    assert.equal(document.activeElement, $("more-b"));
    await press(env, $("more-b"), "ArrowLeft");
    assert.equal(document.activeElement, $("pin-b"));
    await press(env, $("pin-b"), "Escape");
    assert.equal(document.activeElement, $("title-b"));

    // Shift+F10 and the context-menu key open the row's menu.
    await press(env, $("title-b"), "F10", { shiftKey: true });
    await press(env, $("title-a"), "ContextMenu");
    assert.deepEqual(menuClicks, ["b", "a"]);

    // Typing in the rename field never moves focus between rows.
    $("rename-project").focus();
    await press(env, $("rename-project"), "ArrowDown");
    assert.equal(document.activeElement, $("rename-project"));

    await env.act(async () => root.unmount());
  } finally {
    env.cleanup();
  }
});

test("a row's own key handler can claim a key before the roving handler", async () => {
  const env = await createDomTestEnv();
  try {
    stubLayout(env);
    const { useSidebarRovingFocus } = env.loadModule(
      "@liveagent/ui/lib/sidebar/useSidebarRovingFocus.ts",
    );
    const h = env.React.createElement;
    const opened = [];
    function Harness() {
      const roving = useSidebarRovingFocus("hint");
      return h(
        "div",
        roving,
        ["a", "b"].map((id) =>
          h(
            "div",
            { key: id, className: "chat-history-row" },
            h(
              "button",
              {
                id: `title-${id}`,
                "data-sidebar": "menu-button",
                onKeyDown: (event) => {
                  if (event.key === "ContextMenu") {
                    event.preventDefault();
                    opened.push(id);
                  }
                },
              },
              id,
            ),
            h("button", { "aria-haspopup": "menu", onClick: () => opened.push(`menu-${id}`) }, "More"),
          ),
        ),
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = env.createRoot(host);
    await env.act(async () => root.render(h(Harness)));
    await settle(env);
    const title = document.getElementById("title-a");
    title.focus();
    await press(env, title, "ContextMenu");
    assert.deepEqual(opened, ["a"], "the row handler ran and the More button was not clicked");
    await env.act(async () => root.unmount());
  } finally {
    env.cleanup();
  }
});

test("the skip link is the first child of the sidebar wrapper and focuses the composer", async () => {
  const env = await createDomTestEnv();
  try {
    stubLayout(env);
    const { SidebarProvider, Sidebar } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
    const h = env.React.createElement;
    const host = document.createElement("div");
    document.body.append(host);
    const root = env.createRoot(host);
    await env.act(async () =>
      root.render(
        h(
          SidebarProvider,
          null,
          h(Sidebar, { collapsible: "none" }, h("button", { id: "row" }, "Row")),
          h(
            "div",
            { "data-testid": "chat-composer" },
            h("div", { id: "editor", role: "textbox", contentEditable: "true", tabIndex: 0 }),
          ),
        ),
      ),
    );
    await settle(env);

    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
    const tabbables = [...wrapper.querySelectorAll("button, [tabindex]")];
    const skip = tabbables[0];
    assert.equal(skip.dataset.slot, "skip-to-composer", "first Tab stop");
    assert.equal(skip.textContent, "跳到输入框");
    assert.match(skip.className, /\bsr-only\b/, "visually hidden until focused");
    assert.match(skip.className, /focus-visible:fixed/);
    assert.match(skip.className, /focus-visible:\[clip-path:none\]/);

    await env.act(async () => skip.click());
    assert.equal(document.activeElement, document.getElementById("editor"));
    await env.act(async () => root.unmount());
  } finally {
    env.cleanup();
  }
});

test("focusChatComposer reports when no composer is on screen", async () => {
  const env = await createDomTestEnv();
  try {
    const { focusChatComposer } = env.loadModule("@liveagent/ui/components/ui/skip-link.tsx");
    document.body.innerHTML = `<div data-testid="chat-composer"><div role="textbox" contenteditable="false"></div></div>`;
    assert.equal(focusChatComposer(), false, "a disabled editor is not a target");
    document.body.innerHTML = `<div data-testid="chat-composer"><div id="e" role="textbox" contenteditable="true" tabindex="0"></div></div>`;
    assert.equal(focusChatComposer(), true);
    assert.equal(document.activeElement?.id, "e");
  } finally {
    env.cleanup();
  }
});

test("a toggle group's Tab stop starts on the pressed item, not the first one", async () => {
  const env = await createDomTestEnv();
  try {
    stubLayout(env);
    const { ToggleGroup, ToggleGroupItem } = env.loadModule(
      "@liveagent/ui/components/ui/toggle-group.tsx",
    );
    const h = env.React.createElement;
    const host = document.createElement("div");
    document.body.append(host);
    const root = env.createRoot(host);
    await env.act(async () =>
      root.render(
        h(
          ToggleGroup,
          { value: ["en-US"], "aria-label": "Language" },
          h(ToggleGroupItem, { value: "zh-CN", id: "zh" }, "简体中文"),
          h(ToggleGroupItem, { value: "en-US", id: "en" }, "English"),
        ),
      ),
    );
    await settle(env);
    assert.equal(document.getElementById("en").getAttribute("aria-pressed"), "true");
    assert.equal(document.getElementById("en").tabIndex, 0, "pressed item holds the stop");
    assert.equal(document.getElementById("zh").tabIndex, -1);
    await env.act(async () => root.unmount());
  } finally {
    env.cleanup();
  }
});

test("the settings overlay is a modal dialog over an inert background", async () => {
  const env = await createDomTestEnv();
  try {
    const { applySettingsOverlayModal } = env.loadModule(
      "@liveagent/ui/lib/settings/useSettingsOverlayModal.ts",
    );
    document.body.innerHTML = `
      <div id="shell">
        <div id="chat"><button id="open-settings">Settings</button></div>
        <div id="already-inert" inert></div>
        <div id="overlay"><button id="back">Back</button></div>
      </div>`;
    const $ = (id) => document.getElementById(id);
    $("open-settings").focus();

    const close = applySettingsOverlayModal($("overlay"), "Settings");
    assert.equal($("overlay").getAttribute("role"), "dialog");
    assert.equal($("overlay").getAttribute("aria-modal"), "true");
    assert.equal($("overlay").getAttribute("aria-label"), "Settings");
    assert.equal($("chat").hasAttribute("inert"), true, "the chat behind is inert");
    assert.equal(document.activeElement, $("overlay"), "focus moves into the dialog");

    $("back").focus();
    close();
    assert.equal($("chat").hasAttribute("inert"), false);
    assert.equal($("already-inert").hasAttribute("inert"), true, "foreign inert state is kept");
    assert.equal(document.activeElement, $("open-settings"), "focus returns to the opener");
  } finally {
    env.cleanup();
  }
});
