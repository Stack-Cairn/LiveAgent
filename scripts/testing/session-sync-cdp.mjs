import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export class CdpClient {
  static async connect(endpoint, timeoutMs = 10_000) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CDP connect timeout: ${endpoint}`)), timeoutMs);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`CDP connection failed: ${endpoint}`));
      };
    });
    return new CdpClient(socket, timeoutMs);
  }

  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
    socket.onclose = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    };
  }

  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  async evaluate(expression, awaitPromise = true) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }

  async screenshot(path) {
    const result = await this.request("Page.captureScreenshot", { format: "png", fromSurface: true });
    if (!result.data) throw new Error("CDP returned no screenshot data");
    await writeFile(path, Buffer.from(result.data, "base64"));
  }

  close() {
    this.socket.close();
  }
}

export async function findTargets(port, urlPrefix = "http://localhost:") {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  return targets.filter(
    (candidate) =>
      candidate.type === "page" &&
      candidate.url.startsWith(urlPrefix) &&
      candidate.webSocketDebuggerUrl,
  );
}

async function findTarget(port, urlPrefix = "http://localhost:", index = 0) {
  const target = (await findTargets(port, urlPrefix))[index];
  if (!target) throw new Error(`no page target on CDP port ${port} for ${urlPrefix}`);
  return target;
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { action, options } = parseArguments(process.argv.slice(2));
  const target = await findTarget(
    Number(options.port ?? 9222),
    options.url ?? "http://localhost:",
    Number(options.index ?? 0),
  );
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    if (action === "eval") {
      if (!options.script) throw new Error("eval requires --script");
      console.log(JSON.stringify(await client.evaluate(options.script)));
    } else if (action === "screenshot") {
      if (!options.output) throw new Error("screenshot requires --output");
      await client.screenshot(options.output);
      console.log(JSON.stringify({ output: options.output }));
    } else if (action === "login-clipboard") {
      const origin = new URL(target.url).origin;
      await client.request("Browser.grantPermissions", {
        origin,
        permissions: ["clipboardReadWrite"],
      });
      await client.request("Emulation.setFocusEmulationEnabled", { enabled: true });
      let nativeToken;
      try {
        const { stdout } = await execFileAsync("pwsh", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-Clipboard -Raw",
        ]);
        nativeToken = stdout.trim();
      } catch {
        nativeToken = "";
      }
      const result = await client.evaluate(`(async () => {
        let token = '';
        try { token = await navigator.clipboard.readText(); } catch {}
        if (!token) token = ${JSON.stringify(nativeToken)};
        const field = document.querySelector('textarea#access-token');
        const button = Array.from(document.querySelectorAll('button')).find((item) =>
          item.textContent.includes('Gateway')
        );
        if (!field || !button || !token) throw new Error('Gateway login controls or clipboard token missing');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, token);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        button.click();
        return { submitted: true, tokenLengthPositive: token.length > 0 };
      })()`);
      console.log(JSON.stringify(result));
    } else if (action === "new-page") {
      const url = options.newUrl ?? target.url;
      const result = await client.request("Target.createTarget", { url });
      console.log(JSON.stringify({ created: Boolean(result.targetId) }));
    } else if (action === "bring-front") {
      await client.request("Page.bringToFront");
      console.log(JSON.stringify({ focused: true }));
    } else {
      throw new Error(`unknown action: ${action ?? ""}`);
    }
  } finally {
    client.close();
  }
}
