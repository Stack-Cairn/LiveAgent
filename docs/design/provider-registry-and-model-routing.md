# Provider Registry、模型能力与多协议路由设计

| 元数据 | 内容 |
|---|---|
| 状态 | Proposal / 设计评审稿，尚未实现 |
| 版本 | v0.1 |
| 日期 | 2026-08-29 |
| 适用范围 | LiveAgent Desktop、Gateway WebUI、Provider 设置、Chat Runtime、未来媒体生成入口 |

## 1. 摘要

本方案将 LiveAgent 的模型供应商配置重构为以 **Provider 为产品中心、Interface 为 Provider 内部能力、Model 为运行时能力与路由中心** 的三级结构。

用户的默认接入路径保持简单：

```text
选择供应商 → 填写最少必要信息（通常是 SK）→ 获取模型 → 立即使用
```

系统内部则支持：

- 一个 Provider 同时提供 OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini GenerateContent 等多种对话协议；
- Provider 按任务设置默认接口；
- 每个模型独立选择实际接口、请求模型 ID、兼容配置、请求头、UA/客户端模拟；
- 模型声明任务类型、推理/工具等能力、输入输出模态、上下文限制和价格；
- 为独立图像生成、图像编辑预留非流式媒体接口，为音频和视频任务预留扩展边界；
- 保留现有流式重试、提交前故障转移、熔断和本地代理能力，并将故障转移候选从“供应商实例”提升为“模型操作路由”；
- 旧 `CustomProvider` 设置可读时迁移，不要求首次升级立即重写数据库。

本方案不允许设置页加载任意 npm 包或执行用户 JavaScript。Provider 预设、协议适配器、请求签名器和客户端模拟器必须来自 LiveAgent 受信任注册表；用户可配置的是受约束的数据和覆盖项。

## 2. 背景与当前问题

### 2.1 当前实现

当前 Provider 与模型结构集中在 [`types.ts`](../../crates/agent-ui/src/lib/settings/types.ts)：

- `CustomProvider` 只有一个 `baseUrl`、一个 `modelsUrl`、一个 `apiKey`、Provider 级 `customHeaders` 和 Codex 专用 `requestFormat`；
- `ProviderModelConfig` 只有模型 ID、上下文窗口、最大输出 Token、来源和缓存提示配置；
- [`modelFactory.ts`](../../crates/agent-gui/src/lib/providers/runtime/modelFactory.ts) 根据 `ProviderId` 推断协议，供应商品牌与 wire protocol 耦合；
- 图片输入能力仍存在模型名称启发式判断，例如 `vision`、`qwen-vl`、`llava`；
- 当前计费功能被关闭，运行时向 pi-ai 提供的价格固定为零；
- [`providerFailover.ts`](../../crates/agent-gui/src/lib/providers/runtime/providerFailover.ts) 已有提交前缓冲、错误分类、熔断与不可重放边界；
- [`proxy.ts`](../../crates/agent-ui/src/lib/providers/proxy.ts) 已能通过本地 Rust 代理转发 WebView 不能可靠设置的 `User-Agent` 等请求头。

当前请求链为：

```text
CustomProvider + Model
  → createProviderRuntimeConfig
  → modelFactory（按 ProviderId 推断协议）
  → llm.stream()
  → Adapter Registry
  → pi-ai / DeepSeek Adapter
  → 本地代理
  → 上游供应商
```

### 2.2 核心问题

1. **Provider 与协议耦合**：同一家供应商暴露多个协议时，需要复制 Provider 或修改全局请求格式。
2. **模型不是完整的一等配置**：模型无法声明任务、模态、接口绑定、价格和完整能力。
3. **自动接入能力不足**：不同供应商需要用户理解 Base URL、接口路径和请求格式。
4. **接口只有聊天语义**：独立图像生成、图像编辑、音频和视频无法自然接入当前 `stream()` 合同。
5. **价格结构过窄**：文本 Token、图片张数/分辨率、音频时长和视频时长不能共用固定四字段价格。
6. **故障转移候选粒度不正确**：当前按同类型 Provider 队列切换并复用原模型字符串，无法表达同 Provider 多接口、多 SK 和跨供应商显式模型映射。

## 3. 目标与非目标

### 3.1 目标

- Provider 是用户认知中的供应商接入实例。
- 官方与常见三方供应商通过内置预设实现最少字段接入。
- 一个 Provider 可以拥有多种协议和多个任务接口。
- Provider 为每种操作配置默认接口，模型可覆盖。
- 模型能力元数据真正驱动 UI 与请求运行时。
- 支持文本、图像理解、音频理解、视频理解等输入模态。
- 预留图像生成、图像编辑、音频、视频、Embedding、Rerank 等操作。
- 支持模型级上下文、最大输入、最大输出、价格和字段来源。
- 兼容现有设置、选择模型、会话、压缩、请求头和故障转移行为。
- 敏感凭证与敏感请求头最终迁移到安全存储引用。

