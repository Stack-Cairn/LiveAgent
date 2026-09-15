#!/usr/bin/env node
// Generates the model metadata catalog and the provider preset facts consumed
// by both frontends through the shared UI package. models.dev is fetched once;
// OpenAI model metadata is merged Codex-first from openai/codex models.json,
// then supplemented by models.dev; every other section comes from models.dev.
// Two files are written from the same snapshot:
//   crates/agent-ui/src/lib/models/catalog.generated.ts        (MODEL_CATALOG)
//   crates/agent-ui/src/lib/providers/registry/presets.generated.ts (provider facts)
//
// Usage: node scripts/generate-model-catalog.mjs
//          [--source <url|file>] [--codex-source <url|file>] [--check]
//   --source        alternate models.dev api.json URL or local file path
//   --codex-source  alternate Codex models.json URL or local file path
//   --check         compare against the checked-in snapshots without writing;
//                   exits 1 when the data differs
//
// Automated refresh: .github/workflows/update-model-catalog.yml

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_OUTPUT = join(
  repoRoot,
  "crates",
  "agent-ui",
  "src",
  "lib",
  "models",
  "catalog.generated.ts",
);
const PRESETS_OUTPUT = join(
  repoRoot,
  "crates",
  "agent-ui",
  "src",
  "lib",
  "providers",
  "registry",
  "presets.generated.ts",
);

const DEFAULT_SOURCE = "https://models.dev/api.json";
const DEFAULT_CODEX_SOURCE =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const MIN_CODEX_MODELS = 5;

// Catalog sections. Each section unions one or more upstream models.dev
// provider keys (first source wins on a same-id conflict inside the section).
// The openai section is subsequently overlaid with same-id Codex metadata;
// models.dev-only models remain as supplements, while newly listed Codex
// models receive conservative defaults for fields models.json does not
// publish yet.
//
// Codex context_window semantics: models.json publishes the *input-side*
// session budget (GPT-5 family: 272k documented max input), while every other
// catalog source records the total window including output (GPT-5: 400k =
// 272k input + 128k output). The merge converts Codex entries to total-window
// semantics (context_window + resolved maxOutputToken) so the whole catalog —
// and every consumer (usage ring, buffered-reserve compaction thresholds) —
// shares one meaning of contextWindow; the input budget is preserved as
// maxInputTokens. Cross-check: gpt-5.2 converts to exactly the 400k total that
// models.dev/OpenAI document for it.
//
// Every section keeps its own complete list — provider presets list models per
// channel through MODEL_CATALOG[preset.sourceId], so a model deployed on two
// channels (qwen-max on Bailian CN and intl) appears in both sections. Ids
// are only deduplicated case-insensitively *within* a section.
//
// Section order is the lookup order of findCatalogModelAcrossProviders (first
// hit wins for ids present in several sections). Official vendor catalogs
// come first (CN endpoints before their international twins so a bare id
// resolves to the CN limits, as before); platforms that host third-party
// models with platform-clamped limits (volcengine, alibaba/Bailian, tencent)
// come next; aggregators and local runtimes (siliconflow, groq, openrouter,
// lmstudio) come last so an aggregator copy never shadows the vendor entry.
//
// `namespaced`: keep "vendor/model" ids. Aggregators and local runtimes serve
// those ids verbatim; for vendor catalogs such ids are third-party deployments
// (Bailian's "siliconflow/…", "kimi/…") that relays never serve verbatim and
// are skipped.
const SECTIONS = [
  { key: "anthropic", sources: ["anthropic"], min: 8 },
  { key: "google", sources: ["google"], min: 15 },
  { key: "openai", sources: ["openai"], min: 20 },
  { key: "xai", sources: ["xai"], min: 3 },
  { key: "deepseek", sources: ["deepseek"], min: 2 },
  // zai (Z.AI, international brand) is a superset of zhipuai with identical
  // ids and limits for the overlap; keep the domestic brand as the key.
  { key: "zhipuai", sources: ["zai", "zhipuai"], min: 10 },
  { key: "moonshotai-cn", sources: ["moonshotai-cn"], min: 2 },
  { key: "moonshotai", sources: ["moonshotai"], min: 2 },
  { key: "minimax-cn", sources: ["minimax-cn"], min: 3 },
  { key: "minimax", sources: ["minimax"], min: 3 },
  { key: "stepfun", sources: ["stepfun"], min: 4 },
  { key: "xiaomi", sources: ["xiaomi"], min: 4 },
  { key: "longcat", sources: ["longcat"], min: 1 },
  { key: "volcengine", sources: ["volcengine"], min: 6 },
  { key: "alibaba-cn", sources: ["alibaba-cn"], min: 40 },
  { key: "alibaba", sources: ["alibaba"], min: 20 },
  { key: "tencent", sources: ["tencent-coding-plan"], min: 4 },
  { key: "siliconflow-cn", sources: ["siliconflow-cn"], min: 20, namespaced: true },
  { key: "siliconflow", sources: ["siliconflow"], min: 20, namespaced: true },
  { key: "groq", sources: ["groq"], min: 8, namespaced: true },
  { key: "openrouter", sources: ["openrouter"], min: 100, namespaced: true },
  { key: "lmstudio", sources: ["lmstudio"], min: 1, namespaced: true },
];

