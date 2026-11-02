import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 指令提示条：输入框内单行，语气图标 + 指令标签 + 文案 + 关闭；会话忙是可恢复的提醒，不是红色错误。

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
const { buildComposerCommands, parseComposerCommandDraft, runComposerCommand } = env.loadModule(
  "@liveagent/ui/lib/chat/composerCommands.ts",
);
const { ComposerCommandPanel } = env.loadModule("@liveagent/ui/components/chat/ComposerCommandPanel.tsx");

async function panelFor(sendError) {
  const panels = [];
  const host = { sendTurn: async () => { throw sendError; } };
  const commands = buildComposerCommands({
    host,
    catalog: [{ name: "deploy", kind: "prompt", source: "user", description: "Deploy" }],
    skills: [],
  });
  const parsed = parseComposerCommandDraft("/deploy staging", commands);
  await runComposerCommand(parsed, {
    host,
    t: (key) => key,
    consumeDraft: () => {},
    showPanel: (panel) => panels.push(panel),
  });
  return panels.at(-1);
}

test("a busy session is reported as a warning naming the command, without repeating it", async () => {
  assert.deepEqual(await panelFor(new Error("chat.commands.busy")), {
    type: "error",
    tone: "warning",
    command: "deploy",
    message: "chat.commands.busy",
  });
  assert.deepEqual(await panelFor(new Error("upstream exploded")), {
    type: "error",
    command: "deploy",
    message: "upstream exploded",
  });
});

function render(panel) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = env.createRoot(container);
  let closed = 0;
  env.act(() => {
    root.render(env.React.createElement(ComposerCommandPanel, { panel, onClose: () => { closed += 1; } }));
  });
  const section = container.querySelector("[data-composer-command-panel]");
  return { container, section, closed: () => closed, unmount: () => env.act(() => root.unmount()) };
}

test("an error notice is one strip: tone icon, command chip, message, close", () => {
  const view = render({ type: "error", tone: "warning", command: "goal", message: "A task is running" });
  const { section } = view;
  assert.equal(section.getAttribute("data-composer-command-panel"), "error");
  assert.equal(section.getAttribute("data-tone"), "warning");
  assert.equal(section.querySelector("svg")?.getAttribute("data-icon"), "Clock3");
  assert.equal(section.querySelector("code")?.textContent, "/goal");
  assert.ok(section.textContent.includes("A task is running"));
  // The heading ("command failed") lives only in the accessible name, not as a second line.
  assert.ok(!section.textContent.includes("chat.commands.failed"));
  assert.equal(section.getAttribute("aria-label"), "chat.commands.failed");
  env.act(() => section.querySelector("button").click());
  assert.equal(view.closed(), 1);
  view.unmount();
});

test("plain failures keep the error tone and notices stay neutral", () => {
  const failed = render({ type: "error", command: "goal", message: "boom" });
  assert.equal(failed.section.getAttribute("data-tone"), "error");
  assert.equal(failed.section.querySelector("svg")?.getAttribute("data-icon"), "AlertCircle");
  failed.unmount();
  const notice = render({ type: "notice", message: "Goal cleared" });
  assert.equal(notice.section.getAttribute("data-tone"), "info");
  assert.equal(notice.section.querySelector("svg")?.getAttribute("data-icon"), "Info");
  assert.equal(notice.section.querySelector("code"), null);
  notice.unmount();
});

const loop = (overrides = {}) => ({
  id: "lp1",
  interval: "10m",
  prompt: "Summarize new commits",
  enabled: true,
  ...overrides,
});

test("/loop results use the same strip: loop icon, /loop chip, no bordered card", () => {
  const created = render({ type: "loopCreated", loop: loop() });
  const { section } = created;
  assert.equal(section.getAttribute("data-tone"), "info");
  assert.equal(section.querySelector("svg")?.getAttribute("data-icon"), "Repeat");
  assert.equal(section.querySelector("code")?.textContent, "/loop");
  assert.ok(!section.className.includes("border"), section.className);
  assert.ok(section.textContent.includes("Summarize new commits"));
  const cancel = [...section.querySelectorAll("code")].map((node) => node.textContent);
  assert.ok(cancel.includes("/loop cancel lp1"), cancel.join(" | "));
  env.act(() => section.querySelector('button[aria-label="chat.commands.closePanel"]').click());
  assert.equal(created.closed(), 1);
  created.unmount();

  const list = render({
    type: "loops",
    loops: [loop(), loop({ id: "lp2", prompt: "Check CI", enabled: false })],
  });
  assert.equal(list.section.getAttribute("data-tone"), "info");
  assert.ok(!list.section.className.includes("border"), list.section.className);
  const rows = [...list.section.querySelectorAll("li")];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes("lp1") && rows[0].textContent.includes("Summarize new commits"));
  assert.ok(rows[1].querySelector(".line-through"), "disabled loops are struck through");
  list.unmount();

  const empty = render({ type: "loops", loops: [] });
  assert.ok(empty.section.textContent.includes("chat.commands.loopsEmpty"));
  assert.equal(empty.section.querySelectorAll("li").length, 0);
  empty.unmount();
});
