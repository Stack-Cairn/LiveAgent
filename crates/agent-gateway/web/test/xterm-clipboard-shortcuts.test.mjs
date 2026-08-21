import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归护栏:#355 — gateway web 终端(Local/SSH Pane)复用 agent-ui 的
// XTermViewport,复制/粘贴快捷键的行为约束与 GUI 侧一致:Ctrl+Shift+C /
// Cmd+C 把 selection 写入剪贴板,Ctrl+Shift+V / Cmd+V 经 term.paste 注入,
// 命中分支必须 preventDefault(浏览器环境下原生 paste 事件真实存在,
// 不拦截会粘贴两遍),非安全上下文(http 直连)下兜底路径必须可达。

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

test("copy and paste shortcuts cover ctrl+shift and meta modifiers", () => {
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
  assert.match(
    source,
    /term\.paste\(/,
    "剪贴板文本必须通过 term.paste 注入,确保 bracketed paste 包裹正确",
  );
});

test("intercepted shortcuts call preventDefault to suppress native copy/paste", () => {
  // attachCustomKeyEventHandler 返回 false 只跳过 xterm 自身处理,不会取消
  // 浏览器默认行为:Chromium 的 Ctrl+Shift+V 与 macOS 的 Cmd+V 会另行派发
  // 原生 paste 事件(xterm 在 textarea 上有原生监听),不 preventDefault
  // 同一次按键会粘贴两遍。
  assert.match(
    source,
    /event\.preventDefault\(\)/,
    "命中复制/粘贴分支必须 preventDefault,否则原生 paste 事件导致双重粘贴",
  );
});

test("clipboard fallbacks stay reachable in insecure contexts", () => {
  // http 直连 gateway web 时 navigator.clipboard 整个不存在:复制必须落到
  // execCommand 兜底(而不是只挂在 writeText 的 catch 上),粘贴必须放行
  // 按键让原生 paste 事件路径兜底(而不是把按键吞掉)。
  assert.match(
    source,
    /fallbackCopyTextToClipboard\(text\)/,
    "clipboard API 缺失时复制必须走 execCommand 兜底",
  );
  assert.match(
    source,
    /if\s*\(!clipboard\?\.readText\)\s*return true;/,
    "readText 不可用时必须放行按键,让原生 paste 事件成为兜底粘贴通道",
  );
});
