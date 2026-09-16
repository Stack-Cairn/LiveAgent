# 供应商配置、预设注册表与多接口路由设计

| 元数据 | 内容 |
| --- | --- |
| 状态 | v2.3。第 1 阶段（模型级聊天协议与端点 Base URL 覆盖）已实现；其余待实现 |
| 修订日期 | 2026-09-15 |
| 适用范围 | 桌面端与 Gateway WebUI 的供应商设置、聊天运行时、文本辅助请求、自动故障转移 |
| 不包含 | 图像生成、Embedding、Rerank 等非聊天操作；价格与计费；凭据隔离（另立文档） |

## 1. 结论

1. **供应商配置以 `CustomProvider` 为主体增量演进**，不做整体重写。旧存档零迁移，新字段全部可选。
2. **聊天接口只有四类**：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini generateContent。厂商差异用**方言**表达，不新增协议。
3. **每家供应商有一份预设定义**：声明它提供哪些接口、各接口的地址、鉴权头、方言、按模型的接口限制。用户选预设、填 Key，其余由预设与探测自动得出。
4. **接口是供应商内部的渠道**，有独立的启用开关、探测状态和配置；模型可以声明自己能走哪些渠道，首项即路由，其余作故障转移候选。
5. **路由是一个纯函数**，输出协议、方言、地址、远端模型 ID、凭据与最终请求头；运行时、界面和故障转移都只读这一份结果。
6. **故障转移保留并按接口家族分组**，候选按凭据、端点、供应商三层展开，共用一份切换预算。

## 2. 领域模型

### 2.1 三层事实

| 事实 | 对象 | 内容 |
| --- | --- | --- |
| 谁提供连接与凭据 | `CustomProvider` | 名称、预设、凭据列表、主连接、请求默认值、系统代理、重试、用量查询 |
| 这次请求怎样发 | `ProviderEndpointConfig`（供应商内按接口分键） | 启用、地址、模型列表地址、方言、开关、鉴权头覆盖、指定凭据、端点请求头 |
| 模型能做什么 | `ProviderModelConfig` | 远端 ID、可用接口列表、方言、分组、能力、模态、限制、参数覆盖 |

### 2.2 四类接口与方言

```ts
type ProviderChatProtocol =
  | "anthropic-messages"     // Anthropic v1/messages
  | "openai-completions"     // OpenAI Chat Completions
  | "openai-responses"       // OpenAI Responses
  | "google-generative-ai";  // Gemini v1beta generateContent

type ProviderWireDialect =
  | "generic"    // 只发协议规定的字段，鉴权只带协议头档
  | "openai"     // OpenAI 官方语义：store、prompt_cache_*、Codex 会话头
  | "xai"        // 剥离 xAI 不接受的字段，effort 映射，include 追加
  | "deepseek";  // 剥离 DeepSeek 不接受的字段，端点路径规范化，响应状态回放
```

四个协议字面量与 pi-ai 的 `Model.api` 一致。协议决定请求体结构、流解析、端点路径和适配器实现；方言决定同一协议下的字段取舍、鉴权附加头、思考参数映射。`xai` 与 `deepseek` 只属于 Responses，`openai` 属于两类 OpenAI 接口，Anthropic 与 Gemini 目前只有 `generic`。

方言解析顺序：模型 > 端点 > 供应商 > 预设 > 旧 `type` 推导（xai → xai，deepseek → deepseek，codex → openai）> 官方域名推导 > `generic`。其中预设或旧分组给出的 `openai` 只是"OpenAI 官方语义"的缺省：端点域名明确是 api.x.ai / api.deepseek.com 时以域名为准，保证旧的"OpenAI 分组直连 xAI"配置行为不变。

网关实现偏差（quirks）同样有推导层：pi-ai 隔着本地反代只能看到 127.0.0.1，认不出 z.ai / OpenRouter / 通义 / Moonshot 等已知网关，路由按端点域名补上 `thinkingFormat`、`maxTokensField`、`supportsReasoningEffort` 等推导值；预设与用户声明的 quirks 覆盖推导值。

接口家族用于故障转移分组：Anthropic、OpenAI（Completions 与 Responses）、Gemini。

### 2.3 供应商

```ts
type CustomProvider = {
  id: string;
  name: string;
  /** 旧字段，语义收窄为旧路由推导来源；不再新增取值 */
  type: ProviderId;
  /** 预设 ID；自定义供应商为空 */
  presetId?: string;
  enabled: boolean;

  // 主连接 = 未覆盖接口的缺省端点
  baseUrl: string;
  isFullUrl: boolean;
  modelsUrl?: string;
  customHeaders?: CustomHeader[];

  // 凭据。apiKey 始终等于 credentials[0]，保证旧读者可用
  apiKey: string;
  apiKeyConfigured?: boolean;
  credentials?: ProviderCredential[];

  // 接口
  defaultChatProtocol?: ProviderChatProtocol;
  dialect?: ProviderWireDialect;
  endpointConfigs?: Partial<Record<ProviderChatProtocol, ProviderEndpointConfig>>;

  // 请求默认值（不变）
  reasoning: ReasoningLevel;
  promptCachingEnabled: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled: boolean;
  useSystemProxy: boolean;
  retryPolicy?: ProviderRetryPolicy;
  usageQuery: UsageQueryConfig;

  models: ProviderModelConfig[];
  modelOrder?: string[];
  activeModels: string[];
  /** 旧字段，加载时回填进 defaultChatProtocol 后成为冗余，仍写入 */
  requestFormat?: CodexRequestFormat;
};

type ProviderCredential = {
  id: string;
  label: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  enabled: boolean;
  /** 该 Key 能用哪些模型。缺省 auto，见 5.6 */
  modelScope?:
    | { mode: "all" }
    | { mode: "auto" }                       // 以探测到的列表为准
    | { mode: "manual"; models: string[] };  // 用户手选，支持前缀通配
  /** 观测值：上次用此 Key 拉到的模型列表 */
  lastModels?: { at: number; models: string[]; byProtocol: Partial<Record<ProviderChatProtocol, string[]>> };
};

type ProviderEndpointConfig = {
  /** 渠道开关，缺省 true */
  enabled?: boolean;
  baseUrl: string;
  isFullUrl?: boolean;
  modelsUrl?: string;
  dialect?: ProviderWireDialect;
  /** 网关实现偏差；键即 pi-ai Model.compat 同名键 */
  quirks?: {
    supportsUsageInStreaming?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsStore?: boolean;
  };
  /** 鉴权头覆盖；缺省由协议头档决定 */
  auth?: { headerName?: string; prefix?: string };
  /** 引用 credentials[].id；缺省用默认凭据 */
  credentialId?: string;
  headers?: CustomHeader[];
  /** 观测值，不参与路由 */
  lastProbe?: { at: number; status: "ok" | "missing" | "unauthorized" | "unknown"; latencyMs?: number; error?: string };
};
```

多 Key 首版只做"有序备用 + 熔断到凭据"，不做加权轮询。凭据只在供应商内使用，端点可以通过 `credentialId` 指定首选。不同 Key 可能看到不同的模型集合，处理规则见 5.6。用量查询继续用自己的 Key。

### 2.4 模型

```ts
type ProviderModelConfig = {
  id: string;                       // 本地稳定 ID，目录匹配与熔断 key 用它
  wireModelId?: string;             // 发给远端的模型名，缺省等于 id
  displayName?: string;
  group?: string;                   // 列表分组，缺省由模型家族推导
  modelType?: "chat";               // image / embedding / rerank 保留，暂不可选
  chatProtocol?: ProviderChatProtocol;      // 显式选用的接口；可选范围见 4.2
  dialect?: ProviderWireDialect;
  ownedBy?: string;

  contextWindow: number;
  maxInputTokens?: number;
  maxOutputToken: number;
  limitsSource?: ModelLimitsSource;

  inputModalities?: ModelInputModalitiesOverride;
  capabilities?: Partial<Record<ChatCapabilityName, FieldValue<CapabilityState>>>;
  reasoning?: ReasoningLevel;             // 默认使用哪一档；可选档位来自模型目录，见 6.5
  nativeWebSearch?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
};
```

