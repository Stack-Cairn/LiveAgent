import type { ProviderModelConfig } from "../settings";

export const OTHER_MODEL_VENDOR = "其他" as const;

export const MODEL_VENDOR_ORDER = [
  "OpenAI",
  "Anthropic",
  "Google",
  "Qwen",
  "DeepSeek",
  "智谱",
  "Moonshot",
  "字节豆包",
  "Meta",
  "Mistral",
  "xAI",
  "MiniMax",
  "百度",
  "腾讯",
  "零一万物",
] as const;

export type KnownModelVendor = (typeof MODEL_VENDOR_ORDER)[number];
export type ModelVendor = KnownModelVendor | typeof OTHER_MODEL_VENDOR;

type ModelVendorInput = Pick<ProviderModelConfig, "id" | "ownedBy"> & {
  owned_by?: string;
};

const MODEL_ID_PREFIX_RULES: ReadonlyArray<{
  vendor: KnownModelVendor;
  prefixes: readonly string[];
}> = [
  {
    vendor: "OpenAI",
    prefixes: ["gpt-", "o1", "o3", "o4", "chatgpt", "dall-e", "text-embedding"],
  },
  { vendor: "Anthropic", prefixes: ["claude"] },
  { vendor: "Google", prefixes: ["gemini", "gemma"] },
  { vendor: "Qwen", prefixes: ["qwen", "qwq", "qvq"] },
  { vendor: "DeepSeek", prefixes: ["deepseek"] },
  { vendor: "智谱", prefixes: ["glm", "chatglm"] },
  { vendor: "Moonshot", prefixes: ["kimi", "moonshot"] },
  { vendor: "字节豆包", prefixes: ["doubao"] },
  { vendor: "Meta", prefixes: ["llama"] },
  { vendor: "Mistral", prefixes: ["mistral", "mixtral", "codestral"] },
  { vendor: "xAI", prefixes: ["grok"] },
  { vendor: "MiniMax", prefixes: ["minimax", "abab"] },
  { vendor: "百度", prefixes: ["ernie"] },
  { vendor: "腾讯", prefixes: ["hunyuan"] },
  { vendor: "零一万物", prefixes: ["yi-"] },
];

const MODEL_OWNER_RULES: ReadonlyArray<{
  vendor: KnownModelVendor;
  aliases: readonly string[];
}> = [
  { vendor: "OpenAI", aliases: ["openai"] },
  { vendor: "Anthropic", aliases: ["anthropic"] },
  { vendor: "Google", aliases: ["google", "deepmind"] },
  { vendor: "Qwen", aliases: ["qwen", "alibaba", "aliyun", "dashscope"] },
  { vendor: "DeepSeek", aliases: ["deepseek"] },
  { vendor: "智谱", aliases: ["zhipu", "bigmodel", "chatglm", "glm"] },
  { vendor: "Moonshot", aliases: ["moonshot", "kimi"] },
  { vendor: "字节豆包", aliases: ["bytedance", "byte-dance", "volcengine", "doubao"] },
  { vendor: "Meta", aliases: ["meta", "facebook"] },
  { vendor: "Mistral", aliases: ["mistral"] },
  { vendor: "xAI", aliases: ["xai", "x.ai"] },
  { vendor: "MiniMax", aliases: ["minimax"] },
  { vendor: "百度", aliases: ["baidu", "ernie"] },
  { vendor: "腾讯", aliases: ["tencent", "hunyuan"] },
  { vendor: "零一万物", aliases: ["01.ai", "zero-one", "lingyi", "yi"] },
];

const MODEL_VENDOR_RANK = new Map<ModelVendor, number>(
  MODEL_VENDOR_ORDER.map((vendor, index) => [vendor, index]),
);
MODEL_VENDOR_RANK.set(OTHER_MODEL_VENDOR, MODEL_VENDOR_ORDER.length);

function normalizeModelIdForVendor(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  const modelPathMarker = "/models/";
  const markerIndex = normalized.lastIndexOf(modelPathMarker);
  const withoutModelPath =
    markerIndex >= 0
      ? normalized.slice(markerIndex + modelPathMarker.length)
      : normalized.replace(/^models\//, "");
  const pathParts = withoutModelPath.split("/").filter(Boolean);
  return pathParts.at(-1) ?? withoutModelPath;
}

function ownerMatchesAlias(owner: string, alias: string): boolean {
  return (
    owner === alias ||
    owner.startsWith(`${alias}-`) ||
    owner.startsWith(`${alias}_`) ||
    owner.startsWith(`${alias}/`)
  );
}

export function resolveModelVendor(model: ModelVendorInput): ModelVendor {
  const modelId = normalizeModelIdForVendor(model.id);
  for (const rule of MODEL_ID_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => modelId.startsWith(prefix))) {
      return rule.vendor;
    }
  }

  const owner = (model.ownedBy?.trim() || model.owned_by?.trim() || "").toLowerCase();
  if (owner) {
    for (const rule of MODEL_OWNER_RULES) {
      if (rule.aliases.some((alias) => ownerMatchesAlias(owner, alias))) {
        return rule.vendor;
      }
    }
  }

  return OTHER_MODEL_VENDOR;
}

function compareModelIds(left: string, right: string): number {
  return (
    left.localeCompare(right, "en", { sensitivity: "base" }) || left.localeCompare(right, "en")
  );
}

export function sortModelsByVendor<T extends ModelVendorInput>(models: readonly T[]): T[] {
  const groups = new Map<ModelVendor, T[]>();
  for (const model of models) {
    const vendor = resolveModelVendor(model);
    const group = groups.get(vendor);
    if (group) group.push(model);
    else groups.set(vendor, [model]);
  }

  return Array.from(groups.entries())
    .sort(([leftVendor, leftModels], [rightVendor, rightModels]) => {
      if (leftVendor === OTHER_MODEL_VENDOR) return 1;
      if (rightVendor === OTHER_MODEL_VENDOR) return -1;
      return (
        rightModels.length - leftModels.length ||
        (MODEL_VENDOR_RANK.get(leftVendor) ?? Number.MAX_SAFE_INTEGER) -
          (MODEL_VENDOR_RANK.get(rightVendor) ?? Number.MAX_SAFE_INTEGER)
      );
    })
    .flatMap(([, group]) => [...group].sort((left, right) => compareModelIds(right.id, left.id)));
}

export function sortModelsByActiveStateAndVendor<T extends ModelVendorInput>(
  models: readonly T[],
  activeModelIds: ReadonlySet<string>,
): T[] {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const model of models) {
    (activeModelIds.has(model.id) ? active : inactive).push(model);
  }
  return [...sortModelsByVendor(active), ...sortModelsByVendor(inactive)];
}
