import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export function runAcpSessionList(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, options.args ?? ["acp"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const pending = new Map();
    let sequence = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`ACP session/list timed out: ${stderr}`));
    }, options.timeoutMs ?? 20_000);
    const finish = (callback) => {
      clearTimeout(timeout);
      child.stdin.end();
      callback();
    };
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (code && pending.size > 0) finish(() => reject(new Error(`ACP exited ${code}: ${stderr}`)));
    });
    const send = (method, params) => {
      const id = ++sequence;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise((resolveResult, rejectResult) => pending.set(id, { resolveResult, rejectResult }));
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const request = pending.get(Number(message.id));
      if (!request) return;
      pending.delete(Number(message.id));
      if (message.error) request.rejectResult(new Error(JSON.stringify(message.error)));
      else request.resolveResult(message.result);
    });
    (async () => {
      const initialize = await send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const listed = await send("session/list", {});
      finish(() => resolve({ initialize, sessions: listed.sessions ?? [], nextCursor: listed.nextCursor }));
    })().catch((error) => finish(() => reject(error)));
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  if (!options.binary) throw new Error("--binary is required");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArguments(process.argv.slice(2));
  const result = await runAcpSessionList({
    binary: options.binary,
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      LIVEAGENT_HOME: options.home ?? process.env.LIVEAGENT_HOME,
      K_BRAIN_HOME: "",
    },
  });
  console.log(JSON.stringify(result));
}