能力、模态与限制的详细规则见第 6 节。

## 3. 预设注册表：每家供应商的接口定义

### 3.1 目的与定位

用户面对的问题是"这家渠道到底有哪些接口、地址各是什么、Key 放在哪个头里、哪些模型只能走哪个接口"。这些是事实，不应该让用户猜，也不应该写成代码分支。预设注册表把它们做成随应用发布的数据。

注册表同时就是设置页左栏的**渠道目录**：列表里的每一项都是一个注册表条目，已配置的在前，未配置的在后；用户点开未配置的渠道，填 Key（网关和本地服务再填地址），点"检测并启用"即可。四类接口是渠道内部的传输方式，出现在渠道详情与请求配置抽屉里，不作为列表的分类维度。扩展新渠道（MiniMax、GLM、Moonshot 等）就是新增一个注册表条目，不改界面与路由代码。

### 3.2 数据格式

```ts
type ProviderPreset = {
  id: string;                        // "anthropic" | "openai" | "deepseek" | "xai" | "gemini" | "zhipu" | "minimax" | "openrouter" | "new-api" | "ollama" …
  name: string;
  /** 五家原生接口渠道为 true；列表排序与"原生"标记用 */
  native?: boolean;
  /** 用户需要填写什么：只填 Key、填 origin、填完整 Base URL */
  input: "key" | "origin" | "base";
  /** origin 类渠道的缺省地址，例如本地服务的默认端口 */
  defaultOrigin?: string;
  /** 对应 pi-ai 内置 provider id，用于取静态模型目录；没有则省略 */
  piAiProviderId?: string;
  website?: { official?: string; apiKey?: string; docs?: string; models?: string };

  auth: { kind: "api-key"; headerName?: string; prefix?: string } | { kind: "none" };
  /** 预设级方言；端点可覆盖 */
  dialect?: ProviderWireDialect;
  defaultChatProtocol: ProviderChatProtocol;
  /** 该供应商提供的接口。键不存在 = 不提供，探测也不会去试 */
  endpoints: Partial<Record<ProviderChatProtocol, PresetEndpoint>>;
  /** 模型列表来源：api = 各接口的 models 地址；catalog = 只用 pi-ai 静态目录 */
  modelListSource: "api" | "catalog";
  /** 按模型的接口限制与覆盖 */
  models?: PresetModelRule[];
  /** 推荐的 CLI 身份档 */
  identityPreset?: "claude-cli" | "codex-cli" | "grok-shell";
};

type PresetEndpoint = {
  /** 地址模板。{origin} 由用户填写的地址取 scheme+host；官方预设直接写全 */
  baseUrl: string;
  modelsUrl?: string;
  dialect?: ProviderWireDialect;
  quirks?: ProviderEndpointConfig["quirks"];
  auth?: { headerName?: string; prefix?: string };
  /** 界面提示，例如"仅 V4 系列可用" */
  note?: string;
};

type PresetModelRule = {
  /** 精确 ID 或前缀通配（"claude-*"、"deepseek-v4-*"） */
  match: string;
  chatProtocols?: ProviderChatProtocol[];
  wireModelId?: string;
  dialect?: ProviderWireDialect;
  capabilities?: Partial<Record<ChatCapabilityName, CapabilityState>>;
  limits?: { contextWindow?: number; maxInputTokens?: number; maxOutputTokens?: number };
  /** 目录未收录的厂商模型可在预设里补档位；与目录同结构 */
  thinking?: { levels: ThinkingLevel[]; off: boolean };
  hidden?: boolean;
};
```

### 3.3 首批渠道

分两类：**原生接口**（应用自带适配器语义的五家）与**其他渠道**（按四类接口之一接入的厂商、中转与本地服务）。

| 渠道 | 说明 | 接口与地址 | 鉴权 | 方言 | 按模型规则 |
| --- | --- | --- | --- | --- | --- |
| Anthropic | 原生 | anthropic-messages `https://api.anthropic.com/v1`（默认） | x-api-key + anthropic-version；OAuth Key 时不带 | generic | — |
| OpenAI | 原生 | openai-responses `https://api.openai.com/v1`（默认）；openai-completions 同地址 | Bearer | openai | — |
| Gemini | 原生 | google-generative-ai `https://generativelanguage.googleapis.com/v1beta`（默认） | x-goog-api-key | generic | — |
| xAI | 原生 | openai-responses `https://api.x.ai/v1`（唯一接口） | Bearer | xai | — |
| DeepSeek | 原生 | openai-completions `https://api.deepseek.com`（默认）；openai-responses 同地址；anthropic-messages `https://api.deepseek.com/anthropic` | Bearer | deepseek | `deepseek-chat`、`deepseek-reasoner` 只允许 Completions；anthropic-messages 端点只允许 `deepseek-v4-*` |
| 智谱 GLM | 厂商 | openai-completions `https://open.bigmodel.cn/api/paas/v4`（默认）；anthropic-messages `https://open.bigmodel.cn/api/anthropic` | Bearer | generic | — |
| MiniMax | 厂商 | openai-completions `https://api.minimaxi.com/v1`（默认）；anthropic-messages `https://api.minimaxi.com/anthropic` | Bearer | generic | — |
| Moonshot Kimi | 厂商 | openai-completions `https://api.moonshot.cn/v1`（默认）；anthropic-messages `https://api.moonshot.cn/anthropic` | Bearer | generic | — |
| 通义千问 | 厂商 | openai-completions `https://dashscope.aliyuncs.com/compatible-mode/v1` | Bearer | generic | — |
| 豆包 · 火山方舟 | 厂商 | openai-completions `https://ark.cn-beijing.volces.com/api/v3` | Bearer | generic | — |
| 阶跃星辰 | 厂商 | openai-completions `https://api.stepfun.com/v1`（国内）/ `https://api.stepfun.ai/v1`（国际） | Bearer | generic | — |
| 腾讯云 · 混元 | 厂商 | openai-completions `https://tokenhub.tencentmaas.com/v1` | Bearer | generic | — |
| 百度千帆 | 厂商 | openai-completions `https://qianfan.baidubce.com/v2`（覆盖层声明，models.dev 未收录） | Bearer | generic | — |
| 小米 MiMo | 厂商 | openai-completions `https://api.xiaomimimo.com/v1` | Bearer | generic | — |
| 美团 LongCat | 厂商 | openai-completions `https://api.longcat.chat/openai` | Bearer | generic | — |
| 商汤 SenseNova | 厂商 | openai-completions `https://token.sensenova.cn/v1` | Bearer | generic | — |
| 讯飞星火 | 厂商 | openai-completions `https://spark-api-open.xf-yun.com/v1`（覆盖层声明，models.dev 未收录） | Bearer | generic | — |
| 套餐渠道 | 厂商 | 以下厂商的 Coding / Token / Step Plan 各为独立渠道，地址与模型列表取自 models.dev 对应条目：智谱 GLM · Coding Plan `https://open.bigmodel.cn/api/coding/paas/v4`（anthropic-messages 同主渠道）；MiniMax · Token Plan（国际 / 国内）anthropic-messages `https://api.minimax.io/anthropic/v1` / `https://api.minimaxi.com/anthropic/v1`（默认），openai-completions 同主渠道；通义千问 · Coding Plan（国际 / 国内）`https://coding-intl.dashscope.aliyuncs.com/v1` / `https://coding.dashscope.aliyuncs.com/v1`；通义千问 · Token Plan（国际 / 国内）`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` / `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；豆包 · 火山方舟 · Coding Plan `https://ark.cn-beijing.volces.com/api/coding/v3`；阶跃星辰 · Step Plan（国内 / 国际）`https://api.stepfun.com/step_plan/v1` / `https://api.stepfun.ai/step_plan/v1`；腾讯云 · Coding Plan `https://api.lkeap.cloud.tencent.com/coding/v3`；腾讯云 · Token Plan `https://api.lkeap.cloud.tencent.com/plan/v3`；小米 MiMo · Token Plan（国内 / 欧洲 / 新加坡）`https://token-plan-cn.xiaomimimo.com/v1` / `https://token-plan-ams.xiaomimimo.com/v1` / `https://token-plan-sgp.xiaomimimo.com/v1`；Kimi for Coding anthropic-messages `https://api.kimi.com/coding/v1` | Bearer | generic | — |
| 魔搭 ModelScope | 聚合 | openai-completions `https://api-inference.modelscope.cn/v1` | Bearer | generic | — |
| 硅基流动 | 中转 | openai-completions `https://api.siliconflow.cn/v1` | Bearer | generic | — |
| OpenRouter | 中转 | openai-completions `https://openrouter.ai/api/v1`（默认）；anthropic-messages `https://openrouter.ai/api`；openai-responses 待探测 | Bearer | generic | `anthropic/*` 偏好 Messages；`openai/*` 偏好 Responses |
| New API / One API | 中转（自部署） | 四类全部：openai-* `{origin}/v1`，anthropic-messages `{origin}`，google-generative-ai `{origin}/v1beta`；默认 Completions | Bearer | generic | 按家族表 |
| Ollama / LM Studio | 本地 | openai-completions `{origin}/v1`，缺省 origin 为各自默认端口 | 无 | generic；quirks 关闭 developer 角色与 reasoning_effort | — |
| 自定义 | — | 不声明；探测四类 | Bearer | 按域名推导 | 按家族表 |

