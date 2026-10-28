import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CdpClient } from "./session-sync-cdp.mjs";

export function buildEdgeArguments(options) {
  return [
    "--headless=new",
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.profile}`,
    "--disable-gpu",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    options.url,
  ];
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  if (!options.profile || !options.url) throw new Error("--profile and --url are required");
  return {
    edge:
      options.edge ??
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    profile: resolve(options.profile),
    url: options.url,
    port: Number(options.port ?? 9330),
    pages: Number(options.pages ?? 2),
    manifest: options.manifest,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(options.profile, { recursive: false });
  const child = spawn(options.edge, buildEdgeArguments(options), {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  let version;
  while (Date.now() < deadline) {
    try {
      version = await fetch(`http://127.0.0.1:${options.port}/json/version`).then((response) => response.json());
      if (version.webSocketDebuggerUrl) break;
    } catch {
      // The detached browser has not opened its debugging socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (!version?.webSocketDebuggerUrl) throw new Error("Edge did not open its CDP endpoint within 15 seconds");
  const client = await CdpClient.connect(version.webSocketDebuggerUrl);
  try {
    // Headless Edge accepts one command-line target. Additional real pages
    // must be created after startup through CDP.
    for (let index = 1; index < options.pages; index += 1) {
      await client.request("Target.createTarget", { url: options.url });
    }
  } finally {
    client.close();
  }
  const manifest = {
    pid: child.pid,
    profile: options.profile,
    url: options.url,
    port: options.port,
    pages: options.pages,
    startedAt: new Date().toISOString(),
  };
  if (options.manifest) await writeFile(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
}