### 3.2 非目标

- 首版不开放任意协议脚本、任意 npm Adapter 或任意 JavaScript Header Hook。
- 首版不自动探测所有可能接口并产生计费请求。
- 首版不根据价格自动切换供应商。
- 首版不把图像、音频和视频统一伪装成 Chat Completion。
- 首版不要求一次性完成数据库强制迁移。

## 4. 术语与边界

| 术语 | 含义 |
|---|---|
| ProviderDefinition | LiveAgent 内置的供应商说明书，声明接入字段、接口、发现策略、鉴权和默认模型规则 |
| ProviderInstance | 用户实际创建的一个供应商接入，例如“公司 New API” |
| ProviderInterface | Provider 内的一条接口定义，包含操作类型、协议、地址、鉴权和兼容配置 |
| ProviderModel | Provider 下的模型配置，包含能力、模态、限制、价格和接口绑定 |
| ModelInterfaceBinding | 某个模型在某种操作下对某个 ProviderInterface 的绑定 |
| ProtocolAdapter | 将 LiveAgent 标准请求转换成具体 wire protocol 的受信任代码 |
| ClientProfile | UA、SDK 标识头和受控动态请求头组成的客户端模拟档案 |
| CompatibilityProfile | 协议方言和兼容开关，例如 developer role、reasoning 字段、stream options |
| Credential | API Key、OAuth、IAM 等凭证；设置层仅持有引用和脱敏元数据 |

## 5. 总体架构

```text
ProviderDefinition Registry（系统内置、版本化）
        │
        ├─ setup fields
        ├─ interfaces
        ├─ discovery strategy
        ├─ model rules
        └─ client / compatibility profiles
        │
        ▼
ProviderInstance（用户配置，仅保存凭证引用与覆盖）
        │
        ├─ Provider interfaces
        ├─ default interface by operation
        ├─ provider headers / client profile
        └─ models
              │
              ├─ capabilities / modalities / limits / pricing
              └─ interface bindings by operation
                      │
                      ▼
ResolvedOperationRoute
        │
        ├─ provider + model + operation
        ├─ interface + protocol + wire model id
        ├─ credential
        ├─ headers / client profile / compatibility
        └─ retry and failover policy
                      │
                      ▼
Adapter Registry → Local Proxy → Upstream
```

### 5.1 关键设计决策

| 决策 | 取向 | 理由 |
|---|---|---|
| 用户中心对象 | ProviderInstance | 用户管理的是供应商，不是 Adapter 或 Endpoint |
| 接口归属 | 嵌套在 Provider 内 | 避免把底层路由对象暴露成全局设置 |
| 默认接口 | 按 `ModelOperation` 设置 | Chat、图像生成、图像编辑不能共享一个默认端点 |
| 模型覆盖 | 按操作维护 Binding | 同一模型可对话走 Responses、图片走 Images API |
| 能力值 | `supported / unsupported / unknown` | 缺少元数据不等于明确不支持 |
| Adapter | 受信任注册表 | 避免配置成为任意代码执行入口 |
| 旧配置迁移 | 读取时转换，后续再写 V2 | 降低升级风险并保留回滚能力 |
| 图片/媒体执行 | 独立 `execute` / `job` 合同 | 流式文本与 multipart、二进制、异步任务语义不同 |

## 6. Provider Registry

### 6.1 ProviderDefinition

```ts
interface ProviderDefinition {
  id: string;
  name: string;
  category: "official" | "cloud" | "gateway" | "custom";
  icon?: string;

  setupFields: ProviderSetupField[];
  interfaces: ProviderInterfaceDefinition[];
  discovery: ProviderDiscoveryDefinition;
  modelRules: ProviderModelRule[];
  clientProfiles?: ClientProfileDefinition[];
}
```

ProviderDefinition 负责：

- 动态生成接入表单；
- 根据地域、Workspace、Project 等字段生成地址；
- 声明支持的接口与鉴权方式；
- 声明如何获取模型；
- 为已知模型补充默认能力、模态、限制和价格；
- 为模型选择推荐接口；
- 声明默认 UA、客户端模拟和兼容方言。

### 6.2 最少必要字段

产品目标应表述为“只填最少必要信息”，而不是对所有供应商承诺“只填 SK”。

| Provider 类型 | 典型输入 |
|---|---|
| OpenAI / Anthropic / Gemini / DeepSeek | API Key |
| New API / 私有兼容网关 | 服务地址 + API Key |
| 火山方舟 | API Key，必要时地域或推理接入点 |
| 阿里云百炼 | API Key + 地域，部分形态需要 Workspace |
| OAuth Provider | 登录授权，可能带组织/Project 选择 |
| 自定义服务 | 服务地址 + 鉴权 + 至少一个接口 |

### 6.3 ProviderInstance

