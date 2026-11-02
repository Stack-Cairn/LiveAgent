import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function transport() {
  const loader = createTsModuleLoader({ mocks: {
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: { isTauriHost: () => false },
  } });
  return loader.loadModule("src/lib/kbrain/transport.ts").fetchKBrain;
}

test("image multipart keeps browser boundary and backend authentication", async () => {
  const body = new FormData();
  body.append("file", new Blob(["synthetic"], { type: "image/png" }), "test.png");
  let calls = 0;
  const fetchKBrain = transport();
  await fetchKBrain("/v1/image/assets", { method: "POST", body }, {
    baseUrl: "https://backend.test", token: "test-token",
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.body, body);
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-token");
      return Response.json({});
    },
  });
  assert.equal(calls, 1);
});

test("existing JSON bodies retain type and binary bodies preserve explicit media type", async () => {
  const fetchKBrain = transport();
  for (const [body, contentType, expected] of [
    ["{}", undefined, "application/json"],
    [new Blob(["test"]), "image/png", "image/png"],
    [new Blob(["test"]), undefined, null],
  ]) {
    await fetchKBrain("/v1/test", { method: "POST", body, headers: contentType ? { "Content-Type": contentType } : {} }, {
      baseUrl: "https://backend.test", fetch: async (_url, init) => {
        assert.equal(new Headers(init.headers).get("Content-Type"), expected);
        return Response.json({});
      },
    });
  }
});

test("image write rejection retains idempotency key and never automatically replays", async () => {
  const fetchKBrain = transport();
  let calls = 0;
  const response = await fetchKBrain("/v1/image/jobs", { method: "POST", body: "{}", headers: { "Idempotency-Key": "same-request" } }, {
    baseUrl: "https://backend.test", token: "test-token", fetch: async (_url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).get("Idempotency-Key"), "same-request");
      return new Response(null, { status: 401 });
    },
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});
