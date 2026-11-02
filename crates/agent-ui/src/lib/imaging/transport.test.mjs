import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createImageStudioClient, fetchTransport } = loader.loadModule(
  "@liveagent/ui/lib/imaging/client",
);
const fixture = JSON.parse(
  readFileSync(new URL("./testdata/wire-v1.json", import.meta.url), "utf8"),
);
const { version } = fixture;
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const errorCode = (code, status) => (error) => {
  assert.equal(error.name, "ImageClientError");
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};
const frame = (seq, type = "job.state_changed", status = "running") =>
  `id: ${seq}\nevent: image.event\ndata: ${JSON.stringify({ ...fixture.event, seq, type, data: { status } })}\n\n`;
const stream = (content) =>
  new Response(content, { headers: { "Content-Type": "text/event-stream" } });
const turn = () => new Promise((resolve) => setImmediate(resolve));
const clientFor = (transport, options = {}) => createImageStudioClient({ transport, ...options });

test("unversioned gateway errors preserve 401/503/413 and redact upstream text", async () => {
  for (const [status, code] of [
    [401, "IMAGE_AUTH_REQUIRED"],
    [503, "IMAGE_UNAVAILABLE"],
    [413, "IMAGE_TOO_LARGE"],
  ]) {
    const client = clientFor(async () =>
      json({ error: "sentinel credential", message: "private upstream URL" }, status),
    );
    await assert.rejects(client.capabilities(), (error) => {
      errorCode(code, status)(error);
      assert.equal(JSON.stringify(error).includes("sentinel"), false);
      assert.equal(error.message.includes("private"), false);
      return true;
    });
  }
});

test("wrapped pagination preserves opaque cursor through a second page; data arrays fail", async () => {
  const paths = [];
  const cursor = "page/+?=&中文";
  const client = clientFor(async (path) => {
    paths.push(path);
    const url = new URL(path, "https://test.invalid");
    assert.equal(url.searchParams.get("projectId"), "ip_fixture");
    if (paths.length === 1)
      return json({ version, data: { items: [fixture.job], nextCursor: cursor } });
    assert.equal(url.searchParams.get("cursor"), cursor);
    return json({ version, data: { items: [] } });
  });
  const first = await client.listJobs("ip_fixture");
  assert.equal(first.items[0].items[1].status, "failed");
  assert.equal(first.nextCursor, cursor);
  const last = await client.listJobs("ip_fixture", first.nextCursor);
  assert.equal(last.items.length, 0);
  assert.equal(last.nextCursor, undefined);
  for (const data of [[], [fixture.job], null, { items: null }, { items: [], nextCursor: 4 }]) {
    await assert.rejects(
      clientFor(async () => json({ version, data })).listProjects(),
      errorCode("IMAGE_PROTOCOL_ERROR"),
    );
  }
});

test("scope cancellation inside a callback prevents subsequent events in the same chunk", async () => {
  const scope = new AbortController();
  const received = [];
  const client = clientFor(
    async () => stream(frame(1) + frame(2) + frame(3, "job.finished", "succeeded")),
    { signal: scope.signal },
  );
  await assert.rejects(
    client.subscribe(
      "ij_fixture",
      0,
      (event) => {
        received.push(event.seq);
        scope.abort();
      },
      new AbortController().signal,
    ),
    errorCode("IMAGE_ABORTED"),
  );
  assert.deepEqual(received, [1]);
});

test("a late transport response after scope change is cancelled and never consumed", async () => {
  let release;
  let cancelled = 0;
  const scope = new AbortController();
  const client = clientFor(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    { signal: scope.signal },
  );
  const pending = client.readAsset("ia_fixture", "original");
  scope.abort();
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "Content-Type": "image/png" } },
    ),
  );
  await assert.rejects(pending, errorCode("IMAGE_ABORTED"));
  assert.equal(cancelled, 1);
});

test("pre-aborted client prevents all public network methods and host exports", async () => {
  const scope = new AbortController();
  scope.abort();
  let calls = 0;
  const client = clientFor(
    async () => {
      calls++;
      throw new Error("unexpected request");
    },
    {
      signal: scope.signal,
      exports: {
        download: async () => {
          calls++;
          return { saved: true };
        },
      },
    },
  );
  const methods = [
    () => client.capabilities(),
    () => client.listTargets(),
    () => client.getSettings(),
    () => client.saveSettings({ expectedRevision: 0, connections: [], targets: [] }),
    () => client.writeSecret({ connectionId: "ic_fixture", purpose: "bearer", value: "sentinel" }),
    () => client.listProjects(),
    () => client.createProject("poster"),
    () => client.updateProject("ip_fixture", "title", 0),
    () => client.deleteProject("ip_fixture"),
    () => client.upload(new Blob(), "poster.png"),
    () => client.createJob(fixture.job.request, "stable-key"),
    () => client.getJob("ij_fixture"),
    () => client.listJobs("ip_fixture"),
    () => client.cancelJob("ij_fixture"),
    () =>
      client.subscribe(
        "ij_fixture",
        0,
        () => assert.fail("unexpected event"),
        new AbortController().signal,
      ),
    () => client.readAsset("ia_fixture", "original"),
    () => client.exportAsset("ia_fixture", "download"),
  ];
  for (const invoke of methods) await assert.rejects(invoke(), errorCode("IMAGE_ABORTED"));
  assert.equal(calls, 0);
});