```ts
interface ProviderInstance {
  schemaVersion: 2;
  id: string;
  definitionId: string;
  name: string;

  setupValues: Record<string, string>;
  credentialRefs: string[];

  headers?: HeaderEntry[];
  clientProfileId?: string;

  interfaces: ProviderInterface[];
  defaultInterfaceByOperation: Partial<Record<ModelOperation, string>>;
  models: ProviderModel[];

  availabilityPolicy?: ProviderAvailabilityPolicy;
}
```

ProviderInstance 只保存 ProviderDefinition 的差异和用户数据。内置默认值在读取时合并，避免供应商地址或能力更新后，所有用户实例仍停留在创建时快照。

## 7. 操作、协议与 ProviderInterface

### 7.1 操作类型

```ts
type ModelOperation =
  | "chat"
  | "image.generate"
  | "image.edit"
  | "audio.transcribe"
  | "audio.speech"
  | "video.generate"
  | "embedding"
  | "rerank";
```

操作表示用户要完成的任务，协议表示请求如何编码。二者不能混用。

### 7.2 协议标识

```ts
type ProtocolId =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "openai-images"
  | "openai-image-edit"
  | "openai-audio-transcription"
  | "openai-audio-speech"
  | "openai-embeddings"
  | "cohere-rerank"
  | "provider-native";
```

现有 pi-ai 内部 API ID 可以继续作为 Adapter 实现标识，但设置层应使用稳定、用户可解释的 ProtocolId；两者通过注册表映射。

### 7.3 ProviderInterface

```ts
interface ProviderInterface {
  id: string;
  name: string;
  operation: ModelOperation;
  protocol: ProtocolId;

  baseUrl: string;
  path?: string;
  modelsUrl?: string;
  isFullUrl?: boolean;

  authScheme: "bearer" | "x-api-key" | "x-goog-api-key" | "none" | "signed";
  credentialIds?: string[];

  headers?: HeaderEntry[];
  clientProfileId?: string;
  compatibilityProfileId?: string;

  enabled: boolean;
  priority: number;
  source: "preset" | "discovered" | "user";
}
```

Provider 可以同时拥有多个相同操作接口。例如 New API 可同时为 `chat` 提供 Responses、Chat Completions、Anthropic Messages 和 Gemini 原生接口。

### 7.4 默认接口

```ts
defaultInterfaceByOperation: {
  chat: "responses";
  "image.generate": "images-generation";
  "image.edit": "images-edit";
}
```

设置页将其显示为：

- 默认聊天接口；
- 默认图像生成接口；
- 默认图像编辑接口；
- 后续增加默认语音、视频、Embedding 接口。

## 8. ProviderModel 数据模型

```ts
interface ProviderModel {
  id: string;
  displayName?: string;
  ownedBy?: string;

  operations: ModelOperation[];
  capabilities: ModelCapabilities;
  modalities: ModelModalities;
  limits: ModelLimits;
  pricing?: ModelPricing;

  bindings: ModelInterfaceBinding[];

  enabled: boolean;
  source: "provider" | "catalog" | "manual";
  status: "declared" | "discovered" | "verified" | "unavailable";
  fieldSources?: ModelFieldSources;
}
```

### 8.1 模型操作类型

模型类型使用 `operations` 多选，而不是单值 `modelType`。一个模型可同时支持：

- 对话；
- 图像生成；
- 图像编辑；
- 音频识别；
- 视频生成。

这与参考截图中的“文本 / 图片 / 嵌入 / 重排”交互一致，但底层存储必须允许多选和后续操作扩展。

### 8.2 模型能力

```ts
type CapabilityState = "supported" | "unsupported" | "unknown";

interface ModelCapabilities {
  reasoning?: CapabilityState;
  tools?: CapabilityState;
  parallelTools?: CapabilityState;
  structuredOutput?: CapabilityState;
  nativeWebSearch?: CapabilityState;
  promptCaching?: CapabilityState;
  fileInput?: CapabilityState;

  imageUnderstanding?: CapabilityState;
  imageGeneration?: CapabilityState;
  imageEditing?: CapabilityState;

  audioUnderstanding?: CapabilityState;
  audioGeneration?: CapabilityState;
  videoUnderstanding?: CapabilityState;
  videoGeneration?: CapabilityState;
}
```

能力配置必须驱动运行时，而不是只显示标签：

- `tools=unsupported` 时不发送工具定义；
- `imageUnderstanding=supported` 且输入模态含 image 时才开放原生图片附件；
- `structuredOutput=unsupported` 时不发送对应参数；
- `promptCaching=unsupported` 时不注入缓存提示；
- `unknown` 时按保守默认行为处理，并允许用户显式覆盖。

### 8.3 输入输出模态

```ts
type ModelModality = "text" | "image" | "audio" | "video" | "file";

interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}
```

示例：

```json
{
  "input": ["text", "image", "file"],
  "output": ["text"]
}
```

图像编辑模型：

```json
{
  "input": ["text", "image"],
  "output": ["image"]
}
```

### 8.4 上下文与限制

