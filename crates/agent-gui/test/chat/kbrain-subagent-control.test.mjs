import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// K-brain's subagent_followup / subagent_status / subagent_steer / subagent_cancel calls.
// A follow-up is its subagent's card; the other three are one concise row each, titled
// with what was done and to which subagent, with the result where a row shows status.

const loader = createTsModuleLoader();
const control = loader.loadModule("@liveagent/ui/lib/chat/subagentControlTools.ts");
const utils = loader.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);
const { summarizeKBrainToolLine } = loader.loadModule(
  "@liveagent/ui/lib/chat/kbrainToolSummaries.ts",
);
const store = loader.loadModule("src/lib/subagents/kbrainSubagentStore.ts");

const t = (key) => key;
const ok = (text) => ({ text, isError: false });
const describe = (name, args, result, options = {}) =>
  control.describeSubagentControlCall(
    { name, arguments: args },
    result,
    { running: false, ...options },
    t,
  );

test("every subagent control tool maps to its action; other tools do not", () => {
  assert.equal(control.subagentControlAction("subagent_status"), "status");
  assert.equal(control.subagentControlAction("subagent_steer"), "steer");
  assert.equal(control.subagentControlAction("subagent_cancel"), "cancel");
  assert.equal(control.subagentControlAction("subagent_followup"), "followup");
  assert.equal(control.subagentControlAction("subagent"), undefined);
  assert.equal(control.subagentControlAction("toString"), undefined);
  assert.equal(control.isSubagentControlRowToolName("subagent_followup"), false);
  assert.equal(control.isSubagentControlRowToolName("subagent_cancel"), true);
  assert.equal(control.subagentControlTargetId('{"id":" fix-login-1 "}'), "fix-login-1");
  assert.equal(control.subagentControlTargetId({}), "");
  assert.equal(control.subagentControlTargetId("not json"), "");

  for (const name of ["subagent_status", "subagent_steer", "subagent_cancel", "subagent_followup"]) {
    assert.equal(utils.getToolActivityCategory(name), "agent", name);
    assert.equal(utils.getToolMeta(name).category, "agent", name);
    assert.equal(summarizeKBrainToolLine(name, { id: "fix-login-1", message: "x" }), "fix-login-1");
  }
  // A follow-up stands alone like the call that started the subagent; the rows batch.
  assert.equal(utils.isAgentToolName("subagent_followup"), true);
  assert.equal(utils.isAgentToolName("subagent_status"), false);
});

test("subagent_status: one subagent's state, or a count of all of them", () => {
  const single = describe(
    "subagent_status",
    { id: "fix-login-1" },
    ok(
      JSON.stringify({
        id: "fix-login-1",
        description: "Fix login tests",
        status: "running",
        following_up: true,
        can_followup: false,
      }),
    ),
  );
  assert.equal(single.title, "chat.tool.subagent.status.completed");
  assert.equal(single.target, "Fix login tests");
  assert.equal(single.outcome.text, "chat.tool.running · chat.tool.subagent.result.followingUp");
  assert.equal(single.outcome.failed, false);

  const done = describe(
    "subagent_status",
    { id: "fix-login-1" },
    ok(JSON.stringify({ id: "fix-login-1", status: "done", report: "ok" })),
  );
  assert.equal(done.target, "fix-login-1");
  assert.equal(done.outcome.text, "chat.tool.success");

  const all = describe(
    "subagent_status",
    {},
    ok(
      JSON.stringify({
        tasks: [{ status: "running" }, { status: "done" }, { status: "running" }],
        total: 3,
        truncated: false,
      }),
    ),
  );
  assert.equal(all.target, "chat.tool.subagent.all");
  assert.equal(
    all.outcome.text,
    "chat.tool.subagent.result.count · chat.tool.subagent.result.running",
  );
  const running = describe("subagent_status", { id: "a-1" }, undefined, { running: true });
  assert.equal(running.title, "chat.tool.subagent.status.running");
  assert.equal(running.outcome, null);
  // Unknown ids come back as a tool error.
  const missing = describe("subagent_status", { id: "nope" }, {
    text: 'subagent "nope" not found',
    isError: true,
  });
  assert.equal(missing.title, "chat.tool.subagent.status.failed");
  assert.equal(missing.outcome.text, 'subagent "nope" not found');
  assert.equal(missing.outcome.failed, true);
});

