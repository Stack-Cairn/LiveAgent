import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

const source = (name) => new URL(`../src/${name}`, import.meta.url).pathname;
const backend = {
  claimPromptRuns: async () => [],
  releasePromptRun: async () => {},
  completePromptRun: async () => ({ status: "completed" }),
};
const loader = createTsModuleLoader({
  mocks: {
    react: { useEffect() {}, useRef: (value) => ({ current: value }) },
    "@liveagent/app/shims/tauriEvent": { listen: async () => () => {} },
    [source("lib/automation/backend.ts")]: { backend },
    [source("lib/host.ts")]: { isTauriHost: () => true },
    [source("lib/providers/llm.ts")]: {
      assistantMessageToText: (message) =>
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
    },
  },
});
const { executeCronPromptRun } = loader.loadModule("src/components/cron/CronPromptRunner.tsx");

const requestTemplate = {
  executionId: "execution-1",
  taskId: "task-1",
  taskName: "Nightly report",
  prompt: "Summarize the repository.",
  providerId: "backend-provider",
  model: "backend-model",
  startedAt: 1,
  leaseExpiresAt: Date.now() + 60_000,
  timeoutSeconds: 60,
  counted: true,
  workdir: "/workspace/project",
  reasoning: "off",
};

function sseEvent(seq, type, payload = {}, runId = "run-1") {
  return `data: ${JSON.stringify({
    version: "kbrain.agent.v1",
    seq,
    conversation_id: "execution-1",
    run_id: runId,
    type,
    created_at: "2026-09-28T00:00:00Z",
    payload,
  })}\n\n`;
}

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function withFixture(route, callback) {
  const server = createServer(route);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function runRequest(overrides = {}) {
  return { ...requestTemplate, ...overrides };
}

function fixtureRoute({ eventStream, onRequest = () => {} }) {
  return (request, response) => {
    const url = new URL(request.url, "http://fixture");
    onRequest(request, url);
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        onRequest({ ...request, body: JSON.parse(body) }, url);
        json(response, { id: "execution-1", model: { provider: "backend-provider", model: "backend-model" }, last_seq: 0 });
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions/execution-1/runs") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        onRequest({ ...request, body: JSON.parse(body) }, url);
        json(response, { version: "kbrain.agent.v1", conversation_id: "execution-1", run_id: "run-1", accepted_seq: 1 }, 202);
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions/execution-1/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      eventStream(response, request);
      return;
    }
    if (request.method === "POST" && url.pathname.includes("/permissions/")) {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        onRequest({ ...request, body: JSON.parse(body) }, url);
        json(response, { ok: true });
      });
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/cancel")) {
      json(response, { ok: true });
      return;
    }
    json(response, { error: `unexpected ${request.method} ${url.pathname}` }, 404);
  };
}

test("executeCronPromptRun uses a real K-brain session/run/SSE and backend model/cwd", async () => {
  const requests = [];
  await withFixture(
    fixtureRoute({
      eventStream: (response) => {
        response.end(
          sseEvent(2, "assistant.text.delta", { text: "Repository is healthy." }) +
            sseEvent(3, "assistant.message.created", { content: [{ type: "text", text: "Repository is healthy." }] }) +
            sseEvent(4, "run.completed"),
        );
      },
      onRequest: (request, url) => requests.push({ method: request.method, url, body: request.body }),
    }),
    async (baseUrl) => {
      const output = await executeCronPromptRun(runRequest(), new AbortController().signal, { baseUrl });
      assert.equal(output, "Repository is healthy.");
    },
  );
  const session = requests.find(({ url, body }) => url.pathname === "/v1/sessions" && body);
  assert.equal(session.body.cwd, "/workspace/project");
  assert.deepEqual(session.body.model, { provider: "backend-provider", model: "backend-model" });
  assert.match(session.body.messages[0].content[0].text, /final conclusion/);
  const run = requests.find(({ url, body }) => url.pathname.endsWith("/runs") && body);
  assert.equal(run.body.client_request_id, "execution-1");
  assert.equal(run.body.model.provider, "backend-provider");
});

test("executeCronPromptRun cancels an in-flight K-brain run", async () => {
  let eventsRequest;
  let cancelSeen = false;
  const controller = new AbortController();
  await withFixture(
    fixtureRoute({
      eventStream: (response, request) => {
        eventsRequest = request;
        request.on("close", () => response.destroy());
      },
      onRequest: (request, url) => {
        if (request.method === "POST" && url.pathname.endsWith("/cancel")) cancelSeen = true;
      },
    }),
    async (baseUrl) => {
      const running = executeCronPromptRun(runRequest(), controller.signal, { baseUrl });
      while (!eventsRequest) await new Promise((resolve) => setTimeout(resolve, 1));
      controller.abort();
      await assert.rejects(running, /cancelled|aborted/i);
    },
  );
  assert.equal(cancelSeen, true);
});

test("executeCronPromptRun surfaces a backend run error", async () => {
  await withFixture(
    fixtureRoute({
      eventStream: (response) => response.end(sseEvent(2, "run.failed", { error: "provider unavailable" })),
    }),
    async (baseUrl) => {
      await assert.rejects(
        executeCronPromptRun(runRequest(), new AbortController().signal, { baseUrl }),
        /provider unavailable/,
      );
    },
  );
});

test("executeCronPromptRun rejects permission requests without waiting for approval", async () => {
  let permissionDecision;
  let permissionResolved;
  const permissionDone = new Promise((resolve) => (permissionResolved = resolve));
  await withFixture(
    fixtureRoute({
      eventStream: async (response) => {
        response.write(sseEvent(2, "permission.requested", {
          permission_id: "permission-1",
          tool: "shell",
          command: "rm -rf /tmp/nope",
        }));
        await permissionDone;
        response.end(sseEvent(3, "run.failed", { error: "permission denied" }));
      },
      onRequest: (request, url) => {
        if (url.pathname.includes("/permissions/") && request.body) {
          permissionDecision = request.body.decision.decision;
          permissionResolved();
        }
      },
    }),
    async (baseUrl) => {
      await assert.rejects(
        executeCronPromptRun(runRequest(), new AbortController().signal, { baseUrl }),
        /permission denied|failed/i,
      );
    },
  );
  assert.equal(permissionDecision, "reject");
});
