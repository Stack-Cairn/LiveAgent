import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function resourceModules(connection, extraMocks = {}) {
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/lib/host": {
        isKBrainBackendEnabled: () => true,
        isKBrainBrowserHost: () => true,
        isTauriHost: () => false,
        kBrainOwnedDesktopCommand: () => true,
      },
      "@liveagent/ui/lib/hubFetch": {
        hubFetch: () => { throw new Error("Unexpected direct registry request"); },
      },
      ...extraMocks,
    },
  });
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection(connection);
  const host = loader.loadModule("@liveagent/ui/lib/resourceHost.ts");
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").createKbrainSkillsAdapter();
  host.configureResourceHostCapabilities({ ...host.kbrainResourceHostCapabilities, skillsAdapter: adapter });
  return {
    loader, host, adapter,
    skills: loader.loadModule("@liveagent/ui/lib/skills/index.ts"),
    memory: loader.loadModule("@liveagent/ui/lib/memory/api.ts"),
    store: loader.loadModule("@liveagent/ui/pages/skills-hub/skillStoreCache.ts"),
  };
}

async function fixture(t) {
  const requests = [];
  const skills = new Map();
  const memories = new Map();
  let settings = { enabled: true, selected: [] };
  let failList = false;
  let malformedList = false;
  let failMemory = false;
  const summary = (name) => ({ name, description: "Fixture skill", baseDir: name, skillFile: `${name}/SKILL.md`, target: name });
  const install = (name) => { const item = summary(name); skills.set(name, item); return item; };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body, authorization: req.headers.authorization });
    const send = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== "Bearer fixture-token") return send({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/skills") {
      if (failList) return send({ error: "skills unavailable" }, 503);
      return send(malformedList ? {} : { rootDir: "/fixture/skills", skills: [...skills.values()], settings });
    }
    if (url.pathname === "/v1/skills/file") {
      if (!skills.has(url.searchParams.get("path").split("/")[0])) return send({ error: "missing skill" }, 404);
      return send({ content: "# Fixture instructions", truncated: false });
    }
    if (url.pathname === "/v1/skills/settings") { settings = body; return send({ settings }); }
    if (url.pathname === "/v1/skills/store/search") {
      if (url.searchParams.get("q") === "failure") return send({ error: "registry unavailable" }, 502);
      return send({ results: [{ slug: "store-fixture", ownerHandle: "fixture", displayName: "Store fixture", summary: "Install me", latestVersion: "2.0.0", downloads: 2, stars: 1 }], nextCursor: url.searchParams.has("cursor") ? "" : "page-two" });
    }
    if (url.pathname === "/v1/skills/store/install") return send({ action: "clawhub_install", rootDir: "/fixture/skills", installed: [install(body.slug)] });
    if (url.pathname === "/v1/skills/manage") {
      const result = { action: body.action, rootDir: "/fixture/skills" };
      switch (body.action) {
        case "create": result.created = install(body.name); break;
        case "install": result.installed = [install("import-fixture")]; break;
        case "delete": skills.delete(body.name); result.deleted = { name: body.name }; break;
        case "scan_external": result.external = [{ tool: "codex", rootDir: "/fixture/external", exists: true, skills: null, errors: null }]; break;
        case "install_start": result.installJob = { jobId: "fixture-job", phase: "queued", source: body.source, downloadedBytes: 0, startedAt: 1, updatedAt: 1 }; break;
        case "install_status": result.installJob = { jobId: body.jobId, phase: "completed", installed: [install("job-fixture")], downloadedBytes: 42, startedAt: 1, updatedAt: 2, finishedAt: 2 }; break;
        case "install_cancel": result.installJob = { jobId: body.jobId, phase: "cancelled", startedAt: 1, updatedAt: 2, finishedAt: 2 }; break;
        default: return send({ error: `Unexpected action ${body.action}` }, 422);
      }
      return send(result);
    }
    if (url.pathname === "/v1/memory/manage") {
      if (failMemory) return send({ error: "memory unavailable" }, 503);
      const a = body.args;
      switch (body.command) {
        case "memory_paths_info": return send({ root: "/fixture/memory", isFresh: false, isInCloud: false });
        case "memory_list": return send({ entries: [...memories.values()], quota: { used: memories.size, limit: 100 }, truncated: false });
        case "memory_write": memories.set(a.slug, { ...a, unreviewed: true }); return send({ slug: a.slug, created: true });
        case "memory_read": return memories.has(a.slug) ? send(memories.get(a.slug)) : send({ error: "missing memory" }, 404);
        case "memory_update": memories.set(a.slug, { ...memories.get(a.slug), ...a }); return send({ slug: a.slug, updated: true });
        case "memory_accept": memories.get(a.slug).unreviewed = false; return send({ slug: a.slug, updated: true });
        case "memory_delete": memories.delete(a.slug); return send({ slug: a.slug, deleted: true });
        case "memory_wipe_all": memories.clear(); return send({ root: "/fixture/memory", isFresh: true, isInCloud: false });
        default: return send({ error: `Unexpected command ${body.command}` }, 422);
      }
    }
    send({ error: "unknown route" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: "fixture-token", protocolVersion: "kbrain.agent.v1" },
    requests,
    failSkills: () => { failList = true; },
    malformedSkills: () => { failList = false; malformedList = true; },
    failMemory: () => { failMemory = true; },
  };
}

