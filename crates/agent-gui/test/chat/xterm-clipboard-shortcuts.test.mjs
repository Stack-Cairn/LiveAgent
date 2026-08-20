import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归护栏:#355 — 终端选中内容后,Ctrl+Shift+C（Linux/Windows）和
// Cmd+C（macOS）必须把 selection 写入剪贴板,而不是被 xterm 当成
// Ctrl+C 中断信号透传给 PTY。同理 Cmd+V / Ctrl+Shift+V 走剪贴板读取。

const source = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/XTermViewport.tsx", import.meta.url),
  "utf8",
);

test("XTermViewport wires attachCustomKeyEventHandler for copy/paste", () => {
  assert.match(
    source,
    /term\.attachCustomKeyEventHandler\(/,
    "xterm 不会自动拦截复制/粘贴快捷键,需要显式挂自定义键盘处理",
  );
});

test("Ctrl+Shift+C and Cmd+C both route selection to the clipboard", () => {
  // 必须出现 term.getSelection() + writeTextToClipboard 的组合,
  // 同时识别 ctrl+shift 和 meta（macOS 的 Cmd）两种修饰键组合。
  assert.match(
    source,
    /term\.getSelection\(\)/,
    "xterm 的 selection API 必须用于读取选中内容",
  );
  assert.match(
    source,
    /writeTextToClipboard\(selection\)/,
    "Ctrl+Shift+C / Cmd+C 命中后必须把 selection 写入剪贴板",
  );
  assert.match(
    source,
    /event\.ctrlKey\s*&&\s*event\.shiftKey/,
    "Ctrl+Shift 修饰键分支必须存在,否则 Linux/Windows 用户无路可走",
  );
  assert.match(
    source,
    /event\.metaKey/,
    "Cmd 修饰键分支必须存在,否则 macOS 用户无路可走",
  );
});

test("Ctrl+Shift+V and Cmd+V both read from the clipboard", () => {
  assert.match(
    source,
    /clipboard\.readText/,
    "粘贴必须从剪贴板读取文本,而不是依赖 PTY 的 bracketed paste 事件",
  );
  assert.match(
    source,
    /term\.paste\(/,
    "剪贴板文本必须通过 term.paste 注入,确保 bracketed paste 包裹正确",
  );
});