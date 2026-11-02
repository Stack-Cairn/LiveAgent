import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createImageStudioClient, fetchTransport } = loader.loadModule(
  "@liveagent/ui/lib/imaging/client",
);
const { ImageClientError } = loader.loadModule("@liveagent/ui/lib/imaging/errors");
const { parseEvent, parseJob } = loader.loadModule("@liveagent/ui/lib/imaging/wire");
// Frozen copy of KB internal/imaging/testdata/wire-v1.json; no Go internal package dependency.
const fixture = JSON.parse(
  readFileSync(new URL("./testdata/wire-v1.json", import.meta.url), "utf8"),
);
const version = fixture.version;
const asset = {
  id: "ia_fixture",
  hash: "abc",
  mime: "image/png",
  bytes: 4,
  width: 1,
  height: 1,
  source: "upload",
  parentAssetIds: [],
  createdAt: fixture.job.createdAt,
  available: true,
};
const project = {
  id: "ip_fixture",
  title: "海报",
  revision: 0,
  createdAt: fixture.job.createdAt,
  updatedAt: fixture.job.updatedAt,
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function setup(fetch, options = {}, transportOptions = {}) {
  return createImageStudioClient({
    transport: fetchTransport({
      baseUrl: "https://backend.test/proxy",
      fetch,
      headers: () => ({ Authorization: "Bearer test-token" }),
      ...transportOptions,
    }),
    ...options,
  });
}
const errorCode = (code, status) => (error) => {
  assert.ok(error instanceof ImageClientError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};
function event(seq, type = "job.state_changed", data = { status: "running" }) {
  return { ...fixture.event, seq, type, data };
}
function frame(value, newline = "\n") {
  return [`id: ${value.seq}`, "event: image.event", `data: ${JSON.stringify(value)}`, "", ""].join(
    newline,
  );
}
function streamResponse(content, { bytes = false, keepOpen = false, onCancel } = {}) {
  const raw = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return new Response(
    new ReadableStream({
      start(controller) {
        if (bytes) for (const byte of raw) controller.enqueue(new Uint8Array([byte]));
        else if (raw.length) controller.enqueue(raw);
        if (!keepOpen) controller.close();
      },
      cancel: onCancel,
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

test("frozen Go wire fixture: complete job/settings, usage null, private fields excluded", async () => {
  const input = structuredClone(fixture);
  input.job.providerHandle = "private";
  input.job.items[0].providerHandle = "private";
  input.settings.connections[0].binding.customHeaders = { Authorization: "secret" };
  const client = setup(async (url) =>
    json(
      url.endsWith("/settings")
        ? { version, settings: input.settings }
        : { version, job: input.job },
    ),
  );
  const job = await client.getJob("ij_fixture");
  assert.deepEqual(job, fixture.job);
  assert.equal(job.usage, null);
  const settings = await client.getSettings();
  assert.deepEqual(settings, fixture.settings);
  assert.equal(JSON.stringify(job).includes("private"), false);
});

test("all CRUD routes use the shared API, camelCase and JSON media type", async () => {
  const calls = [];
  const client = setup(async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (url.includes("/targets")) return json({ version, items: fixture.settings.targets });
    if (url.includes("/settings")) return json({ version, ...fixture.settings });
    if (url.includes("/secrets"))
      return json({ version, ref: "opaque_ref", configured: true, value: "must-not-leak" });
    if (url.includes("/jobs/")) return json({ version, job: fixture.job });
    if (url.includes("/jobs?")) return json({ version, items: [fixture.job], nextCursor: "next" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "POST" || init.method === "PATCH") return json({ version, project });
    return json({ version, items: [project], nextCursor: "next" });
  });
  assert.equal((await client.listTargets()).length, 2);
  await client.saveSettings({ expectedRevision: 0, connections: [], targets: [] });
  assert.deepEqual(
    await client.writeSecret({ connectionId: "ic_fixture", purpose: "bearer", value: "sentinel" }),
    { ref: "opaque_ref", configured: true },
  );
  assert.deepEqual(await client.listProjects("a&b"), { items: [project], nextCursor: "next" });
  assert.deepEqual(await client.createProject("海报", "workspace"), project);
  await client.updateProject("ip_fixture", "new", 0);
  await client.deleteProject("ip_fixture");
  assert.deepEqual(await client.listJobs("ip_fixture", "x/y"), {
    items: [fixture.job],
    nextCursor: "next",
  });
  await client.cancelJob("ij_fixture");
  assert.equal(calls[0].url.pathname, "/proxy/v1/image/targets");
  assert.equal(calls[3].url.searchParams.get("cursor"), "a&b");
  assert.equal(calls[7].url.searchParams.get("cursor"), "x/y");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    expectedRevision: 0,
    connections: [],
    targets: [],
  });
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[5].init.method, "PATCH");
  assert.equal(JSON.parse(calls[5].init.body).expectedRevision, 0);
  assert.equal(calls[8].init.method, "POST");
  for (const { init, url } of calls) {
    assert.equal(init.headers.get("Authorization"), "Bearer test-token");
    assert.equal(url.search.includes("test-token"), false);
    if (init.body) assert.equal(init.headers.get("Content-Type"), "application/json");
  }
});

test("createJob preserves fixed Idempotency-Key for explicit replay and validates replayed", async () => {
  const calls = [];
  const client = setup(async (url, init) => {
    calls.push({ url, init });
    return json(
      { version, job: fixture.job, replayed: calls.length > 1 },
      calls.length > 1 ? 200 : 202,
    );
  });
  for (let i = 0; i < 2; i++)
    assert.equal((await client.createJob(fixture.job.request, "stable-key")).id, "ij_fixture");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.headers.get("Idempotency-Key"), "stable-key");
    assert.deepEqual(JSON.parse(call.init.body), fixture.job.request);
    assert.equal(call.url.includes("stable-key"), false);
  }
  const malformed = setup(async () => json({ version, job: fixture.job, replayed: "true" }));
  await assert.rejects(
    malformed.createJob(fixture.job.request, "key"),
    errorCode("IMAGE_PROTOCOL_ERROR"),
  );
});

test("capability health distinguishes old backend, unsupported, version mismatch and errors", async () => {
  for (const health of [
    { version: "kbrain.agent.v1", status: "ok" },
    { capabilities: {} },
    { capabilities: { image: { supported: false } } },
  ]) {
    const client = setup(async (url) => {
      assert.ok(url.endsWith("/v1/health"));
      return json(health);
    });
    assert.deepEqual(await client.capabilities(), { supported: false });
  }
  assert.deepEqual(
    await setup(async () =>
      json({ capabilities: { image: { supported: true, version } } }),
    ).capabilities(),
    { supported: true, version },
  );
  for (const health of [
    {},
    { capabilities: null },
    { capabilities: { image: { supported: true, version: "v2" } } },
  ]) {
    await assert.rejects(
      setup(async () => json(health)).capabilities(),
      errorCode("IMAGE_PROTOCOL_ERROR"),
    );
  }
  for (const [status, code] of [
    [401, "IMAGE_AUTH_REQUIRED"],
    [404, "IMAGE_NOT_FOUND"],
    [405, "IMAGE_METHOD_NOT_ALLOWED"],
    [503, "IMAGE_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      setup(async () => new Response("not JSON", { status })).capabilities(),
      errorCode(code, status),
    );
  }
});

test("401/405/409/413/503 failures do not replay writes, body/message/cause stay redacted", async () => {
  for (const [status, code] of [
    [401, "IMAGE_AUTH_REQUIRED"],
    [405, "IMAGE_METHOD_NOT_ALLOWED"],
    [409, "IMAGE_IDEMPOTENCY_CONFLICT"],
    [413, "IMAGE_TOO_LARGE"],
    [503, "IMAGE_UNAVAILABLE"],
    [422, "IMAGE_FUTURE_CODE"],
  ]) {
    let count = 0;
    const client = setup(async () => {
      count++;
      return json(
        {
          version,
          error: {
            code,
            message: "Bearer sentinel https://secret.test/?key=sentinel",
            retryable: true,
            requestId: "https://secret.test/?key=sentinel",
            details: { rawBody: "sentinel", actualRevision: 0 },
          },
        },
        status,
      );
    });
    await assert.rejects(
      client.writeSecret({ connectionId: "ic_fixture", purpose: "bearer", value: "sentinel" }),
      (error) => {
        errorCode(code, status)(error);
        assert.equal(`${error}\n${JSON.stringify(error)}`.includes("sentinel"), false);
        assert.deepEqual(error.details, { actualRevision: 0 });
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(count, 1);
  }
  const client = setup(async () => {
    throw new Error("sentinel credential in native fetch URL");
  });
  await assert.rejects(
    client.createJob(fixture.job.request, "key"),
    errorCode("IMAGE_NETWORK_ERROR"),
  );
});

test("response version, required job fields and safe integer boundaries are checked", async () => {
  for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
    const value = { ...fixture.job, revision };
    assert.equal(parseJob(value).revision, revision);
  }
  const invalidJobs = [
    { ...fixture.job, usage: undefined },
    { ...fixture.job, status: "invented" },
    { ...fixture.job, revision: -1 },
    { ...fixture.job, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...fixture.job, assetIds: [1] },
    { ...fixture.job, targetSnapshot: {} },
  ];
  for (const job of invalidJobs) {
    await assert.rejects(
      setup(async () => json({ version, job })).getJob("ij_fixture"),
      errorCode("IMAGE_PROTOCOL_ERROR"),
    );
  }
  await assert.rejects(
    setup(async () => json({ version: "v2", job: fixture.job })).getJob("ij_fixture"),
    errorCode("IMAGE_PROTOCOL_ERROR"),
  );
  await assert.rejects(
    setup(async () => json({ version: "v2", error: fixture.error }, 409)).getJob("ij_fixture"),
    errorCode("IMAGE_PROTOCOL_ERROR", 409),
  );
  const metadata = await setup(async () =>
    json({
      version,
      job: fixture.job,
      firstAvailableSeq: 0,
      lastEventSeq: Number.MAX_SAFE_INTEGER,
    }),
  ).getJob("ij_fixture");
  assert.equal(metadata.firstAvailableSeq, 0);
  assert.equal(metadata.lastEventSeq, Number.MAX_SAFE_INTEGER);
  assert.equal(parseEvent(event(0)).seq, 0);
  assert.equal(parseEvent(event(Number.MAX_SAFE_INTEGER)).seq, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => parseEvent(event(Number.MAX_SAFE_INTEGER + 1)),
    errorCode("IMAGE_PROTOCOL_ERROR"),
  );
});

test("multipart upload uses file only and browser boundary; authenticated asset returns Blob", async () => {
  const payload = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const controller = new AbortController();
  const client = setup(
    async (url, init) => {
      assert.equal(init.headers.get("Authorization"), "Bearer test-token");
      assert.ok(init.signal instanceof AbortSignal);
      if (init.method === "POST") {
        assert.ok(init.body instanceof FormData);
        assert.deepEqual([...init.body.keys()], ["file"]);
        assert.equal(init.body.get("file").name, "poster.png");
        assert.equal(init.headers.has("Content-Type"), false);
        const encoded = new Request(url, init);
        assert.match(encoded.headers.get("Content-Type"), /^multipart\/form-data; boundary=/);
        assert.deepEqual(
          new Uint8Array(await init.body.get("file").arrayBuffer()),
          new Uint8Array(await payload.arrayBuffer()),
        );
        return json({ version, asset, nativeUrl: "https://provider.test/private" }, 201);
      }
      assert.equal(new URL(url).searchParams.get("variant"), "thumbnail");
      return new Response(payload, { headers: { "Content-Type": "image/png" } });
    },
    {},
    { headers: () => ({ Authorization: "Bearer test-token", "Content-Type": "application/json" }) },
  );
  assert.deepEqual(await client.upload(payload, "poster.png", controller.signal), asset);
  const read = await client.readAsset("ia_fixture", "thumbnail", controller.signal);
  assert.ok(read instanceof Blob);
  assert.deepEqual(
    new Uint8Array(await read.arrayBuffer()),
    new Uint8Array(await payload.arrayBuffer()),
  );
  await assert.rejects(
    setup(async () => json({ version })).readAsset("ia_fixture", "original"),
    errorCode("IMAGE_PROTOCOL_ERROR"),
  );
});

test("SSE handles single-byte UTF-8 chunks, CRLF, heartbeat, multiline data and terminal cancellation", async () => {
  let cancelled = false;
  const ready = event(1, "asset.ready", { asset: { ...asset, hash: "中文" } });
  const multiline = JSON.stringify(ready, null, 2)
    .split("\n")
    .map((line) => `data: ${line}\r\n`)
    .join("");
  const content = `: heartbeat\r\n\r\nid: 1\r\nevent: image.event\r\n${multiline}\r\n${frame(event(2, "job.finished", { status: "succeeded" }), "\r\n")}`;
  const client = setup(async (_url, init) => {
    assert.equal(init.headers.get("Last-Event-ID"), "0");
    assert.equal(init.headers.get("Accept"), "text/event-stream");
    return streamResponse(content, {
      bytes: true,
      keepOpen: true,
      onCancel: () => {
        cancelled = true;
      },
    });
  });
  const received = [];
  await client.subscribe("ij_fixture", 0, (e) => received.push(e), new AbortController().signal);
  assert.deepEqual(
    received.map((e) => e.seq),
    [1, 2],
  );
  assert.equal(received[0].data.asset.hash, "中文");
  assert.equal(cancelled, true);
});

test("SSE reconnect uses Last-Event-ID, deduplicates, advances unknown events, discards partial frame", async () => {
  const cursors = [];
  const client = setup(
    async (_url, init) => {
      cursors.push(init.headers.get("Last-Event-ID"));
      if (cursors.length === 1)
        return streamResponse(
          `${frame(event(1))}${frame(event(2, "future.kind", { secret: "ignored" }))}id: 3\ndata: {`,
        );
      return streamResponse(
        frame(event(2)) + frame(event(3, "job.finished", { status: "partial_succeeded" })),
      );
    },
    { reconnectDelaysMs: [0] },
  );
  const received = [];
  await client.subscribe(
    "ij_fixture",
    0,
    (e) => received.push(e.seq),
    new AbortController().signal,
  );
  assert.deepEqual(cursors, ["0", "2"]);
  assert.deepEqual(received, [1, 3]);
});

test("SSE EVENT_GAP carries zero/large recovery values to host without reconnecting", async () => {
  let count = 0;
  const client = setup(async () => {
    count++;
    return json(
      {
        version,
        error: {
          ...fixture.error,
          code: "IMAGE_EVENT_GAP",
          details: { firstAvailableSeq: 0, lastEventSeq: Number.MAX_SAFE_INTEGER },
        },
      },
      409,
    );
  });
  await assert.rejects(
    client.subscribe("ij_fixture", 0, () => {}, new AbortController().signal),
    (error) => {
      errorCode("IMAGE_EVENT_GAP", 409)(error);
      assert.deepEqual(error.details, {
        firstAvailableSeq: 0,
        lastEventSeq: Number.MAX_SAFE_INTEGER,
      });
      return true;
    },
  );
  assert.equal(count, 1);
});

test("SSE bounded reconnect, invalid event, wrong scope and 401 never loop", async () => {
  let count = 0;
  const client = setup(
    async () => {
      count++;
      return streamResponse(": heartbeat\n\n");
    },
    { reconnectDelaysMs: [0, 0] },
  );
  await assert.rejects(
    client.subscribe("ij_fixture", 0, () => {}, new AbortController().signal),
    errorCode("IMAGE_STREAM_ENDED"),
  );
  assert.equal(count, 3);
  for (const response of [
    () => streamResponse(frame({ ...event(1), jobId: "ij_other" })),
    () => streamResponse(frame(event(1, "job.finished", {}))),
    () => streamResponse(frame(event(Number.MAX_SAFE_INTEGER + 1))),
    () => streamResponse(`id: 2\ndata: ${JSON.stringify(event(1))}\n\n`),
    () => streamResponse("id: 1\ndata: not json\n\n"),
    () =>
      json(
        { version, error: { ...fixture.error, code: "IMAGE_AUTH_REQUIRED", retryable: true } },
        401,
      ),
  ]) {
    let calls = 0;
    await assert.rejects(
      setup(async () => {
        calls++;
        return response();
      }).subscribe("ij_fixture", 0, () => {}, new AbortController().signal),
    );
    assert.equal(calls, 1);
  }
});

test("SSE abort cancels pending reader and abort during reconnect clears timer", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let opened;
  const ready = new Promise((resolve) => {
    opened = resolve;
  });
  const client = setup(async () => {
    opened();
    return streamResponse("", {
      keepOpen: true,
      onCancel: () => {
        cancelled = true;
      },
    });
  });
  const pending = client.subscribe("ij_fixture", 0, () => {}, controller.signal);
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("secret reason"));
  await assert.rejects(pending, errorCode("IMAGE_ABORTED"));
  assert.equal(cancelled, true);
  const scope = new AbortController();
  let calls = 0;
  const retrying = setup(
    async () => {
      calls++;
      return streamResponse("");
    },
    { signal: scope.signal },
  );
  const retry = retrying.subscribe("ij_fixture", 0, () => {}, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  scope.abort();
  await assert.rejects(retry, errorCode("IMAGE_ABORTED"));
  assert.equal(calls, 1);
});

test("scope abort reaches binary requests; pre-aborted upload performs no request", async () => {
  const scope = new AbortController();
  let calls = 0;
  let opened;
  const ready = new Promise((resolve) => {
    opened = resolve;
  });
  const client = setup(
    async (_url, init) => {
      calls++;
      opened();
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("native secret")), {
          once: true,
        }),
      );
    },
    { signal: scope.signal },
  );
  const pending = client.readAsset("ia_fixture", "original");
  await ready;
  scope.abort();
  await assert.rejects(pending, errorCode("IMAGE_ABORTED"));
  await assert.rejects(client.upload(new Blob(), "file.png"), errorCode("IMAGE_ABORTED"));
  assert.equal(calls, 1);
});

