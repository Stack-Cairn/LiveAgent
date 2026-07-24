#!/usr/bin/env node
// Generates the model metadata catalog (context window / max output)
// consumed by both frontends, from the models.dev open database. The output
// is written byte-identically to:
//   crates/agent-gui/src/lib/models/catalog.generated.ts
//   crates/agent-gateway/web/src/lib/models/catalog.generated.ts
// and is enforced in sync by scripts/check-mirror.mjs.
//
// Usage: node scripts/generate-model-catalog.mjs [--source <url|file>] [--check]
//   --source  alternate api.json URL or local file path (offline debugging)
//   --check   compare against the checked-in snapshot without writing;
//             exits 1 when the data differs
//
// Refresh: make update-model-catalog

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATHS = [
  join(repoRoot, "crates", "agent-gui", "src", "lib", "models", "catalog.generated.ts"),
  join(repoRoot, "crates", "agent-gateway", "web", "src", "lib", "models", "catalog.generated.ts"),
];

const DEFAULT_SOURCE = "https://models.dev/api.json";

// Catalog sections. Each section unions one or more upstream models.dev
// provider keys (first source wins on a same-id conflict — used to prefer the
// China endpoint's limits for vendors that publish both).
//
// The first four sections are the native catalogs behind the app's provider
// types (claude_code→anthropic, gemini→google, codex→openai, xai); scoped
// lookup (findCatalogModel) only ever reads these. The remaining sections are
// mainland-China vendors with no app provider type of their own: they are
// consumed exclusively through findCatalogModelAcrossProviders, so models
// served through claude_code/codex-compatible relays resolve real limits.
//
// Section order is also the adjudication order for duplicate ids across
// sections: ids are deduplicated case-insensitively, first section wins.
// Pure vendor-official catalogs therefore come first; "alibaba" (Bailian) and
// "tencent" (coding plan) host third-party models (glm/kimi/MiniMax/deepseek
// deployments with platform-clamped limits), so they come last and their
// copies of another vendor's models are dropped in favor of the official ones.
const SECTIONS = [
  { key: "anthropic", sources: ["anthropic"], min: 8 },
  { key: "google", sources: ["google"], min: 15 },
  { key: "openai", sources: ["openai"], min: 20 },
  { key: "xai", sources: ["xai"], min: 3 },
  { key: "deepseek", sources: ["deepseek"], min: 3 },
  // zai (Z.AI, international brand) is a superset of zhipuai with identical
  // ids and limits for the overlap; keep the domestic brand as the key.
  { key: "zhipuai", sources: ["zai", "zhipuai"], min: 10 },
  { key: "moonshotai", sources: ["moonshotai-cn", "moonshotai"], min: 8 },
  { key: "minimax", sources: ["minimax-cn", "minimax"], min: 5 },
  { key: "stepfun", sources: ["stepfun"], min: 4 },
  { key: "xiaomi", sources: ["xiaomi"], min: 4 },
  { key: "longcat", sources: ["longcat"], min: 1 },
  { key: "alibaba", sources: ["alibaba-cn", "alibaba"], min: 40 },
  { key: "tencent", sources: ["tencent-coding-plan"], min: 4 },
];

// Models that must exist; their absence signals an upstream schema change
// (or, for unioned sections, a source-key rename).
const SENTINELS = [
  ["anthropic", "claude-sonnet-4-6"],
  ["openai", "gpt-5"],
  ["deepseek", "deepseek-chat"],
  ["zhipuai", "glm-4.6"],
  ["alibaba", "qwen-max"],
];

// Single semantic rule shared with lib/models/modelCatalog.ts (bound together
// by the catalog invariant tests): community catalogs record "output == context"
// for providers that publish no separate output cap, which would zero out the
// input budget of any consumer that reserves the full output. Repair such
// degenerate pairs with a uniform reservation cap.
const MAX_OUTPUT_TOKEN_CAP = 32_000;
function normalizeMaxOutputToken(contextWindow, maxOutputToken) {
  if (maxOutputToken < contextWindow) return maxOutputToken;
  return Math.min(MAX_OUTPUT_TOKEN_CAP, Math.max(1, Math.floor(contextWindow / 4)));
}

