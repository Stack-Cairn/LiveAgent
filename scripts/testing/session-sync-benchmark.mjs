import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runBenchmarkRequests(options) {
  const {
    url,
    bursts = 5,
    requestsPerBurst = 3,
    intervalMs = 60_000,
    token,
    outputPath,
  } = options;
  if (!url) throw new Error("url is required");
  if (!Number.isInteger(bursts) || bursts < 1) throw new Error("bursts must be positive");
  if (!Number.isInteger(requestsPerBurst) || requestsPerBurst < 1) {
    throw new Error("requestsPerBurst must be positive");
  }
  const rows = [];
  for (let burst = 0; burst < bursts; burst += 1) {
    for (let request = 0; request < requestsPerBurst; request += 1) {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const response = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
      const body = Buffer.from(await response.arrayBuffer());
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      const row = {
        burst,
        request,
        startedAt,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        status: response.status,
        responseBytes: body.length,
        totalCount: parsed?.total_count,
        sessionCount: Array.isArray(parsed?.sessions) ? parsed.sessions.length : undefined,
      };
      rows.push(row);
      if (outputPath) await appendFile(outputPath, `${JSON.stringify(row)}\n`);
      if (!response.ok) throw new Error(`benchmark request failed: HTTP ${response.status}`);
    }
    if (burst + 1 < bursts) await delay(intervalMs);
  }
  return rows;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return {
    url: options.url,
    bursts: options.bursts === undefined ? 5 : Number(options.bursts),
    requestsPerBurst: options.requests === undefined ? 3 : Number(options.requests),
    intervalMs: options.interval === undefined ? 60_000 : Number(options.interval),
    token: options.token,
    outputPath: options.output,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rows = await runBenchmarkRequests(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify({ requests: rows.length, last: rows.at(-1) }));
}