现有五个 `ProviderId` 分组各对应一个原生渠道。旧存档加载时按 `type` 补 `presetId`；反过来，新建的非原生渠道实例按默认接口家族回填 `type`（Messages → `claude_code`，Gemini → `gemini`，OpenAI 家族 → `codex`；xAI、DeepSeek 原生渠道保持各自的值），这样 P1.5 完成前仍读 `type` 的 61 处代码（15 个文件）行为不变。同一渠道可以有多个实例（多账号、多地址），实例名自动加序号。地址与方言取自各家公开文档，接入前以探测结果为准。`modelListSource: "catalog"` 的渠道不做列表探测，状态显示"目录渠道"。

### 3.4 模型家族表

同一张表服务三处：模型列表分组、默认接口推断、原生搜索资格。

| 家族（ID 模式） | 接口偏好顺序 | 默认方言 |
| --- | --- | --- |
| claude | anthropic-messages → openai-completions | generic |
| gemini / gemma | google-generative-ai → openai-completions | generic |
| gpt / o1–o4 / codex / chatgpt | openai-responses → openai-completions | openai（官方域名）/ generic |
| grok | openai-responses → openai-completions | xai |
| deepseek | openai-completions → openai-responses → anthropic-messages | deepseek |
| glm / kimi / qwen / minimax / doubao / hunyuan / mistral 等 | openai-completions | generic |
| 其他 | openai-completions | generic |

### 3.5 来源与维护

- 注册表是应用内的 TypeScript 数据模块（agent-ui 共享层），不是用户可编辑文件；构建期由脚本从 pi-ai 内置供应商派生基础项（id、Base URL、接口集合、静态模型目录），再叠加手工维护的覆盖层（方言、pi-ai 未收录的接口、网关形态、按模型规则）。派生脚本与覆盖层都进仓库，生成产物有版本号。
- 预设更新随应用版本发布。用户供应商记录 `presetId` 与采用时的预设版本；新版本预设的非敏感变化（名称、说明、新增接口）在详情页提示"预设已更新"，地址与鉴权变化需要用户确认后应用，不静默改。
- 远程拉取预设不在首版范围。

### 3.6 用户怎样使用

1. 左栏渠道目录里点开未配置的渠道。厂商与原生渠道只需填 Key；网关填 origin 与 Key；本地服务只确认地址；未内置的渠道用搜索框下的"添加渠道"，按接口填 Base URL 与 Key。
2. 点"检测并启用"：按注册表声明的接口逐个探测（自定义探测四类），拉取模型，生成摘要。
3. 采纳摘要后该渠道成为已配置实例，排到列表前部。所有由注册表与探测得出的值带"自动"标签，可改可还原。
4. 已配置渠道的详情页可"再加一个实例"，用于第二个账号或另一个地址。

## 4. 路由解析

### 4.1 纯函数

```ts
type ResolvedProviderChatRoute = {
  protocol: ProviderChatProtocol;
  dialect: ProviderWireDialect;
  family: "anthropic" | "openai" | "gemini";
  baseUrl: string;
  isFullUrl: boolean;
  modelsUrl?: string;
  wireModelId: string;
  credentialId: string;
  credentialSource: "endpoint" | "scope" | "fallback";
  headers: CustomHeader[];        // 供应商级与端点级用户头合并后的结果
  quirks: ProviderEndpointConfig["quirks"];
  source: "model" | "preset" | "family" | "provider" | "legacy";  // 接口的来源，供界面显示"自动"
  /** 过渡期派生值；新读取点改读 protocol 与 dialect */
  adapterProviderId: ProviderId;
  requestFormat?: CodexRequestFormat;
};
```

`resolveProviderChatRoute(provider, modelId, options?)` 在 `createProviderRuntimeConfig` 构造运行时配置时调用一次，结果写入 `ProviderRuntimeConfig`；界面侧的调用只读 `protocol`、`dialect`、`source`。凭据值不进入路由结果，运行时按 `credentialId` 取值。

### 4.2 接口的决定顺序

1. 模型显式选用的 `chatProtocol`（须已启用；否则视为未指定）。
2. 预设按模型规则给出的列表中第一个已启用的渠道。
3. 模型家族偏好 ∩ 供应商已启用渠道，取交集第一个。
4. 供应商 `defaultChatProtocol`（必须已启用）。
5. 旧推导：`type` 与 `requestFormat`。

**模型可显式选用的接口**（`modelSelectableProtocols`）按渠道决定，不由用户维护列表：

| 渠道 | 可选接口 |
| --- | --- |
| Anthropic（原生） | Anthropic Messages（固定） |
| OpenAI（原生） | Chat Completions ↔ Responses |
| xAI（原生） | Responses（固定） |
| Gemini（原生） | generateContent v1beta（固定） |
| DeepSeek（原生） | 预设声明的三个接口 |
| 其它渠道（厂商 / 中转 / 自建 / 自定义） | Chat Completions、Responses、Anthropic Messages；Gemini 系列模型再加 v1beta |

选项里没有配置地址（或已停用）的接口置灰不可选。模型只选一个接口；端点层故障转移候选不再由模型维护有序列表，而是自动取供应商已启用的同家族其它接口（8.2）。

交集为空不猜测，直接退到第 4 步并把 `source` 标为 `provider`。任何一步得到的渠道若被关闭，跳到下一步。

### 4.3 请求头装配

三层内置头档加用户头，合并顺序固定：

```text
协议头档 < 方言头档 < 端点身份档 < 供应商 customHeaders < 端点 headers
```