test("subagent_steer: sent, or rejected as an Error: result", () => {
  const sent = describe(
    "subagent_steer",
    { id: "fix-login-1", message: "Also cover logout" },
    ok("Steered fix-login-1; it will see the message before its next model call."),
    { label: "Fix login tests" },
  );
  assert.equal(sent.title, "chat.tool.subagent.steer.completed");
  assert.equal(sent.target, "Fix login tests");
  assert.equal(sent.outcome.text, "chat.tool.subagent.result.steered");

  const rejected = describe(
    "subagent_steer",
    { id: "fix-login-1", message: "x" },
    ok("Error: subagent fix-login-1 is not running; use subagent_followup."),
  );
  assert.equal(rejected.title, "chat.tool.subagent.steer.failed");
  assert.equal(rejected.outcome.failed, true);
  assert.match(rejected.outcome.text, /^subagent fix-login-1 is not running/);
});

test("subagent_cancel: requested, or the subagent had already stopped", () => {
  const requested = describe(
    "subagent_cancel",
    { id: "fix-login-1" },
    ok("Cancellation requested; the subagent will stop shortly."),
  );
  assert.equal(requested.title, "chat.tool.subagent.cancel.completed");
  assert.equal(requested.outcome.text, "chat.tool.subagent.result.cancelRequested");

  const inactive = describe(
    "subagent_cancel",
    { id: "fix-login-1" },
    ok("Subagent is already inactive; nothing to cancel."),
  );
  assert.equal(inactive.title, "chat.tool.subagent.cancel.inactive");
  assert.equal(inactive.outcome.text, "chat.tool.subagent.result.inactive");
  assert.equal(inactive.outcome.failed, false);
});

test("subagent_followup: the row keeps the report, titled after the subagent", () => {
  const followup = describe(
    "subagent_followup",
    { id: "fix-login-1", message: "Now the signup tests" },
    ok("Signup tests fixed."),
  );
  assert.equal(followup.title, "chat.tool.subagent.followup.completed");
  assert.equal(followup.target, "fix-login-1");
  assert.equal(followup.outcome, null);
  const running = describe("subagent_followup", { id: "fix-login-1" }, undefined, { running: true });
  assert.equal(running.title, "chat.tool.subagent.followup.running");
});

// ---- store: control calls find the subagent they name ----

function fakeClient({ capabilities, list } = {}) {
  const calls = { list: 0, capabilities: 0 };
  return {
    calls,
    ...(capabilities
      ? {
          getCapabilities: async () => {
            calls.capabilities += 1;
            return capabilities();
          },
        }
      : {}),
    listSubagents: async () => {
      calls.list += 1;
      return list?.() ?? { subagents: [], last_seq: 0 };
    },
    getSubagentTranscript: async () => ({ messages: [] }),
    cancelSubagent: async () => {},
    subscribeSubagent: () => new Promise(() => {}),
  };
}

const subagent = (overrides = {}) => ({
  id: "fix-login-1",
  parent_id: "run-1",
  description: "Fix login tests",
  status: "done",
  parent_tool_call_id: "call-start",
  started_at: "2026-11-05T00:00:00Z",
  ...overrides,
});

