import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { buildBridgeRequest } from "./session-sync-tools.mjs";

export function bridgeCall(port, command, args = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (callback) => {
      clearTimeout(timeout);
      socket.close();
      callback();
    };
    socket.onerror = () => finish(() => reject(new Error(`cannot connect to MCP bridge ${port}`)));
    socket.onopen = () => socket.send(JSON.stringify(buildBridgeRequest(command, args, id)));
    socket.onmessage = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id) return;
      finish(() => {
        if (response.success === false) reject(new Error(response.error ?? `${command} failed`));
        else resolve(response);
      });
    };
  });
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return { action, options };
}

const { action, options } = parseArguments(process.argv.slice(2));
if (action) {
  const port = Number(options.port ?? 9223);
  let response;
  if (action === "windows") {
    response = await bridgeCall(port, "list_windows");
  } else if (action === "state") {
    response = await bridgeCall(port, "get_backend_state");
  } else if (action === "eval") {
    if (!options.script) throw new Error("eval requires --script");
    response = await bridgeCall(port, "execute_js", {
      script: options.script,
      windowLabel: options.window ?? "main",
    });
  } else if (action === "screenshot") {
    if (!options.output) throw new Error("screenshot requires --output");
    response = await bridgeCall(port, "capture_native_screenshot", {
      format: "png",
      windowLabel: options.window ?? "main",
      maxWidth: options.width === undefined ? undefined : Number(options.width),
    });
    const dataUrl = response.data;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error("bridge returned no PNG screenshot");
    }
    await writeFile(options.output, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
  } else if (action === "resize") {
    if (!options.width || !options.height) throw new Error("resize requires --width and --height");
    response = await bridgeCall(port, "resize_window", {
      width: Number(options.width),
      height: Number(options.height),
      windowId: options.window ?? "main",
      logical: true,
    });
  } else {
    throw new Error(`unknown action: ${action}`);
  }
  console.log(JSON.stringify(response));
}