| 层 | 内容 | 键 |
| --- | --- | --- |
| 协议头档 | 鉴权头名（可被端点 `auth` 覆盖）、协议版本头 | protocol |
| 方言头档 | Anthropic SDK 指纹头 + 每会话 `X-Claude-Code-Session-Id`；Responses + OpenAI 官方方言的 Codex 会话头 | (protocol, dialect) |
| 端点身份档 | 端点 `identity` 选定的 CLI：User-Agent、静态身份头（Codex 的 originator / version、grok-shell 的客户端头、Anthropic SDK 头）与该 CLI 的每会话动态头 | 端点 |
| 用户头 | 供应商级、端点级业务头 | 供应商 / 端点 |

**身份模拟按端点，不按供应商。** 同一个中转开了 Messages / Responses / Completions 三个端点时，每个端点各自选择 Claude Code / Codex / Grok / 不模拟 / 纯协议头；推荐值按该端点自己的接口与方言给（Messages → Claude Code，xAI 方言 → Grok，其余 OpenAI 家族 → Codex，Gemini 无对应 CLI）。缺省（未选）= 只有协议头档 + 方言头档，与改造前一致；`none` = 连方言头都不带。供应商级请求头编辑器不再提供"模拟 CLI"，检测到旧配置里供应商级写入的 CLI 身份头时给出提示与一键移除，避免一套指纹覆盖到所有接口。

同名按大小写不敏感覆盖。保留键（`anthropic-beta`、`Content-Type`、`Content-Length`、`Host`、代理控制头）由发请求一侧最终决定。Grok 的每回合头（conv / req / turn）没有稳定来源，不伪造。装配实现在共享层 `lib/providers/requestHeaders.ts`，设置页"最终请求头"预览与运行时 `prepareProviderRequest` 用同一份。不做按模型的请求头。

### 4.4 与 pi-ai 的对应

| 本稿 | pi-ai 落点 |
| --- | --- |
| 协议 | `Model.api` 四个字面量 |
| 方言 | `Model.provider` 填方言 id，使 `detectCompat` 生效；Responses 下的 xai / deepseek 剥离仍由本项目中间件承担 |
| 端点 quirks | `Model.compat` 同名键 |
| 思考档位与 wire 映射 | 可选档位来自本项目模型目录（6.5）；发送方式经 `Model.thinkingLevelMap` 与 `compat.thinkingFormat` |
| 用户头 | `Model.headers` 或 stream `options.headers`，最终经本地代理上游头覆盖包 |
| 预设与模型目录初值 | 内置供应商工厂的 `getModels()` |

不切换到 pi-ai 的 `createModels()` 注册表：本项目继续手工构造 `Model` 并经 `resolveAdapter(model.api)` 调用 API 实现，以保留本地代理、凭据脱敏、故障转移与分发针孔。`modelFactory.ts` 里与 `detectCompat` 重复的域名判断在 P1.5 删除。`Model.provider` 改填方言后，凡读 `message.provider` 做判断的代码改读路由结果里的供应商实例 id。

## 5. 快速接入、探测与渠道开关

### 5.1 三级控制

| 级别 | 用户操作 | 系统行为 |
| --- | --- | --- |
| 快速接入 | 选预设，填地址与 Key，点"检测并配置" | 按预设探测接口，拉取模型，推断分组、接口、方言、能力，生成摘要 |
| 摘要确认 | 一键采纳，或勾掉不要的渠道与模型分组 | 只写入采纳的内容，值标 `auto` |
| 高级调整 | 请求配置抽屉、编辑模型抽屉 | 用户改动标 `user`，每项旁有"还原为自动" |

### 5.2 探测

只用各接口的模型列表请求，不产生生成任务。现有 `buildProviderModelsAttempts` 与 Rust 侧 `provider_models.rs` 的"先 Bearer 再官方形式"两段尝试是现成实现，改为对预设声明的每个接口各跑一次，在 Rust 侧执行，经本地代理与系统代理策略。

| 结果 | 判定 |
| --- | --- |
| 200 且解析出模型数组 | 可用；记录模型与耗时 |
| 404 / 405 | 不存在；不启用，不报错 |
| 401 / 403 | 鉴权失败；摘要显示原因，不启用 |
| 其他 | 未知；默认不启用，用户可强制启用 |

WebUI 发起的探测经现有 `gateway_provider_models` 命令转到桌面执行，WebUI 自身不直连上游。Completions 与 Responses 共用模型列表地址，无法用列表区分，两者同时标可用；默认接口按预设或家族表决定，Responses 真实可用性由首次请求与端点层故障转移兜底。结果存入端点 `lastProbe`，是观测不是配置；地址或 Key 变更后自动重探。真实聊天测试单独按钮，跑前提示可能计费。

### 5.3 自动配置产物

1. 每个可用接口一条 `endpointConfigs[protocol]`，`enabled: true`，地址来自预设模板或探测所用地址。
2. 默认接口：预设声明的默认接口若可用则用；否则取可用接口里家族表最常见的一个。
3. 方言按 2.2 顺序。
4. 模型：各接口列表合并去重；`group` 按家族表；`chatProtocol` 只在预设规则明确指定时写入，否则留空按 4.2 推断；能力与限制取目录，未命中标 `unknown`。
5. 鉴权头名只在探测证明仅某种头可通过时写覆盖。
6. 请求头、多 Key、quirks 不自动生成。

### 5.4 渠道开关

`endpointConfigs[protocol].enabled` 与供应商启用、模型启用平行：

- 关闭的渠道不参与路由、模型发现、故障转移端点层。
- 模型引用了关闭渠道时解析跳过；全部跳完退到供应商默认接口；默认接口也关闭则标"无可用渠道"，选择器灰显，配置不删。
- 默认接口不能直接关闭，须先切换默认；界面直接给切换动作。
- 详情页只展示已启用渠道；请求配置抽屉展示全部，关闭的折叠并标"已停用"。
- 模型编辑抽屉的接口多选只列已启用渠道。
- 每个渠道有状态芯片：未检测 / 可用含耗时 / 不存在 / 鉴权失败 / 未知，可单独重测。

### 5.5 自动值与用户值

- 自动值随重探刷新；用户值不被覆盖，只提示"自动值已变化"。
- "还原为自动"清除用户值。
- 手工添加的模型不因重探删除；上游不再返回的自动模型只标记。
- 来源结构复用第 6 节的 `FieldValue`。
- 观测值（端点 `lastProbe`、凭据 `lastModels`）与配置同存于 `provider_settings` 的 JSON 中，但备份快照与 Gateway 同步导出时剥离；OpenRouter 一类渠道的列表可达数百项，单条观测上限 1000 个模型 ID，超出截断并标记。

### 5.6 多 Key 与模型范围

同一渠道下多把 Key 有两种情况，必须都能表达：

| 情况 | 例子 | 期望行为 |
| --- | --- | --- |
| Key 可互换：各 Key 看到同一批模型 | 同一中转的两个账号 | 任意 Key 都能服务任意模型；按顺序备用，失败换下一把 |
| Key 各管一片：不同 Key 看到不同模型 | 一把 Key 只开通了 Claude 系列，另一把只开通了 GPT 系列；或两把 Key 有交集但不相同 | 每个模型只用能服务它的 Key；凭据层故障转移只在能服务它的 Key 之间切换 |

**模型范围**是每把 Key 的属性：

- `auto`（缺省）：以该 Key 最近一次拉取的模型列表为准。探测时对每把启用的 Key 各拉一次列表（按已启用渠道），结果存入 `lastModels`，是观测不是配置。
- `all`：不看列表，任何模型都可用。用于列表接口不可用或不完整的渠道。
- `manual`：用户手选或写前缀通配，例如 `claude-*`。