test("default SSE backoff is 1/2/4/8/15 seconds with a finite total budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const client = clientFor(async () => {
    calls++;
    return stream(": heartbeat\n\n");
  });
  const pending = client.subscribe("ij_fixture", 0, () => {}, new AbortController().signal);
  const failure = assert.rejects(pending, errorCode("IMAGE_STREAM_ENDED"));
  await turn();
  assert.equal(calls, 1);
  for (const ms of [1000, 2000, 4000, 8000, 15000]) {
    const before = calls;
    t.mock.timers.tick(ms - 1);
    await turn();
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await turn();
    assert.equal(calls, before + 1);
  }
  await failure;
  assert.equal(calls, 6);
});

test("SSE retries network/429/503 using authenticated GET and the last accepted cursor", async () => {
  const calls = [];
  let authReads = 0;
  const transport = fetchTransport({
    baseUrl: "https://backend.invalid",
    headers: () => ({ Authorization: `Bearer test-${++authReads}` }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return stream(frame(1));
      if (calls.length === 2) throw new Error("private upstream detail");
      if (calls.length === 3) return json({ error: "quota" }, 429);
      if (calls.length === 4) return json({ error: "unavailable" }, 503);
      return stream(frame(1) + frame(2, "job.finished", "succeeded"));
    },
  });
  const received = [];
  await clientFor(transport, { reconnectDelaysMs: [0, 0, 0, 0] }).subscribe(
    "ij_fixture",
    0,
    (e) => received.push(e.seq),
    new AbortController().signal,
  );
  assert.deepEqual(received, [1, 2]);
  assert.deepEqual(
    calls.map((c) => c.init.headers.get("Last-Event-ID")),
    ["0", "1", "1", "1", "1"],
  );
  calls.forEach(({ url, init }, i) => {
    assert.equal(init.headers.get("Authorization"), `Bearer test-${i + 1}`);
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(new URL(url).search, "");
  });
});

test("SSE callback failures are redacted and do not reconnect or deliver the next event", async () => {
  let calls = 0;
  let received = 0;
  const client = clientFor(async () => {
    calls++;
    return stream(frame(1) + frame(2));
  });
  await assert.rejects(
    client.subscribe(
      "ij_fixture",
      0,
      () => {
        received++;
        throw new Error("sentinel");
      },
      new AbortController().signal,
    ),
    (error) => {
      errorCode("IMAGE_CALLBACK_FAILED")(error);
      assert.equal(String(error).includes("sentinel"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(received, 1);
});

test("malformed UTF-8, unsafe media type, oversized lines and empty-data floods close without retry", async () => {
  const responses = [
    () => stream(new Uint8Array([0xc3, 0x28])),
    () => new Response(frame(1), { headers: { "Content-Type": "text/event-stream-unsafe" } }),
    () => stream(`data: ${"x".repeat(1024 * 1024)}\n\n`),
    () => stream("data:\n".repeat(180000)),
  ];
  for (const response of responses) {
    let calls = 0;
    const client = clientFor(async () => {
      calls++;
      return response();
    });
    await assert.rejects(
      client.subscribe(
        "ij_fixture",
        0,
        () => assert.fail("unexpected event"),
        new AbortController().signal,
      ),
      errorCode("IMAGE_PROTOCOL_ERROR"),
    );
    assert.equal(calls, 1);
  }
});

test("gap recovery uses a refreshed snapshot cursor, not the stale event cursor", async () => {
  const paths = [];
  let subscriptions = 0;
  const client = clientFor(async (path, init) => {
    paths.push(path);
    if (!path.endsWith("/events"))
      return json({
        version,
        job: { ...fixture.job, status: "running" },
        firstAvailableSeq: 9,
        lastEventSeq: 12,
      });
    subscriptions++;
    if (subscriptions === 1)
      return json(
        {
          version,
          error: {
            ...fixture.error,
            code: "IMAGE_EVENT_GAP",
            details: { firstAvailableSeq: 9, lastEventSeq: 12 },
          },
        },
        409,
      );
    assert.equal(new Headers(init.headers).get("Last-Event-ID"), "12");
    return stream(frame(13, "job.finished", "partial_succeeded"));
  });
  await assert.rejects(
    client.subscribe("ij_fixture", 2, () => {}, new AbortController().signal),
    errorCode("IMAGE_EVENT_GAP", 409),
  );
  const snapshot = await client.getJob("ij_fixture");
  const received = [];
  await client.subscribe(
    snapshot.id,
    snapshot.lastEventSeq,
    (event) => received.push(event.seq),
    new AbortController().signal,
  );
  assert.deepEqual(received, [13]);
  assert.equal(paths.length, 3);
});
