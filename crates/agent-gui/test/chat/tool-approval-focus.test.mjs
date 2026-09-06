import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ToolApprovalBar.tsx", import.meta.url),
  "utf8",
);

test("the approval bar yields focus only to an editable element that is still rendered", () => {
  // 审批栏出现时输入卡片被 hidden 隐藏，但提交时刻 document.activeElement
  // 仍指向那个 textarea（浏览器的 focus fixup 晚于 React 提交）。守卫若只看
  // 标签名，发送后紧接着到来的审批就抓不到焦点，Enter/Escape 快捷键失效。
  // 只有仍在渲染的可编辑元素（侧栏重命名、新建分组草稿）才值得让路。
  assert.match(source, /const activeIsEditable =/);
  assert.match(source, /activeIsEditable && active\.getClientRects\(\)\.length > 0/);
  assert.match(source, /panelRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
});
