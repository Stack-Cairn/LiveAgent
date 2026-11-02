import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@liveagent/app/shims/tauriCore": {
      invoke: async () => {
        throw new Error("native invoke not expected");
      },
    },
    "../host": { isTauriHost: () => true },
  },
});
const failures = loader.loadModule("src/lib/kbrain/historyMigrationFailures.ts");
const migration = loader.loadModule("src/lib/kbrain/historyMigration.ts");
const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function page(id = "big-one", text = "old question") {
  return {
    complete: true,
    conversations: [
      {
        id,
        title: "A long conversation",
        providerId: "removed",
        model: "removed-model",
        createdAt: 1000,
        updatedAt: 2000,
        isPinned: false,
        isShared: false,
        redactToolContent: false,
        contextMetaJson: "{}",
        checkpoint: { status: "not_found" },
        segments: [
          {
            segmentIndex: 0,
            segmentId: "first",
            messagesJson: JSON.stringify([{ id: "u1", role: "user", content: text, timestamp: 1000 }]),
          },
        ],
      },
    ],
  };
}

test("classification separates deterministic failures from transient ones", () => {
  const limit = 4 << 20;
  const classify = failures.classifyHistoryMigrationFailure;
  assert.equal(classify({ message: "Failed to fetch", bytes: limit + 1 }), "transient");
  assert.equal(classify({ message: "Failed to fetch", bytes: limit - 1 }), "transient");
  assert.equal(classify({ message: "Failed to fetch" }), "transient");
  assert.equal(classify({ status: 413, message: "too big" }), "too_large");
  assert.equal(classify({ status: 409, message: "conflict" }), "conflict");
  assert.equal(classify({ status: 400, message: "bad" }), "rejected");
  assert.equal(classify({ status: 500, message: "boom" }), "transient");
  assert.equal(failures.isDeterministicHistoryMigrationFailure("transient"), false);
});

test("merge drops records for conversations that now succeed", () => {
  const record = (sourceId, kind = "too_large") => ({
    sourceId,
    title: sourceId,
    fingerprint: "f",
    kind,
    message: "m",
    failedAt: 1,
  });
  const merged = failures.mergeHistoryMigrationFailures([record("a"), record("b")], {
    succeeded: ["a"],
    failed: [record("c", "conflict")],
  });
  assert.deepEqual(
    merged.map((entry) => entry.sourceId),
    ["b", "c"],
  );
});

test("dismissal hides the notice but keeps the settings list", () => {
  const storage = memoryStorage();
  const scope = "dismiss-scope";
  const record = { sourceId: "x", title: "X", fingerprint: "f1", kind: "too_large", message: "m", failedAt: 1 };
  failures.writeHistoryMigrationFailures(scope, [record], storage);
  failures.dismissHistoryMigrationFailures(scope, [record], storage);
  const dismissed = failures.readDismissedHistoryMigrationFailures(scope, storage);
  assert.equal(dismissed.has("x:f1"), true);
  assert.equal(failures.readHistoryMigrationFailures(scope, storage).length, 1);
});

