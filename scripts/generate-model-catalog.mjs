#!/usr/bin/env node
// Generates the model metadata catalog (context window / max output /
// thinking capability / input modalities) consumed by both frontends through the shared UI package. OpenAI model metadata is
// merged Codex-first from openai/codex models.json, then supplemented by the
// models.dev open database; every other section comes from models.dev. The
// output is written once to:
//   crates/agent-ui/src/lib/models/catalog.generated.ts
//
// Usage: node scripts/generate-model-catalog.mjs
//          [--source <url|file>] [--codex-source <url|file>] [--check]
//   --source        alternate models.dev api.json URL or local file path
//   --codex-source  alternate Codex models.json URL or local file path
//   --check         compare against the checked-in snapshot without writing;
//                   exits 1 when the data differs
//
// Automated refresh: .github/workflows/update-model-catalog.yml

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATHS = [
  join(repoRoot, "crates", "agent-ui", "src", "lib", "models", "catalog.generated.ts"),
];

const DEFAULT_SOURCE = "https://models.dev/api.json";
const DEFAULT_CODEX_SOURCE =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const MIN_CODEX_MODELS = 5;

// Catalog sections. Each section unions one or more upstream models.dev
// provider keys (first source wins on a same-id conflict — used to prefer the
// China endpoint's limits for vendors that publish both). The openai section
// is subsequently overlaid with same-id Codex metadata; models.dev-only models
// remain as supplements, while newly listed Codex models receive conservative
// defaults for fields models.json does not publish yet.
//
// Codex context_window semantics: models.json publishes the *input-side*
// session budget (GPT-5 family: 272k documented max input), while every other
// catalog source records the total window including output (GPT-5: 400k =
// 272k input + 128k output). The merge converts Codex entries to total-window
// semantics (context_window + resolved maxOutputToken) so the whole catalog —
// and every consumer (usage ring, buffered-reserve compaction thresholds) —
// shares one meaning of contextWindow. Cross-check: gpt-5.2 converts to
// exactly the 400k total that models.dev/OpenAI document for it.
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
  { key: "deepseek", sources: ["deepseek"], min: 2 },
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

// Models that must exist (with the expected thinking shape); their absence
// signals an upstream schema change (or, for unioned sections, a source-key
// rename). `level` must be present in the extracted thinking levels; `off`
// must match when specified. `inputModality` must be present in the extracted
// input modalities — it guards against upstream renaming modalities.input,
// which would otherwise silently strip modality data from every entry.
const SENTINELS = [
  { section: "anthropic", id: "claude-sonnet-4-6", level: "high", off: true, inputModality: "image" },
  { section: "openai", id: "gpt-5", level: "minimal" },
  // 272k Codex input budget + 128k models.dev output = 400k total window.
  // Fails when either upstream changes semantics or Codex lifts the default
  // session budget — both require re-evaluating the merge conversion above.
  { section: "openai", id: "gpt-5.6-sol", level: "max", contextWindow: 400_000 },
  { section: "deepseek", id: "deepseek-v4-flash", level: "low", off: true },
  { section: "deepseek", id: "deepseek-v4-pro", level: "high", off: true },
  { section: "zhipuai", id: "glm-4.6", off: true },
  { section: "alibaba", id: "qwen-max" },
];

// Single semantic rule shared with lib/models/modelCatalog.ts (bound together
// by the catalog invariant tests): community catalogs record "output == context"
// for providers that publish no separate output cap, which would zero out the
// input budget of any consumer that reserves the full output. Repair such
// degenerate pairs with a uniform reservation cap.
const MAX_OUTPUT_TOKEN_CAP = 32_000;
const DEEPSEEK_RESPONSES_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
function normalizeMaxOutputToken(contextWindow, maxOutputToken) {
  if (maxOutputToken < contextWindow) return maxOutputToken;
  return Math.min(MAX_OUTPUT_TOKEN_CAP, Math.max(1, Math.floor(contextWindow / 4)));
}

