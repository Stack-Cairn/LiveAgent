import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Checkpoints and public shares are keyed by the K-brain session. Callers (the
// desktop rewind provider and the WebUI bridge) address conversations by their
// local id, so the shared client must translate through the session mapping.
const loader = createTsModuleLoader();
const { kBrainCheckpointClient } = loader.loadModule("src/lib/kbrain/checkpoints.ts");
const { resolveKBrainHistoryShare } = loader.loadModule("src/lib/kbrain/history.ts");
const { setKBrainSessionId } = loader.loadModule("src/lib/kbrain/mapping.ts");
const { setKBrainRuntimeConnection, clearKBrainRuntimeConnection } = loader.loadModule(
  "src/lib/kbrain/runtimeConnection.ts",
);

async function withBackend(t, routes) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null });
    const route = routes[`${request.method} ${request.url}`];
    response.writeHead(route ? (route.status ?? 200) : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify(route ? route.body : { error: "share not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  setKBrainRuntimeConnection({ baseUrl: origin, token: "fixture-token", protocolVersion: "kbrain.agent.v1" });
  t.after(() => {
    clearKBrainRuntimeConnection();
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    server.closeAllConnections();
    server.close();
  });
  return { origin, requests };
}

test("checkpoint client sends the mapped K-brain session id, not the local id", async (t) => {
  const turn = { turn_seq: 2, turn_id: "t2", file_count: 1, dir_count: 0, incomplete: false, first_captured_at: 1 };
  const { origin, requests } = await withBackend(t, {
    "GET /v1/sessions/abcd1234/checkpoints": { body: [turn] },
    "POST /v1/sessions/abcd1234/checkpoints/2/preview": {
      body: {
        turn_seq: 2, restore_files: 1, delete_files: 0, clean_files: 0, skipped_dirs: 0, missing_blobs: 0,
        unresolvable_files: 0, capture_errors: 0,
        entries: [{ path: "/w/a.txt", key: "k", action: "restore", current_hash: "h" }],
      },
    },
    "POST /v1/sessions/abcd1234/checkpoints/2/rewind": {
      body: {
        turn_seq: 2, restored_files: 1, deleted_files: 0, clean_files: 0, skipped_dirs: 0,
        capture_errors: 0, conflicts: [], failed: [],
      },
    },
  });
  setKBrainSessionId("local-conversation", "abcd1234", origin);

  const list = await kBrainCheckpointClient.list("local-conversation");
  assert.deepEqual(list, [{ turnSeq: 2, turnId: "t2", fileCount: 1, dirCount: 0, incomplete: false, firstCapturedAt: 1 }]);
  const preview = await kBrainCheckpointClient.preview({
    conversationId: "local-conversation", turnSeq: 2, authorizedRoots: ["/w"],
  });
  assert.deepEqual(preview.entries, [{ path: "/w/a.txt", key: "k", action: "restore", currentHash: "h" }]);
  const rewind = await kBrainCheckpointClient.rewind({
    conversationId: "local-conversation", turnSeq: 2, authorizedRoots: ["/w"],
    expected: [{ key: "k", currentHash: "h" }],
  });
  assert.equal(rewind.restoredFiles, 1);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "GET /v1/sessions/abcd1234/checkpoints",
      "POST /v1/sessions/abcd1234/checkpoints/2/preview",
      "POST /v1/sessions/abcd1234/checkpoints/2/rewind",
    ],
  );
  assert.deepEqual(requests[1].body, { authorized_roots: ["/w"] });
  assert.deepEqual(requests[2].body.expected, [{ key: "k", current_hash: "h" }]);
});

test("public share resolves through K-brain with the local id and derived redaction", async (t) => {
  const token = "a".repeat(64);
  const plain = "b".repeat(64);
  const { origin } = await withBackend(t, {
    [`GET /v1/shares/${token}`]: {
      body: {
        conversation_id: "abcd1234",
        title: "Shared run",
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
      },
    },
    [`GET /v1/shares/${plain}`]: {
      body: {
        conversation_id: "ffff0000",
        title: "",
        messages: [
          { id: "a2", role: "assistant", content: [], tool_calls: [{ id: "c1", name: "Bash", arguments: { command: "ls" } }] },
          { id: "t1", role: "tool", tool_call_id: "c1", name: "Bash", content: [{ type: "text", text: "out" }] },
        ],
      },
    },
  });
  setKBrainSessionId("local-conversation", "abcd1234", origin);

  const redacted = await resolveKBrainHistoryShare(` ${token} `);
  assert.equal(redacted.conversationId, "local-conversation");
  assert.equal(redacted.title, "Shared run");
  assert.equal(redacted.redactToolContent, true);
  assert.deepEqual(redacted.messages.map((message) => message.role), ["user", "assistant"]);

  const full = await resolveKBrainHistoryShare(plain);
  // An unmapped session never mints a local alias for a share visitor.
  assert.equal(full.conversationId, "ffff0000");
  assert.equal(full.redactToolContent, false);
  assert.ok(full.messages.some((message) => message.role === "toolResult"));

  await assert.rejects(resolveKBrainHistoryShare("c".repeat(64)), /share not found/);
  await assert.rejects(resolveKBrainHistoryShare("  "), /share token is required/);
});
