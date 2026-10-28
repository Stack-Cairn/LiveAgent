import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const rootIndex = process.argv.indexOf("--root");
const baseIndex = process.argv.indexOf("--base-url");
if (rootIndex < 0 || !process.argv[rootIndex + 1] || baseIndex < 0 || !process.argv[baseIndex + 1]) {
  throw new Error("--root and --base-url are required");
}
const root = resolve(process.argv[rootIndex + 1]);
const config = {
  defaultModel: "fixture-model",
  maxRetries: 1,
  providers: {
    fixture: {
      name: "fixture",
      api: "openai-completions",
      baseUrl: process.argv[baseIndex + 1],
      apiKey: "fixture-key",
      models: [{ id: "fixture-model", contextWindow: 32_000, maxTokens: 1_024 }],
    },
  },
};
await mkdir(root, { recursive: true });
await writeFile(resolve(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(JSON.stringify({ configured: true, root, model: "fixture-model" }));
