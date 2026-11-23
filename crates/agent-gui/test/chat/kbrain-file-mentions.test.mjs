import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The K-brain browser host has no native fs_mention_list command; @ file
// mentions are served from K-brain's /v1/fs "mention_list" when the backend has
// it (capability filesystem_mention_list), else from its "list" walk, instead
// of failing with "Tauri command ... is unavailable".

const source = (name) => new URL(`../../src/${name}`, import.meta.url).pathname;
const requests = [];
let respond = () => ({ status: 200, body: { entries: [] } });
let capabilities = {};
function loadHost() {
  const loader = createTsModuleLoader({
    mocks: {
      [source("lib/kbrain/runtimeConnection.ts")]: {
        getConfiguredKBrainConnection: () => ({ baseUrl: "http://kb.test", token: "secret", protocolVersion: "kbrain.agent.v1" }),
        resolveKBrainClientOptions: (input) => ({ baseUrl: "http://kb.test", token: "secret", ...input }),
      },
      [source("lib/host.ts")]: {
        isKBrainBackendEnabled: () => true,
        isKBrainBrowserHost: () => true,
        isTauriHost: () => false,
        kBrainOwnedDesktopCommand: () => false,
      },
      "@tauri-apps/api/core": {
        invoke: async () => {
          throw new Error("native invoke must not be used in the browser host");
        },
        isTauri: () => false,
      },
    },
  });
  return {
    invoke: loader.loadModule("src/shims/tauriCore.ts").invoke,
    rankFileMentions: loader.loadModule("src/lib/kbrain/fileMentions.ts").rankFileMentions,
  };
}
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (path === "/v1/health") {
    return new Response(JSON.stringify({ version: "kbrain.agent.v1", status: "ok", capabilities }), {
      status: 200,
    });
  }
  const body = JSON.parse(init.body ?? "{}");
  requests.push({ path, body });
  const { status, body: out } = respond(body);
  return {
    ok: status < 300,
    status,
    headers: new Headers(),
    json: async () => out,
    text: async () => JSON.stringify(out),
  };
};
// An older backend: no filesystem_mention_list capability.
const { invoke, rankFileMentions } = loadHost();

const tree = [
  { path: "README.md", kind: "file", hidden: false },
  { path: "src", kind: "dir", hidden: false },
  { path: "src/app.ts", kind: "file", hidden: false },
  { path: "src/NOTES.md", kind: "file", hidden: false },
  { path: "node_modules", kind: "dir", hidden: false },
  { path: "node_modules/pkg/readme.md", kind: "file", hidden: false },
  { path: "docs/guide/readme-extra.md", kind: "file", hidden: false },
];

test.beforeEach(() => {
  requests.length = 0;
});