```ts
interface ModelLimits {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;

  maxImagesPerRequest?: number;
  maxImageBytes?: number;
  maxAudioSeconds?: number;
  maxVideoSeconds?: number;
  maxFileBytes?: number;
}
```

字段语义：

- `contextWindow`：输入和输出的总 Token 窗口；
- `maxInputTokens`：供应商明确声明的独立输入上限；
- `maxOutputTokens`：单次最大输出；
- 实际输入预算为 `min(maxInputTokens, contextWindow - 输出预留)`，缺失 `maxInputTokens` 时只使用上下文预算。

保留当前 `contextWindow` 的总窗口语义，继续为历史压缩、上下文占用和输出预留提供唯一来源。

### 8.5 字段来源与覆盖

```ts
type MetadataSource = "user" | "provider" | "catalog" | "heuristic" | "unknown";

interface ModelFieldSources {
  operations?: MetadataSource;
  capabilities?: MetadataSource;
  modalities?: MetadataSource;
  limits?: MetadataSource;
  pricing?: MetadataSource;
}
```

字段优先级：

```text
用户覆盖 > Provider 实时元数据 > LiveAgent 内置目录 > 启发式推断 > unknown
```

同步模型时不得覆盖用户修改。Provider 不再返回某模型时，将其标记为 `unavailable`，不直接删除本地配置或历史会话引用。

## 9. 模型接口绑定与路由

### 9.1 ModelInterfaceBinding

```ts
interface ModelInterfaceBinding {
  id: string;
  operation: ModelOperation;
  interfaceId: string;

  wireModelId?: string;
  enabled: boolean;
  priority: number;

  pathOverride?: string;
  headers?: HeaderEntry[];
  clientProfileId?: string;
  compatibilityProfileId?: string;
  requestOptions?: Record<string, JsonValue>;
}
```

同一个模型可以拥有：

```text
chat / primary   → Responses / wireModelId=model-a
chat / fallback  → Chat Completions / wireModelId=model-a-chat
image.generate   → Images / wireModelId=image-a
image.edit       → Image Edit / wireModelId=image-a
```

### 9.2 路由解析

```text
1. 根据用户动作确定 operation
2. 查找模型该 operation 下启用的 bindings
3. 优先使用模型显式首选 binding
4. 无模型覆盖时使用 Provider defaultInterfaceByOperation
5. 仍无结果时使用 ProviderDefinition 推荐接口
6. 校验模型 operation、模态和能力
7. 解析凭证、请求头、UA、兼容配置
8. 生成 ResolvedOperationRoute
9. 交给对应 Adapter 执行
```

```ts
interface ResolvedOperationRoute {
  providerId: string;
  modelId: string;
  operation: ModelOperation;

  interfaceId: string;
  protocol: ProtocolId;
  wireModelId: string;
  url: string;

  credentialId?: string;
  headers: Record<string, string>;
  clientProfileId?: string;
  compatibilityProfileId?: string;
}
```

路由解析器必须是桌面聊天、文本摘要、标题生成、Gateway 远端聊天和未来媒体入口的唯一解析入口，避免多条调用链分别拼接 Provider 设置。

## 10. 价格模型

### 10.1 计量项设计

固定的输入、输出、缓存读取、缓存写入四字段只适用于部分文本模型。统一价格结构使用计量项：

```ts
interface ModelPricing {
  currency: "USD" | "CNY";
  source: "provider" | "catalog" | "user";
  status: "known" | "unknown" | "disabled";
  effectiveAt?: string;
  meters: PricingMeter[];
}

interface PricingMeter {
  type:
    | "text.input"
    | "text.output"
    | "text.cached-input"
    | "text.cache-write"
    | "image.input"
    | "image.output"
    | "audio.input"
    | "audio.output"
    | "video.input"
    | "video.output";

  unit: "1m_tokens" | "image" | "megapixel" | "second" | "minute";
  price: string;
  conditions?: PricingCondition[];
}
```

价格使用十进制字符串或最小货币单位整数，禁止使用二进制浮点数作为持久化真相源。

### 10.2 阶梯价格

参考截图中的“从 N 个输入 Token 起”交互，文本阶梯价格表示为：

```ts
interface PricingTier {
  fromInclusive: number;
  toExclusive?: number;
  meters: PricingMeter[];
}
```

规则：

- 第一档固定从 0 开始；
- 后续档位按 `fromInclusive` 升序；
- 档位不得重叠；
- 缓存价格留空时回退本档输入价格；
- 显式填写 0 表示免费；
- `pricing.status=unknown` 与价格 0 必须严格区分。

### 10.3 非 Token 价格

图片可按尺寸、质量、张数或百万像素；音频和视频可按秒或分钟。条件示例：

```json
{
  "type": "image.output",
  "unit": "image",
  "price": "0.04",
  "conditions": [
    { "field": "size", "equals": "1024x1024" },
    { "field": "quality", "equals": "standard" }
  ]
}
```