test("export delegates exact destination and reports actual saved; no remote download fallback", async () => {
  const calls = [];
  const client = setup(
    async () => {
      throw new Error("unexpected HTTP");
    },
    {
      exports: {
        download: async (id, signal) => {
          calls.push({ id, signal });
          return { saved: false, nativePath: "private" };
        },
        remote_workspace: async (id) => {
          calls.push({ id });
          return { saved: true };
        },
      },
    },
  );
  assert.deepEqual(await client.exportAsset("ia_fixture", "download"), { saved: false });
  assert.deepEqual(await client.exportAsset("ia_fixture", "remote_workspace"), { saved: true });
  await assert.rejects(
    client.exportAsset("ia_fixture", "local_workspace"),
    errorCode("IMAGE_UNSUPPORTED_OPERATION"),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "ia_fixture");
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("transport refreshes auth headers per call without exposing credentials in URL or redirect", async () => {
  let revision = 0;
  const client = setup(
    async (url, init) => {
      assert.equal(init.headers.get("Authorization"), `Bearer ${revision}`);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(url, "https://backend.test/proxy/v1/image/targets");
      return json({ version, items: [] });
    },
    {},
    { headers: async () => ({ Authorization: `Bearer ${++revision}` }) },
  );
  await client.listTargets();
  await client.listTargets();
  assert.equal(revision, 2);
  assert.throws(
    () => fetchTransport({ baseUrl: "https://user:secret@backend.test" }),
    errorCode("IMAGE_INVALID_INPUT"),
  );
});

test("target verification requires paid consent and forwards stable key with typed receipt", async () => {
  const requests = [];
  const receipt = {
    id: "iv_test",
    targetId: "it_test",
    jobId: "ij_test",
    state: "pending",
    jobStatus: "running",
    settingsRevision: 1,
  };
  const client = setup(async (url, init) => {
    requests.push({ url, init });
    return json({ version, verification: receipt });
  });
  const input = {
    expectedRevision: 1,
    projectId: "ip_test",
    connectionId: "ic_test",
    remoteId: "gpt-image-2",
    targetRevision: 1,
    operation: "generate",
    count: 1,
    prompt: "测试海报",
    confirmPaid: false,
  };
  await assert.rejects(() => client.startTargetVerification("it_test", input, "verify-key"));
  assert.equal(requests.length, 0);
  assert.deepEqual(
    await client.startTargetVerification("it_test", { ...input, confirmPaid: true }, "verify-key"),
    receipt,
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(new Headers(requests[0].init.headers).get("X-Idempotency-Key"), "verify-key");
  assert.match(requests[0].url, /targets\/it_test\/verify$/);
  assert.deepEqual(await client.getTargetVerification("it_test", "iv_test"), receipt);
  assert.match(requests[1].url, /targets\/it_test\/verifications\/iv_test$/);
  assert.notEqual(requests[1].init.method, "POST");
});

test("verification recovery uses authenticated GET and the original key without a submit", async () => {
  const calls = [];
  const receipt = {
    id: "iv_recovered",
    targetId: "it_test",
    state: "pending",
    settingsRevision: 1,
  };
  const client = setup(async (url, init) => {
    calls.push({ url, init });
    return json({ version, verification: receipt });
  });
  assert.deepEqual(await client.getTargetVerificationByKey("it_test", "original-key"), receipt);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /targets\/it_test\/verifications\/by-key$/);
  assert.notEqual(calls[0].init.method, "POST");
  assert.equal(new Headers(calls[0].init.headers).get("X-Idempotency-Key"), "original-key");
});

test("verification journal survives client recreation without another paid submit", async () => {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  let posts = 0;
  const receipt = { id: "iv_journal", targetId: "it_test", state: "pending", settingsRevision: 1 };
  const fetch = async (_url, init) => {
    if (init.method === "POST") posts++;
    return json({ version, verification: receipt });
  };
  const first = setup(fetch, { verificationStorage: storage });
  const input = {
    expectedRevision: 1,
    projectId: "ip_test",
    connectionId: "ic_test",
    remoteId: "gpt-image-2",
    targetRevision: 1,
    operation: "generate",
    count: 1,
    prompt: "fixture",
    confirmPaid: true,
  };
  await first.startTargetVerification("it_test", input, "journal-key");
  const second = setup(fetch, { verificationStorage: storage });
  const restored = second.loadVerificationAttempt("it_test");
  assert.equal(restored.key, "journal-key");
  assert.equal(restored.receipt.id, "iv_journal");
  await second.getTargetVerificationByKey("it_test", restored.key);
  assert.equal(posts, 1);
});

test("unwritable verification journal prevents paid submission", async () => {
  let calls = 0;
  const client = setup(
    async () => {
      calls++;
      return json({ version });
    },
    {
      verificationStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    },
  );
  const input = {
    expectedRevision: 1,
    projectId: "ip_test",
    connectionId: "ic_test",
    remoteId: "gpt-image-2",
    targetRevision: 1,
    operation: "generate",
    count: 1,
    prompt: "fixture",
    confirmPaid: true,
  };
  await assert.rejects(() => client.startTargetVerification("it_test", input, "journal-key"));
  assert.equal(calls, 0);
});

test("verification journal rejects corruption, competing keys and resetting unresolved work", async () => {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  let calls = 0,
    state = "pending";
  const receipt = () => ({ id: "iv_journal", targetId: "it_test", state, settingsRevision: 1 });
  const client = setup(
    async () => {
      calls++;
      return json({ version, verification: receipt() });
    },
    { verificationStorage: storage },
  );
  const input = {
    expectedRevision: 1,
    projectId: "ip_test",
    connectionId: "ic_test",
    remoteId: "gpt-image-2",
    targetRevision: 1,
    operation: "generate",
    count: 1,
    prompt: "fixture",
    confirmPaid: true,
  };
  await client.startTargetVerification("it_test", input, "original-key");
  assert.throws(
    () => client.clearVerificationAttempt("it_test"),
    errorCode("IMAGE_RESULT_UNKNOWN"),
  );
  await assert.rejects(
    () => client.startTargetVerification("it_test", input, "different-key"),
    errorCode("IMAGE_IDEMPOTENCY_CONFLICT"),
  );
  assert.equal(calls, 1);
  state = "verified";
  await client.getTargetVerificationByKey("it_test", "original-key");
  assert.equal(client.loadVerificationAttempt("it_test").receipt.state, "verified");
  client.clearVerificationAttempt("it_test");
  assert.equal(client.loadVerificationAttempt("it_test"), null);
  const path = [...values.keys()][0];
  values.set(path, "not-json");
  assert.throws(
    () => client.loadVerificationAttempt("it_test"),
    errorCode("IMAGE_VERIFICATION_STORAGE_UNAVAILABLE"),
  );
  await assert.rejects(
    () => client.startTargetVerification("it_test", input, "new-key"),
    errorCode("IMAGE_VERIFICATION_STORAGE_UNAVAILABLE"),
  );
  assert.equal(calls, 2);
});

test("deleteJob sends DELETE to the job path and surfaces 409 as a typed error", async () => {
  const calls = [];
  let busy = false;
  const client = setup(async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (busy)
      return json(
        {
          version,
          error: {
            code: "IMAGE_PROJECT_BUSY",
            message: "Image job is still active",
            retryable: false,
            requestId: "r",
          },
        },
        409,
      );
    return json({ version, deleted: true });
  });
  await client.deleteJob("ij_fixture");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].url.pathname, "/proxy/v1/image/jobs/ij_fixture");
  busy = true;
  await assert.rejects(client.deleteJob("ij_fixture"), errorCode("IMAGE_PROJECT_BUSY", 409));
});
