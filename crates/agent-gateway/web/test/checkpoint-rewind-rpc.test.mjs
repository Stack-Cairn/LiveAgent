import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const rpc = loader.loadModule("src/lib/gatewaySocketRpc.ts");

test("checkpoint rewind preserves preview hashes across the WebUI RPC boundary", async () => {
  const client = Object.create(rpc.GatewayWebSocketRpcClient.prototype);
  client.request = async (method, payload) => {
    assert.equal(method, "checkpoint.rewind");
    assert.deepEqual(payload, {
      conversation_id: "conversation-1",
      turn_seq: 7,
      authorized_roots: ["/work/project"],
      expected: [
        {
          key: "/work/project\u0001src/a.ts",
          current_hash: "hash-at-preview",
        },
      ],
    });
    return {
      turnSeq: 7,
      restoredFiles: 1,
      deletedFiles: 0,
      cleanFiles: 0,
      skippedDirs: 0,
      captureErrors: 0,
      conflicts: [],
      failed: [],
    };
  };

  const result = await client.rewindCheckpoint({
    conversationId: "conversation-1",
    turnSeq: 7,
    authorizedRoots: ["/work/project"],
    expected: [
      {
        key: "/work/project\u0001src/a.ts",
        currentHash: "hash-at-preview",
      },
    ],
  });

  assert.equal(result.restoredFiles, 1);
  assert.deepEqual(result.conflicts, []);
});
