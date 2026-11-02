import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 对抗复审：指令名来自用户模板，长度不受限（字符集 [A-Za-z0-9_:-]，允许 "目录:名称" 命名空间）。
// 提示条里的指令标签若是 shrink-0 且没有宽度上限，窄屏下会把文案挤到 0 宽、把关闭按钮推出提示条。
// 实测（无头 Edge，真实构建 CSS，GUI 与 WebUI 两个宿主）：
//   "/release-notes:generate-weekly-summary-for-all-repos" 在 390 宽时关闭按钮越出提示条 51px、
//   文案宽 0 被逐字竖排成 49 行；320 宽时越出 121px。约 28 个字符的指令名在 320 宽就会把文案挤到约 15px。
// jsdom 不做布局，这里锁定可布局性约束：标签要么可收缩并截断（带 max-w/truncate），要么允许换行。

const markerIcon = (name) => () => globalThis.React.createElement("svg", { "data-icon": name });
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      { get: (_target, name) => (name === "__esModule" ? true : markerIcon(String(name))) },
    ),
  },
});
globalThis.React = env.React;
const { ComposerCommandPanel } = env.loadModule("@liveagent/ui/components/chat/ComposerCommandPanel.tsx");

test("a long command name chip cannot starve the message or push the close button out", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = env.createRoot(container);
  const command = "release-notes:generate-weekly-summary-for-all-repos";
  env.act(() => {
    root.render(
      env.React.createElement(ComposerCommandPanel, {
        panel: { type: "error", tone: "warning", command, message: "A task is running" },
        onClose: () => {},
      }),
    );
  });
  const chip = container.querySelector("[data-composer-command-panel] code");
  assert.ok(chip, "command chip rendered");
  const classes = new Set(chip.className.split(/\s+/));
  const boundedAndTruncated =
    [...classes].some((c) => /^max-w-/.test(c)) && (classes.has("truncate") || classes.has("text-ellipsis"));
  const canWrap = !classes.has("shrink-0") && (classes.has("break-all") || classes.has("break-words"));
  assert.ok(
    boundedAndTruncated || canWrap,
    `chip classes "${chip.className}" keep a ${command.length + 1}-char name at full width (shrink-0, no max width, no wrap)`,
  );
  // 截断时完整指令名仍要能看到（title 或可见文本）。
  if (boundedAndTruncated) assert.equal(chip.getAttribute("title"), `/${command}`);
  env.act(() => root.unmount());
});
