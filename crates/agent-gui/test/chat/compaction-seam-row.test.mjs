import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const EmptyIcon = () => null;

const T = {
  "chat.contextCheckpoint.title": "上下文检查点",
  "chat.contextCheckpoint.seam": "已压缩上下文，继续处理",
  "chat.contextCheckpoint.messageCount": "{count} 条消息",
  "chat.contextCheckpoint.tokensAfter": "压缩后 {tokens}",
  "chat.work.running": "处理中",
  "chat.work.activity": "已处理",
  "chat.thinking": "思考中",
  "chat.thoughtFor": "思考了",
  "chat.thinkingProcess": "思考过程",
};

const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/Markdown": {
      Markdown: ({ content }) => env.React.createElement("div", { "data-md": "" }, content),
    },
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({ locale: "zh-CN", t: (key) => T[key] ?? key }),
    },
    "@liveagent/ui/lib/shared/utils": {
      cn: (...values) => values.filter(Boolean).join(" "),
    },
    "../../lib/shared/utils": {
      cn: (...values) => values.filter(Boolean).join(" "),
    },
    "../../IconSet": new Proxy({}, { get: () => EmptyIcon }),
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => EmptyIcon }),
  },
});
const { React, act, createRoot } = env;

const { CompactionSeamRow } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/CompactionSeamRow.tsx",
);
const { AssistantTurnContent } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/RoundContent.tsx",
);
const { createCompactionSeamRound } = env.loadModule("@liveagent/ui/lib/chat/replyContinuity.ts");

function click(element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const seam = {
  key: "summary-seg-1",
  summaryId: "sum-1",
  content: "## 摘要\n之前完成了前 3 项任务。",
  coveredMessageCount: 94,
  generatedBy: { providerId: "deepseek", model: "deepseek-v4-flash" },
  contextUsageTokens: 18_400,
};

test("the seam row reads as one collapsed milestone and expands to the summary", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(CompactionSeamRow, { seam }));
  });

  const row = container.querySelector("[data-compaction-seam]");
  assert.ok(row);
  assert.equal(row.dataset.summaryId, "sum-1");
  const button = row.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.match(button.textContent, /已压缩上下文，继续处理/);
  assert.match(button.textContent, /94 条消息/);
  assert.match(button.textContent, /压缩后 18\.4K/);
  assert.equal(container.querySelector("[data-md]"), null, "summary body stays unmounted");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.match(container.querySelector("[data-md]").textContent, /前 3 项任务/);
  assert.match(container.textContent, /deepseek · deepseek-v4-flash/);

  act(() => root.unmount());
});

test("a stitched reply renders one processing trace with the seam inline and one answer", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const write = (id, path) => ({
    kind: "tool",
    item: {
      toolCall: { type: "toolCall", id, name: "Write", arguments: { path, content: "x\n" } },
      toolResult: { role: "toolResult", toolCallId: id, isError: false, content: [], details: { path } },
    },
  });
  const rounds = [
    { round: 1, key: "r1", blocks: [write("w1", "a.ts")], meta: { stopReason: "toolUse" } },
    createCompactionSeamRound(seam),
    { round: 1, key: "p1:r1", blocks: [write("w2", "b.ts")], meta: { stopReason: "toolUse" } },
    {
      round: 2,
      key: "p1:r2",
      blocks: [{ kind: "text", id: "text-1", text: "第 3 轮测试已全部完成。" }],
      meta: { stopReason: "stop" },
    },
  ];

  act(() => {
    root.render(
      React.createElement(AssistantTurnContent, {
        rounds,
        isLive: false,
        isStreaming: false,
        renderMode: "static",
      }),
    );
  });

  const traces = container.querySelectorAll("[data-chat-work-trace]");
  assert.equal(traces.length, 1, "exactly one processing section for the whole reply");
  assert.match(container.textContent, /第 3 轮测试已全部完成/);

  // A settled reply with an answer starts with its trace folded; the seam
  // lives inside that fold, never as a standalone card outside it.
  assert.equal(container.querySelectorAll("[data-compaction-seam]").length, 0);
  const traceToggle = traces[0].querySelector("button");
  assert.equal(traceToggle.getAttribute("aria-expanded"), "false");
  click(traceToggle);

  const seams = container.querySelectorAll("[data-compaction-seam]");
  assert.equal(seams.length, 1, "the checkpoint renders inside the trace as a seam");
  assert.ok(traces[0].contains(seams[0]));
  const operations = traces[0].querySelectorAll("[data-assistant-operation]");
  assert.equal(operations.length, 3, "edit batch → seam → edit batch, in order");
  assert.ok(operations[1].contains(seams[0]));
  const seamButton = seams[0].querySelector("button");
  assert.equal(seamButton.getAttribute("aria-expanded"), "false");

  act(() => root.unmount());
});