价格恢复后应由 LiveAgent 独立 Pricing Service 根据 Usage/MediaResult 计算；pi-ai `Model.cost` 只作为文本运行时兼容结构，不作为唯一价格来源。

## 11. 图像生成、图像编辑与媒体扩展

### 11.1 区分对话内能力和独立操作

必须区分：

1. 对话协议内通过内置工具生成图片：属于 `chat` 的能力；
2. 调用 `/images/generations` 等独立接口：属于 `image.generate` 操作；
3. 上传原图和 Mask 编辑：属于 `image.edit` 操作。

三者不能共享同一个运行合同。

### 11.2 Adapter 合同

```ts
interface ConversationAdapter {
  stream(request: ConversationRequest): AssistantEventStream;
}

interface MediaAdapter {
  execute(request: MediaRequest): Promise<MediaResult>;
}

interface JobAdapter {
  submit(request: JobRequest): Promise<JobHandle>;
  poll(handle: JobHandle): Promise<JobStatus>;
  cancel(handle: JobHandle): Promise<void>;
}
```

- Chat、Responses、Messages、GenerateContent 使用 `ConversationAdapter`；
- 图像生成和编辑首版使用 `MediaAdapter`；
- 视频生成和长音频任务预留 `JobAdapter`。

### 11.3 图像操作参数

图像配置使用受约束字段，不开放任意模板代码：

```ts
interface ImageOperationOptions {
  sizes?: string[];
  qualities?: string[];
  styles?: string[];
  formats?: string[];
  supportsMask?: boolean;
  supportsTransparentBackground?: boolean;
  maxImages?: number;
}
```

模型 Binding 可以覆盖 Provider Interface 的默认图片参数，但不能绕过 Adapter 的 schema 校验。

### 11.4 媒体任务重试

图像和视频请求可能已被上游接受并计费，网络中断不代表任务未创建：

- 默认不自动重提图像生成、图像编辑和视频任务；
- 供应商支持 Idempotency-Key 时才允许安全重试；
- 异步任务依赖上游 Job ID恢复查询，不重新提交；
- 用户主动重试必须提示可能重复计费。

## 12. 请求头、UA 与客户端模拟

### 12.1 ClientProfile

```ts
interface ClientProfileDefinition {
  id: string;
  name: string;
  userAgentTemplate?: string;
  staticHeaders?: HeaderEntry[];
  dynamicHeaders?: DynamicHeaderRule[];
  compatibilityProfileId?: string;
  allowedProtocols?: ProtocolId[];
}
```

可预留内置档案：

- LiveAgent Native；
- OpenAI SDK Compatible；
- Claude Code Compatible；
- Codex Compatible；
- Browser Compatible；
- Custom。

动态变量只允许受控模板，例如 `${app.version}`、`${os.name}`、`${session.id}`、`${model.id}`，禁止执行任意脚本。

### 12.2 Header 合并顺序

```text
协议必需头
< ProviderDefinition 默认头
< ClientProfile 模拟头
< Provider 用户头
< ProviderInterface 覆盖头
< ProviderModel Binding 覆盖头
< 本次请求动态头
```

鉴权头、`Host`、`Content-Length` 和 `x-liveagent-*` 控制头受保护。签名鉴权由受信任 RequestSigner 完成，不能通过静态 Header 模拟。

### 12.3 请求预览

高级设置提供只读“最终请求预览”，显示：

- URL 与协议；
- wire model ID；
- Header 名称、脱敏值和来源；
- 应用的 ClientProfile 和 CompatibilityProfile；
- 不显示真实 SK、Cookie 和敏感 Header 值。

## 13. 模型发现与自动接入

### 13.1 接入流程

```text
选择 Provider 预设
 → 动态显示最少必要字段
 → 规范化地址
 → 用无计费接口验证凭证（如果供应商支持）
 → 获取模型列表
 → 合并内置模型目录
 → 应用 Provider 模型规则
 → 生成模型能力、模态、限制和接口绑定
 → 展示差异与来源
 → 用户确认保存
```

### 13.2 发现原则

- 模型列表只证明模型对当前凭证可见，不证明它支持所有协议；
- ProviderDefinition 负责把模型匹配到已知接口；
- 未确认能力保持 `unknown`；
- 不在保存 Provider 时自动发起可能计费的对话请求；
- “测试连接”显式说明可能产生少量费用；
- 自定义服务只探测预设允许的已知路径，不进行无限路径扫描；
- 凭证不得跟随跨域重定向发送。

## 14. 故障转移与可用性策略

### 14.1 现有功能的去留

当前“同 Provider 类型的备用实例队列”会弱化：

- 同一供应商多 SK 由 Provider 内 Credential 处理；
- 同一供应商多协议由 ProviderInterface 处理；
- 重复创建多个 Provider 只为切换接口或 Key 的需求消失。

