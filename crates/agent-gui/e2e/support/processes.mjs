// Child process helpers: every process started by the suite is tracked by PID
// and stopped by that PID, with its output teed into a log file.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { connect } from "node:net";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startProcess(command, args, { env, cwd, logFile, name = command } = {}) {
  await mkdir(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} ${name}: ${command} ${args.join(" ")}\n`);
  const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      log.write(`--- ${name} exited code=${code} signal=${signal}\n`);
      resolve({ code, signal });
    });
  });
  child.once("error", (error) => log.write(`--- ${name} failed to start: ${error.message}\n`));
  return {
    child,
    name,
    exited,
    async stop(timeoutMs = 5000) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const done = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
        if (!done) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      log.end();
    },
  };
}

export async function waitForPort(port, { host = "127.0.0.1", timeoutMs = 60_000, process: owner } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (owner && owner.child.exitCode !== null) {
      throw new Error(`${owner.name} exited (code ${owner.child.exitCode}) before listening on ${port}`);
    }
    const open = await new Promise((resolve) => {
      const socket = connect({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${host}:${port}`);
}

export async function waitForHttp(url, { timeoutMs = 60_000, headers } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
      lastError = new Error(`${url}: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`);
}
