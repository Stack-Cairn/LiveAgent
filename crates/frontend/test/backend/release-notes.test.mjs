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
    env: {
      ...process.env,
      ...env,
    },
  });
}

function runNotesScriptAsync(args, env = {}, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [notesScript, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
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

test("AI release notes script falls back when no API key is configured", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-notes-"));
  try {
    const outputPath = path.join(dir, "notes.md");
    const fallbackPath = path.join(dir, "fallback.md");
    writeFileSync(fallbackPath, "## What's Changed\n\n- Fallback notes.\n");

    const result = runNotesScript(["v0.1.6", outputPath, fallbackPath], {
      AI_RELEASE_NOTES_API_KEY: "",
      PACKYCODE_API_KEY: "",
      OPENAI_API_KEY: "",
    });

    assert.equal(
      result.status,
      0,
      `notes script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(readFileSync(outputPath, "utf8"), "## What's Changed\n\n- Fallback notes.\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AI release notes script calls Chat Completions API and writes markdown", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-notes-"));
  let requestBody = "";

  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-key");

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "# LiveAgent v0.1.6\n\n> Release notes generated from repository context.\n\n## Overview\n\nLiveAgent now publishes cleaner release notes.",
              },
            },
          ],
        }),
      );
    });
  });

  try {
    const address = await listen(server);
    initTaggedRepo(dir, "v0.1.6");
    const outputPath = path.join(dir, "notes.md");
    const fallbackPath = path.join(dir, "fallback.md");
    writeFileSync(fallbackPath, "## What's Changed\n\n- GitHub fallback notes.\n");

    const result = await runNotesScriptAsync(["v0.1.6", outputPath, fallbackPath], {
      AI_RELEASE_NOTES_API_KEY: "test-key",
      AI_RELEASE_NOTES_BASE_URL: `http://${address.address}:${address.port}/v1`,
      AI_RELEASE_NOTES_MODEL: "gpt-test",
      AI_RELEASE_NOTES_TIMEOUT_MS: "2000",
      PACKYCODE_API_KEY: "",
      OPENAI_API_KEY: "",
    }, { cwd: dir });

    assert.equal(
      result.status,
      0,
      `notes script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const requestJson = JSON.parse(requestBody);
    assert.equal(requestJson.model, "gpt-test");
    assert.equal(requestJson.reasoning_effort, undefined);
    assert.match(JSON.stringify(requestJson.messages), /Release tag: v0\.1\.6/);
    assert.match(readFileSync(outputPath, "utf8"), /^# LiveAgent v0\.1\.6/);
    assert.match(readFileSync(outputPath, "utf8"), /cleaner release notes/);
  } finally {
    await close(server);
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AI release notes script falls back to Responses API when chat output is empty", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-notes-"));
  const requests = [];

  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer test-key");

    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      requests.push({
        body: JSON.parse(requestBody),
        url: request.url,
      });

      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");

      if (request.url === "/v1/chat/completions") {
        response.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
        return;
      }

      assert.equal(request.url, "/v1/responses");
      response.end(
        JSON.stringify({
          output_text:
            "# LiveAgent v0.1.6\n\n> Release notes generated by the Responses fallback.\n\n## Overview\n\nLiveAgent still publishes AI release notes when chat output is empty.",
        }),
      );
    });
  });

  try {
    const address = await listen(server);
    initTaggedRepo(dir, "v0.1.6");
    const outputPath = path.join(dir, "notes.md");
    const fallbackPath = path.join(dir, "fallback.md");
    writeFileSync(fallbackPath, "## What's Changed\n\n- GitHub fallback notes.\n");

    const result = await runNotesScriptAsync(["v0.1.6", outputPath, fallbackPath], {
      AI_RELEASE_NOTES_API_KEY: "test-key",
      AI_RELEASE_NOTES_BASE_URL: `http://${address.address}:${address.port}/v1`,
      AI_RELEASE_NOTES_MODEL: "gpt-test",
      AI_RELEASE_NOTES_TIMEOUT_MS: "2000",
      PACKYCODE_API_KEY: "",
      OPENAI_API_KEY: "",
    }, { cwd: dir });

    assert.equal(
      result.status,
      0,
      `notes script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    assert.deepEqual(requests.map((request) => request.url), [
      "/v1/chat/completions",
      "/v1/responses",
    ]);
    assert.equal(requests[0].body.reasoning_effort, undefined);
    assert.equal(requests[1].body.reasoning, undefined);
    assert.match(readFileSync(outputPath, "utf8"), /^# LiveAgent v0\.1\.6/);
    assert.match(readFileSync(outputPath, "utf8"), /Responses fallback/);
  } finally {
    await close(server);
    rmSync(dir, { force: true, recursive: true });
  }
});