// A single channel's list is capped so an aggregator cannot balloon the
// bundle; truncation is recorded in the generated file header.
const MODEL_CAP = 400;

// Provider presets derived from models.dev provider facts (display name, docs
// URL, API root, adapter). `section` is the catalog section that lists the
// channel's models (GeneratedPreset.sourceId); `source` picks the models.dev
// provider whose facts are used when the section unions several providers.
// Order is the default catalog display order. Everything models.dev does not
// know (extra protocol endpoints, dialects, per-model protocol rules, identity
// presets, local services) lives in presets.overlay.ts.
const PRESETS = [
  { id: "anthropic", section: "anthropic" },
  { id: "openai", section: "openai" },
  { id: "gemini", section: "google" },
  { id: "xai", section: "xai" },
  { id: "deepseek", section: "deepseek" },
  { id: "zhipu", section: "zhipuai", source: "zhipuai" },
  { id: "minimax", section: "minimax" },
  { id: "minimax-cn", section: "minimax-cn" },
  { id: "moonshot", section: "moonshotai" },
  { id: "moonshot-cn", section: "moonshotai-cn" },
  { id: "dashscope", section: "alibaba" },
  { id: "dashscope-cn", section: "alibaba-cn" },
  { id: "volcengine", section: "volcengine" },
  { id: "siliconflow", section: "siliconflow" },
  { id: "siliconflow-cn", section: "siliconflow-cn" },
  { id: "groq", section: "groq" },
  { id: "openrouter", section: "openrouter" },
  { id: "lmstudio", section: "lmstudio" },
];

// `npm` adapter package → the wire protocols that adapter speaks.
const NPM_PROTOCOLS = {
  "@ai-sdk/anthropic": ["anthropic-messages"],
  "@ai-sdk/openai": ["openai-responses", "openai-completions"],
  "@ai-sdk/google": ["google-generative-ai"],
  "@ai-sdk/xai": ["openai-responses", "openai-completions"],
  "@ai-sdk/openai-compatible": ["openai-completions"],
  "@openrouter/ai-sdk-provider": ["openai-completions"],
  "@ai-sdk/groq": ["openai-completions"],
};

// Official API roots for adapters whose models.dev entry has no `api` field.
const DEFAULT_API = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
};

