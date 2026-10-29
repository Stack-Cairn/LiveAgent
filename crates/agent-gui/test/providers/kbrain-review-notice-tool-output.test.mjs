import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// K-brain internal/approval/run.go (tool_output phase) prepends
//   "Non-text attachments were not reviewed. "
// to the reviewer report whenever a tool result carries image/file parts, and
// forces injection=unknown, so the desktop always raises the review toast.
// The reviewer report it prefixes is either a fixed Unknown(...) reason or
// "Sensitive data was redacted; manual approval required. <model text>".

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const model = { provider: "fixture", model: "fixture-model" };
const baseParams = {
  conversationId: "conversation-1",
  sessionId: "host-session-1",
  cwd: "/tmp/workspace",
  model,
  prompt: "hello",
  context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
  signal: new AbortController().signal,
  onTextDelta() {},
  onThinkingDelta() {},
  onToolCall() {},
  onToolResult() {},
};

function event(seq, type, payload = {}) {
  return `data: ${JSON.stringify({
    version: "kbrain.agent.v1",
    seq,
    conversation_id: "backend-session-1",
    run_id: "run-1",
    type,
    created_at: "2026-09-27T00:00:00Z",
    payload,
  })}\n\n`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(body) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return json({ id: "backend-session-1", model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) {
      return json(
        {
          version: "kbrain.agent.v1",
          conversation_id: "backend-session-1",
          run_id: "run-1",
          accepted_seq: 1,
        },
        202,
      );
    }
    if (parsed.pathname.endsWith("/events")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (parsed.pathname.includes("/cancel")) return json({ ok: true });
    throw new Error(`unexpected K-brain URL ${parsed.pathname}`);
  };
}

async function toastFor(reason, locale) {
  storage.clear();
  const warnings = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { warning: (...args) => warnings.push(args) },
      },
    },
  });
  const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
  const review = event(2, "approval.reviewed", {
    tool: "computer_exec",
    phase: "tool_output",
    automatic: false,
    report: {
      risk: "unknown",
      sandbox: "unknown",
      sensitive_data: "unknown",
      model_behavior: "unknown",
      injection: "unknown",
      reason,
    },
  });
  await runKBrainTurn({
    ...baseParams,
    locale,
    fetch: makeFetch(review + event(3, "run.completed")),
  });
  assert.equal(warnings.length, 1, "the tool_output review raises one toast");
  return warnings[0][1].description;
}

test("tool_output review with non-text attachments is shown in Chinese for a zh-CN interface", async () => {
  const description = await toastFor(
    "Non-text attachments were not reviewed. Reviewer unavailable; manual approval required",
    "zh-CN",
  );
  assert.doesNotMatch(
    description,
    /manual approval required|Non-text attachments were not reviewed/,
    `K-brain fixed English leaked into the zh-CN toast: ${description}`,
  );
  assert.match(description, /未配置可用的审查模型，需要人工确认。/);
});

test("non-text prefix stacked on the sensitive-data prefix still translates the fixed parts", async () => {
  const description = await toastFor(
    "Non-text attachments were not reviewed. Sensitive data was redacted; manual approval required. Screenshot shows a login form",
    "zh-CN",
  );
  assert.doesNotMatch(
    description,
    /manual approval required|Non-text attachments were not reviewed/,
    `K-brain fixed English leaked into the zh-CN toast: ${description}`,
  );
  assert.match(description, /已隐去敏感信息，需要人工确认。/);
  assert.match(description, /Screenshot shows a login form$/, "model free text stays as written");
});