**模型目录合并**：各 Key 各渠道拉到的列表按模型 ID 取并集，`provider.models` 里每个模型只出现一次；每个模型记录"哪些 Key 看到它"，这个集合由各 Key 的 `lastModels` 派生，不单独存。摘要页显示"K 把 Key 看到 N 个模型；其中 M 个只有某把 Key 可用"。

**选 Key 的顺序**（路由函数的一部分）：

1. 端点 `credentialId` 指定的 Key，且该模型在其范围内。
2. 按凭据列表顺序，第一把启用且范围包含该模型的 Key。
3. 都不包含时，用第一把启用的 Key，并在路由结果里标 `credentialSource: "fallback"`，模型行显示"未在任何 Key 的列表中"。不阻止请求，因为列表接口漏报很常见。

**凭据层故障转移**只在范围包含该模型的 Key 之间展开；`all` 范围的 Key 总是候选。熔断 key 仍是 `provider::credential::model`，所以一把 Key 对某个模型失败不影响它服务其他模型。

**界面**：

- 管理密钥抽屉每把 Key 显示范围模式、上次看到的模型数、与默认 Key 的差异（"与主 Key 相同" / "多 3 个、少 5 个"），可切换 auto / all / manual。
- 模型行在多 Key 且范围不同时显示"Key：主账号 / 备用账号"小标签；只有一把 Key 能用时显示那把的名字。
- 编辑模型抽屉可以指定凭据（覆盖自动选择），显示为用户值。
- "获取模型列表"按启用的 Key × 启用的渠道遍历，合并后刷新观测；某把 Key 拉取失败不清空它上次的观测，只标"上次刷新失败"。

**边界**：两把 Key 都能看到同一模型但配额等级不同，视为可互换，不在本稿处理；Key 与渠道绑定（某把 Key 只能用于某个接口）通过端点 `credentialId` 加该 Key 的范围共同表达，不再引入"Key 的渠道范围"字段。

## 6. 模型能力、模态与限制

### 6.1 能力状态与有效能力

```ts
type CapabilityState = "supported" | "unsupported" | "unknown";
type ModelModality = "text" | "image" | "audio" | "video" | "file";
type ChatCapabilityName =
  | "reasoning" | "tools" | "parallelTools" | "structuredOutput"
  | "nativeWebSearch" | "promptCaching" | "fileInput" | "imageUnderstanding";
```

有效能力是三方交集：模型声明、所选接口适配器的实现范围、供应商级开关。适配器不支持的能力模型声明也无效，界面标"当前适配器不支持"；模型声明不支持的能力供应商开关不能打开；`unknown` 按能力处理，`tools` / `reasoning` / `promptCaching` 沿用启发式并标来源，`imageUnderstanding` / `fileInput` 未知时不自动开启附件。

能力的默认值来自模型目录（6.6）：`tools` ← tool_call，`structuredOutput` ← structured_output，`reasoning` ← 目录有思考描述，`fileInput` ← attachment 或输入模态含 pdf，`imageUnderstanding` ← 输入模态含 image。目录命中但字段缺省的按 unsupported 处理（models.dev 对这些布尔字段缺省即 false）；目录未命中的才是 unknown。界面每个芯片都带来源（用户 / 目录 / 供应商 / 启发式 / 未知），不再出现"目录已收录却全部显示未知"的情况。

运行时消费：`tools` 为 unsupported 时不下发工具定义（纯文本回合）；`imageUnderstanding` / `fileInput` 参与输入模态推导；`reasoning` 决定思考档位是否可选；`nativeWebSearch` 与供应商开关求交。`parallelTools`、`promptCaching` 保留字段，无消费者，界面不开放。

### 6.2 逐字段来源

```ts
type FieldSource = "user" | "catalog" | "provider" | "adapter" | "heuristic" | "unknown";
type FieldValue<T> = { value: T; source: FieldSource; updatedAt?: number; candidates?: { value: T; source: Exclude<FieldSource, "user"> }[] };
```

合并顺序：用户覆盖 > 内置目录 > 供应商元数据 > 适配器声明 > 启发式 > unknown。供应商元数据更新不自动覆盖目录值，显示冲突与采纳入口。现有 `limitsSource` 是迁移起点。运行观测单独保存，不参与合并，不自动改写用户值。界面把 `provider` / `heuristic` 来源统一显示为"自动"。

### 6.3 限制与上下文预算

```text
budget = max(0, min(maxInputTokens ?? ∞, contextWindow − outputReserve))
outputReserve = min(maxOutputToken, 用户请求的输出上限)
```

缺失项不参与约束；目录未命中时使用按协议家族标注 heuristic 的默认值，不生成无限预算。压缩阈值读这个预算。模型级参数覆盖只能落在适配器 schema 之内，未知字段拒绝。

### 6.4 模型发现

按渠道执行，记录所用接口与凭据。刷新保留本地 `id`、用户覆盖与来源历史；短暂失败不批量下线；成功完整刷新且不再返回才标不可用，不删除。无列表接口时支持手工添加。

### 6.5 思考档位目录

思考档位不是用户配置项，而是**模型元信息**，随应用维护。现有实现已经是这个结构，本稿只是把它固定下来并补齐边界：

- 单一真源是 `catalog.generated.ts` 的 `thinking` 字段（`levels` 升序子集，`off` 表示能否关闭），生成期从 Codex 的 `supported_reasoning_levels` 与 models.dev 的 `reasoning_options` 归一化到统一梯子 `minimal < low < medium < high < xhigh < max`。
- `modelThinking.ts` 的 `resolveModelThinking(providerId, modelId)` 是唯一的读取入口：先按供应商作用域查目录，未命中按模型 ID 跨供应商回查（中转挂载的 glm / kimi / deepseek 等命中真实档位），最后才落家族启发式（Anthropic 按世代推断 xhigh，其余给 minimal 到 high）。界面档位列表与请求期钳制都从这里派生。
- 每档在 wire 上怎么发（Anthropic 的 adaptive / budget、OpenAI 的 effort 字段、Gemini 的 thinkingBudget、DeepSeek 的 thinking.type、xAI 的 effort 值改写）属于协议与方言的运行时领域，通过 pi-ai 的 `thinkingLevelMap` 与 `compat.thinkingFormat` 表达，不进目录也不进用户配置。

在本稿的配置模型里：

| 项 | 谁维护 | 用户能改什么 |
| --- | --- | --- |
| 可选档位与能否关闭 | 目录（模型元信息） | 不能改。目录未收录且启发式也不适用的模型，允许手动指定档位，标 `user` 来源并提示"目录未收录" |
| 默认使用哪一档 | 供应商级 `reasoning`，模型级 `reasoning` 覆盖 | 可改，取值限定在该模型可选档位内，越界时按梯子就近钳制 |
| 是否始终开启 | 目录 `off: false`，加 xAI 例外（wire 无法表达关闭） | 不能改 |
| 厂商模型档位补充 | 预设注册表的 `PresetModelRule.thinking` | 随应用更新 |

界面：编辑模型抽屉显示"思考档位（来自模型目录）"为只读芯片，标出当前默认档；目录未命中时显示"目录未收录，按家族兜底"，并给出手动指定入口。模型行的"推理"能力图标由目录的 `reasoning` 决定。

### 6.6 模型元数据目录：唯一维护处与获取

**唯一来源。** 模型级事实只有一份生成文件 `crates/agent-ui/src/lib/models/catalog.generated.ts`，由 `scripts/generate-model-catalog.mjs` 从 models.dev `api.json` 派生（OpenAI 段先叠 Codex `models.json`，规则不变）。预设注册表的生成层 `presets.generated.ts` 只保留渠道事实（名称、文档、环境变量、适配器、接口、地址），通过 `sourceId` 引用目录 section，不再复制模型列表。覆盖层 `presets.overlay.ts` 只放 models.dev 没有的东西：额外接口地址、方言、逐模型接口规则、身份预设。

