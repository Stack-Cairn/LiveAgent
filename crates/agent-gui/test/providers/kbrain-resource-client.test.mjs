import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const checkpointList = [
  {
    turn_seq: 7,
    turn_id: "turn-7",
    file_count: 2,
    dir_count: 1,
    incomplete: false,
    first_captured_at: 1770000000000,
  },
];

const checkpointDiff = {
  turn_seq: 7,
  restore_files: 1,
  delete_files: 1,
  clean_files: 2,
  skipped_dirs: 0,
  missing_blobs: 0,
  unresolvable_files: 0,
  capture_errors: 0,
  entries: [
    {
      path: "/work/file.txt",
      key: "/work/file.txt",
      action: "restore",
      current_hash: "old",
    },
  ],
};

const checkpointRewind = {
  turn_seq: 7,
  restored_files: 1,
  deleted_files: 1,
  clean_files: 2,
  skipped_dirs: 0,
  capture_errors: 0,
  conflicts: [],
  failed: [],
  revision: "rev-8",
};

test("K-brain resource client uses the checkpoint, compaction, and migration HTTP contracts", async () => {
  const calls = [];
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test/",
    token: "fixture-token",
    fetch: async (url, init = {}) => {
      const request = { url: new URL(url), init };
      calls.push(request);
      switch (request.url.pathname) {
        case "/v1/sessions/session%2Fid/checkpoints":
          return jsonResponse(checkpointList);
        case "/v1/sessions/session%2Fid/checkpoints/7/preview":
          return jsonResponse(checkpointDiff);
        case "/v1/sessions/session%2Fid/checkpoints/7/rewind":
          return jsonResponse(checkpointRewind);
        case "/v1/sessions/session%2Fid/compact":
          return jsonResponse(
            {
              version: "kbrain.agent.v1",
              conversation_id: "session/id",
              run_id: "compact-7",
              accepted_seq: 12,
              status: "accepted",
              revision: "rev-7",
            },
            202,
          );
        case "/v1/migrations/liveagent-history":
          return jsonResponse({
            source_id: "legacy-1",
            backend_id: "session/id",
            status: "imported",
            checkpoint: "unresolved",
            fingerprint: "fingerprint-1",
          });
        default:
          throw new Error(`unexpected URL ${request.url}`);
      }
    },
  });

  assert.deepEqual(await client.listCheckpoints("session/id"), checkpointList);
  assert.deepEqual(
    await client.checkpointPreview("session/id", 7, ["/work/project"]),
    checkpointDiff,
  );
  assert.deepEqual(
    await client.checkpointRewind(
      "session/id",
      7,
      ["/work/project"],
      [{ key: "/work/file.txt", currentHash: "old" }],
    ),
    checkpointRewind,
  );
  assert.equal((await client.compactSession("session/id", { expected_revision: "rev-7" })).run_id, "compact-7");
  assert.deepEqual(
    await client.importLegacyHistory({ source_id: "legacy-1" }),
    {
      source_id: "legacy-1",
      backend_id: "session/id",
      status: "imported",
      checkpoint: "unresolved",
      fingerprint: "fingerprint-1",
    },
  );

  const previewCall = calls.find(({ url }) =>
    url.pathname.endsWith("/preview"),
  );
  assert.equal(previewCall.init.method, "POST");
  assert.deepEqual(JSON.parse(previewCall.init.body), {
    authorized_roots: ["/work/project"],
  });
  const rewindCall = calls.find(({ url }) => url.pathname.endsWith("/rewind"));
  assert.deepEqual(JSON.parse(rewindCall.init.body), {
    authorized_roots: ["/work/project"],
    expected: [{ key: "/work/file.txt", current_hash: "old" }],
  });
  const compactCall = calls.find(({ url }) =>
    url.pathname.endsWith("/compact"),
  );
  assert.equal(compactCall.init.method, "POST");
  const compactBody = JSON.parse(compactCall.init.body);
  assert.equal(compactBody.conversation_id, "session/id");
  assert.equal(typeof compactBody.client_request_id, "string");
  assert.equal(compactBody.expected_revision, "rev-7");
  assert.equal(new Headers(calls.at(-1).init.headers).get("Authorization"), "Bearer fixture-token");
});

test("K-brain resource client rejects malformed resource replies", async () => {
  const malformedCheckpointClient = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async () => jsonResponse([{ turn_seq: 7 }]),
  });
  await assert.rejects(
    () => malformedCheckpointClient.listCheckpoints("session"),
    /Malformed K-brain checkpoint list response/,
  );

  const malformedImportClient = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async () => jsonResponse({ source_id: "legacy-1" }),
  });
  await assert.rejects(
    () => malformedImportClient.importLegacyHistory({ source_id: "legacy-1" }),
    /Malformed K-brain history import response/,
  );
});

test("K-brain resource client preserves HTTP failures and rejects malformed compaction replies", async () => {
  const failedClient = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async () =>
      jsonResponse({ error: "checkpoint backend unavailable" }, 503),
  });
  await assert.rejects(
    () => failedClient.listCheckpoints("session"),
    /checkpoint backend unavailable/,
  );

  const malformedClient = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async () =>
      jsonResponse(
        {
          version: "kbrain.agent.v1",
          conversation_id: "session",
          run_id: "",
          accepted_seq: 3,
          status: "accepted",
        },
        202,
      ),
  });
  await assert.rejects(
    () =>
      malformedClient.compactSession("session", {
        client_request_id: "request-1",
        expected_revision: "rev-1",
      }),
    /Malformed K-brain compaction acceptance/,
  );
});
