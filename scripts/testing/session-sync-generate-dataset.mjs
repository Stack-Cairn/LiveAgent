import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createSessionDataset } from "./session-sync-tools.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  if (!options.root) throw new Error("--root is required");
  return {
    root: resolve(options.root),
    count: options.count === undefined ? 248 : Number(options.count),
    totalBytes: options.bytes === undefined ? 251 * 1024 * 1024 : Number(options.bytes),
    seed: options.seed ?? "session-sync-v1",
    workdirCount: options.workdirs === undefined ? 12 : Number(options.workdirs),
  };
}

const options = parseArguments(process.argv.slice(2));
const result = await createSessionDataset(options.root, options);
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  root: options.root,
  ...result,
};
await writeFile(
  resolve(options.root, "session-sync-dataset.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest));
