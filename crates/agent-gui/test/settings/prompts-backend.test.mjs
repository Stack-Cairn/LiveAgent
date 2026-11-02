import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const HOST_MODULE = fileURLToPath(new URL("../../src/lib/host.ts", import.meta.url));
const { workspaceProjectPathKey } = createTsModuleLoader().loadModule("@liveagent/ui/lib/settings/workspaceProjects");
const BROWSER_KEY = "liveagent.kbrain-browser-settings.v1";

test("original prompt settings save and reload through the real K-brain factory and upstream request", { timeout: 120_000 }, async () => {
  const binary = await getKBrainBinary();
  const root = await mkdtemp(path.join(tmpdir(), "kbrain-prompts-"));
  const home = path.join(root, "home");
  const workdir = path.join(root, "workspace");
  await mkdir(path.join(home, "prompts"), { recursive: true });
  await mkdir(workdir);
  await writeFile(path.join(workdir, "AGENTS.md"), "AGENTS_RULE_MARKER\n");
  await writeFile(path.join(home, "brain.md"), "BRAIN_RULE_MARKER\n");
  await writeFile(path.join(home, "system.md"), "SYSTEM_RULE_MARKER\n");
  await writeFile(path.join(home, "prompts", "review.md"), "---\ndescription: Review files\nargument-hint: file mode\n---\nReview [$1] using [$2]. All: $@\n");
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] }));
    }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const config = path.join(home, "config.json");
  await writeFile(config, JSON.stringify({ defaultModel: "fixture-model", providers: { fixture: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: "fixture-key",
    models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }],
  } } }));
  let child;
  let baseUrl;
  let logs = "";
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const cache = new Map([[BROWSER_KEY, JSON.stringify({ system: { workdir } })]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, String(value)),
  } });
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    await ended;
  }
  async function start() {
    logs = "";
    child = spawn(binary, ["backend", "-listen", "127.0.0.1:0", "-token", "prompt-token", "-config", config, "-session-dir", path.join(root, "sessions")], {
      cwd: workdir,
      env: { ...process.env, LIVEAGENT_HOME: home, K_BRAIN_HOME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", data => { logs += data; });
    baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`backend readiness timeout: ${logs}`)), 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`backend exited ${code}: ${logs}`)); });
      child.stdout.on("data", data => {
        logs += data;
        const match = logs.match(/k-brain backend listening on (http:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
  }
  const nativeCalls = [];
  function modules(browser = true) {
    const loader = createTsModuleLoader({ mocks: {
      [HOST_MODULE]: { isKBrainBrowserHost: () => browser, isKBrainBackendEnabled: () => true, isTauriHost: () => !browser, kBrainOwnedDesktopCommand: () => false },
      "@tauri-apps/api/core": { invoke: async (command, args) => {
        nativeCalls.push({ command, args });
        if (command === "settings_load_all") return { agents: [{ id: "stale", name: "Stale", prompt: "STALE_NATIVE", enabled: true }], system: { workdir, workspaceResourceSettings: { [workdir]: { mode: "custom", skillNames: ["selected-skill"], mcpServerIds: [], projectPrompt: "STALE_NATIVE", projectPromptStrategy: "replace" } } } };
        if (command === "settings_save_system") return {};
        assert.fail(`unexpected native command: ${command}`);
      } },
    } });
    loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({ baseUrl, token: "prompt-token", protocolVersion: "kbrain.agent.v1" });
    return {
      storage: loader.loadModule("src/lib/settings/storage.ts"),
      settings: loader.loadModule("src/lib/settings/index.ts"),
      prompts: loader.loadModule("src/lib/kbrain/prompts.ts").createKBrainPromptClient(),
    };
  }
  async function api(endpoint, body) {
    const response = await fetch(baseUrl + endpoint, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer prompt-token", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response;
  }
  let sequence = 0;
  async function turn(sessionID, text) {
    const start = requests.length;
    const accepted = await (await api(`/v1/sessions/${sessionID}/runs`, { conversation_id: sessionID, client_request_id: `prompt-${++sequence}`, prompt: text })).json();
    const events = await (await api(`/v1/sessions/${sessionID}/events?after_seq=${accepted.accepted_seq - 1}`)).text();
    assert.match(events, /run.completed/);
    assert.doesNotMatch(events, /run.failed/);
    const request = requests.slice(start).find(item => item.stream && item.messages?.at(-1)?.content?.split("\n\n<kbrain-context>")[0]?.endsWith(`</kbrain-turn-time>\n\n${text}`));
    assert.ok(request, JSON.stringify(requests.slice(start)));
    return request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  }
  try {
    await start();
    assert.equal((await fetch(baseUrl + "/v1/prompts")).status, 401);
    let { storage, settings, prompts } = modules();
    let loaded = await storage.loadPersistedSettings();
    let next = settings.updateAgents(loaded, [
      { id: "first", name: "First", description: "", prompt: "GLOBAL_ALPHA_MARKER", enabled: true },
      { id: "second", name: "Second", description: "", prompt: "GLOBAL_BETA_MARKER", enabled: false },
    ]);
    next = settings.updateWorkspacePromptSettings(next, workdir, { projectPrompt: "PROJECT_APPEND_MARKER", projectPromptStrategy: "append" });
    await storage.persistSettings(loaded, next);
    assert.equal((await prompts.get(workdir)).effectivePrompt, "GLOBAL_ALPHA_MARKER\n\nPROJECT_APPEND_MARKER");
    const session = await (await api("/v1/sessions", { cwd: workdir, model: { provider: "fixture", model: "fixture-model" } })).json();
    const initialPrompt = await turn(session.id, "first settings prompt");
    assert.match(initialPrompt, /GLOBAL_ALPHA_MARKER/);
    assert.match(initialPrompt, /PROJECT_APPEND_MARKER/);
    assert.doesNotMatch(initialPrompt, /GLOBAL_BETA_MARKER/);
    assert.match(initialPrompt, /AGENTS_RULE_MARKER/);
    assert.match(initialPrompt, /BRAIN_RULE_MARKER/);

    const firstRequest = requests.find(item => item.stream && item.messages?.at(-1)?.content?.split("\n\n<kbrain-context>")[0]?.endsWith("\n\nfirst settings prompt"));
    assert.doesNotMatch(initialPrompt, /Current date\/time:/);
    assert.match(firstRequest.messages.at(-1).content, /^<kbrain-turn-time>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/kbrain-turn-time>/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(await turn(session.id, "unchanged resources followup"), initialPrompt);
    const followup = requests.find(item => item.stream && item.messages?.at(-1)?.content?.split("\n\n<kbrain-context>")[0]?.endsWith("\n\nunchanged resources followup"));
    assert.deepEqual(followup.messages.slice(0, firstRequest.messages.length), firstRequest.messages);
    assert.deepEqual(followup.tools, firstRequest.tools);

    loaded = await storage.loadPersistedSettings();
    next = settings.updateAgents(loaded, loaded.agents.map(item => ({ ...item, enabled: item.id === "second" })));
    next = settings.updateWorkspacePromptSettings(next, workdir, { projectPrompt: "PROJECT_REPLACE_MARKER", projectPromptStrategy: "replace" });
    await storage.persistSettings(loaded, next);
    assert.equal((await prompts.get(workdir)).effectivePrompt, "PROJECT_REPLACE_MARKER");
    const replacedPrompt = await turn(session.id, "changed settings same session");
    assert.match(replacedPrompt, /PROJECT_REPLACE_MARKER/);
    assert.doesNotMatch(replacedPrompt, /GLOBAL_ALPHA_MARKER|GLOBAL_BETA_MARKER|PROJECT_APPEND_MARKER/);
    assert.match(replacedPrompt, /AGENTS_RULE_MARKER/);
    assert.match(replacedPrompt, /BRAIN_RULE_MARKER/);
    assert.match(replacedPrompt, /SYSTEM_RULE_MARKER/);
    const beforeRestart = requests.find(item => item.stream && item.messages?.at(-1)?.content?.split("\n\n<kbrain-context>")[0]?.endsWith("\n\nchanged settings same session"));

    await stop();
    await start();
    ({ storage, settings, prompts } = modules());
    loaded = await storage.loadPersistedSettings();
    assert.equal(loaded.agents.find(item => item.enabled).id, "second");
    assert.equal(settings.resolveEffectivePromptSettings(loaded, workdir).prompt, "PROJECT_REPLACE_MARKER");
    assert.equal((await prompts.get(workdir)).effectivePrompt, "PROJECT_REPLACE_MARKER");
    assert.match(await turn(session.id, "reloaded settings prompt"), /PROJECT_REPLACE_MARKER/);
    const afterRestart = requests.find(item => item.stream && item.messages?.at(-1)?.content?.split("\n\n<kbrain-context>")[0]?.endsWith("\n\nreloaded settings prompt"));
    assert.deepEqual(afterRestart.messages.slice(0, beforeRestart.messages.length), beforeRestart.messages);
    assert.deepEqual(afterRestart.tools, beforeRestart.tools);
    next = settings.updateWorkspacePromptSettings(loaded, workdir, { projectPrompt: "PROJECT_APPEND_AFTER_RELOAD", projectPromptStrategy: "append" });
    await storage.persistSettings(loaded, next);
    const expanded = await prompts.expandMarkdown("review", ["src/two words.ts", "strict 'quoted'"], workdir);
    assert.equal(expanded.text, "Review [src/two words.ts] using [strict 'quoted']. All: src/two words.ts strict 'quoted'");
    const appendedPrompt = await turn(session.id, expanded.text);
    assert.match(appendedPrompt, /GLOBAL_BETA_MARKER/);
    assert.match(appendedPrompt, /PROJECT_APPEND_AFTER_RELOAD/);
    assert.doesNotMatch(appendedPrompt, /GLOBAL_ALPHA_MARKER|PROJECT_REPLACE_MARKER/);
    assert.doesNotMatch(cache.get(BROWSER_KEY), /GLOBAL_|PROJECT_/);
    assert.equal((await storage.loadPersistedSettings()).system.workspaceResourceSettings[workspaceProjectPathKey(workdir)].projectPromptStrategy, "append");
    const desktop = modules(false);
    const desktopLoaded = await desktop.storage.loadPersistedSettings();
    assert.equal(desktop.settings.resolveEffectivePromptSettings(desktopLoaded, workdir).prompt, "GLOBAL_BETA_MARKER\n\nPROJECT_APPEND_AFTER_RELOAD");
    assert.deepEqual(desktopLoaded.system.workspaceResourceSettings[workspaceProjectPathKey(workdir)].skillNames, ["selected-skill"]);
    const desktopNext = desktop.settings.updateWorkspacePromptSettings(desktopLoaded, workdir, { projectPrompt: "DESKTOP_PROJECT_MARKER", projectPromptStrategy: "replace" });
    await desktop.storage.persistSettings(desktopLoaded, desktopNext);
    assert.equal((await desktop.prompts.get(workdir)).effectivePrompt, "DESKTOP_PROJECT_MARKER");
    assert.match(await turn(session.id, "desktop prompt settings"), /DESKTOP_PROJECT_MARKER/);
    const invalid = desktop.settings.updateAgents(desktopNext, [{ id: "invalid/id", name: "Invalid", description: "", prompt: "unsaved", enabled: true }]);
    await assert.rejects(desktop.storage.persistSettings(desktopNext, invalid), error => error.code === "save_failed");
    assert.equal((await desktop.prompts.get()).globalTemplates.find(item => item.enabled).id, "second");
    const cleared = desktop.settings.updateWorkspacePromptSettings(desktopNext, workdir, { projectPrompt: "", projectPromptStrategy: "replace" });
    await desktop.storage.persistSettings(desktopNext, cleared);
    assert.equal((await desktop.prompts.get(workdir)).effectivePrompt, "GLOBAL_BETA_MARKER");
    const clearedPrompt = await turn(session.id, "cleared project settings");
    assert.match(clearedPrompt, /GLOBAL_BETA_MARKER/);
    assert.doesNotMatch(clearedPrompt, /DESKTOP_PROJECT_MARKER/);
    assert.ok(nativeCalls.every(call => call.command !== "settings_save_agents"));
    for (const call of nativeCalls.filter(call => call.command === "settings_save_system")) {
      const entry = call.args.payload.workspaceResourceSettings[workspaceProjectPathKey(workdir)];
      assert.equal(entry.projectPrompt, undefined);
      assert.equal(entry.projectPromptStrategy, undefined);
      assert.deepEqual(entry.skillNames, ["selected-skill"]);
    }
  } finally {
    await stop();
    await new Promise(resolve => upstream.close(resolve));
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
    await rm(root, { recursive: true, force: true });
  }
});