test("follow-up and control calls link to the subagent they name", async () => {
  const client = fakeClient({ list: () => ({ subagents: [subagent()], last_seq: 4 }) });
  store.resetKBrainSubagentStore();
  store.configureKBrainSubagentStore({ client: () => client, resolveSession: () => "backend-1" });
  await store.loadKBrainSubagents("chat-1");
  assert.equal(store.getKBrainSubagentForToolCall("call-start").entry.subagent.id, "fix-login-1");

  let emitted = 0;
  const unsubscribe = store.subscribeKBrainSubagents(() => (emitted += 1));
  store.linkKBrainSubagentToolCalls("chat-1", [
    { id: "call-followup", name: "subagent_followup", arguments: { id: "fix-login-1" } },
    { id: "call-status", name: "subagent_status", arguments: '{"id":"fix-login-1"}' },
    { id: "call-list", name: "subagent_status", arguments: {} },
    { id: "call-read", name: "Read", arguments: { id: "fix-login-1" } },
  ]);
  assert.equal(emitted, 1);
  // Linking the same calls again (a history reload) changes nothing.
  store.linkKBrainSubagentToolCalls("chat-1", [
    { id: "call-followup", name: "subagent_followup", arguments: { id: "fix-login-1" } },
  ]);
  assert.equal(emitted, 1);
  unsubscribe();

  for (const id of ["call-followup", "call-status"]) {
    const linked = store.getKBrainSubagentForToolCall(id);
    assert.equal(linked.conversationId, "chat-1");
    assert.equal(linked.entry.subagent.description, "Fix login tests");
  }
  assert.equal(store.getKBrainSubagentForToolCall("call-list"), undefined);
  assert.equal(store.getKBrainSubagentForToolCall("call-read"), undefined);
  // An id the conversation never started resolves to nothing, so the row shows the id.
  store.linkKBrainSubagentToolCalls("chat-1", [
    { id: "call-other", name: "subagent_cancel", arguments: { id: "unknown-2" } },
  ]);
  assert.equal(store.getKBrainSubagentForToolCall("call-other"), undefined);

  store.forgetKBrainSubagents("chat-1");
  assert.equal(store.getKBrainSubagentForToolCall("call-followup"), undefined);
});

test("without the subagent_transcripts capability nothing is listed or linked", async () => {
  const client = fakeClient({
    capabilities: () => ({ session_archive: 1 }),
    list: () => ({ subagents: [subagent()], last_seq: 4 }),
  });
  store.resetKBrainSubagentStore();
  store.configureKBrainSubagentStore({ client: () => client, resolveSession: () => "backend-1" });
  await store.loadKBrainSubagents("chat-2");
  assert.equal(client.calls.list, 0);
  assert.equal(store.getKBrainConversationSubagents("chat-2").unsupported, true);
  store.linkKBrainSubagentToolCalls("chat-2", [
    { id: "call-f", name: "subagent_followup", arguments: { id: "fix-login-1" } },
  ]);
  assert.equal(store.getKBrainSubagentForToolCall("call-f"), undefined);

  // With the capability the list loads; one health read serves later conversations.
  const supported = fakeClient({
    capabilities: () => ({ subagent_transcripts: 1 }),
    list: () => ({ subagents: [subagent()], last_seq: 4 }),
  });
  store.resetKBrainSubagentStore();
  store.configureKBrainSubagentStore({ client: () => supported, resolveSession: () => "backend-1" });
  await store.loadKBrainSubagents("chat-3");
  await store.loadKBrainSubagents("chat-4");
  assert.equal(supported.calls.capabilities, 1);
  assert.equal(supported.calls.list, 2);

  // A failed health read is not a "no": the list request decides.
  const flaky = fakeClient({
    capabilities: () => {
      throw new Error("offline");
    },
    list: () => ({ subagents: [subagent()], last_seq: 4 }),
  });
  store.resetKBrainSubagentStore();
  store.configureKBrainSubagentStore({ client: () => flaky, resolveSession: () => "backend-1" });
  await store.loadKBrainSubagents("chat-5");
  assert.equal(flaky.calls.list, 1);
});

// ---- rendering ----

const icons = new Proxy({}, { get: () => () => null });
const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));

async function render(element, bindings) {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": icons,
      [iconPath]: icons,
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
      "@liveagent/ui/components/Markdown": { Markdown: () => null },
      "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
      "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
      "@liveagent/ui/components/chat/AskUserQuestionCard": { AskUserQuestionCard: () => null },
      "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
      "@liveagent/adapters/assistantBubble": {
        readAskUserQuestionDeadline: () => undefined,
        useAskUserQuestionPending: () => false,
        usePlanDecisionState: () => ({ pending: false, approved: false }),
        retainRunningToolContent: false,
        submitAskUserQuestionAnswers() {},
        submitPlanDecision() {},
        usePendingToolApproval: () => false,
        usePermissionAutoResolved: () => null,
        deferLargeToolImages: false,
        useSubagentCard: (id) => bindings[id] ?? null,
      },
    },
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(element(env)));
  return {
    host,
    async cleanup() {
      await env.act(async () => root.unmount());
      host.remove();
      env.cleanup();
    },
  };
}

