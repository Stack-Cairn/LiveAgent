import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 对抗复审：/loop 创建结果把提示词拼进提示条头部且不截断。K-brain 对提示词没有长度上限，
// loopHint 还要求"提示词需包含完整上下文"，长提示词是常态。实测（真实 CSS、无头 Edge）
// 约 600 字的中文提示词在 390×844 下把提示条撑到 752px、在 320×640 下撑到 1200px，
// 关闭按钮（条顶）与输入框（条下）无法同屏，"停止：/loop cancel <id>" 被挤到最底部。
// 改造前提示词放在 truncate + title 的单行里。期望：提示词仍有行数上限，全文可悬停查看。

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "zh-CN", t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy(
      {},
      {
        get: (_target, name) =>
          name === "__esModule" ? true : () => env.React.createElement("svg", { "data-icon": String(name) }),
      },
    ),
  },
});
const modulePath =
  process.env.COMMAND_NOTICE_PANEL_MODULE ?? "@liveagent/ui/components/chat/ComposerCommandPanel.tsx";
const { ComposerCommandPanel } = env.loadModule(modulePath);

const CLAMP = /(^|\s)(truncate|line-clamp-\d+)(\s|$)/;
const longPrompt =
  "请检查仓库 Stack-Cairn/LiveAgent 在 v2-kbrian 分支上的最新提交，列出新增的提交、作者和改动文件，对比上一次检查的结果，标出新出现的 CI 失败、被回滚的提交和改动了共享组件的提交；如果有 PR 等待评审超过 24 小时，单独列出并附链接；最后用三句话总结今天的进展和风险。".repeat(
    4,
  );

test("a long /loop prompt is clamped in the created strip, with the full text on hover", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = env.createRoot(container);
  env.act(() => {
    root.render(
      env.React.createElement(ComposerCommandPanel, {
        panel: {
          type: "loopCreated",
          loop: { id: "loop-a1b2c3", interval: "10m", prompt: longPrompt, enabled: true },
        },
        onClose() {},
      }),
    );
  });
  const section = container.querySelector("[data-composer-command-panel]");
  // 最内层包含提示词全文的元素，以及它到提示条之间的祖先链。
  const holder = [...section.querySelectorAll("*")]
    .filter((node) => node.textContent.includes(longPrompt))
    .at(-1);
  assert.ok(holder, "prompt is rendered");
  const chain = [];
  for (let node = holder; node && node !== section; node = node.parentElement) chain.push(node);
  const clamped = chain.find((node) => CLAMP.test(node.getAttribute("class") ?? ""));
  assert.ok(
    clamped,
    `prompt is rendered without a line limit; chain: ${chain.map((n) => `<${n.tagName.toLowerCase()} class="${n.getAttribute("class") ?? ""}">`).join(" < ")}`,
  );
  assert.equal(clamped.getAttribute("title"), longPrompt, "clamped prompt exposes the full text via title");
  // 取消方式仍然完整可见。
  assert.ok([...section.querySelectorAll("code")].some((n) => n.textContent === "/loop cancel loop-a1b2c3"));
  env.act(() => root.unmount());
  container.remove();
});