test("fs_mention_list in the browser host lists through K-brain /v1/fs", async () => {
  respond = () => ({ status: 200, body: { entries: tree, has_more: false } });
  const result = await invoke("fs_mention_list", {
    workdir: "/ws",
    max_results: 5000,
    query: "",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v1/fs");
  assert.deepEqual(requests[0].body, {
    action: "list",
    workdir: "/ws",
    path: "",
    depth: 8,
    max_results: 10000,
    show_hidden: false,
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["src", "README.md", "src/app.ts", "src/NOTES.md", "docs/guide/readme-extra.md"],
  );
  assert.equal(result.truncated, false);
});

test("a query filters case-insensitively and ranks name prefixes first", async () => {
  respond = () => ({ status: 200, body: { entries: tree } });
  const result = await invoke("fs_mention_list", { workdir: "/ws", query: "@README" });
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["README.md", "docs/guide/readme-extra.md"],
  );
});

test("a tree too large for one walk falls back to shallower depths", async () => {
  respond = (body) =>
    body.depth > 2
      ? { status: 422, body: { error: "filesystem tree exceeds 10000 entries; narrow path or depth" } }
      : { status: 200, body: { entries: tree.slice(0, 2) } };
  const result = await invoke("fs_mention_list", { workdir: "/ws" });
  assert.deepEqual(
    requests.map((request) => request.body.depth),
    [8, 4, 2],
  );
  assert.equal(result.entries.length, 2);
  assert.equal(result.truncated, true);
});

test("other K-brain errors keep their reason", async () => {
  respond = () => ({
    status: 422,
    body: { error: "filesystem path is outside configured roots; configure backend -filesystem-root" },
  });
  await assert.rejects(invoke("fs_mention_list", { workdir: "/elsewhere" }), /outside configured roots/);
  assert.equal(requests.length, 1);
});

test("other native commands still fail clearly in the browser host", async () => {
  await assert.rejects(invoke("fs_list", { workdir: "/ws" }), /unavailable in K-brain browser mode/);
});

test("ranking caps results and marks the list truncated", () => {
  const ranked = rankFileMentions(tree, "", 2);
  assert.deepEqual(
    ranked.entries.map((entry) => entry.path),
    ["src", "README.md"],
  );
  assert.equal(ranked.truncated, true);
});

// A backend with capability filesystem_mention_list ranks and filters itself.
const mentionTree = [
  { path: "server", kind: "dir" },
  { path: "internal/server.go", kind: "file" },
  { path: ".github/server.yml", kind: "file" },
];

test("a backend with mention_list answers the lookup itself, capped at 500", async () => {
  capabilities = { filesystem_mention_list: 1 };
  const host = loadHost();
  respond = (body) =>
    body.action === "mention_list"
      ? { status: 200, body: { path: "", query: "serv", entries: mentionTree, truncated: true } }
      : { status: 500, body: { error: "list must not be used" } };
  const result = await host.invoke("fs_mention_list", {
    workdir: "/ws",
    max_results: 5000,
    query: "@Serv",
  });
  assert.deepEqual(requests.map((request) => request.body), [
    { action: "mention_list", workdir: "/ws", path: "", query: "serv", max_results: 500 },
  ]);
  // Hidden entries stay out unless show_hidden asks for them, like the native command.
  assert.deepEqual(result, {
    entries: [
      { path: "server", kind: "dir", hidden: false },
      { path: "internal/server.go", kind: "file", hidden: false },
    ],
    truncated: true,
  });
  requests.length = 0;
  const withHidden = await host.invoke("fs_mention_list", {
    workdir: "/ws",
    query: "serv",
    max_results: 80,
    show_hidden: true,
  });
  assert.equal(requests[0].body.max_results, 80);
  assert.deepEqual(withHidden.entries.at(-1), { path: ".github/server.yml", kind: "file", hidden: true });
});

test("mention_list errors other than an unknown action keep their reason", async () => {
  capabilities = { filesystem_mention_list: 1 };
  const host = loadHost();
  respond = () => ({
    status: 422,
    body: { error: "filesystem path is outside configured roots; configure backend -filesystem-root" },
  });
  await assert.rejects(host.invoke("fs_mention_list", { workdir: "/elsewhere", query: "a" }), /outside configured roots/);
  assert.equal(requests.length, 1);
});

for (const [status, error] of [
  [422, "unsupported filesystem action"],
  [400, 'invalid JSON: json: unknown field "query"'],
]) {
  test(`a backend that turns mention_list down (${status}) falls back to the list walk`, async () => {
    capabilities = { filesystem_mention_list: 1 };
    const host = loadHost();
    respond = (body) =>
      body.action === "mention_list"
        ? { status, body: { error } }
        : { status: 200, body: { entries: tree } };
    const result = await host.invoke("fs_mention_list", { workdir: "/ws", query: "readme" });
    assert.deepEqual(
      requests.map((request) => request.body.action),
      ["mention_list", "list"],
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.path),
      ["README.md", "docs/guide/readme-extra.md"],
    );
  });
}

test("a whole-workspace index request keeps the list walk", async () => {
  capabilities = { filesystem_mention_list: 1 };
  const host = loadHost();
  respond = () => ({ status: 200, body: { entries: tree } });
  await host.invoke("fs_mention_list", { workdir: "/ws", max_results: 20000, query: "" });
  assert.deepEqual(
    requests.map((request) => request.body.action),
    ["list"],
  );
});