const doneView = {
  id: "fix-login-1",
  description: "Fix login tests",
  status: "done",
  model: "fixture-model",
  durationMs: 8_000,
};

function toolItem(id, name, args, result) {
  return {
    toolCall: { type: "toolCall", id, name, arguments: args },
    ...(result
      ? {
          toolResult: {
            role: "toolResult",
            toolCallId: id,
            toolName: name,
            content: [{ type: "text", text: result.text }],
            isError: Boolean(result.isError),
          },
        }
      : {}),
  };
}

function toolCall(props) {
  return (env) => {
    const { MemoToolCallItem } = env.loadModule(
      "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
    );
    return env.React.createElement(MemoToolCallItem, props);
  };
}

test("a follow-up is its subagent's card, with the follow-up's own status", async () => {
  const binding = { view: doneView, open() {} };
  const args = { id: "fix-login-1", message: "Now signup" };
  const running = await render(
    toolCall({ item: toolItem("call-f", "subagent_followup", args), isRunning: true }),
    { "call-f": binding },
  );
  try {
    const card = running.host.querySelector("[data-subagent-card]");
    assert.equal(card?.getAttribute("data-subagent-card"), "fix-login-1");
    assert.ok(card.textContent.includes("chat.subagent.followupLabel"));
    assert.ok(card.textContent.includes("Fix login tests"));
    // K-brain re-sends the original "done" while the follow-up runs; the card says running.
    assert.ok(card.textContent.includes("chat.tool.running"), card.textContent);
  } finally {
    await running.cleanup();
  }

  const failed = await render(
    toolCall({
      item: toolItem("call-f", "subagent_followup", args, { text: "boom", isError: true }),
    }),
    { "call-f": binding },
  );
  try {
    const card = failed.host.querySelector("[data-subagent-card]");
    assert.ok(card.textContent.includes("chat.subagent.followupLabel"));
    assert.equal(card.textContent.includes("chat.tool.running"), false);
  } finally {
    await failed.cleanup();
  }

  // Unlinked (older K-brain, WebUI): the concise row names the subagent id.
  const plain = await render(
    toolCall({ item: toolItem("call-f", "subagent_followup", args, { text: "Signup fixed." }) }),
    {},
  );
  try {
    assert.equal(plain.host.querySelector("[data-subagent-card]"), null);
    assert.ok(plain.host.textContent.includes("chat.tool.subagent.followup.completed"));
    assert.ok(plain.host.textContent.includes("fix-login-1"));
  } finally {
    await plain.cleanup();
  }
});

test("status, steer and cancel are rows titled with the action and the subagent", async () => {
  const binding = { view: doneView, open() {} };
  const cases = [
    {
      name: "subagent_status",
      result: { text: JSON.stringify({ id: "fix-login-1", status: "done" }) },
      title: "chat.tool.subagent.status.completed",
      outcome: "chat.tool.success",
    },
    {
      name: "subagent_steer",
      result: { text: "Steered fix-login-1; it will read the message next." },
      title: "chat.tool.subagent.steer.completed",
      outcome: "chat.tool.subagent.result.steered",
    },
    {
      name: "subagent_cancel",
      result: { text: "Subagent is already inactive; nothing to cancel." },
      title: "chat.tool.subagent.cancel.inactive",
      outcome: "chat.tool.subagent.result.inactive",
    },
  ];
  for (const { name, result, title, outcome } of cases) {
    // compactChip is the transcript's grouped layout; it shows the result too.
    for (const [linked, compactChip] of [
      [true, false],
      [false, false],
      [true, true],
    ]) {
      const view = await render(
        toolCall({ item: toolItem("call-c", name, { id: "fix-login-1" }, result), compactChip }),
        linked ? { "call-c": binding } : {},
      );
      try {
        const text = view.host.textContent;
        assert.equal(view.host.querySelector("[data-subagent-card]"), null);
        assert.ok(text.includes(title), `${name}: ${text}`);
        assert.ok(text.includes(outcome), `${name} (compact ${compactChip}): ${text}`);
        assert.ok(text.includes(linked ? "Fix login tests" : "fix-login-1"), `${name}: ${text}`);
      } finally {
        await view.cleanup();
      }
    }
  }
});
