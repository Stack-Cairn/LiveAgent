# 模型能力注册与多协议路由

## 结论

LiveAgent 不应把「供应商」「模型厂商」「wire 协议」继续压在 `ProviderId` 一个字段里，也不应完整复制 Cherry Studio 的通用模型市场结构。当前最合适的边界是：

1. `CustomProvider` 继续表示用户保存的一份连接、凭据和故障转移身份。
2. `ProviderChatProtocol` 表示一次请求采用的 wire 协议。
3. 路由按 `模型覆盖 > 供应商默认 > 旧 ProviderId/requestFormat` 解析。
4. 解析结果一次性写入 `ProviderRuntimeConfig`，之后鉴权、代理、模型工厂、思考参数、缓存和原生搜索都读取同一个 adapter identity。
5. 模型能力继续由已有专用数据源负责：上下文限额来自模型目录，思考档位来自 `modelThinking`，图片输入来自目录加用户覆盖。只有真正存在运行时消费者的能力才进入设置模型。

本次已实现上述聊天协议路由闭环，并保留旧配置的零迁移行为。

## Cherry Studio 中值得借鉴的结构

分析基于 Cherry Studio `6beb5e1b7e952915f649e5e09b940e08956da3b1`：

- `packages/provider-registry/src/schemas/provider.ts` 将供应商连接拆成 `endpointConfigs`，每种 endpoint 有自己的 `baseUrl`、模型列表地址、reasoning format、adapter family 和 dialect；`defaultChatEndpoint` 只负责默认选择。
- `packages/provider-registry/src/schemas/model.ts` 将模型事实拆成能力、输入/输出模态、限额、价格、思考控制和图像生成参数；模型描述「能做什么」，endpoint 描述「怎样发送」。
- `packages/provider-registry/src/schemas/provider-models.ts` 表达 provider/model 交叉关系与覆盖，而不是复制整份模型记录。
- `packages/provider-registry/src/providers/*.ts` 允许一个供应商在同一连接下暴露多个协议，并允许单模型改变 `endpointTypes` 的优先顺序。
- 生成目录与手工源分离：运行时读取生成产物，维护者修改 schema/creator/provider 源并运行生成器，避免 UI 或请求路径内出现庞大的品牌判断表。

其核心价值不是字段数量，而是三类事实分离：

| 事实 | 归属 | 示例 |
| --- | --- | --- |
| 谁提供连接与凭据 | Provider | API Key、代理、自定义 Header、failover 身份 |
| 模型能做什么 | Model | 图片输入、思考、上下文窗口、最大输出 |
| 这次请求怎样传输 | Endpoint/Protocol | Anthropic Messages、OpenAI Responses、Google Generate Content |

不直接复制的部分：

- LiveAgent 当前只有聊天/Agent 文本生成入口，没有图像生成、Embedding、Rerank 的运行时与产品表面，提前导入这些 schema 会制造虚假能力。
- 项目已明确移除 token 计费；`pi-ai` 的必填 cost 当前统一为零。本次不因参考项目重新引入价格数据。
- LiveAgent 已有 `modelCatalog`、`modelThinking`、原生搜索和附件门控，另建第二套 capability bag 会产生双真源。

## 改造前的问题

改造前的 `CustomProvider.type` 同时承担：

- 设置页分类；
- failover 分组；
- API 鉴权头；
- proxy 路由命名空间；
- 模型工厂协议选择；
- reasoning/cache/search payload 策略。

`requestFormat` 只在 Codex 分类下切换 OpenAI Responses 与 Chat Completions。结果是一个聚合网关即使在同一 Base URL 暴露 Anthropic、OpenAI 和 Gemini，也必须拆成多份供应商配置；模型 id 无法声明自己的实际协议。仅在 `modelFactory` 增加判断也不够，因为鉴权与 payload 中间件仍会沿用原 ProviderId，形成「模型按 A 协议创建，请求却按 B 供应商装配」的分裂路由。

## 已实现的数据模型

```ts
type ProviderChatProtocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "google-generative-ai"
  | "deepseek-responses";

type CustomProvider = {
  // 原字段保留
  defaultChatProtocol?: ProviderChatProtocol;
  endpointConfigs?: Partial<
    Record<ProviderChatProtocol, { baseUrl: string }>
  >;
};

type ProviderModelConfig = {
  // 原字段保留
  chatProtocol?: ProviderChatProtocol;
};
```

`endpointConfigs` 只保存与主 Base URL 不同的协议 API 根地址。凭据、自定义 Header、系统代理和重试策略仍由供应商统一拥有，避免秘密复制和配置漂移。