但现有故障转移引擎必须保留：提交前缓冲、不可重放边界、错误分类、熔断和冷却仍是正确基础。

### 14.2 新候选模型

```text
Provider + Model + Operation + InterfaceBinding + Credential
```

尝试顺序：

```text
首选 Binding + 主 Credential
 → 同 Binding 备用 Credential
 → 同 Provider 等价 Binding
 → 显式模型故障转移组中的其他 Provider/Model
```

### 14.3 错误策略

| 错误 | 默认行为 |
|---|---|
| 401 / Key 无效 | 切换同接口备用 Credential |
| 429 / 明确额度不足 | 按配置切换 Credential 或等价接口 |
| 网络错误、408、5xx | 提交前允许切换等价候选 |
| 400、413、422、上下文过长 | 不做通用故障转移 |
| 已输出文本/思考/工具调用 | 禁止自动重放 |
| 图像/视频请求已提交 | 默认不自动重提 |

### 14.4 跨 Provider 模型组

跨供应商不能只比较原始模型字符串，必须显式配置：

```ts
interface ModelFallbackGroup {
  id: string;
  name: string;
  operation: ModelOperation;
  candidates: Array<{ providerId: string; modelId: string }>;
}
```

## 15. 设置页信息架构与交互

### 15.1 设计方向

界面延续 LiveAgent 当前深色、克制、紧凑的设置体验，不引入营销化大卡片或高饱和渐变。截图中的“更多设置”作为模型编辑的视觉基线：能力使用可切换标签，数值和价格按语义分组。

本页面的单一任务是：**让用户确认一个模型能做什么、受什么限制、通过哪条接口执行，以及如何计价。**

信息层级采用“默认收敛、来源可解释、覆盖才展开”：

- 默认只显示推荐值；
- 修改后显示“用户覆盖”标识；
- 每个自动字段可查看来源；
- 高级接口和 Header 不与基础模型能力混在同一视觉层级。

### 15.2 Provider 页面

```text
┌ Provider 标题 / 状态 / 测试连接 ──────────────────────────┐
│ 概览 │ 模型 │ 接口 │ 凭证 │ 请求设置 │ 可用性             │
├───────────────────────────────────────────────────────────┤
│ 当前 Tab 内容                                              │
└───────────────────────────────────────────────────────────┘
```

- 概览：供应商信息、连接状态、默认聊天模型和同步时间；
- 模型：模型列表、筛选、能力徽章和编辑抽屉；
- 接口：Provider 内接口与各操作默认接口；
- 凭证：主/备用 SK 或账号；
- 请求设置：Provider Header、UA、ClientProfile、代理；
- 可用性：Credential、接口和跨 Provider 故障转移策略。

### 15.3 模型列表

| 列 | 内容 |
|---|---|
| 模型 | 显示名、模型 ID、来源、可用状态 |
| 类型 | 对话、图像、嵌入、重排等操作标签 |
| 输入 | 文本、视觉、音频、视频、文件 |
| 能力 | 推理、工具、结构化输出等 |
| 默认接口 | 当前 `chat` 或主要操作 Binding |
| 限制 | 上下文 / 最大输出 |
| 价格 | 已配置、未知或关闭 |

### 15.4 模型编辑抽屉

```text
┌ 模型名称 / ID / 状态 ─────────────────────────────┐
│ 基本信息                                          │
│ 接口绑定                                          │
│ 类型与能力                                        │
│ 输入输出模态                                      │
│ 上下文与限制                                      │
│ 价格与阶梯                                        │
│ 请求头与客户端模拟                                │
│ 原始元数据与字段来源                              │
└───────────────────────────────────────────────────┘
```

参考截图中的“更多设置”调整为：

1. **模型类型**：对话、图片生成、图片编辑、嵌入、重排等多选标签；
2. **模型能力**：推理、工具、结构化输出、联网、缓存等标签；
3. **输入模态**：视觉、音频、视频、文件；文本默认存在但仍在底层显式存储；
4. **限制**：上下文窗口、最大输入、最大输出以及媒体限制；
5. **价格**：币种、阶梯、输入/输出/缓存价格；媒体操作切换成对应计量项；
6. **接口绑定**：按操作选择“继承 Provider 默认”或指定接口。

### 15.5 可访问性与响应式

- 标签和按钮点击区域不小于 44px；
- 不只用颜色表达 `supported / unknown / unsupported`；
- 键盘焦点清晰可见；
- 输入错误紧邻字段并说明修复方式；
- 窄屏下模型列表切换为卡片，编辑抽屉改为全屏 Sheet；
- 折叠面板保留 `aria-expanded`；
- 尊重 reduced motion，设置页不使用持续动画。

## 16. 持久化、安全与同步

### 16.1 凭证

- Provider 设置只保存 `credentialRef`、label、type、configured、masked 状态；
- API Key、OAuth Token、IAM Secret 保存到系统安全存储；
- Gateway WebUI、配置同步、备份和诊断不得包含真实值；
- 多账号 TokenStore、刷新锁和登出按 `credentialId` 管理，不按 Provider 全局管理。

