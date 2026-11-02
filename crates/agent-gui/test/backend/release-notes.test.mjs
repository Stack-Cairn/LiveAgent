import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");
const notesScript = path.join(repoRoot, "scripts/release/create-ai-release-notes.mjs");

function runNotesScript(args, env = {}, options = {}) {
  return spawnSync(process.execPath, [notesScript, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runNotesScriptAsync(args, env = {}, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [notesScript, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed\n${result.stderr}`);
}

function initTaggedRepo(dir, tag) {
  runGit(["init"], dir);
  runGit(["config", "user.name", "Release Test"], dir);
  runGit(["config", "user.email", "release-test@example.com"], dir);
  writeFileSync(path.join(dir, "README.md"), "# Release test\n");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "Initial release"], dir);
  runGit(["tag", "v0.1.5"], dir);
  writeFileSync(path.join(dir, "README.md"), "# Release test\n\nAI notes.\n");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "Improve release notes"], dir);
  runGit(["tag", tag], dir);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("AI release notes script falls back when no K-brain token is configured", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-notes-"));
  try {
    const outputPath = path.join(dir, "notes.md");
    const fallbackPath = path.join(dir, "fallback.md");
    writeFileSync(fallbackPath, "## What's Changed\n\n- Fallback notes.\n");
    const result = runNotesScript(["v0.1.6", outputPath, fallbackPath], {
      KBRAIN_TOKEN: "",
      K_BRAIN_TOKEN: "",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(outputPath, "utf8"), "## What's Changed\n\n- Fallback notes.\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AI release notes script sends exactly one canonical K-brain text request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-notes-"));
  let requestBody = "";
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/text/generate");
    assert.equal(request.headers.authorization, "Bearer kbrain-test-token");
    request.setEncoding("utf8");
    request.on("data", (chunk) => { requestBody += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        version: "kbrain.agent.v1",
        text: "# LiveAgent v0.1.6\n\n> Generated through K-brain.\n\n## Overview\n\nLiveAgent now uses one canonical model request.",
        model: { provider: "fixture", model: "fixture-model" },
      }));
    });
  });
  try {
    const address = await listen(server);
    initTaggedRepo(dir, "v0.1.6");
    const outputPath = path.join(dir, "notes.md");
    const result = await runNotesScriptAsync(["v0.1.6", outputPath], {
      KBRAIN_TOKEN: "kbrain-test-token",
      KBRAIN_URL: `http://${address.address}:${address.port}`,
      AI_RELEASE_NOTES_PROVIDER: "fixture",
      AI_RELEASE_NOTES_MODEL: "fixture-model",
    }, { cwd: dir });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const requestJson = JSON.parse(requestBody);
    assert.deepEqual(requestJson.model, { provider: "fixture", model: "fixture-model" });
    assert.equal(requestJson.output, "text");
    assert.deepEqual(requestJson.messages.map((message) => message.role), ["system", "user"]);
    assert.match(JSON.stringify(requestJson.messages), /Release tag: v0\.1\.6/);
    assert.match(readFileSync(outputPath, "utf8"), /^# LiveAgent v0\.1\.6/);
    assert.match(readFileSync(outputPath, "utf8"), /canonical model request/);
  } finally {
    await close(server);
    rmSync(dir, { force: true, recursive: true });
  }
});