协议覆盖 URL 是 API 根地址，不是最终请求 URL；最终路径仍由对应 adapter 添加。旧的供应商级 `isFullUrl` 仅在请求仍走旧协议时生效，切换协议后即使复用主 Base URL 也按 API 根地址解释，防止把一个协议的最终 URL 错用到另一个协议。

## 路由算法

`resolveProviderChatRoute(provider, modelId)` 是纯函数，输出：

```ts
type ResolvedProviderChatRoute = {
  protocol: ProviderChatProtocol;
  adapterProviderId: ProviderId;
  baseUrl: string;
  isFullUrl: boolean;
  requestFormat?: CodexRequestFormat;
};
```

解析顺序：

1. 读取 `ProviderModelConfig.chatProtocol`。
2. 缺失时读取 `CustomProvider.defaultChatProtocol`。
3. 再缺失时按旧规则推导：Claude → Anthropic，Gemini → Google，DeepSeek → DeepSeek Responses，xAI → OpenAI Responses，Codex → 原 `requestFormat`。
4. 如果 `endpointConfigs[protocol]` 存在，使用它的 Base URL；否则使用主 Base URL。
5. 协议映射到现有 adapter family。xAI 自身走 OpenAI Responses 时保留 `xai` identity，使其搜索与 payload 特例不丢失；普通网关的 OpenAI 协议走 `codex` adapter。

旧存档没有三个新字段，因此会稳定落到第 3 步，行为不变，也不需要批量迁移。

## 运行时闭环

路由在 `createProviderRuntimeConfig` 中只解析一次：

```text
Saved provider + selected model
             │
             ▼
 resolveProviderChatRoute
             │
             ▼
 ProviderRuntimeConfig
 (adapterProviderId, protocol, URL, format)
       ┌─────┼─────────┬───────────┐
       ▼     ▼         ▼           ▼
     auth   proxy   modelFactory  payload policy
```

下游改为用 `adapterProviderId` 处理传输语义，同时继续用原 ProviderId 做选择状态、展示和 failover breaker key。这样同一模型的主请求、文本辅助请求、摘要、标题、记忆整理及 failover 候选都共享同一路由语义。

## 设置界面

供应商编辑器新增：

- 默认聊天协议：默认是“自动”，即完全保持旧行为。
- 协议端点覆盖：折叠的高级区域，只在不同协议需要不同 API 根地址时填写。
- 模型聊天协议：每个模型可继承供应商默认值，或显式选择一个协议。

上下文窗口、最大输出、输入模态和缓存提示仍在原模型编辑区域，不改变既有操作路径。

## 能力模型的后续演进规则

未来增加能力时遵守以下约束：

1. 先有运行时消费者，再加入 capability schema 和 UI；不保存无法执行的声明。
2. 区分目录事实与用户覆盖。目录事实随生成目录升级；用户覆盖使用可选字段，只表达 delta。
3. 能力和协议正交。图片输入是模型能力，图片在 wire 中如何编码是 adapter 行为。
4. 服务端工具是 provider/model/protocol 三者交叉事实，不能只挂在模型品牌上。
5. 新协议必须先注册 adapter，再加入 `PROVIDER_CHAT_PROTOCOLS`；枚举本身不是实现。

建议的下一阶段顺序：

1. 将 `nativeWebSearch` 的现有 provider/model 启发式编译成 provider-model-protocol 目录。
2. 将思考的模型 knob 与 endpoint wire dialect 在生成期组合，运行时只读取解析结果。
3. 若产品增加图像生成或 Embedding，再为不同 operation 建独立 endpoint 类型；不要把非聊天模型塞进聊天模型选择器。
4. 只有恢复费用展示或预算控制产品后，才引入价格与货币 schema，并明确目录价、供应商实报费用和用户覆盖的优先级。

## 验证不变量

- 非法协议和空 endpoint URL 在设置加载时丢弃。
- 合法单模型协议覆盖可持久化往返。
- 路由优先级由单测锁定。
- 跨协议路由会同时改变 adapter、Base URL、request format 与请求装配身份。
- xAI Responses 保留原生 xAI 语义。
- 无新字段的 Claude/Codex/Gemini/xAI/DeepSeek 配置继续走原路由。

## 参考

- Cherry Studio provider schema: <https://github.com/CherryHQ/cherry-studio/blob/main/packages/provider-registry/src/schemas/provider.ts>
- Cherry Studio model schema: <https://github.com/CherryHQ/cherry-studio/blob/main/packages/provider-registry/src/schemas/model.ts>
- Cherry Studio provider registry: <https://github.com/CherryHQ/cherry-studio/tree/main/packages/provider-registry>