test("startup skips a conversation that already failed for size; manual import retries it", async () => {
  globalThis.localStorage = memoryStorage();
  runtime.setKBrainRuntimeConnection({
    baseUrl: "http://migration-failures.test",
    token: "",
    protocolVersion: "kbrain.agent.v1",
  });
  // A payload supported by newer backends but rejected by older backends.
  const bigPage = () => page("big-one", "x".repeat(4 << 20));
  let posts = 0;
  let accept = false;
  const fetch = async (_url, init) => {
    if (init.method === "POST") {
      posts++;
      if (!accept) return new Response(JSON.stringify({ error: "import too large" }), { status: 413 });
      return new Response(
        JSON.stringify({
          source_id: "big-one",
          backend_id: "big-one",
          status: "imported",
          checkpoint: "not_found",
          fingerprint: "fp",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  try {
    const first = await migration.migrateLegacyHistoryPage(bigPage(), { fetch });
    assert.equal(posts, 1);
    assert.equal(first.failures[0].kind, "too_large");
    assert.ok(first.failures[0].bytes > (4 << 20));

    // Next launch: same content, no re-upload, but still reported (as skipped).
    const second = await migration.migrateLegacyHistoryPage(bigPage(), { fetch });
    assert.equal(posts, 1);
    assert.equal(second.failures.length, 1);
    assert.equal(second.failures[0].skipped, true);
    assert.equal(second.complete, false);

    // Manual import retries; once K-brain accepts it, the record is cleared.
    accept = true;
    const manual = await migration.migrateLegacyHistoryPage(bigPage(), {
      fetch,
      retryKnownFailures: true,
    });
    assert.equal(posts, 2);
    assert.equal(manual.failures.length, 0);
    const scope = loader.loadModule("src/lib/kbrain/mapping.ts").kBrainStorageScope();
    assert.equal(failures.readHistoryMigrationFailures(scope).length, 0);
  } finally {
    runtime.clearKBrainRuntimeConnection();
  }
});

test("a transient failure is retried on the next launch", async () => {
  globalThis.localStorage = memoryStorage();
  runtime.setKBrainRuntimeConnection({
    baseUrl: "http://migration-transient.test",
    token: "",
    protocolVersion: "kbrain.agent.v1",
  });
  let posts = 0;
  const fetch = async (_url, init) => {
    if (init.method === "POST") {
      posts++;
      throw new TypeError("Failed to fetch");
    }
    return new Response("{}", { status: 404 });
  };
  try {
    await migration.migrateLegacyHistoryPage(page("large-transient", "x".repeat(5 << 20)), { fetch });
    await migration.migrateLegacyHistoryPage(page("large-transient", "x".repeat(5 << 20)), { fetch });
    assert.equal(posts, 2);
  } finally {
    runtime.clearKBrainRuntimeConnection();
  }
});

test("only the import POST can produce a deterministic failure record", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../../src/lib/kbrain/historyMigration.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /importAttempted = true;\s+const result = await client\.importLegacyHistory/);
  assert.match(source, /const kind = importAttempted\s+\? classifyHistoryMigrationFailure/);
});

 test("recoverable HTTP failures are not cached as permanent rejection", () => {
  for (const status of [401, 403, 404, 408, 425, 429, 502, 503]) {
    assert.equal(failures.classifyHistoryMigrationFailure({ status, message: "retry", bytes: 5 << 20 }), "transient");
  }
 });
 test("old size-inferred failures do not suppress migration after upgrade", () => {
  const storage = memoryStorage();
  storage.setItem("liveagent.kbrain-history-migration-failures.v1:upgrade", JSON.stringify([
    { sourceId: "old", fingerprint: "f", kind: "too_large", message: "Failed to fetch" },
  ]));
  assert.deepEqual(failures.readHistoryMigrationFailures("upgrade", storage), []);
 });

test("a partial checkpoint result is cached; startup stops re-uploading it, manual import still retries", async () => {
  globalThis.localStorage = memoryStorage();
  runtime.setKBrainRuntimeConnection({
    baseUrl: "http://migration-partial.test",
    token: "",
    protocolVersion: "kbrain.agent.v1",
  });
  let posts = 0;
  let checkpoint = "partial";
  const fetch = async (_url, init) => {
    if (init.method === "POST") {
      posts++;
      return new Response(
        JSON.stringify({
          source_id: "partial-one",
          backend_id: "partial-one",
          status: posts === 1 ? "imported" : "already_imported",
          checkpoint,
          fingerprint: "fp",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ id: "partial-one" }), { status: 200 });
  };
  try {
    await migration.migrateLegacyHistoryPage(page("partial-one"), { fetch });
    assert.equal(posts, 1);
    // Next launch: same content, served from the cache after an existence check.
    const again = await migration.migrateLegacyHistoryPage(page("partial-one"), { fetch });
    assert.equal(posts, 1);
    assert.equal(again.results[0].status, "already_imported");
    assert.equal(again.results[0].checkpoint, "partial");
    assert.equal(again.complete, false);
    // Manual import re-sends it.
    await migration.migrateLegacyHistoryPage(page("partial-one"), { fetch, retryKnownFailures: true });
    assert.equal(posts, 2);
    // Changed content means a new fingerprint and a fresh upload.
    await migration.migrateLegacyHistoryPage(page("partial-one", "edited"), { fetch });
    assert.equal(posts, 3);

    // "unresolved" stays retryable on every launch.
    checkpoint = "unresolved";
    await migration.migrateLegacyHistoryPage(page("unresolved-one"), { fetch });
    await migration.migrateLegacyHistoryPage(page("unresolved-one"), { fetch });
    assert.equal(posts, 5);
  } finally {
    runtime.clearKBrainRuntimeConnection();
  }
});
