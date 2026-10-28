import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CdpClient, findTargets } from "./session-sync-cdp.mjs";

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(probe, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`${description} timed out; last=${JSON.stringify(last)}`);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  if (!options.output || !options.workdir) throw new Error("--output and --workdir are required");
  return {
    output: resolve(options.output),
    workdir: resolve(options.workdir).replaceAll("\\", "/"),
    desktopPort: Number(options.desktopPort ?? 9222),
    webPort: Number(options.webPort ?? 9331),
    durationMs: Number(options.duration ?? 30 * 60_000),
    intervalMs: Number(options.interval ?? 30_000),
    maxIterations: Number(options.iterations ?? Number.POSITIVE_INFINITY),
    prefix: options.prefix ?? "cycle",
  };
}

const options = parseArguments(process.argv.slice(2));
await mkdir(options.output, { recursive: false });
const desktopTarget = (await findTargets(options.desktopPort, "http://localhost:1420/"))[0];
if (!desktopTarget) throw new Error("desktop target is unavailable");
const desktop = await CdpClient.connect(desktopTarget.webSocketDebuggerUrl, 30_000);
const webTargets = await findTargets(options.webPort, "http://127.0.0.1:50052/");
if (webTargets.length < 2) throw new Error(`two WebUI pages required, got ${webTargets.length}`);
const webClients = await Promise.all(
  webTargets.slice(0, 2).map((target) => CdpClient.connect(target.webSocketDebuggerUrl, 30_000)),
);
for (const client of webClients) {
  await client.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => item.getAttribute('aria-label') === '打开边栏'
    );
    button?.click();
    return true;
  })()`);
}
await delay(500);

async function desktopEval(body) {
  return desktop.evaluate(`(async () => { ${body} })()`);
}

async function webContains(client, text) {
  await client.request("Page.bringToFront");
  return client.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
}

const startedAt = new Date().toISOString();
const deadline = Date.now() + options.durationMs;
let iteration = 0;
try {
  while (Date.now() < deadline && iteration < options.maxIterations) {
    const id = `${options.prefix}-${String(iteration).padStart(4, "0")}`;
    const created = await desktopEval(`
      const connection = await window.__TAURI_INTERNALS__.invoke('kbrain_backend_connection');
      const response = await fetch(connection.baseUrl + '/v1/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: ${JSON.stringify(options.workdir)},
          model: { provider: 'fixture', model: 'fixture-model' },
          title: ${JSON.stringify(id)},
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: ${JSON.stringify(id + " message")} }]
          }]
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body));
      return { backendId: body.id, revision: globalThis.__LIVEAGENT_SESSION_SYNC_DIAGNOSTICS__?.().revision };
    `);
    await desktopEval(`
      const connection = await window.__TAURI_INTERNALS__.invoke('kbrain_backend_connection');
      const response = await fetch(connection.baseUrl + '/v1/sessions/' + ${JSON.stringify(created.backendId)}, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true })
      });
      if (!response.ok) throw new Error(await response.text());
      return true;
    `);
    await waitFor(
      () => desktop.evaluate(`document.body.innerText.includes(${JSON.stringify(id)})`),
      `${id} desktop create`,
      90_000,
    );
    for (const client of webClients) {
      await waitFor(() => webContains(client, id), `${id} WebUI create`, 15_000);
    }

    const renamed = `${id}-renamed`;
    await desktopEval(`
      const connection = await window.__TAURI_INTERNALS__.invoke('kbrain_backend_connection');
      const response = await fetch(connection.baseUrl + '/v1/sessions/' + ${JSON.stringify(created.backendId)}, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: ${JSON.stringify(renamed)}, pinned: true, cwd: ${JSON.stringify(options.workdir)} })
      });
      if (!response.ok) throw new Error(await response.text());
      return true;
    `);
    await waitFor(
      () => desktop.evaluate(`document.body.innerText.includes(${JSON.stringify(renamed)})`),
      `${id} desktop rename`,
      90_000,
    );
    for (const client of webClients) {
      await waitFor(() => webContains(client, renamed), `${id} WebUI rename`, 15_000);
    }

    if (iteration % 4 === 0) {
      await desktop.evaluate(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); true`);
    }
    await desktopEval(`
      const connection = await window.__TAURI_INTERNALS__.invoke('kbrain_backend_connection');
      const response = await fetch(connection.baseUrl + '/v1/sessions/' + ${JSON.stringify(created.backendId)}, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + connection.token }
      });
      if (!response.ok) throw new Error(await response.text());
      return true;
    `);
    await waitFor(
      () => desktop.evaluate(`!document.body.innerText.includes(${JSON.stringify(renamed)})`),
      `${id} desktop delete`,
      90_000,
    );
    for (const client of webClients) {
      await waitFor(async () => {
        await client.request("Page.bringToFront");
        return client.evaluate(`!document.body.innerText.includes(${JSON.stringify(renamed)})`);
      }, `${id} WebUI delete`, 15_000);
    }
    const row = {
      iteration,
      id,
      finishedAt: new Date().toISOString(),
      diagnostics: await desktop.evaluate("globalThis.__LIVEAGENT_SESSION_SYNC_DIAGNOSTICS__?.()"),
    };
    await appendFile(resolve(options.output, "cycles.jsonl"), `${JSON.stringify(row)}\n`);
    iteration += 1;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(options.intervalMs, remaining));
  }
  await writeFile(
    resolve(options.output, "result.json"),
    `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), iterations: iteration }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ iterations: iteration }));
} finally {
  desktop.close();
  for (const client of webClients) client.close();
}