**目录条目字段。**

| 字段 | 来源（models.dev） | 用途 |
| --- | --- | --- |
| `id` / `name` / `family` | id / name / family | 匹配、显示、系列分组的辅助信息 |
| `contextWindow` / `maxInputTokens` / `maxOutputToken` | limit.context / limit.input / limit.output | 上下文预算（6.3）、探测采纳时的限额初值 |
| `inputModalities` / `outputModalities` | modalities.input / output | 图片、PDF、音频、视频输入的默认判断；输出模态只展示 |
| `thinking` | reasoning_options（effort 阶梯 / 开关 / 预算） | 思考档位（6.5） |
| `toolCall` / `structuredOutput` / `attachment` / `temperature` | tool_call / structured_output / attachment / temperature | 能力默认值（6.1） |
| `knowledge` / `releaseDate` / `lastUpdated` / `status` / `openWeights` / `interleaved` | 同名字段 | 目录信息面板：知识截止、发布与更新日期、beta / deprecated 标记 |

不收录价格（项目已移除计费）。不收录"模型支持哪些接口"：models.dev 只描述供应商适配器，接口归属由渠道端点 + 预设逐模型规则 + 模型系列偏好决定（4.10），目录信息面板把这条推导链展示出来而不是另存一份。

**获取与刷新。**

- 本地：`pnpm generate:model-catalog` 一次拉取并写出两份生成文件；`pnpm generate:model-catalog:check` 在 CI 与提交前校验快照未被手改。
- 自动：`.github/workflows/update-model-catalog.yml` 每日执行生成器并开 PR，两份文件一起提交，快照日期 `MODEL_CATALOG_SNAPSHOT_DATE` 同步。
- 应用内不直接访问 models.dev。运行中拿到的供应商元数据（`/models` 返回的限额、模态）作为 `provider` 来源参与合并，不改写目录。

**合并顺序与展示。** 每个模型字段按 6.2 的顺序合并：用户覆盖 > 目录 > 供应商元数据 > 启发式 > 未知。编辑模型抽屉新增"目录信息"面板：命中的目录 section 与条目 id（含去前缀匹配）、快照日期、系列、发布 / 更新 / 知识截止、状态、输入与输出模态、原始能力位、限额三项。能力芯片、模态选择、限额输入各自带来源徽标，"还原为目录值"一键清除用户覆盖。模型列表行按有效模态显示图片 / 文件图标。

**术语。** "接口家族"（Anthropic / OpenAI / Gemini）只用于故障转移分组与路由；"模型系列"（claude / gpt / gemini / deepseek / glm …）只用于列表分组、默认接口偏好与原生搜索资格。界面文案分别使用这两个词，不再混用"家族"。

## 7. 设置界面

三栏结构，替换现在的"五个 Tab + 一个大对话框"。

**左栏：渠道目录。** 搜索框下方是"添加渠道"按钮；列表项即注册表条目：已配置实例在前（图标、名称、启用点、默认接口与"多接口"标签），未配置渠道在后（灰显，标"未配置"与它提供的接口）。只有搜索，没有分类或接口筛选。

**添加渠道对话框**（自定义中转、聚合网关、尚未内置的厂商）：头像与名称、API 密钥（本地服务可留空）、端点设置。端点设置按四类接口各一个 Base URL 输入，Chat Completions 与 Anthropic Messages 常显，Responses 与 Gemini 折叠在"更多设置"；填入根地址后即时显示实际请求路径（例如 `…/v1/chat/completions`、`…/v1/messages`），留空的接口不创建。底部"从预设创建（可选）"下拉选择注册表条目后填入该渠道的接口与地址，用于同一渠道的第二个账号、Coding Plan 或项目隔离，地址与 Key 仍可单独改。提交后立即按已填接口探测并拉取模型，默认接口取预设声明或按 Completions、Responses、Messages、Gemini 的顺序取第一个已填项。

**中栏：供应商详情。**

1. 标题行：名称、启用开关、渠道标签、"再加一个实例"。未配置渠道的详情只显示注册表声明的接口与地址、鉴权方式、取 Key 链接，以及 Key（和地址）输入与"检测并启用"。
2. API 密钥：默认 Key，"管理密钥"进多 Key 抽屉，"检测"。
3. API 地址：默认接口地址与状态芯片，"检测并配置"，"请求配置"；已启用渠道以小标签横排显示。
4. 模型列表：按 `group` 折叠分组，行内能力图标、接口标签（自动浅色 / 显式实色）、方言标签、编辑与移除；"获取模型列表"、"手动添加"。
5. 更多设置：推理档、缓存、原生搜索、流内重试、系统代理。
6. 用量查询。

**抽屉一：请求配置。** 每个接口一张卡片：启用开关、状态芯片、"默认"或"设为默认"、Base URL、完整 URL、模型列表地址、方言、鉴权头名、指定凭据、端点请求头；"添加端点"只列预设声明但尚未配置的接口（自定义列全部四类）；供应商级请求头与"模拟 CLI"。

**抽屉二：编辑模型。** 模型 ID、远端 ID、显示名、分组；模型类型（仅文本可选）；能力芯片三态；输入模态；接口多选（只列已启用渠道，可排序，首项路由）；方言；上下文窗口、最大输入、最大输出、缓存提示；思考档位只读（来自目录）加默认档选择。每个覆盖项显示来源与"还原"。不含价格。

**可用性分区。** 故障转移按三个接口家族分组，见第 8 节。

WebUI 共用组件，秘密只显示 configured。窄屏退化为列表 → 详情 → 抽屉三级。

### 7.1 从现有页面的迁移

| 现有 | 新位置 |
| --- | --- |
| 五个品牌 Tab | 取消；左栏改为渠道目录，五家原生渠道是其中五项 |
| 供应商卡片 | 左栏已配置实例行 |
| 对话框"普通配置" | 中栏详情；协议端点覆盖并入请求配置抽屉 |
| 对话框"请求配置" | 代理 / 重试 / 缓存进"更多设置"；请求头与模拟 CLI 进请求配置抽屉 |
| 对话框"用量查询" | 详情底部 |
| 模型编辑抽屉 | 编辑模型抽屉，字段扩展 |
| 每 Tab 底部故障转移卡片 | 可用性分区 |
| "获取模型列表" | 探测的一部分，仍可单渠道重拉 |

`ProviderModalView` 的三个面板与 `ProviderModal` 草稿状态拆成四个组件复用；`buildProviderModelsAttempts`、`fetchModelsFromApi`、`provider_models.rs` 是探测的基础。

## 8. 自动故障转移

### 8.1 现状

`settings.modelFailover` 按 `ProviderId` 分五组：`enabled`（默认关）、有序供应商队列（上限 8）、`maxSwitches` 3、`failureThreshold` 4、`cooldownSeconds` 60。计划构造器只把启用了同一模型 ID 的同组供应商列为候选；`withProviderFailover` 按序尝试，内容提交前（text / thinking / toolcall_start 之一出现前）遇到可转移错误就丢弃本次尝试换下一个，提交后不再切换；熔断器为进程内 Map，key `customProviderId::model`；成功后本轮后续 round 从获胜候选开始。Agent 请求与文本模式请求都接入，流内重试在内层先跑。

### 8.2 调整

运行时内核不动，只改分组依据与候选展开。

**分组按接口家族**：Anthropic ← `claude_code`；OpenAI ← `codex` + `xai` + `deepseek` 三份队列按序合并去重；Gemini ← `gemini`。Completions 与 Responses 同组，因为同一模型在两者下工具与流式语义等价，且现状 Codex 队列本来混合两种格式。跨家族不互为候选。方言不参与分组，每个候选按自己的方言装配。

