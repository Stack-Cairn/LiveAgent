import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { countSessionTranscripts } from "./session-sync-tools.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  if (!options.binary || !options.output) throw new Error("--binary and --output are required");
  return { binary: resolve(options.binary), output: resolve(options.output) };
}

function waitForFirstLine(child, stderr, timeoutMs = 10_000) {
  return new Promise((resolveLine, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error(`fixture startup timed out: ${stderr.value}`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveLine(stdout.slice(0, newline));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}: ${stderr.value}`)));
  });
}

function collect(child) {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
}

const options = parseArguments(process.argv.slice(2));
await mkdir(options.output, { recursive: false });
const fixtureStderr = { value: "" };
const fixture = spawn(process.execPath, [resolve("scripts/testing/session-sync-mock-model.mjs"), "--port", "0"], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
fixture.stderr.on("data", (chunk) => (fixtureStderr.value += chunk));
try {
  const ready = JSON.parse(await waitForFirstLine(fixture, fixtureStderr));
  const config = {
    defaultModel: "session-sync-model",
    maxRetries: 1,
    providers: {
      fixture: {
        name: "fixture",
        api: "openai-completions",
        baseUrl: ready.baseUrl,
        apiKey: "fixture-key",
        models: [{ id: "session-sync-model", contextWindow: 32_000, maxTokens: 1_024 }],
      },
    },
  };
  await writeFile(resolve(options.output, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const run = spawn(
    options.binary,
    [
      "run",
      "--format",
      "json",
      "--quiet",
      "--max-turns",
      "1",
      "--timeout",
      "20s",
      "-m",
      "session-sync-model",
      "-p",
      "fixture",
      "Reply with the fixture response.",
    ],
    {
      windowsHide: true,
      env: { ...process.env, LIVEAGENT_HOME: options.output, K_BRAIN_HOME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = await collect(run);
  await Promise.all([
    writeFile(resolve(options.output, "kn-run.ndjson"), result.stdout),
    writeFile(resolve(options.output, "kn-run.stderr.log"), result.stderr),
  ]);
  if (result.code !== 0) throw new Error(`kn run failed (${result.code}): ${result.stderr}`);
  const events = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!events.some((event) => JSON.stringify(event).includes("session sync fixture response"))) {
    throw new Error("kn run did not emit the fixture response");
  }
  const metrics = await fetch(ready.metricsUrl).then((response) => response.json());
  const manifest = {
    binary: options.binary,
    fixture: ready,
    metrics,
    eventTypes: events.map((event) => event.type),
    sessionTranscriptCount: await countSessionTranscripts(options.output),
  };
  await writeFile(resolve(options.output, "result.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
} finally {
  if (!fixture.killed) fixture.kill();
}