### 16.2 敏感请求头

```ts
interface HeaderEntry {
  key: string;
  value?: string;
  valueRef?: string;
  sensitive?: boolean;
  enabled: boolean;
}
```

普通 UA 和业务标识头可同步；自定义 Token、Cookie 等使用 `valueRef`，只同步已配置状态。

### 16.3 配置版本

- ProviderInstance 使用 `schemaVersion: 2`；
- 同步包与 WebUI DTO 独立版本化；
- 读取器同时支持旧 `CustomProvider` 和 V2；
- 不支持的新字段必须保留或明确拒绝，不能静默丢失后回写。

## 17. 旧配置迁移

### 17.1 Provider 迁移

旧配置读取时生成：

```text
ProviderDefinition = legacy-custom / 对应内置预设
ProviderInterface.id = legacy-default-chat
Credential.id = legacy-primary
Provider headers = 原 customHeaders
defaultInterfaceByOperation.chat = legacy-default-chat
```

协议映射：

| 旧配置 | V2 协议 |
|---|---|
| Claude | `anthropic-messages` |
| Gemini | `gemini-generate-content` |
| Codex + completions | `openai-chat` |
| Codex + responses | `openai-responses` |
| xAI | `openai-responses` |
| DeepSeek | 当前 DeepSeek Adapter 对应协议 |

### 17.2 Model 迁移

| 旧字段 | V2 字段 |
|---|---|
| `id` | `ProviderModel.id` |
| `contextWindow` | `limits.contextWindow` |
| `maxOutputToken` | `limits.maxOutputTokens` |
| `promptCacheHintMode` | 缓存能力/兼容覆盖 |
| 无 capabilities | Catalog/Provider/heuristic，缺失为 unknown |
| 无 modalities | Catalog/Provider/heuristic，缺失为 unknown |
| 无 pricing | `pricing.status=unknown`，不能解释为免费 |
| 无 bindings | 绑定 Provider 默认聊天接口 |

当前 `{customProviderId, model}` 选择结构和历史会话引用保持不变，运行时再解析最终操作路由。

## 18. 本地实现方案

### 18.1 新增共享类型与注册表

建议新增：

```text
crates/agent-ui/src/lib/providers/registry/
├── types.ts
├── definitions.ts
├── protocols.ts
├── openai.ts
├── anthropic.ts
├── gemini.ts
├── deepseek.ts
├── newApi.ts
├── volcengineArk.ts
├── aliyunModelStudio.ts
└── legacy.ts
```

同时在 `settings/types.ts` 与 `settings/index.ts` 增加 V2 类型、归一化和只读迁移。

### 18.2 路由解析

建议新增：

```text
crates/agent-gui/src/lib/providers/runtime/operationRouteResolver.ts
crates/agent-gui/src/lib/providers/runtime/operationContracts.ts
```

调整：

- `providerRuntimeConfig.ts`：接收 `ResolvedOperationRoute`；
- `modelFactory.ts`：优先使用显式协议、模型能力和模态；旧 ProviderId 推断只作为兼容包装器；
- `requestOptions.ts`：根据 Interface authScheme、ClientProfile 和 Header 层级构建请求；
- `streamByApi.ts` / Adapter Registry：保持现有对话 Adapter，增加媒体 Adapter 注册入口。

### 18.3 设置与模型发现

调整：

- `ProviderModal.tsx` / `ProviderModalView.tsx`：逐步替换成供应商接入向导；
- `ProvidersSection.tsx`：Provider 详情页与模型/接口/凭证分区；
- `providerUtils.ts`：按 ProviderDefinition 执行模型发现和元数据合并；
- Gateway WebUI 继续复用 `agent-ui` 共享模型与组件，端差异只保留在 Adapter 层。

### 18.4 价格与用量

建议新增：

```text
crates/agent-ui/src/lib/providers/pricing.ts
crates/agent-gui/src/lib/providers/runtime/pricingService.ts
```

负责：

- 阶梯验证；
- Token/图片/时长计量；
- Usage 到价格的确定性计算；
- unknown 与 zero 的区分；
- 对话详情中的价格展示。

### 18.5 媒体能力

建议新增：

```text
crates/agent-gui/src/lib/providers/media/
├── types.ts
├── registry.ts
├── executeMediaOperation.ts
└── adapters/
```

首版只建立类型、注册表和图像生成/编辑入口，不要求同步实现音频和视频 UI。

### 18.6 故障转移

将当前 `withProviderFailover()` 的候选准备层抽象为 `RequestCandidate[]`，保留流式执行器和提交语义。Chat、Media、Job 分别应用不同的重试策略。

## 19. 分阶段实施

### Phase 0：设计冻结与基线测试

- 冻结 V2 类型、路由规则、字段来源和迁移表；
- 为当前五种协议生成请求 Golden；
- 固化旧 Provider 路由、Header、UA、上下文和故障转移行为。

