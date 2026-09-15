// 预设覆盖层：models.dev 不知道的事实（设计文档 3.2 / 3.3）。
//
// 生成层（presets.generated.ts）给出名称、文档、API 根地址、适配器与目录分区 id
// （模型列表在 lib/models/catalog.generated.ts 的 MODEL_CATALOG[sourceId]）；
// 这里补充：额外协议端点、方言、按模型的接口规则、CLI 身份档、用户需要填什么、
// 以及 models.dev 未收录的本地服务与通用网关。合并见 presets.ts。

import type { ProviderChatProtocol, ProviderWireDialect } from "./protocols";

export type PresetCategory = "official" | "relay" | "self-hosted";
export type PresetInputKind = "key" | "origin" | "base";
export type PresetIdentity = "claude-cli" | "codex-cli" | "grok-shell";

export type PresetEndpointOverlay = {
  /** 地址模板。{origin} 由用户填写的地址取 scheme+host；官方预设直接写全 */
  baseUrl?: string;
  modelsUrl?: string;
  dialect?: ProviderWireDialect;
  quirks?: {
    supportsUsageInStreaming?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsStore?: boolean;
  };
  auth?: { headerName?: string; prefix?: string };
  /** 界面提示，例如"仅 V4 系列可用" */
  note?: string;
};

export type PresetModelRule = {
  /** 精确 ID 或前缀通配（"claude-*"、"deepseek-v4-*"） */
  match: string;
  chatProtocols?: readonly ProviderChatProtocol[];
  wireModelId?: string;
  dialect?: ProviderWireDialect;
  hidden?: boolean;
};

export type PresetOverlay = {
  id: string;
  /** 覆盖生成层的显示名（例如中文名） */
  name?: string;
  /** 五家原生接口渠道 */
  native?: boolean;
  category: PresetCategory;
  input: PresetInputKind;
  /** origin 类渠道的缺省地址（本地服务的默认端口） */
  defaultOrigin?: string;
  /** 无需密钥（本地服务） */
  authOptional?: boolean;
  dialect?: ProviderWireDialect;
  defaultChatProtocol?: ProviderChatProtocol;
  /** 追加或覆盖生成层的端点；键不存在则沿用生成层 */
  endpoints?: Partial<Record<ProviderChatProtocol, PresetEndpointOverlay>>;
  /** 模型列表来源：api = 各接口的 models 地址；catalog = 只用目录 */
  modelListSource?: "api" | "catalog";
  models?: readonly PresetModelRule[];
  identity?: PresetIdentity;
  /** 取 Key 的页面 */
  apiKeyUrl?: string;
  /** 不在渠道目录里展示（例如 lmstudio 由本地服务预设代替） */
  hidden?: boolean;
  /** 列表排序权重（小的在前；生成层顺序为次序） */
  order?: number;
};