function fail(message) {
  console.error(`generate-model-catalog: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, check: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--source") {
      i += 1;
      if (!argv[i]) fail("--source requires a value");
      args.source = argv[i];
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function loadUpstream(source) {
  if (/^https?:\/\//.test(source)) {
    let response;
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      fail(`fetch failed: ${error?.message ?? error}`);
    }
    if (!response.ok) fail(`fetch failed: HTTP ${response.status} from ${source}`);
    try {
      return await response.json();
    } catch (error) {
      fail(`invalid JSON from ${source}: ${error?.message ?? error}`);
    }
  }
  try {
    return JSON.parse(readFileSync(resolve(source), "utf8"));
  } catch (error) {
    fail(`cannot read ${source}: ${error?.message ?? error}`);
  }
  return undefined;
}

// claimedLower: lowercased id -> owning section key. Lowercase-unique ids
// across the whole catalog are what make cross-provider lookup unambiguous
// and let the runtime index add case-insensitive aliases; the invariant is
// re-asserted by test/models/model-catalog.test.mjs.
function extractSection(section, upstream, claimedLower) {
  const entries = [];
  for (const source of section.sources) {
    const providerData = upstream?.[source];
    if (!providerData) fail(`section ${section.key}: source ${source} missing from upstream data`);
    const rawModels = providerData.models;
    if (!rawModels || typeof rawModels !== "object") {
      fail(`section ${section.key}: source ${source} missing models map`);
    }
    for (const [id, model] of Object.entries(rawModels)) {
      // Aggregator-namespaced deployments (e.g. Bailian's "siliconflow/…",
      // "kimi/…") are not vendor model ids; relays never serve them verbatim.
      if (id.includes("/")) {
        console.error(`skip ${source}/${id} (aggregator-prefixed id)`);
        continue;
      }
      const contextWindow = model?.limit?.context;
      const rawOutput = model?.limit?.output;
      if (!model?.modalities?.output?.includes?.("text")) {
        console.error(`skip ${source}/${id} (non-text output)`);
        continue;
      }
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        console.error(`skip ${source}/${id} (invalid limit.context)`);
        continue;
      }
      if (!Number.isInteger(rawOutput) || rawOutput <= 0) {
        console.error(`skip ${source}/${id} (invalid limit.output)`);
        continue;
      }
      const lower = id.toLowerCase();
      const claimedBy = claimedLower.get(lower);
      if (claimedBy === section.key) continue; // CN/global union overlap: first source wins.
      if (claimedBy) {
        console.error(`skip ${source}/${id} (id claimed by section ${claimedBy})`);
        continue;
      }
      claimedLower.set(lower, section.key);
      entries.push({
        id,
        contextWindow,
        maxOutputToken: normalizeMaxOutputToken(contextWindow, rawOutput),
      });
    }
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

function renderEntry(entry) {
  return `    { id: ${JSON.stringify(entry.id)}, contextWindow: ${entry.contextWindow}, maxOutputToken: ${entry.maxOutputToken} },`;
}

function renderCatalog(catalog, snapshotDate) {
  const keys = SECTIONS.map((section) => section.key);
  const lines = [
    "// Generated by scripts/generate-model-catalog.mjs — DO NOT EDIT.",
    `// Source: https://models.dev/api.json (sections: ${keys.join(", ")})`,
    "// Refresh: make update-model-catalog",
    "",
    "export type CatalogModelEntry = {",
    "  id: string;",
    "  contextWindow: number;",
    "  maxOutputToken: number;",
    "};",
    "",
    `export type CatalogProviderId = ${keys.map((key) => JSON.stringify(key)).join(" | ")};`,
    "",
    `export const MODEL_CATALOG_SNAPSHOT_DATE = "${snapshotDate}";`,
    "",
    "export const MODEL_CATALOG: Record<CatalogProviderId, readonly CatalogModelEntry[]> = {",
  ];
  for (const key of keys) {
    lines.push(`  ${key}: [`);
    for (const entry of catalog[key]) lines.push(renderEntry(entry));
    lines.push("  ],");
  }
  lines.push("};", "");
  return lines.join("\n");
}

function stripSnapshotDate(content) {
  return content.replace(/^export const MODEL_CATALOG_SNAPSHOT_DATE = ".*";$/m, "");
}

function readExisting(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv);
const upstream = await loadUpstream(args.source);

const catalog = {};
const claimedLower = new Map();
for (const section of SECTIONS) {
  const entries = extractSection(section, upstream, claimedLower);
  if (entries.length < section.min) {
    fail(
      `section ${section.key}: only ${entries.length} models after filtering ` +
        `(expected >= ${section.min}); upstream data looks truncated`,
    );
  }
  catalog[section.key] = entries;
}
for (const [sectionKey, modelId] of SENTINELS) {
  if (!catalog[sectionKey].some((entry) => entry.id === modelId)) {
    fail(`sentinel model ${sectionKey}/${modelId} missing; upstream schema may have changed`);
  }
}

const existingContents = OUTPUT_PATHS.map(readExisting);
const today = new Date().toISOString().slice(0, 10);
const nextContent = renderCatalog(catalog, today);

const unchanged =
  existingContents.every((content) => content !== null) &&
  existingContents.every(
    (content) => stripSnapshotDate(content) === stripSnapshotDate(nextContent),
  ) &&
  existingContents[0] === existingContents[1];

if (args.check) {
  if (!unchanged) {
    console.error("catalog snapshot is stale; run: make update-model-catalog");
    process.exit(1);
  }
  console.log("catalog snapshot is up to date.");
  process.exit(0);
}

if (unchanged) {
  console.log("catalog unchanged");
  process.exit(0);
}

for (const path of OUTPUT_PATHS) writeFileSync(path, nextContent);
const [guiBytes, webBytes] = OUTPUT_PATHS.map((path) => readFileSync(path));
if (!guiBytes.equals(webBytes)) fail("post-write self-check failed: outputs differ");
const total = SECTIONS.reduce((sum, section) => sum + catalog[section.key].length, 0);
console.log(`catalog updated (${total} models, snapshot ${today})`);
