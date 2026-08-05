import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const guard = loader.loadModule("src/lib/system/webviewNavigationGuard.ts");

const PROD = { isMac: false, allowReloadChords: false };
const PROD_MAC = { isMac: true, allowReloadChords: false };
const DEV = { isMac: false, allowReloadChords: true };

function key(overrides) {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  };
}

test("刷新全家桶在生产配置下全部拦截", () => {
  const reloadChords = [
    key({ key: "F5", code: "F5" }),
    key({ key: "F5", code: "F5", ctrlKey: true }),
    key({ key: "F5", code: "F5", shiftKey: true }),
    key({ key: "F5", code: "F5", ctrlKey: true, shiftKey: true }),
    key({ key: "BrowserRefresh", code: "BrowserRefresh" }),
    key({ key: "r", code: "KeyR", ctrlKey: true }),
    key({ key: "R", code: "KeyR", ctrlKey: true, shiftKey: true }),
    key({ key: "r", code: "KeyR", metaKey: true }),
    // 西里尔布局：key 为本地字符，物理键位 code 仍是 KeyR。
    key({ key: "к", code: "KeyR", ctrlKey: true }),
  ];
  for (const event of reloadChords) {
    assert.equal(guard.shouldBlockBrowserKeyDefault(event, PROD), true, JSON.stringify(event));
    assert.equal(guard.shouldBlockBrowserKeyDefault(event, PROD_MAC), true, JSON.stringify(event));
  }
});

test("dev 配置放行刷新组合键，但仍拦其余浏览器加速键", () => {
  assert.equal(guard.shouldBlockBrowserKeyDefault(key({ key: "F5", code: "F5" }), DEV), false);
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "r", code: "KeyR", ctrlKey: true }), DEV),
    false,
  );
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "BrowserRefresh", code: "BrowserRefresh" }), DEV),
    false,
  );
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "p", code: "KeyP", ctrlKey: true }), DEV),
    true,
  );
});

test("Ctrl/Cmd 组合的打印、查找、保存、打开、查看源码被拦截", () => {
  for (const [k, code] of [
    ["p", "KeyP"],
    ["f", "KeyF"],
    ["s", "KeyS"],
    ["o", "KeyO"],
    ["u", "KeyU"],
  ]) {
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code, ctrlKey: true }), PROD),
      true,
      `Ctrl+${k}`,
    );
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code, metaKey: true }), PROD_MAC),
      true,
      `Cmd+${k}`,
    );
  }
});

test("F3/F7 与键盘导航媒体键被拦截", () => {
  for (const k of [
    "F3",
    "F7",
    "BrowserBack",
    "BrowserForward",
    "BrowserHome",
    "BrowserSearch",
    "BrowserFavorites",
    "BrowserStop",
  ]) {
    assert.equal(guard.shouldBlockBrowserKeyDefault(key({ key: k, code: k }), PROD), true, k);
  }
});

test("Alt+方向键历史导航只在非 mac 拦截（mac 上是分词移动光标）", () => {
  for (const k of ["ArrowLeft", "ArrowRight", "Home"]) {
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code: k, altKey: true }), PROD),
      true,
      `win/linux Alt+${k}`,
    );
    assert.equal(
      guard.shouldBlockBrowserKeyDefault(key({ key: k, code: k, altKey: true }), PROD_MAC),
      false,
      `mac Option+${k}`,
    );
  }
  // 不带 Alt 的方向键永不拦截。
  assert.equal(
    guard.shouldBlockBrowserKeyDefault(key({ key: "ArrowLeft", code: "ArrowLeft" }), PROD),
    false,
  );
});

test("常规输入与应用快捷键不受影响", () => {
  const passThrough = [
    key({ key: "a", code: "KeyA" }),
    key({ key: "a", code: "KeyA", ctrlKey: true }),
    key({ key: "c", code: "KeyC", ctrlKey: true }),
    key({ key: "v", code: "KeyV", ctrlKey: true }),
    key({ key: "z", code: "KeyZ", ctrlKey: true }),
    key({ key: "Enter", code: "Enter" }),
    key({ key: "F1", code: "F1" }),
    key({ key: "F12", code: "F12" }),
    // AltGr（Windows 报告为 ctrl+alt）打特殊字符，必须放行。
    key({ key: "ŕ", code: "KeyR", ctrlKey: true, altKey: true }),
    key({ key: "þ", code: "KeyP", ctrlKey: true, altKey: true }),
  ];
  for (const event of passThrough) {
    assert.equal(guard.shouldBlockBrowserKeyDefault(event, PROD), false, JSON.stringify(event));
  }
});

function createFakeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, listener, options) {
      listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener) {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, event) {
      for (const entry of [...listeners]) {
        if (entry.type === type) entry.listener(event);
      }
    },
  };
}

function fakeEvent(overrides) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    ...overrides,
  };
  return event;
}

test("安装器：keydown 捕获阶段拦截 F5，卸载后不再拦", () => {
  const win = createFakeWindow();
  const uninstall = guard.installWebviewNavigationGuard({ isMac: false }, win);

  const keydownEntry = win.listeners.find((entry) => entry.type === "keydown");
  assert.ok(keydownEntry, "keydown 已注册");
  assert.equal(keydownEntry.options?.capture, true, "keydown 走捕获阶段");

  const f5 = fakeEvent(key({ key: "F5", code: "F5" }));
  win.dispatch("keydown", f5);
  assert.equal(f5.defaultPrevented, true);

  uninstall();
  assert.equal(win.listeners.length, 0, "卸载后无残留监听器");
});

test("安装器：鼠标侧键前进/后退被取消，普通点击不受影响", () => {
  const win = createFakeWindow();
  const uninstall = guard.installWebviewNavigationGuard({ isMac: false }, win);

  const back = fakeEvent({ button: 3 });
  win.dispatch("mouseup", back);
  assert.equal(back.defaultPrevented, true);

  const forwardDown = fakeEvent({ button: 4 });
  win.dispatch("mousedown", forwardDown);
  assert.equal(forwardDown.defaultPrevented, true);

  const leftClick = fakeEvent({ button: 0 });
  win.dispatch("mouseup", leftClick);
  assert.equal(leftClick.defaultPrevented, false);

  uninstall();
});

test("安装器：页内拖放兜底取消导航，可编辑目标与已处理事件放行", () => {
  const win = createFakeWindow();
  const uninstall = guard.installWebviewNavigationGuard({ isMac: false }, win);

  // 未被任何组件处理的拖放：取消默认导航并标记不可放置。
  const dataTransfer = { dropEffect: "copy" };
  const dragOver = fakeEvent({ target: { tagName: "DIV" }, dataTransfer });
  win.dispatch("dragover", dragOver);
  assert.equal(dragOver.defaultPrevented, true);
  assert.equal(dataTransfer.dropEffect, "none");

  const drop = fakeEvent({ target: { tagName: "DIV" }, dataTransfer: null });
  win.dispatch("drop", drop);
  assert.equal(drop.defaultPrevented, true);

  // 拖进输入框/富文本是合法编辑操作。
  for (const target of [
    { tagName: "TEXTAREA" },
    { tagName: "INPUT" },
    { tagName: "DIV", isContentEditable: true },
  ]) {
    const editableDrop = fakeEvent({ target, dataTransfer: null });
    win.dispatch("drop", editableDrop);
    assert.equal(editableDrop.defaultPrevented, false, JSON.stringify(target));
  }

  // 组件已 preventDefault 的事件不再动它（dropEffect 保持组件设置的值）。
  const handledTransfer = { dropEffect: "move" };
  const handled = fakeEvent({ target: { tagName: "DIV" }, dataTransfer: handledTransfer });
  handled.preventDefault();
  win.dispatch("dragover", handled);
  assert.equal(handledTransfer.dropEffect, "move");

  uninstall();
});

test("安装器：漏接的表单提交被兜底取消；重复安装保持幂等", () => {
  const win = createFakeWindow();
  const first = guard.installWebviewNavigationGuard({ isMac: false }, win);

  const submit = fakeEvent({});
  win.dispatch("submit", submit);
  assert.equal(submit.defaultPrevented, true);

  const before = win.listeners.length;
  const second = guard.installWebviewNavigationGuard({ isMac: false }, win);
  assert.equal(win.listeners.length, before, "重复安装先卸载旧监听器");

  second();
  assert.equal(win.listeners.length, 0);
  // 旧的卸载函数再调用也不应报错或误删。
  first();
});