### Phase 1：Provider Registry 与只读兼容层

- 增加 ProviderDefinition；
- 旧 `CustomProvider` 读取时转换；
- 引入 `ResolvedOperationRoute`；
- `modelFactory` 支持显式协议但 UI 与存储仍保持旧形态。

### Phase 2：供应商向导与 Provider 多接口

- 内置首批 Provider 预设；
- 动态最少字段；
- 自动获取模型；
- Provider 按操作设置默认接口；
- 保存 V2 ProviderInstance。

### Phase 3：模型能力、模态、限制与接口覆盖

- 新模型编辑抽屉；
- 能力和模态接入运行时；
- 模型按操作覆盖接口和 wire model ID；
- 移除名称启发式作为主要判断，只保留兼容兜底。

### Phase 4：价格系统

- 文本 Token 和缓存价格；
- 阶梯价格；
- 用量详情计算；
- 图片、音频和视频计量结构先落盘，按功能启用。

### Phase 5：图像生成与图像编辑

- MediaAdapter；
- 图片生成/编辑任务入口；
- 结果 Artifact；
- 幂等、计费和手动重试边界。

### Phase 6：凭证与可用性策略

- Keychain secretRef；
- 多 SK/多账号；
- Provider 内接口故障转移；
- 跨 Provider 显式模型故障转移组；
- 迁移旧 failover 队列。

## 20. 测试与验收

### 20.1 配置与迁移

- [ ] 所有旧 Provider 可无损读取并产生与当前一致的请求；
- [ ] V2 配置经过 Desktop、Gateway WebUI、同步和备份后不丢字段；
- [ ] 用户覆盖字段不会被模型同步覆盖；
- [ ] 真实凭证和敏感 Header 不进入 WebUI、同步包、导出和日志。

### 20.2 Provider 与模型发现

- [ ] 官方 Provider 在只填最少字段后可获取模型；
- [ ] New API/私有网关使用服务地址 + SK 接入；
- [ ] 模型列表失败时允许使用内置目录或手动模型；
- [ ] 模型来源、状态和字段来源可见；
- [ ] 模型名不会被错误当作协议能力证明。

### 20.3 模型运行时

- [ ] 同 Provider 的两个模型可选择不同聊天协议；
- [ ] 同一模型的 Chat 与 Image Generate 可选择不同接口；
- [ ] `wireModelId` 与显示模型 ID 可不同；
- [ ] 模态和能力真正控制附件、工具和请求参数；
- [ ] 上下文窗口和最大输出继续正确驱动压缩与用量显示。

### 20.4 Header 与模拟

- [ ] Header 合并优先级稳定；
- [ ] UA 经 Rust 本地代理出现在真实上游请求中；
- [ ] 受保护 Header 无法被覆盖；
- [ ] 最终请求预览正确脱敏并显示来源；
- [ ] 跨域重定向不会携带凭证。

### 20.5 价格

- [ ] unknown 与 zero 明确区分；
- [ ] 阶梯边界无重叠且计算正确；
- [ ] 缓存价格空值回退正确；
- [ ] 图片按张/尺寸、音视频按时长的计量可扩展；
- [ ] Decimal 计算不存在二进制浮点误差。

### 20.6 故障转移与媒体

- [ ] Chat 只在提交前切换候选；
- [ ] 工具调用或文本提交后不自动重放；
- [ ] 401 可切备用 Credential；
- [ ] 语义错误和上下文错误不进行通用切换；
- [ ] 图片/视频请求默认不会因网络中断自动重复提交；
- [ ] 支持 Idempotency-Key 的媒体接口可安全恢复或重试。

## 21. 风险与待确认项

1. 各供应商模型列表对协议能力的描述并不统一，需要内置 Catalog 与用户覆盖共同工作。
2. 部分网关同一模型名在不同入站协议下会路由到不同上游，必须按 operation + protocol 建模。
3. 价格变化频繁，内置价格必须携带来源和生效时间，不能静默覆盖用户值。
4. 图像、音频和视频的计费及任务状态差异大，首版只建立稳定合同，不追求一次覆盖全部供应商。
5. SoPick 等待确认准确产品名称和官方接口文档后再增加 ProviderDefinition。
6. 多 OAuth 账号必须按 Credential 隔离 TokenStore 和刷新锁，不能复制 Provider 级单会话限制。

## 22. 最终产品语义

```text
Provider 决定：
  我接入的是谁、有哪些接口、默认走哪条接口、如何鉴权与模拟客户端。

Model 决定：
  我能做什么、支持什么输入输出、限制和价格是什么、每种任务实际走哪条接口。

Runtime 决定：
  当前操作如何解析成安全、可解释、可回退的真实请求。
```

默认用户只需完成“选择供应商、填写最少字段、获取模型”；高级能力全部存在，但只在用户需要覆盖 Provider 推荐值时展开。
