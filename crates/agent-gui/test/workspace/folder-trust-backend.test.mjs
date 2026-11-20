import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Cross-repository check: LiveAgent's folder trust client against a real K-brain
// backend in a temporary home. Trusting the folder must make its project
// prompt templates appear in the composer command catalog without a restart.

async function startBackend(t) {
  const binary = await getKBrainBinary();
  const root = await mkdtemp(path.join(tmpdir(), "kbrain-trust-"));
  const home = path.join(root, "home");
  const workdir = path.join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(workdir, ".liveagent", "prompts"), { recursive: true });
  await writeFile(
    path.join(workdir, ".liveagent", "prompts", "ship.md"),
    "---\ndescription: Ship the project\nargument-hint: target\n---\nSHIP $1\n",
  );
  const link = path.join(root, "link");
  await symlink(workdir, link);
  const config = path.join(home, "config.json");
  // The provider is never called: these routes do not run the model.
  await writeFile(
    config,
    JSON.stringify({
      defaultModel: "fixture-model",
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9",
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }],
        },
      },
    }),
  );
  let logs = "";
  const child = spawn(
    binary,
    ["backend", "-listen", "127.0.0.1:0", "-token", "trust-token", "-config", config, "-session-dir", path.join(root, "sessions")],
    { cwd: root, env: { ...process.env, HOME: home, LIVEAGENT_HOME: home, K_BRAIN_HOME: "" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (data) => {
    logs += data;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend readiness timeout: ${logs}`)), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`backend exited ${code}: ${logs}`));
    });
    child.stdout.on("data", (data) => {
      logs += data;
      const match = logs.match(/k-brain backend listening on (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const loader = createTsModuleLoader();
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl,
    token: "trust-token",
    protocolVersion: "kbrain.agent.v1",
  });
  return { loader, home, workdir, link };
}

test("trusting a folder from LiveAgent exposes its project commands immediately", { timeout: 120_000 }, async (t) => {
  const { loader, home, link } = await startBackend(t);
  const { createKBrainFolderTrustClient, subscribeKBrainFolderTrustChanged } = loader.loadModule("src/lib/kbrain/folderTrust.ts");
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
  const trust = createKBrainFolderTrustClient();
  const client = createKBrainClient();

  if (!(await trust.supported())) {
    t.skip("pinned K-brain predates /v1/trust; build K-brain with folder trust and set LIVEAGENT_KBRAIN_BINARY");
    return;
  }
  const projectCommand = async () =>
    (await client.listCommands(link)).find((command) => command.name === "ship");
  const notified = [];
  const unsubscribe = subscribeKBrainFolderTrustChanged((status) => notified.push(status.trusted));
  t.after(unsubscribe);

  const initial = await trust.get(link);
  assert.equal(initial.trusted, false);
  assert.notEqual(initial.workdir, link, "the backend reports the canonical folder, not the symlink");
  assert.equal(await projectCommand(), undefined, "untrusted project commands stay hidden");

  const granted = await trust.trust(link);
  assert.deepEqual(granted, { workdir: initial.workdir, trusted: true, source: initial.workdir });
  assert.deepEqual(
    { kind: (await projectCommand())?.kind, source: (await projectCommand())?.source },
    { kind: "prompt", source: "project" },
  );
  const stored = await readFile(path.join(home, "trusted_folders.toml"), "utf8");
  assert.ok(stored.includes(JSON.stringify(initial.workdir)), "trust is stored in the shared trusted_folders.toml");

  assert.equal((await trust.revoke(link)).trusted, false);
  assert.equal(await projectCommand(), undefined, "revoked project commands disappear again");
  assert.deepEqual(notified, [true, false]);

  await assert.rejects(trust.trust("relative/folder"), (error) => error.status === 400);
  await assert.rejects(trust.get(path.join(home, "missing")), (error) => error.status === 400);
});
