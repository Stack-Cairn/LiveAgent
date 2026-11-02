import { readFile, writeFile } from "node:fs/promises";

import { buildMetricSummary } from "./session-sync-tools.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  if (!options.samples) throw new Error("--samples is required");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const samples = (await readFile(options.samples, "utf8"))
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const result = buildMetricSummary(samples, {
  logicalProcessors: Number(options.processors ?? process.env.NUMBER_OF_PROCESSORS ?? 1),
});
if (options.requests) {
  const requests = (await readFile(options.requests, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  result.requests = {
    count: requests.length,
    minimumMs: Math.min(...requests.map((request) => request.elapsedMs)),
    maximumMs: Math.max(...requests.map((request) => request.elapsedMs)),
    averageMs:
      Math.round(
        (requests.reduce((sum, request) => sum + request.elapsedMs, 0) / requests.length) * 100,
      ) / 100,
  };
}
const output = `${JSON.stringify(result, null, 2)}\n`;
if (options.output) await writeFile(options.output, output);
console.log(output.trim());