// Models that must exist (with the expected shape); their absence signals an
// upstream schema change (or, for unioned sections, a source-key rename).
// `level` must be present in the extracted thinking levels; `off` must match
// when specified. `inputModality` must be present in the extracted input
// modalities — it guards against upstream renaming modalities.input, which
// would otherwise silently strip modality data from every entry. `fields`
// lists boolean capability fields that must be extracted as true — guarding
// against upstream renaming tool_call / structured_output / attachment.
const SENTINELS = [
  {
    section: "anthropic",
    id: "claude-sonnet-4-6",
    level: "high",
    off: true,
    inputModality: "image",
    fields: ["toolCall", "attachment"],
  },
  { section: "openai", id: "gpt-5", level: "minimal" },
  {
    section: "openai",
    id: "gpt-5.2",
    contextWindow: 400_000,
    maxInputTokens: 272_000,
    fields: ["toolCall", "structuredOutput", "attachment"],
  },
  // 272k Codex input budget + 128k models.dev output = 400k total window.
  // Fails when either upstream changes semantics or Codex lifts the default
  // session budget — both require re-evaluating the merge conversion above.
  { section: "openai", id: "gpt-5.6-sol", level: "max", contextWindow: 400_000 },
  { section: "deepseek", id: "deepseek-v4-flash", level: "low", off: true },
  { section: "deepseek", id: "deepseek-v4-pro", level: "high", off: true },
  { section: "zhipuai", id: "glm-4.6", off: true },
  { section: "alibaba-cn", id: "qwen-max" },
  { section: "alibaba", id: "qwen-max" },
  { section: "openrouter", id: "anthropic/claude-sonnet-4.5", fields: ["toolCall"] },
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
// Modality extraction
// ---------------------------------------------------------------------------
// Canonical order for the catalog's modality fields. models.dev publishes
// modalities.input/output and Codex models.json publishes input_modalities
// with the same vocabulary; unknown future values are dropped with a note
// rather than failing the refresh — modality data must never block a limits
// update.
const MODALITIES = ["text", "image", "audio", "video", "pdf"];

function normalizeModalities(values, label) {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set();
  for (const value of values) {
    if (MODALITIES.includes(value)) {
      seen.add(value);
    } else {
      console.error(`note ${label}: unknown modality "${value}" dropped`);
    }
  }
  if (seen.size === 0) return undefined;
  return MODALITIES.filter((modality) => seen.has(modality));
}

// Output modalities are only recorded when the model emits more than text
// (every catalog entry emits text — non-text-output models are filtered out).
function normalizeOutputModalities(values, label) {
  const modalities = normalizeModalities(values, label);
  if (!modalities || (modalities.length === 1 && modalities[0] === "text")) return undefined;
  return modalities;
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

// ---------------------------------------------------------------------------
// Descriptive fields
// ---------------------------------------------------------------------------
// models.dev treats its boolean capability fields as "absent == false"; only
// `true` is recorded so the generated file stays compact and consumers can
// read "catalog hit + field absent" as unsupported. Pricing is intentionally
// not extracted (the app has no billing features).
const STATUSES = new Set(["beta", "deprecated"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function descriptiveFields(model, id, label) {
  const name = nonEmptyString(model?.name);
  const status = nonEmptyString(model?.status);
  if (status && status !== "active" && !STATUSES.has(status)) {
    console.error(`note ${label}: unknown status "${status}" dropped`);
  }
  return {
    ...(name && name !== id ? { name } : {}),
    ...(nonEmptyString(model?.family) ? { family: model.family.trim() } : {}),
    ...(model?.tool_call === true ? { toolCall: true } : {}),
    ...(model?.structured_output === true ? { structuredOutput: true } : {}),
    ...(model?.attachment === true ? { attachment: true } : {}),
    ...(model?.temperature === true ? { temperature: true } : {}),
    ...(nonEmptyString(model?.knowledge) ? { knowledge: model.knowledge.trim() } : {}),
    ...(nonEmptyString(model?.release_date) ? { releaseDate: model.release_date.trim() } : {}),
    ...(nonEmptyString(model?.last_updated) ? { lastUpdated: model.last_updated.trim() } : {}),
    ...(status && STATUSES.has(status) ? { status } : {}),
    ...(model?.open_weights === true ? { openWeights: true } : {}),
    // interleaved thinking is published either as `true` or as the
    // { field } descriptor naming the stream field; both mean supported.
    ...(model?.interleaved === true ||
    (model?.interleaved && typeof model.interleaved === "object")
      ? { interleaved: true }
      : {}),
  };
}

function normalizeMaxInputTokens(model, contextWindow, label) {
  const input = model?.limit?.input;
  if (input === undefined || input === null) return undefined;
  if (!Number.isInteger(input) || input <= 0 || input > contextWindow) {
    console.error(`note ${label}: invalid limit.input ${JSON.stringify(input)} dropped`);
    return undefined;
  }
  return input;
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

function mergeCodexOpenAIEntries(entries, codexModels) {
  const mergedByLower = new Map(entries.map((entry) => [entry.id.toLowerCase(), entry]));

  for (const codexModel of codexModels.values()) {
    const lower = codexModel.id.toLowerCase();
    const supplemental = mergedByLower.get(lower);
    const label = `openai/codex/${codexModel.id}`;
    const thinking = normalizeCodexThinking(codexModel.raw, supplemental?.thinking, label);
    // Codex-first like the rest of the merge; models.dev fills the gap when
    // models.json stops publishing input_modalities.
    const inputModalities =
      normalizeModalities(codexModel.raw?.input_modalities, label) ??
      supplemental?.inputModalities;

    if (supplemental) {
      // Codex context_window is the input-side budget; add the resolved output
      // cap to express the same total-window semantics as the rest of the
      // catalog (see the section comment above SECTIONS). The budget itself is
      // kept as maxInputTokens — Codex-first like the window, so a models.dev
      // limit.input published for a larger tier (gpt-5.4: 922k) cannot exceed
      // the converted window.
      const maxOutputToken = normalizeMaxOutputToken(
        codexModel.contextWindow,
        supplemental.maxOutputToken,
      );
      const {
        contextWindow: _context,
        maxInputTokens: _input,
        maxOutputToken: _output,
        inputModalities: _modalities,
        thinking: _thinking,
        ...descriptive
      } = supplemental;
      mergedByLower.set(lower, {
        id: codexModel.id,
        contextWindow: codexModel.contextWindow + maxOutputToken,
        maxInputTokens: codexModel.contextWindow,
        maxOutputToken,
        ...(inputModalities ? { inputModalities } : {}),
        ...(thinking ? { thinking } : {}),
        ...descriptive,
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
    const maxOutputToken = normalizeMaxOutputToken(codexModel.contextWindow, MAX_OUTPUT_TOKEN_CAP);
    const name = nonEmptyString(codexModel.raw?.display_name);
    mergedByLower.set(lower, {
      id: codexModel.id,
      ...(name && name !== codexModel.id ? { name } : {}),
      contextWindow: codexModel.contextWindow + maxOutputToken,
      maxInputTokens: codexModel.contextWindow,
      maxOutputToken,
      ...(inputModalities ? { inputModalities } : {}),
      ...(thinking ? { thinking } : {}),
    });
  }

  return [...mergedByLower.values()];
}

// Lowercase-unique ids inside a section are what let the runtime index add
// case-insensitive aliases without ambiguity; the invariant is re-asserted by
// test/models/model-catalog.test.mjs.
function extractSection(section, upstream, codexModels) {
  const entries = [];
  const claimedLower = new Set();
  for (const source of section.sources) {
    const providerData = upstream?.[source];
    if (!providerData) fail(`section ${section.key}: source ${source} missing from upstream data`);
    const rawModels = providerData.models;
    if (!rawModels || typeof rawModels !== "object") {
      fail(`section ${section.key}: source ${source} missing models map`);
    }
    for (const [id, model] of Object.entries(rawModels)) {
      const label = `${source}/${id}`;
      // The formal DeepSeek provider uses the native Responses API. Keep its
      // catalog aligned with the models that DeepSeek documents for that API;
      // retired Chat Completions aliases remain available through custom relay
      // configurations, but must not reappear as official provider choices.
      if (section.key === "deepseek" && !DEEPSEEK_RESPONSES_MODELS.has(id.toLowerCase())) {
        console.error(`skip ${label} (not supported by DeepSeek Responses)`);
        continue;
      }
      if (id.includes("/") && !section.namespaced) {
        console.error(`skip ${label} (aggregator-prefixed id)`);
        continue;
      }
      const contextWindow = model?.limit?.context;
      const rawOutput = model?.limit?.output;
      if (!model?.modalities?.output?.includes?.("text")) {
        console.error(`skip ${label} (non-text output)`);
        continue;
      }
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        console.error(`skip ${label} (invalid limit.context)`);
        continue;
      }
      if (!Number.isInteger(rawOutput) || rawOutput <= 0) {
        console.error(`skip ${label} (invalid limit.output)`);
        continue;
      }
      const lower = id.toLowerCase();
      if (claimedLower.has(lower)) continue; // CN/global union overlap: first source wins.
      claimedLower.add(lower);
      const thinking = normalizeThinking(model, id, label, section.key);
      const inputModalities = normalizeModalities(model?.modalities?.input, label);
      const outputModalities = normalizeOutputModalities(model?.modalities?.output, label);
      const maxInputTokens = normalizeMaxInputTokens(model, contextWindow, label);
      entries.push({
        id,
        contextWindow,
        ...(maxInputTokens ? { maxInputTokens } : {}),
        maxOutputToken: normalizeMaxOutputToken(contextWindow, rawOutput),
        ...(inputModalities ? { inputModalities } : {}),
        ...(outputModalities ? { outputModalities } : {}),
        ...(thinking ? { thinking } : {}),
        ...descriptiveFields(model, id, label),
      });
    }
  }
  const mergedEntries =
    section.key === "openai" ? mergeCodexOpenAIEntries(entries, codexModels) : entries;
  mergedEntries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mergedEntries;
}

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------
function extractPreset(preset, upstream) {
  const section = SECTIONS.find((candidate) => candidate.key === preset.section);
  if (!section) fail(`preset ${preset.id}: unknown section ${preset.section}`);
  const source = preset.source ?? section.sources[0];
  const raw = upstream?.[source];
  if (!raw) fail(`preset ${preset.id}: source ${source} missing from upstream data`);
  const protocols = NPM_PROTOCOLS[raw.npm];
  if (!protocols) fail(`preset ${preset.id}: unsupported adapter ${raw.npm}`);
  const baseUrl = (nonEmptyString(raw.api) ?? DEFAULT_API[raw.npm] ?? "").replace(/\/+$/, "");
  if (!baseUrl) fail(`preset ${preset.id}: no api base url`);
  return {
    id: preset.id,
    sourceId: preset.section,
    name: nonEmptyString(raw.name) ?? preset.id,
    ...(nonEmptyString(raw.doc) ? { doc: raw.doc.trim() } : {}),
    envKeys: Array.isArray(raw.env) ? raw.env.filter((key) => typeof key === "string") : [],
    adapter: raw.npm,
    protocols,
    baseUrl,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const ENTRY_FIELD_ORDER = [
  "id",
  "name",
  "family",
  "contextWindow",
  "maxInputTokens",
  "maxOutputToken",
  "inputModalities",
  "outputModalities",
  "thinking",
  "toolCall",
  "structuredOutput",
  "attachment",
  "temperature",
  "knowledge",
  "releaseDate",
  "lastUpdated",
  "status",
  "openWeights",
  "interleaved",
];

function renderValue(key, value) {
  if (key === "thinking") {
    const levels = value.levels.map((level) => JSON.stringify(level)).join(", ");
    return `{ levels: [${levels}], off: ${value.off} }`;
  }
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  return JSON.stringify(value);
}

function renderEntry(entry) {
  const unknown = Object.keys(entry).filter((key) => !ENTRY_FIELD_ORDER.includes(key));
  if (unknown.length > 0) fail(`entry ${entry.id}: unexpected fields ${unknown.join(", ")}`);
  const parts = ENTRY_FIELD_ORDER.filter((key) => entry[key] !== undefined).map(
    (key) => `${key}: ${renderValue(key, entry[key])}`,
  );
  return `    { ${parts.join(", ")} },`;
}

function renderCatalog(catalog, truncated, snapshotDate) {
  const keys = SECTIONS.map((section) => section.key);
  const lines = [
    "// Generated by scripts/generate-model-catalog.mjs — DO NOT EDIT.",
    `// Sources: ${DEFAULT_CODEX_SOURCE} (openai primary);`,
    `//          ${DEFAULT_SOURCE} (openai supplement; sections: ${keys.join(", ")})`,
    "// Automated refresh: .github/workflows/update-model-catalog.yml",
    "//",
    "// Section order is the lookup order of findCatalogModelAcrossProviders; every",
    "// section keeps its own full list (presets list models per channel), so the",
    "// same id may appear under several sections. Boolean capability fields are",
    "// only written when true (models.dev semantics: absent == false); pricing is",
    "// not extracted.",
  ];
  if (truncated.length > 0) {
    lines.push(`// Sections truncated to the first ${MODEL_CAP} ids (sorted):`);
    for (const note of truncated) lines.push(`//   ${note.key}: ${note.kept} of ${note.total}`);
  }
  lines.push(
    "",
    'export type CatalogThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";',
    "",
    `export type CatalogModality = ${MODALITIES.map((modality) => JSON.stringify(modality)).join(" | ")};`,
    "",
    "export type CatalogInputModality = CatalogModality;",
    "",
    'export type CatalogModelStatus = "beta" | "deprecated";',
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
    "  /** Display name; absent = same as id. */",
    "  name?: string;",
    "  family?: string;",
    "  /** Total window including output. */",
    "  contextWindow: number;",
    "  /** Input-side budget when the provider publishes one (models.dev limit.input). */",
    "  maxInputTokens?: number;",
    "  maxOutputToken: number;",
    "  /** Accepted input modalities, canonical order; absent = upstream published none. */",
    "  inputModalities?: readonly CatalogInputModality[];",
    "  /** Output modalities beyond text, canonical order; absent = text only. */",
    "  outputModalities?: readonly CatalogModality[];",
    "  /** Absent = the model does not reason. */",
    "  thinking?: CatalogModelThinking;",
    "  toolCall?: true;",
    "  structuredOutput?: true;",
    "  /** Accepts file attachments (documents). */",
    "  attachment?: true;",
    "  /** Honors the temperature parameter. */",
    "  temperature?: true;",
    "  /** Knowledge cutoff (YYYY-MM or YYYY-MM-DD). */",
    "  knowledge?: string;",
    "  releaseDate?: string;",
    "  lastUpdated?: string;",
    "  /** Absent = active. */",
    "  status?: CatalogModelStatus;",
    "  openWeights?: true;",
    "  /** Supports interleaved thinking between tool calls. */",
    "  interleaved?: true;",
    "};",
    "",
    `export type CatalogProviderId = ${keys.map((key) => JSON.stringify(key)).join(" | ")};`,
    "",
    `export const MODEL_CATALOG_SNAPSHOT_DATE = "${snapshotDate}";`,
    "",
    "export const MODEL_CATALOG: Record<CatalogProviderId, readonly CatalogModelEntry[]> = {",
  );
  for (const key of keys) {
    lines.push(`  ${JSON.stringify(key)}: [`);
    for (const entry of catalog[key]) lines.push(renderEntry(entry));
    lines.push("  ],");
  }
  lines.push("};", "");
  return lines.join("\n");
}

function renderPresets(presets) {
  const lines = [
    "// Generated by scripts/generate-model-catalog.mjs — DO NOT EDIT.",
    `// Source: ${DEFAULT_SOURCE} (provider facts only)`,
    "// Automated refresh: .github/workflows/update-model-catalog.yml",
    "//",
    "// Facts models.dev publishes per provider: name, docs URL, API root, env keys",
    "// and wire adapter. The channel's model list is MODEL_CATALOG[sourceId] in",
    "// lib/models/catalog.generated.ts (same snapshot). Endpoint variants, dialects,",
    "// per-model protocol rules and local services live in presets.overlay.ts.",
    'import type { CatalogProviderId } from "../../models/catalog.generated";',
    'import type { ProviderChatProtocol } from "./protocols";',
    "",
    'export { MODEL_CATALOG_SNAPSHOT_DATE } from "../../models/catalog.generated";',
    "",
    "export type GeneratedPreset = {",
    "  id: string;",
    "  /** Catalog section listing this channel's models: MODEL_CATALOG[sourceId]. */",
    "  sourceId: CatalogProviderId;",
    "  name: string;",
    "  doc?: string;",
    "  envKeys: readonly string[];",
    "  adapter: string;",
    "  protocols: readonly ProviderChatProtocol[];",
    "  baseUrl: string;",
    "};",
    "",
    "export const GENERATED_PRESETS: readonly GeneratedPreset[] = [",
  ];
  for (const preset of presets) {
    const parts = Object.entries(preset).map(
      ([key, value]) => `${key}: ${Array.isArray(value) ? renderValue(key, value) : JSON.stringify(value)}`,
    );
    lines.push(`  { ${parts.join(", ")} },`);
  }
  lines.push("];", "");
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv);
const [upstream, codexUpstream] = await Promise.all([
  loadUpstream(args.source, "models.dev"),
  loadUpstream(args.codexSource, "Codex"),
]);
const codexModels = extractCodexOpenAIModels(codexUpstream);

const catalog = {};
const truncated = [];
for (const section of SECTIONS) {
  const entries = extractSection(section, upstream, codexModels);
  if (entries.length < section.min) {
    fail(
      `section ${section.key}: only ${entries.length} models after filtering ` +
        `(expected >= ${section.min}); upstream data looks truncated`,
    );
  }
  if (entries.length > MODEL_CAP) {
    truncated.push({ key: section.key, kept: MODEL_CAP, total: entries.length });
    console.error(`note section ${section.key}: truncated to ${MODEL_CAP} of ${entries.length}`);
  }
  catalog[section.key] = entries.slice(0, MODEL_CAP);
}
for (const sentinel of SENTINELS) {
  const entry = catalog[sentinel.section].find((candidate) => candidate.id === sentinel.id);
  const label = `sentinel ${sentinel.section}/${sentinel.id}`;
  if (!entry) fail(`${label} missing; upstream schema may have changed`);
  if (sentinel.level && !entry.thinking?.levels.includes(sentinel.level)) {
    fail(
      `${label}: expected thinking level "${sentinel.level}"; ` +
        "upstream reasoning_options schema may have changed",
    );
  }
  if (sentinel.off !== undefined && entry.thinking?.off !== sentinel.off) {
    fail(
      `${label}: expected thinking.off=${sentinel.off}; ` +
        "upstream reasoning_options schema may have changed",
    );
  }
  if (sentinel.inputModality && !entry.inputModalities?.includes(sentinel.inputModality)) {
    fail(
      `${label}: expected input modality "${sentinel.inputModality}"; ` +
        "upstream modalities schema may have changed",
    );
  }
  if (sentinel.contextWindow !== undefined && entry.contextWindow !== sentinel.contextWindow) {
    fail(
      `${label}: expected contextWindow=${sentinel.contextWindow}, got ${entry.contextWindow}; ` +
        "Codex precedence may have changed",
    );
  }
  if (sentinel.maxInputTokens !== undefined && entry.maxInputTokens !== sentinel.maxInputTokens) {
    fail(
      `${label}: expected maxInputTokens=${sentinel.maxInputTokens}, got ${entry.maxInputTokens}; ` +
        "upstream limit.input schema may have changed",
    );
  }
  for (const field of sentinel.fields ?? []) {
    if (entry[field] !== true) {
      fail(`${label}: expected ${field}=true; upstream capability field schema may have changed`);
    }
  }
}

const presets = PRESETS.map((preset) => extractPreset(preset, upstream));

const today = new Date().toISOString().slice(0, 10);
const outputs = [
  { path: CATALOG_OUTPUT, next: renderCatalog(catalog, truncated, today) },
  { path: PRESETS_OUTPUT, next: renderPresets(presets) },
];
const unchanged = outputs.every(({ path, next }) => {
  const existing = readExisting(path);
  return existing !== null && stripSnapshotDate(existing) === stripSnapshotDate(next);
});

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

for (const { path, next } of outputs) writeFileSync(path, next);
const total = SECTIONS.reduce((sum, section) => sum + catalog[section.key].length, 0);
console.log(
  `catalog updated (${SECTIONS.length} sections, ${total} models, ${presets.length} presets, snapshot ${today})`,
);