export const PRESET_OVERLAYS: readonly PresetOverlay[] = [
  {
    id: "anthropic",
    native: true,
    category: "official",
    input: "key",
    defaultChatProtocol: "anthropic-messages",
    identity: "claude-cli",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    order: 10,
  },
  {
    id: "openai",
    native: true,
    category: "official",
    input: "key",
    dialect: "openai",
    defaultChatProtocol: "openai-responses",
    endpoints: { "openai-completions": { baseUrl: "https://api.openai.com/v1" } },
    identity: "codex-cli",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    order: 20,
  },
  {
    id: "gemini",
    name: "Gemini",
    native: true,
    category: "official",
    input: "key",
    defaultChatProtocol: "google-generative-ai",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    order: 30,
  },
  {
    id: "xai",
    native: true,
    category: "official",
    input: "key",
    dialect: "xai",
    defaultChatProtocol: "openai-responses",
    endpoints: { "openai-completions": { baseUrl: "https://api.x.ai/v1" } },
    identity: "grok-shell",
    apiKeyUrl: "https://console.x.ai",
    order: 40,
  },
  {
    id: "deepseek",
    native: true,
    category: "official",
    input: "key",
    dialect: "deepseek",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-responses": { baseUrl: "https://api.deepseek.com" },
      "anthropic-messages": {
        baseUrl: "https://api.deepseek.com/anthropic",
        note: "仅 V4 系列可用",
      },
    },
    models: [
      { match: "deepseek-chat", chatProtocols: ["openai-completions"] },
      { match: "deepseek-reasoner", chatProtocols: ["openai-completions"] },
    ],
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    order: 50,
  },
  {
    id: "groq",
    name: "Groq",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.groq.com/keys",
    order: 115,
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://open.bigmodel.cn/api/anthropic" } },
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    order: 60,
  },
  {
    id: "minimax",
    name: "MiniMax",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": { baseUrl: "https://api.minimax.io/v1" },
      "anthropic-messages": { baseUrl: "https://api.minimax.io/anthropic" },
    },
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    order: 70,
  },
  {
    id: "minimax-cn",
    name: "MiniMax（国内）",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": { baseUrl: "https://api.minimaxi.com/v1" },
      "anthropic-messages": { baseUrl: "https://api.minimaxi.com/anthropic" },
    },
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    order: 71,
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://api.moonshot.ai/anthropic" } },
    apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
    order: 80,
  },
  {
    id: "moonshot-cn",
    name: "Moonshot Kimi（国内）",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://api.moonshot.cn/anthropic" } },
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    order: 81,
  },
  {
    id: "dashscope",
    name: "通义千问（国际）",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
    order: 90,
  },
  {
    id: "dashscope-cn",
    name: "通义千问",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    },
    apiKeyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    order: 91,
  },
  {
    id: "volcengine",
    name: "豆包 · 火山方舟",
    category: "official",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    order: 100,
  },
  {
    id: "siliconflow",
    name: "硅基流动（国际）",
    category: "relay",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://cloud.siliconflow.com/account/ak",
    order: 110,
  },
  {
    id: "siliconflow-cn",
    name: "硅基流动",
    category: "relay",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "openai-completions": { baseUrl: "https://api.siliconflow.cn/v1" } },
    apiKeyUrl: "https://cloud.siliconflow.cn/account/ak",
    order: 111,
  },
  {
    id: "openrouter",
    category: "relay",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "anthropic-messages": { baseUrl: "https://openrouter.ai/api" },
      "openai-responses": { baseUrl: "https://openrouter.ai/api/v1", note: "待探测" },
    },
    models: [
      { match: "anthropic/*", chatProtocols: ["anthropic-messages", "openai-completions"] },
      { match: "openai/*", chatProtocols: ["openai-responses", "openai-completions"] },
    ],
    apiKeyUrl: "https://openrouter.ai/settings/keys",
    order: 120,
  },
  {
    id: "new-api",
    name: "New API / One API",
    category: "relay",
    input: "origin",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": { baseUrl: "{origin}/v1" },
      "openai-responses": { baseUrl: "{origin}/v1" },
      "anthropic-messages": { baseUrl: "{origin}" },
      "google-generative-ai": { baseUrl: "{origin}/v1beta" },
    },
    order: 130,
  },
  {
    id: "ollama",
    name: "Ollama",
    category: "self-hosted",
    input: "origin",
    defaultOrigin: "http://localhost:11434",
    authOptional: true,
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": {
        baseUrl: "{origin}/v1",
        quirks: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
        },
      },
    },
    order: 140,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    category: "self-hosted",
    input: "origin",
    defaultOrigin: "http://localhost:1234",
    authOptional: true,
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": {
        baseUrl: "{origin}/v1",
        quirks: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
        },
      },
    },
    modelListSource: "api",
    order: 141,
  },
  {
    id: "custom",
    name: "自定义渠道",
    category: "self-hosted",
    input: "base",
    defaultChatProtocol: "openai-completions",
    hidden: true,
    order: 999,
  },
];
