import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const previousObserver = globalThis.ResizeObserver;
let disconnected = 0;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() { disconnected += 1; }
};
const { ShortcutKeyboard, SHORTCUT_KEYBOARD_TONES } = env.loadModule("src/pages/settings/ShortcutKeyboard.tsx");
const host = document.createElement("div");
document.body.append(host);
const root = env.createRoot(host);
const defaults = {
  layout: "87", recording: false, pressedCodes: new Set(), heldCodes: new Set(),
  decorForCode: () => undefined,
};
const render = async (props = {}) => env.act(async () => root.render(env.React.createElement(ShortcutKeyboard, { ...defaults, ...props })));
const key = (label) => [...host.querySelectorAll(".ghk-key")].find(el => el.querySelector(".ghk-klegend")?.textContent === label);

test("layout changes retain the main keyboard and selectively add navigation and numpad", async () => {
  await render({ layout: "61" });
  assert.ok(key("Q"));
  assert.equal(key("F1"), undefined);
  assert.equal(key("Home"), undefined);
  assert.equal(key("Num"), undefined);
  await render();
  assert.ok(key("F1"));
  assert.ok(key("Home"));
  assert.equal(key("Num"), undefined);
  await render({ layout: "104" });
  assert.ok(key("Num"));
  assert.equal(key("⏎").parentElement.style.gridRow, "span 2");
  assert.equal(key("⏎").style.height, "100%");
});

test("pressed state overrides held state without dropping binding labels or tooltip", async () => {
  const props = { heldCodes: new Set(["KeyN"]), decorForCode: code => code === "KeyN" ? { bound: { colorClass: SHORTCUT_KEYBOARD_TONES[0], tag: "New chat", title: "Ctrl + N" } } : undefined };
  await render(props);
  assert.ok(key("N").classList.contains("ghk-held"));
  await render({ ...props, pressedCodes: new Set(["KeyN"]) });
  assert.ok(key("N").classList.contains("ghk-down"));
  assert.equal(key("N").classList.contains("ghk-held"), false);
  assert.equal(key("N").title, "Ctrl + N");
  assert.equal(key("N").querySelector(".ghk-tag").textContent, "New chat");
  await render();
  assert.equal(key("N").querySelector(".ghk-tag"), null);
  assert.equal(key("N").classList.contains("ghk-down"), false);
});

test("recording and Enter press update independently; hints share palette classes", async () => {
  await render({ recording: true, pressedCodes: new Set(["Enter"]), decorForCode: code => code === "KeyQ" ? { hintDots: SHORTCUT_KEYBOARD_TONES.slice(0, 2), hintTitle: "Available combinations" } : undefined });
  assert.ok(host.querySelector(".ghk-board.ghk-rec"));
  assert.ok(host.querySelector(".ghk-enter.ghk-down"));
  assert.equal(key("Q").querySelectorAll(".ghk-dot").length, 2);
  assert.ok(key("Q").querySelector(".ghk-dot").classList.contains(SHORTCUT_KEYBOARD_TONES[0]));
});

test.after(async () => {
  await env.act(async () => root.unmount());
  assert.ok(disconnected > 0);
  if (previousObserver === undefined) delete globalThis.ResizeObserver;
  else globalThis.ResizeObserver = previousObserver;
  env.cleanup();
});