test("original Skills APIs use authenticated HTTP for create/list/read/import/store/settings and install jobs", async (t) => {
  const f = await fixture(t);
  const { skills, adapter, store, host } = resourceModules(f.connection);
  assert.equal(host.getResourceHostCapabilities().skillsBackendManaged, false);
  assert.equal(host.getResourceHostCapabilities().memoryBackendManaged, false);
  await skills.manageSkill({ action: "create", name: "created-fixture", description: "Fixture", body: "Instructions" });
  assert.equal((await skills.discoverSkills({ force: true })).skills[0].name, "created-fixture");
  assert.equal((await skills.readSkillText({ path: "created-fixture/SKILL.md" })).content, "# Fixture instructions");
  await skills.manageSkill({ action: "install", source: "/fixture/external", conflict: "backup" });
  assert.equal((await skills.discoverSkills({ force: true })).skills.length, 2);
  assert.deepEqual((await skills.scanExternalSkills())[0].skills, []);
  const catalog = await store.loadSkillStoreCatalog({ query: "fixture", sort: "downloads", limit: 24 });
  assert.equal(catalog.items[0].latestVersion, "2.0.0");
  assert.deepEqual(catalog.items[0].topics, []);
  assert.equal(catalog.items[0].ownerHandle, "fixture");
  const browse = await store.loadSkillStoreCatalog({ query: "", sort: "stars", limit: 24 });
  assert.equal(browse.cursor, "page-two");
  assert.equal((await store.loadMoreSkillStoreCatalog({ sort: "stars", cursor: browse.cursor, limit: 24 })).cursor, null);
  const installed = await adapter.storeInstall({ slug: "store-fixture", ownerHandle: "fixture" });
  assert.equal(installed.installed[0].name, "store-fixture");
  const job = await skills.startSkillInstallJob({ source: "https://clawhub.ai/api/v1/download?slug=fixture", ownerHandle: "fixture" });
  assert.equal((await skills.getSkillInstallJobStatus(job.jobId)).phase, "done");
  assert.equal((await skills.cancelSkillInstallJob(job.jobId)).phase, "cancelled");
  await adapter.settings({ enabled: false, selected: ["created-fixture"] });
  assert.deepEqual((await adapter.list()).settings, { enabled: false, selected: ["created-fixture"] });
  await skills.manageSkill({ action: "delete", name: "created-fixture" });
  assert.equal((await skills.discoverSkills({ force: true })).skills.some((s) => s.name === "created-fixture"), false);
  await assert.rejects(skills.readSkillText({ path: "created-fixture/SKILL.md" }), /missing skill/);
  await assert.rejects(store.loadSkillStoreCatalog({ query: "failure", sort: "downloads", limit: 24 }), /registry unavailable/);
  const previous = skills.getCachedSkillsDiscovery();
  f.failSkills();
  await assert.rejects(skills.discoverSkills({ force: true }), /skills unavailable/);
  assert.ok(previous.skills.length > 0);
  f.malformedSkills();
  await assert.rejects(skills.discoverSkills({ force: true }), /Invalid K-brain skills list response/);
  assert.ok(f.requests.every((r) => r.authorization === "Bearer fixture-token"));
  assert.equal(f.requests.some((r) => r.body.action === "ensure_builtin"), false);
});

test("original Memory API forwards CRUD, accept and wipe over HTTP and propagates failures", async (t) => {
  const f = await fixture(t);
  const { memory } = resourceModules(f.connection);
  const entry = { slug: "fixture", scope: "global", memoryType: "user", description: "A fixture", body: "First body", actor: "user" };
  assert.equal((await memory.memoryPathsInfo()).root, "/fixture/memory");
  await memory.memoryWrite(entry);
  assert.equal((await memory.memoryList({ includeDaily: true })).entries.length, 1);
  assert.equal((await memory.memoryRead({ slug: entry.slug })).body, "First body");
  await memory.memoryUpdate({ slug: entry.slug, body: "Updated body", mode: "replace" });
  assert.equal((await memory.memoryRead({ slug: entry.slug })).body, "Updated body");
  await memory.memoryAccept({ slug: entry.slug, scope: "global" });
  assert.equal((await memory.memoryRead({ slug: entry.slug })).unreviewed, false);
  await memory.memoryDelete({ slug: entry.slug, scope: "global" });
  await assert.rejects(memory.memoryRead({ slug: entry.slug }), /missing memory/);
  await memory.memoryWrite(entry);
  assert.equal((await memory.memoryWipeAll()).isFresh, true);
  assert.equal((await memory.memoryList({})).entries.length, 0);
  f.failMemory();
  await assert.rejects(memory.memoryList({}), /memory unavailable/);
  const write = f.requests.find((r) => r.body.command === "memory_write");
  assert.deepEqual(write.body.args, entry);
  assert.equal(write.method, "POST");
});