// ---------------------------------------------------------------------------
// Input modality extraction
// ---------------------------------------------------------------------------
// Canonical order for the catalog's inputModalities field. models.dev
// publishes modalities.input and Codex models.json publishes input_modalities
// with the same vocabulary; unknown future values are dropped with a note
// rather than failing the refresh — modality data must never block a limits
// update.
const INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"];

function normalizeInputModalities(values, label) {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set();
  for (const value of values) {
    if (INPUT_MODALITIES.includes(value)) {
      seen.add(value);
    } else {
      console.error(`note ${label}: unknown input modality "${value}" dropped`);
    }
  }
  if (seen.size === 0) return undefined;
  return INPUT_MODALITIES.filter((modality) => seen.has(modality));
}

// ---------------------------------------------------------------------------
// Thinking capability extraction
// ---------------------------------------------------------------------------
// Upstream expresses "how can thinking be tuned" as reasoning_options entries
// of three shapes: an effort ladder, an on/off toggle, and a raw token budget.
// The catalog reduces that to the app's own ladder: which UI levels exist and
// whether thinking can be turned off. Wire semantics (what each level sends)
// stay in the streaming runtime — this is capability data only.

// App-side ladder, ascending. Upstream's "none" is not a level: it folds into
// `off`. Unknown future values are dropped with a note rather than failing the
// refresh — thinking data must never block a limits update.
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Budget-only models (no effort ladder published) get the four standard
// levels: the runtime maps them onto its per-provider budget tables, and
// xhigh/max stay opt-in via an explicit effort ladder.
const BUDGET_DEFAULT_LEVELS = ["minimal", "low", "medium", "high"];

// Pure-toggle models (toggle only, no ladder and no budget — glm-4.x, gemma,
// MiniMax-M3) get a single "high" notch: their wire protocols only understand
// on/off, but the app's enable path is level-based, so one selectable level is
// what makes the toggle reachable. The UI hides single-entry level pickers.
const TOGGLE_ONLY_LEVELS = ["high"];

// The anthropic-messages protocol always allows disabling thinking client-side
// (the request simply omits the thinking block), so upstream's ladder never
// lists "none" for Anthropic models even though `off` is real. Fixed always-on
// models (empty options) are still honored as such.
const CLIENT_SIDE_OFF_SECTIONS = new Set(["anthropic"]);

// Facts where the upstream aggregator is missing or lags the provider's
// protocol documentation, keyed "section/id". Kept tiny and documented.
// claude-fable-5: adaptive thinking cannot be disabled (the API requires the
// thinking block; pi-ai's catalog marks off:null) — the client-side-off rule
// above must not apply.
// DeepSeek's Responses thinking guide documents the same none/low/high/max
// ladder for both V4 models; models.dev currently omits low from V4 Pro.
const THINKING_OVERRIDES = new Map([
  ["anthropic/claude-fable-5", { off: false }],
  ["deepseek/deepseek-v4-flash", { levels: ["low", "high", "max"], off: true }],
  ["deepseek/deepseek-v4-pro", { levels: ["low", "high", "max"], off: true }],
]);

function normalizeThinking(model, id, label, sectionKey) {
  if (!model?.reasoning) return undefined;
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  if (options.length === 0) {
    // Reasoning is always on and not tunable (e.g. deepseek-reasoner,
    // MiniMax-M2 family) — levels stay empty, off stays false.
    return { levels: [], off: false };
  }
  const effort = options.find((option) => option?.type === "effort");
  const hasToggle = options.some((option) => option?.type === "toggle");
  const hasBudget = options.some((option) => option?.type === "budget_tokens");

  let off = hasToggle || CLIENT_SIDE_OFF_SECTIONS.has(sectionKey);
  let levels = [];
  if (effort && Array.isArray(effort.values)) {
    const values = new Set();
    for (const value of effort.values) {
      if (value === "none") {
        off = true;
      } else if (THINKING_LEVELS.includes(value)) {
        values.add(value);
      } else {
        console.error(`note ${label}: unknown effort value "${value}" dropped`);
      }
    }
    levels = THINKING_LEVELS.filter((level) => values.has(level));
  } else if (hasBudget) {
    levels = [...BUDGET_DEFAULT_LEVELS];
  } else if (hasToggle) {
    levels = [...TOGGLE_ONLY_LEVELS];
  }
  const override = THINKING_OVERRIDES.get(`${sectionKey}/${id}`);
  return { levels, off, ...(override ?? {}) };
}