**候选三层**，共用 `maxSwitches`：

| 层 | 触发 | 对象 | 熔断 key |
| --- | --- | --- | --- |
| 凭据层 | 鉴权、配额、账户类错误 | 同供应商下一把启用的 Key | `provider::credential::model` |
| 端点层 | 连接、5xx、404 模型不存在 | 供应商已启用的同家族其它渠道（当前路由接口除外） | `provider::endpoint::model` |
| 供应商层 | 上两层用尽 | 队列下一个供应商（须启用同名模型且解析后同家族） | 同上 |

`enabled` 只控制供应商层；凭据层与端点层随配置自动生效。错误分类表仍集中一处，方言可登记额外模式。熔断器保持进程内。不做跨模型兜底，不做负载均衡。

## 9. 迁移与兼容

- 所有新增字段可选。旧存档：`credentials` 缺省为 `[默认 Key]`；`presetId` 由 `type` 补；`defaultChatProtocol` 由 `type` 与 `requestFormat` 回填；`endpointConfigs[*].enabled` 缺省 true；`group` 与 `chatProtocols` 缺省由家族表推断；`wireModelId` 等于 `id`。
- 写入时同步维护 `apiKey` 与 `requestFormat`，旧版本仍可读。
- 存档中的 `deepseek-responses` 改写为 `openai-responses` + `deepseek` 方言。该值只在开发分支出现过。
- 故障转移五份旧队列按 8.2 合并；因家族不一致不再合格的条目不删除，只在计划构造时跳过并标注。
- 归一化丢弃非法协议、空地址、指向不存在凭据的 `credentialId`、被关闭的默认接口（自动切到第一个已启用渠道）。
- Gateway 同步与备份沿用现有结构，秘密只带 configured 标记。

## 10. 实施阶段

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| P1 已完成 | 模型级聊天协议、端点 Base URL 覆盖、运行时统一读解析结果 | 现有单测通过 |
| P1.5 接口收敛与预设 | 协议枚举减为四类并引入方言；`(protocol, dialect)` 选适配器；方言落到 `Model.provider` / `compat` / `thinkingLevelMap`，删除与 pi-ai 重复的推导；协议头档与方言头档；预设注册表与派生脚本；扁平供应商列表；故障转移分组迁移 | 无新字段的五类旧配置请求装配 Golden 不变；`deepseek-responses` 自动改写；三组队列合并后候选关系不丢失；每个旧分组对应一个预设 |
| P2 多接口、多 Key、探测 | 端点完整配置（启用、quirks、鉴权头、凭据、头）；凭据列表与模型范围（5.6）；模型 `chatProtocol`；按预设的探测与摘要；渠道开关规则；路由输出扩展；凭据层与端点层候选 | 旧配置往返无丢失；多 Key 在 401 时按序切换并熔断到凭据；关闭默认渠道被阻止；探测四类接口各分支正确 |
| P3 模型配置与界面 | 三栏界面与两个抽屉；`wireModelId` / `displayName` / `group` / `maxInputTokens` / 模型级推理与原生搜索；`FieldValue` 来源与冲突提示；能力三态；原生搜索资格改为家族表 | 网关前缀模型能匹配目录；自动值与用户值来源正确；`unknown` 不关闭原本可用的工具与附件 |
| P4 凭据隔离 | Key 不进 JS 运行时，本地代理只接受受控路由句柄，熔断状态下沉 | 另立文档 |

## 11. 验证

- 归一化：非法协议、空地址、不存在的 `credentialId`、关闭的默认接口、旧版单 Key 单地址配置的往返。
- 预设：每个预设的接口地址模板展开、按模型规则命中、旧 `type` 到 `presetId` 的映射。
- 路由：五步接口决定顺序与 `source`；方言六步顺序；端点覆盖同时影响地址、模型列表地址、头与凭据；`wireModelId` 不影响目录匹配。
- 请求装配 Golden：四类接口在协议头档、方言头档、供应商头、端点头、身份档叠加下的最终头集合；保留键不可覆盖；xai / deepseek 方言的 Responses 剥离与现状逐字节一致。
- 探测与自动配置：200 / 404 / 401 / 未知各分支；Completions 与 Responses 同时可用；重探不覆盖用户值、不删手工模型；关闭渠道后引用它的模型退到默认接口或标无可用渠道。
- 多 Key：两把 Key 同列表与不同列表两种探测结果的合并与范围推导；选 Key 三步顺序与 `credentialSource`；范围外 Key 不进入凭据层候选；某把 Key 刷新失败不清空旧观测；手动范围的前缀通配。
- 故障转移：五队列合并为三组后候选不丢失；跨家族不互为候选；凭据层与端点层按序展开且共用预算；提交后不切换；文本模式与 Agent 模式一致。
- 双端：WebUI 公开快照不含 Key 值；Gateway 同步后计划构造与桌面一致。
- 界面：窄屏三级导航可用；自动 / 用户 / 还原状态正确。

## 附录 A：可行性审阅（2026-09-15）

对照当前代码逐项核对，结论：方案可实施，无需改动运行时内核；风险集中在 `type` 字段的读取点迁移和界面重排。

| 项 | 核对结果 | 处理 |
| --- | --- | --- |
| 四类接口与 pi-ai | pi-ai 0.84 的 `Api` 已含这四个字面量；`detectCompat` 按 `model.provider` 或域名推导 Completions 方言 | 方言落到 `Model.provider` 与 `compat`，不新写检测 |
| Responses 方言剥离 | pi-ai 不做 xAI / DeepSeek 的字段剥离 | 保留现有两个中间件，触发条件改读方言 |
| `type` 读取点 | 61 处，15 个文件（路由、故障转移归一化、设置页、导入、记忆整理、Cron、WebUI 事件） | 新实例回填 `type`，读取点按阶段改为读路由结果；P1.5 退出条件里加"无新字段配置 Golden 不变" |
| 探测 | 前端 `buildProviderModelsAttempts` 与 Rust `provider_models.rs` 已有两段尝试；WebUI 已走 `gateway_provider_models` | 改为按接口逐个调用，不新增命令 |
| 存储 | 供应商域是 `provider_settings` 表内 JSON | 新字段全部可选，观测值同表存放但不入备份与同步 |
| 故障转移 | 内核按候选列表工作，与分组无关 | 只改计划构造器与设置键迁移 |
| 思考档位 | 目录与 `resolveModelThinking` 已是单一真源 | 用户字段只保留默认档 |
| 多 Key | 凭据层候选按范围过滤，熔断 key 已含模型 | 无内核改动 |
| WebUI | 共用 agent-ui 组件；秘密只带 configured | 三栏布局需在 WebUI 验证窄屏退化 |
| 预设地址 | 厂商渠道地址取自公开文档，未逐一实测 | 接入前以探测结果为准；预设表带版本号便于修正 |

可用性判断：

- 官方与厂商渠道：填 Key 一步；网关：填 origin 与 Key；本地：确认地址。这三条路径覆盖绝大多数用户，且探测只发模型列表请求。
- 需要人工调整的场景（不同协议不同地址、按模型指定接口、多 Key 各管一片、网关实现偏差）都有明确入口，且改动标为用户值可还原。
- 摘要页默认不勾选"其他"分组，网关用户不会被几十个陌生模型淹没；需要时一键全选。

## 附录 B：P1.5 实施任务清单

按依赖顺序，每项可独立提交与验证：