test("Memory page hook exits loading after HTTP failure and retains existing entries", async (t) => {
  const f = await fixture(t);
  const states = [];
  let cursor = 0;
  const { loader, memory } = resourceModules(f.connection, {
    react: {
      useEffect() {},
      useState(initial) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
    },
  });
  const { useMemoryPanelData } = loader.loadModule("@liveagent/ui/pages/settings/memory/useMemoryPanelData.ts");
  const render = () => { cursor = 0; return useMemoryPanelData({ t: (key) => key }); };
  await memory.memoryWrite({ slug: "keep", scope: "global", memoryType: "user", description: "Keep", body: "Body" });
  assert.equal(await render().reload(), true);
  assert.equal(render().entries.length, 1);
  f.failMemory();
  assert.equal(await render().reload(), false);
  assert.equal(render().loading, false);
  assert.equal(render().entries.length, 1);
  assert.match(render().error, /memory unavailable/);
  assert.equal(render().backendManaged, false);
});

const liveConnectionFile = process.env.KBRAIN_RESOURCE_CONNECTION_FILE;
test("real K-brain backend round-trip for uniquely named memory and Skills records", async (t) => {
  // Opt-in integration test: needs a running K-brain backend, so it skips
  // instead of failing when no connection file is provided.
  if (!liveConnectionFile) {
    t.skip("KBRAIN_RESOURCE_CONNECTION_FILE is not set");
    return;
  }
  const connection = JSON.parse(readFileSync(liveConnectionFile, "utf8"));
  const { skills, memory } = resourceModules(connection);
  const suffix = `${Date.now()}`;
  const name = `ui-resource-${suffix}`;
  t.after(async () => {
    await Promise.allSettled([
      skills.manageSkill({ action: "delete", name }),
      memory.memoryDelete({ slug: name, scope: "global", actor: "user" }),
    ]);
  });
  await skills.manageSkill({ action: "create", name, description: "HTTP adapter verification", body: "Read this fixture." });
  assert.ok((await skills.discoverSkills({ force: true })).skills.some((s) => s.name === name));
  assert.match((await skills.readSkillText({ path: `${name}/SKILL.md` })).content, /Read this fixture/);
  assert.equal((await skills.manageSkill({ action: "validate", name })).validation.ok, true);
  const exported = await skills.manageSkill({ action: "package", name });
  t.after(() => rmSync(exported.package.archive, { force: true }));
  await skills.manageSkill({ action: "delete", name });
  const imported = await skills.manageSkill({ action: "install", source: exported.package.archive, conflict: "fail" });
  assert.equal(imported.installed[0].name, name);
  await skills.manageSkill({ action: "delete", name });
  const job = await skills.startSkillInstallJob({ source: exported.package.archive, conflict: "fail" });
  let status;
  for (let i = 0; i < 40; i++) {
    status = await skills.getSkillInstallJobStatus(job.jobId);
    if (["done", "error", "cancelled"].includes(status.phase)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.phase, "done", status.error);
  assert.equal(status.installed[0].name, name);
  assert.match((await skills.readSkillText({ path: `${name}/SKILL.md` })).content, /Read this fixture/);
  await memory.memoryWrite({ slug: name, scope: "global", memoryType: "user", description: "HTTP adapter verification", body: "Original memory body", actor: "user" });
  assert.ok((await memory.memoryList({ scope: "global", limit: 1000 })).entries.some((entry) => entry.slug === name));
  assert.match((await memory.memoryRead({ slug: name, scope: "global" })).body, /Original memory body/);
  await memory.memoryUpdate({ slug: name, scope: "global", body: "Updated memory body", mode: "replace", actor: "user" });
  assert.match((await memory.memoryRead({ slug: name, scope: "global" })).body, /Updated memory body/);
  await memory.memoryAccept({ slug: name, scope: "global" });
  await memory.memoryDelete({ slug: name, scope: "global", actor: "user" });
  await assert.rejects(memory.memoryRead({ slug: name, scope: "global" }));
  await skills.manageSkill({ action: "delete", name });
  await assert.rejects(skills.readSkillText({ path: `${name}/SKILL.md` }));
});
