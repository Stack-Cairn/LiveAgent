import { appendFile, writeFile } from "node:fs/promises";

import { CdpClient, findTargets } from "./session-sync-cdp.mjs";

const options = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, index, values) => (index % 2 === 0 ? [...pairs, [value.slice(2), values[index + 1]]] : pairs), []),
);
if (!options.output) throw new Error("--output is required");
const durationMs = Number(options.duration ?? 60_000);
const sources = [
  ["desktop", Number(options.desktopPort ?? 9222), "http://localhost:1420/"],
  ["webui", Number(options.webPort ?? 9331), "http://127.0.0.1:50052/"],
];
const clients = [];
let errorCount = 0;
const startedAt = new Date().toISOString();
for (const [role, port, prefix] of sources) {
  for (const [index, target] of (await findTargets(port, prefix)).entries()) {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl, 30_000);
    clients.push(client);
    const record = async (kind, params) => {
      errorCount += 1;
      const raw = JSON.stringify(params);
      await appendFile(
        options.output,
        `${JSON.stringify({ at: new Date().toISOString(), role, index, kind, detail: raw.slice(0, 2_000) })}\n`,
      );
    };
    client.on("Runtime.exceptionThrown", (params) => void record("exception", params));
    client.on("Log.entryAdded", (params) => {
      if (["error", "warning"].includes(params?.entry?.level)) void record("log", params);
    });
    await client.request("Runtime.enable");
    await client.request("Log.enable");
  }
}
await new Promise((resolve) => setTimeout(resolve, durationMs));
for (const client of clients) client.close();
const result = { startedAt, finishedAt: new Date().toISOString(), targets: clients.length, errorCount };
if (options.summary) await writeFile(options.summary, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