1. **注册表数据模块**（agent-ui `lib/providers/registry/`）：四类接口常量、方言枚举、协议头档与方言头档、模型家族表、预设表（首批渠道）、派生脚本读取 pi-ai 内置供应商。单测：地址模板展开、家族匹配、按模型规则命中。
2. **协议枚举收敛**（agent-ui `settings/types.ts`、`settings/index.ts`）：删除 `deepseek-responses`，加载时改写；`resolveProviderChatRoute` 输出 `dialect`、`family`、`source`；`getProviderChatProtocolAdapter` 改为按（协议, 方言）返回适配器家族。单测：路由五步与方言六步顺序。
3. **请求装配**（agent-gui `requestOptions.ts`、`modelFactory.ts`、`payloadPipeline.ts`）：头档查表替代 `ProviderId` 分支；`Model.provider` 填方言；删除与 `detectCompat` 重复的域名判断；两个 Responses 中间件改读方言。Golden：五类旧配置的最终请求逐字节不变。
4. **故障转移分组迁移**（agent-ui `modelFailover.ts`、agent-gui `providerRuntimeConfig.ts`）：设置键改为三家族并合并旧队列；候选资格加同家族检查。单测：合并后候选关系不丢失。
5. **渠道目录左栏**（agent-ui `pages/settings/`）：列表改为注册表驱动，未配置渠道的待配置详情，"添加渠道"对话框，`presetId` 与 `type` 回填。WebUI 同步验证。
6. **设置页拆分**：`ProviderModalView` 拆为详情、请求配置抽屉、编辑模型抽屉、密钥抽屉四个组件；旧对话框在新页面可用后删除。

P2 与 P3 的任务清单在各自阶段开始前补充。

## 附录 C：实施记录（2026-09-15）

分支 `feat/provider-registry-routing`，按附录 B 的顺序落地，与设计的偏差如下：

| 项 | 实施情况 |
| --- | --- |
| 注册表与预设 | `crates/agent-ui/src/lib/providers/registry/`；预设生成层与模型目录由同一个 `scripts/generate-model-catalog.mjs` 从 models.dev 一次派生（`presets.generated.ts` 只含 18 家的供应商事实，渠道模型列表即 `MODEL_CATALOG[sourceId]`，22 个分区、785 个目录模型），覆盖层手工维护；`pnpm generate:model-catalog[:check]` |
| 协议枚举 | 四类字面量；`deepseek-responses` 在加载时改写为 Responses + deepseek 方言；适配器注册表内部仍用 `deepseek-responses` 作为 DeepSeek Responses 适配器的 api id，这是实现细节，不出现在设置层 |
| 路由 | `resolveProviderChatRoute` 输出接口来源、家族、方言、远端 ID、凭据与来源、合并头、quirks、鉴权覆盖；运行时 `createProviderRuntimeConfig` 一次填充 |
| 请求装配 | 协议头档 + 方言头档 + 用户头查表；`Model.provider` 填方言（generic → "openai"，与 pi-ai 的同模型判定和 `detectCompat` 行为一致），quirks 映射到 pi-ai compat；删除了与 `detectCompat` 重复的域名判断，z.ai / OpenRouter / 通义等由路由层 quirks 推导补回 |
| 故障转移 | 设置键按三家族，旧五组合并；计划构造按凭据层 → 端点层 → 供应商层展开，共用 `maxSwitches`；熔断 key 为 `provider::credential::protocol::model` |
| 多 Key | 归一化保证 `apiKey === credentials[0].apiKey`；Gateway 同步与 Web 存储脱敏覆盖每把 Key，`providerId::credentialId` 作为额外 Key 的更新键；Rust 公开快照同样脱敏并按凭据 id 回填旧值 |
| 探测 | `pages/settings/providerProbe.ts`：按候选接口 × 启用 Key 拉模型列表，200 / 404 / 401 / 其他分类；自动配置产出端点、默认接口、模型（分组、限额、预设规则）、每把 Key 的 `lastModels` |
| 观测值 | 备份快照剥离 `lastProbe` / `lastModels`；Gateway 同步**不剥离**（WebUI 需要状态芯片，且回传缺失会抹掉桌面观测），与 5.5 的表述有出入，以此为准 |
| 模型级默认档 | 实现为"覆盖会话里该供应商键的档位"并钳到该模型可用档位；会话关闭思考仍优先 |
| 远端模型 ID | `Model.id = wireModelId`，本地 id 用于目录、熔断、展示；用户配置了 `wireModelId ≠ id` 时，消息元数据里的 model 是远端值 |
| Cherry Studio 导入 | 映射到 `presetId` / `endpointConfigs` / `credentials`，行为不变 |
| 旧实例的预设归属 | 只有 Base URL 命中预设声明的官方主机才映射到该预设，否则归为自定义渠道；挂着官方预设但地址不在官方主机内的实例同样降级。探测候选一律从实例自己的地址派生，保证中转 Key 不会发到官方地址 |
| 实机验证 | 桌面端对一个真实中转执行"检测并配置"：四类接口探测、模型合并、采纳后端点与模型写入均通过 |

## 附录 D：完整性审查与修复（2026-09-15）

对附录 C 的实现做了一轮全量审查（逐行、删除行为、跨文件调用、复用、简化、效率、修复深度、约定八个角度）加桌面端走查，修复项按层归类：

| 层 | 修复 |
| --- | --- |
| 设置层 | 隐式端点由主连接物化为唯一真相（`resolveProviderEndpoint` 对隐式接口也返回 `config`）；`providerFailoverFamilies` 按已启用接口计算，全关返回空；主机解析统一到 `registry/hosts.ts`（无 scheme、显式 443 端口均可归属预设）；预设按 id / 主机建索引；路由上下文一次构造；`credentialCoversModel` 的 auto 范围用集合查找；空地址默认端点被丢弃时切到第一个已启用端点；旧 5 组故障转移迁移改用只在旧键集合出现的类型判定；鉴权头改名且未给前缀时不带 Bearer；全部 Key 停用时不再用停用 Key 发请求 |
| 探测 | 模型列表地址保留非 v1 版本段（`/api/paas/v4` 不再被改写，TS 与 Rust 同步）；严格模式下 200 但无模型数组归"未知"；既有端点永不因探测失败被停用或切走默认接口，只更新观测；探测候选只从实例自己的地址派生 |
| 运行时 | `Model.provider` generic → "openai"；旧工厂签名也应用 quirks 推导；家族与协议一律经 `resolveRuntimeWireRoute` 取得；删除无读者的 `endpointHeaders`；路由解析在渲染期按 `[provider, modelId]` 记忆化；停用供应商不进入聊天、摘要、标题、提交信息的模型选择 |
| 网关桥 | WebUI 复用落库 Key 探测时按 `credential_id` 选凭据（proto 新增字段）；草稿地址主机必须属于该供应商已保存的地址集合，否则拒绝；协议沿用请求值，回填按命中的端点而不是主地址 |
| 界面 | 再加一个实例预填自定义实例的地址与方言；停用端点上的"设为默认"不可用；编辑模型抽屉显示三层故障转移候选；窄屏换行；quirks 只在 OpenAI 家族卡片显示；`{origin}` 模板按输入实时展开；未知原因直接显示；最终请求头预览复用运行时合并规则；限额与推理来源徽标正确；管理密钥的差异只在两把 Key 都拉取过后显示，刷新不再覆盖探测期间的修改；取消探测仍写回观测；删除端点与 Key 需确认；添加渠道非自建必填 Key，非法请求头行可见；模型分组内拖拽排序写回 `modelOrder`；模型行记忆化；停用供应商显示提示条；清理无消费者的 i18n 键 |
| 测试 | 新增/改写：注册表主机归属、隐式端点、故障转移家族与迁移、探测严格模式、网关桥凭据与主机、运行时方言映射与 quirks、辅助模型选择、WebUI 源码契约（改按三栏结构锁定） |

