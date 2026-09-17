// 预设覆盖层：models.dev 不知道的事实（设计文档 3.2 / 3.3）。
//
// 生成层（presets.generated.ts）给出名称、文档、API 根地址、适配器与目录分区 id
// （模型列表在 lib/models/catalog.generated.ts 的 MODEL_CATALOG[sourceId]）；
// 这里补充：额外协议端点、方言、按模型的接口规则、CLI 身份档、用户需要填什么、
// 以及 models.dev 未收录的本地服务与通用网关。合并见 presets.ts。

import type { ProviderChatProtocol, ProviderWireDialect } from "./protocols";

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
  input: PresetInputKind;
  /** origin 类渠道的缺省地址（本地服务的默认端口） */
  defaultOrigin?: string;
  /** 无需密钥（本地服务） */
  authOptional?: boolean;
  dialect?: ProviderWireDialect;
  defaultChatProtocol?: ProviderChatProtocol;
  /** 追加或覆盖生成层的端点；键不存在则沿用生成层 */
  endpoints?: Partial<Record<ProviderChatProtocol, PresetEndpointOverlay>>;
  /**
   * 模型列表来源。catalog = 模型厂商自营渠道，模型列表随应用内置（目录分区
   * MODEL_CATALOG[sourceId]），探测不请求 `/models`；api = 聚合站、中转、本地
   * 服务与自定义渠道，模型列表只有问它才知道。缺省 api。
   * 声明了 catalog 但目录里没有该渠道的模型时由 presets.ts 退回 api。
   */
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
    modelListSource: "catalog",
    native: true,
    input: "key",
    defaultChatProtocol: "anthropic-messages",
    identity: "claude-cli",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    order: 10,
  },
  {
    id: "openai",
    modelListSource: "catalog",
    native: true,
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
    modelListSource: "catalog",
    name: "Gemini",
    native: true,
    input: "key",
    defaultChatProtocol: "google-generative-ai",
    apiKeyUrl: "https://aistudio.google.com/apikey",
    order: 30,
  },
  {
    id: "xai",
    modelListSource: "catalog",
    native: true,
    input: "key",
    dialect: "xai",
    defaultChatProtocol: "openai-responses",
    identity: "grok-shell",
    apiKeyUrl: "https://console.x.ai",
    order: 40,
  },
  {
    id: "deepseek",
    modelListSource: "catalog",
    native: true,
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
    modelListSource: "api",
    name: "Groq",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.groq.com/keys",
    order: 115,
  },
  {
    id: "zhipu",
    modelListSource: "catalog",
    name: "智谱 GLM",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://open.bigmodel.cn/api/anthropic" } },
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    order: 60,
  },
  {
    id: "zhipu-intl",
    modelListSource: "catalog",
    name: "智谱 Z.AI（国际）",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://api.z.ai/api/anthropic" } },
    apiKeyUrl: "https://z.ai/manage-apikey/apikey-list",
    order: 61,
  },
  // 套餐渠道（Coding / Token / Step Plan）：接入地址与模型列表独立于主渠道，
  // 各自一个预设，排在主渠道之后；取 Key 页沿用主渠道。
  {
    id: "zhipu-coding-plan",
    modelListSource: "catalog",
    name: "智谱 GLM · Coding Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://open.bigmodel.cn/api/anthropic" } },
    apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    order: 62,
  },
  {
    id: "minimax",
    modelListSource: "catalog",
    name: "MiniMax",
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
    modelListSource: "catalog",
    name: "MiniMax（国内）",
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
    id: "minimax-token-plan",
    modelListSource: "catalog",
    name: "MiniMax · Token Plan",
    input: "key",
    defaultChatProtocol: "anthropic-messages",
    endpoints: { "openai-completions": { baseUrl: "https://api.minimax.io/v1" } },
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    order: 72,
  },
  {
    id: "minimax-cn-token-plan",
    modelListSource: "catalog",
    name: "MiniMax（国内）· Token Plan",
    input: "key",
    defaultChatProtocol: "anthropic-messages",
    endpoints: { "openai-completions": { baseUrl: "https://api.minimaxi.com/v1" } },
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    order: 73,
  },
  {
    id: "moonshot",
    modelListSource: "catalog",
    name: "Moonshot Kimi",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://api.moonshot.ai/anthropic" } },
    apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
    order: 80,
  },
  {
    id: "moonshot-cn",
    modelListSource: "catalog",
    name: "Moonshot Kimi（国内）",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "anthropic-messages": { baseUrl: "https://api.moonshot.cn/anthropic" } },
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    order: 81,
  },
  {
    id: "kimi-for-coding",
    modelListSource: "catalog",
    name: "Kimi for Coding",
    input: "key",
    defaultChatProtocol: "anthropic-messages",
    apiKeyUrl: "https://www.kimi.com/code/console",
    order: 82,
  },
  {
    id: "dashscope",
    modelListSource: "catalog",
    name: "通义千问（国际）",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
    order: 90,
  },
  {
    id: "dashscope-cn",
    modelListSource: "catalog",
    name: "通义千问",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: {
      "openai-completions": { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    },
    apiKeyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    order: 91,
  },
  {
    id: "dashscope-coding-plan",
    modelListSource: "catalog",
    name: "通义千问（国际）· Coding Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
    order: 92,
  },
  {
    id: "dashscope-cn-coding-plan",
    modelListSource: "catalog",
    name: "通义千问 · Coding Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    order: 93,
  },
  {
    id: "dashscope-token-plan",
    modelListSource: "catalog",
    name: "通义千问（国际）· Token Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://modelstudio.console.alibabacloud.com/?tab=model#/api-key",
    order: 94,
  },
  {
    id: "dashscope-cn-token-plan",
    modelListSource: "catalog",
    name: "通义千问 · Token Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    order: 95,
  },
  {
    id: "volcengine",
    modelListSource: "catalog",
    name: "豆包 · 火山方舟",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    order: 106,
  },
  {
    id: "volcengine-coding-plan",
    modelListSource: "catalog",
    name: "豆包 · 火山方舟 · Coding Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    order: 107,
  },
  {
    id: "stepfun",
    modelListSource: "catalog",
    name: "阶跃星辰（国际）",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    order: 85,
  },
  {
    id: "stepfun-cn",
    modelListSource: "catalog",
    name: "阶跃星辰",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.stepfun.com/interface-key",
    order: 86,
  },
  {
    id: "stepfun-step-plan",
    modelListSource: "catalog",
    name: "阶跃星辰（国际）· Step Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.stepfun.ai/interface-key",
    order: 87,
  },
  {
    id: "stepfun-cn-step-plan",
    modelListSource: "catalog",
    name: "阶跃星辰 · Step Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.stepfun.com/interface-key",
    order: 88,
  },
  {
    id: "tencent",
    modelListSource: "catalog",
    name: "腾讯云 · 混元",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.cloud.tencent.com/lkeap/api",
    order: 96,
  },
  {
    id: "tencent-coding-plan",
    modelListSource: "catalog",
    name: "腾讯云 · Coding Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.cloud.tencent.com/lkeap/api",
    order: 97,
  },
  {
    id: "tencent-token-plan",
    modelListSource: "catalog",
    name: "腾讯云 · Token Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.cloud.tencent.com/lkeap/api",
    order: 98,
  },
  {
    id: "baidu",
    modelListSource: "catalog",
    name: "百度千帆",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "openai-completions": { baseUrl: "https://qianfan.baidubce.com/v2" } },
    apiKeyUrl: "https://console.bce.baidu.com/iam/#/iam/apikey/list",
    order: 99,
  },
  {
    id: "xiaomi",
    modelListSource: "catalog",
    name: "小米 MiMo",
    input: "key",
    defaultChatProtocol: "openai-completions",
    // 官方 Anthropic 兼容入口：{base}/v1/messages（用户提供）。
    endpoints: { "anthropic-messages": { baseUrl: "https://api.xiaomimimo.com/anthropic" } },
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    order: 100,
  },
  {
    id: "xiaomi-token-plan-cn",
    modelListSource: "catalog",
    name: "小米 MiMo · Token Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    order: 101,
  },
  {
    id: "xiaomi-token-plan-eu",
    modelListSource: "catalog",
    name: "小米 MiMo（欧洲）· Token Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    order: 102,
  },
  {
    id: "xiaomi-token-plan-sg",
    modelListSource: "catalog",
    name: "小米 MiMo（新加坡）· Token Plan",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    order: 103,
  },
  {
    id: "longcat",
    modelListSource: "catalog",
    name: "美团 LongCat",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://longcat.chat/platform/api_keys",
    order: 104,
  },
  {
    id: "sensenova",
    modelListSource: "catalog",
    name: "商汤 SenseNova",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://console.sensecore.cn/iam/Security/access-key",
    order: 105,
  },
  {
    id: "xunfei",
    modelListSource: "catalog",
    name: "讯飞星火",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "openai-completions": { baseUrl: "https://spark-api-open.xf-yun.com/v1" } },
    apiKeyUrl: "https://console.xfyun.cn/services/bmx1",
    order: 108,
  },
  {
    id: "modelscope",
    modelListSource: "api",
    name: "魔搭 ModelScope",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://modelscope.cn/my/myaccesstoken",
    order: 113,
  },
  {
    id: "siliconflow",
    modelListSource: "api",
    name: "硅基流动（国际）",
    input: "key",
    defaultChatProtocol: "openai-completions",
    apiKeyUrl: "https://cloud.siliconflow.com/account/ak",
    order: 110,
  },
  {
    id: "siliconflow-cn",
    modelListSource: "api",
    name: "硅基流动",
    input: "key",
    defaultChatProtocol: "openai-completions",
    endpoints: { "openai-completions": { baseUrl: "https://api.siliconflow.cn/v1" } },
    apiKeyUrl: "https://cloud.siliconflow.cn/account/ak",
    order: 111,
  },
  {
    id: "openrouter",
    modelListSource: "api",
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
    modelListSource: "api",
    name: "New API / One API",
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
    modelListSource: "api",
    name: "Ollama",
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
    modelListSource: "api",
    name: "LM Studio",
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
    order: 141,
  },
  {
    id: "custom",
    modelListSource: "api",
    name: "自定义渠道",
    input: "base",
    defaultChatProtocol: "openai-completions",
    hidden: true,
    order: 999,
  },
];