function normalizeCodexThinking(model, supplementalThinking, label) {
  const supported = Array.isArray(model?.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];
  if (supported.length === 0) return supplementalThinking;

  const values = new Set();
  let off = supplementalThinking?.off ?? false;
  for (const option of supported) {
    const value = typeof option === "string" ? option : option?.effort;
    if (value === "none") {
      off = true;
    } else if (THINKING_LEVELS.includes(value)) {
      values.add(value);
    } else if (typeof value === "string" && value !== "") {
      console.error(`note ${label}: unsupported Codex reasoning effort "${value}" dropped`);
    }
  }
  return { levels: THINKING_LEVELS.filter((level) => values.has(level)), off };
}

function fail(message) {
  console.error(`generate-model-catalog: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, codexSource: DEFAULT_CODEX_SOURCE, check: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--source") {
      i += 1;
      if (!argv[i]) fail("--source requires a value");
      args.source = argv[i];
    } else if (arg === "--codex-source") {
      i += 1;
      if (!argv[i]) fail("--codex-source requires a value");
      args.codexSource = argv[i];
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function loadUpstream(source, label) {
  if (/^https?:\/\//.test(source)) {
    let response;
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      fail(`${label} fetch failed: ${error?.message ?? error}`);
    }
    if (!response.ok) fail(`${label} fetch failed: HTTP ${response.status} from ${source}`);
    try {
      return await response.json();
    } catch (error) {
      fail(`${label} returned invalid JSON from ${source}: ${error?.message ?? error}`);
    }
  }
  try {
    return JSON.parse(readFileSync(resolve(source), "utf8"));
  } catch (error) {
    fail(`cannot read ${label} source ${source}: ${error?.message ?? error}`);
  }
  return undefined;
}

function extractCodexOpenAIModels(upstream) {
  if (!Array.isArray(upstream?.models)) {
    fail("Codex source missing models array");
  }
  if (upstream.models.length < MIN_CODEX_MODELS) {
    fail(
      `Codex source only contains ${upstream.models.length} models ` +
        `(expected >= ${MIN_CODEX_MODELS}); upstream data looks truncated`,
    );
  }

  const models = new Map();
  for (const model of upstream.models) {
    const id = typeof model?.slug === "string" ? model.slug.trim() : "";
    if (!id) fail("Codex model missing slug");
    const contextWindow = model?.context_window;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      fail(`Codex model ${id} has invalid context_window`);
    }
    const lower = id.toLowerCase();
    if (models.has(lower)) fail(`Codex source contains duplicate model id ${id}`);
    models.set(lower, { id, contextWindow, raw: model });
  }
  return models;
}

function mergeCodexOpenAIEntries(entries, codexModels, claimedLower) {
  const mergedByLower = new Map(entries.map((entry) => [entry.id.toLowerCase(), entry]));

  for (const codexModel of codexModels.values()) {
    const lower = codexModel.id.toLowerCase();
    const supplemental = mergedByLower.get(lower);
    const thinking = normalizeCodexThinking(
      codexModel.raw,
      supplemental?.thinking,
      `openai/codex/${codexModel.id}`,
    );
    // Codex-first like the rest of the merge; models.dev fills the gap when
    // models.json stops publishing input_modalities.
    const inputModalities =
      normalizeInputModalities(codexModel.raw?.input_modalities, `openai/codex/${codexModel.id}`) ??
      supplemental?.inputModalities;

    if (supplemental) {
      // Codex context_window is the input-side budget; add the resolved output
      // cap to express the same total-window semantics as the rest of the
      // catalog (see the section comment above SECTIONS).
      const maxOutputToken = normalizeMaxOutputToken(
        codexModel.contextWindow,
        supplemental.maxOutputToken,
      );
      mergedByLower.set(lower, {
        id: codexModel.id,
        contextWindow: codexModel.contextWindow + maxOutputToken,
        maxOutputToken,
        ...(inputModalities ? { inputModalities } : {}),
        ...(thinking ? { thinking } : {}),
      });
      continue;
    }

    // Hidden Codex-only entries are runtime/internal compatibility records, not
    // public catalog additions. A newly listed model is still useful before
    // models.dev catches up; use the existing conservative output cap until a
    // same-id supplement becomes available.
    if (codexModel.raw?.visibility !== "list" || codexModel.raw?.supported_in_api === false) {
      continue;
    }
    const claimedBy = claimedLower.get(lower);
    if (claimedBy) {
      console.error(`skip openai/codex/${codexModel.id} (id claimed by section ${claimedBy})`);
      continue;
    }
    claimedLower.set(lower, "openai");
    const maxOutputToken = normalizeMaxOutputToken(codexModel.contextWindow, MAX_OUTPUT_TOKEN_CAP);
    mergedByLower.set(lower, {
      id: codexModel.id,
      contextWindow: codexModel.contextWindow + maxOutputToken,
      maxOutputToken,
      ...(inputModalities ? { inputModalities } : {}),
      ...(thinking ? { thinking } : {}),
    });
  }

  return [...mergedByLower.values()];
}

// claimedLower: lowercased id -> owning section key. Lowercase-unique ids
// across the whole catalog are what make cross-provider lookup unambiguous
// and let the runtime index add case-insensitive aliases; the invariant is
// re-asserted by test/models/model-catalog.test.mjs.
function extractSection(section, upstream, claimedLower, codexModels) {
  const entries = [];
  for (const source of section.sources) {
    const providerData = upstream?.[source];
    if (!providerData) fail(`section ${section.key}: source ${source} missing from upstream data`);
    const rawModels = providerData.models;
    if (!rawModels || typeof rawModels !== "object") {
      fail(`section ${section.key}: source ${source} missing models map`);
    }
    for (const [id, model] of Object.entries(rawModels)) {
      // The formal DeepSeek provider uses the native Responses API. Keep its
      // catalog aligned with the models that DeepSeek documents for that API;
      // retired Chat Completions aliases remain available through custom relay
      // configurations, but must not reappear as official provider choices.
      if (section.key === "deepseek" && !DEEPSEEK_RESPONSES_MODELS.has(id.toLowerCase())) {
        console.error(`skip ${source}/${id} (not supported by DeepSeek Responses)`);
        continue;
      }
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
      const thinking = normalizeThinking(model, id, `${source}/${id}`, section.key);
      const inputModalities = normalizeInputModalities(model?.modalities?.input, `${source}/${id}`);
      entries.push({
        id,
        contextWindow,
        maxOutputToken: normalizeMaxOutputToken(contextWindow, rawOutput),
        ...(inputModalities ? { inputModalities } : {}),
        ...(thinking ? { thinking } : {}),
      });
    }
  }
  const mergedEntries =
    section.key === "openai"
      ? mergeCodexOpenAIEntries(entries, codexModels, claimedLower)
      : entries;
  mergedEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mergedEntries;
}

function renderEntry(entry) {
  const parts = [
    `id: ${JSON.stringify(entry.id)}`,
    `contextWindow: ${entry.contextWindow}`,
    `maxOutputToken: ${entry.maxOutputToken}`,
  ];
  if (entry.inputModalities) {
    const modalities = entry.inputModalities
      .map((modality) => JSON.stringify(modality))
      .join(", ");
    parts.push(`inputModalities: [${modalities}]`);
  }
  if (entry.thinking) {
    const levels = entry.thinking.levels.map((level) => JSON.stringify(level)).join(", ");
    parts.push(`thinking: { levels: [${levels}], off: ${entry.thinking.off} }`);
  }
  return `    { ${parts.join(", ")} },`;
}

function renderCatalog(catalog, snapshotDate) {
  const keys = SECTIONS.map((section) => section.key);
  const lines = [
    "// Generated by scripts/generate-model-catalog.mjs — DO NOT EDIT.",
    `// Sources: ${DEFAULT_CODEX_SOURCE} (openai primary);`,
    `//          ${DEFAULT_SOURCE} (openai supplement; sections: ${keys.join(", ")})`,
    "// Automated refresh: .github/workflows/update-model-catalog.yml",
    "",
    'export type CatalogThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";',
    "",
    `export type CatalogInputModality = ${INPUT_MODALITIES.map((modality) => JSON.stringify(modality)).join(" | ")};`,
    "",
    "export type CatalogModelThinking = {",
    "  /** Selectable levels, ascending; [] = thinking is always on and not tunable. */",
    "  levels: readonly CatalogThinkingLevel[];",
    "  /** Whether thinking can be turned off. */",
    "  off: boolean;",
    "};",
    "",
    "export type CatalogModelEntry = {",
    "  id: string;",
    "  contextWindow: number;",
    "  maxOutputToken: number;",
    "  /** Accepted input modalities, canonical order; absent = upstream published none. */",
    "  inputModalities?: readonly CatalogInputModality[];",
    "  /** Absent = the model does not reason. */",
    "  thinking?: CatalogModelThinking;",
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
const [upstream, codexUpstream] = await Promise.all([
  loadUpstream(args.source, "models.dev"),
  loadUpstream(args.codexSource, "Codex"),
]);
const codexModels = extractCodexOpenAIModels(codexUpstream);

const catalog = {};
const claimedLower = new Map();
for (const section of SECTIONS) {
  const entries = extractSection(section, upstream, claimedLower, codexModels);
  if (entries.length < section.min) {
    fail(
      `section ${section.key}: only ${entries.length} models after filtering ` +
        `(expected >= ${section.min}); upstream data looks truncated`,
    );
  }
  catalog[section.key] = entries;
}
for (const sentinel of SENTINELS) {
  const entry = catalog[sentinel.section].find((candidate) => candidate.id === sentinel.id);
  if (!entry) {
    fail(
      `sentinel model ${sentinel.section}/${sentinel.id} missing; upstream schema may have changed`,
    );
  }
  if (sentinel.level && !entry.thinking?.levels.includes(sentinel.level)) {
    fail(
      `sentinel ${sentinel.section}/${sentinel.id}: expected thinking level "${sentinel.level}"; ` +
        "upstream reasoning_options schema may have changed",
    );
  }
  if (sentinel.off !== undefined && entry.thinking?.off !== sentinel.off) {
    fail(
      `sentinel ${sentinel.section}/${sentinel.id}: expected thinking.off=${sentinel.off}; ` +
        "upstream reasoning_options schema may have changed",
    );
  }
  if (sentinel.inputModality && !entry.inputModalities?.includes(sentinel.inputModality)) {
    fail(
      `sentinel ${sentinel.section}/${sentinel.id}: expected input modality ` +
        `"${sentinel.inputModality}"; upstream modalities schema may have changed`,
    );
  }
  if (
    sentinel.contextWindow !== undefined &&
    entry.contextWindow !== sentinel.contextWindow
  ) {
    fail(
      `sentinel ${sentinel.section}/${sentinel.id}: expected contextWindow=` +
        `${sentinel.contextWindow}, got ${entry.contextWindow}; Codex precedence may have changed`,
    );
  }
}

const existingContents = OUTPUT_PATHS.map(readExisting);
const today = new Date().toISOString().slice(0, 10);
const nextContent = renderCatalog(catalog, today);

const unchanged =
  existingContents.every((content) => content !== null) &&
  existingContents.every((content) => stripSnapshotDate(content) === stripSnapshotDate(nextContent));

if (args.check) {
  if (!unchanged) {
    console.error("catalog snapshot is stale; run: node scripts/generate-model-catalog.mjs");
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
const total = SECTIONS.reduce((sum, section) => sum + catalog[section.key].length, 0);
console.log(`catalog updated (${total} models, snapshot ${today})`);
