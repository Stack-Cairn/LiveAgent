# 模型元数据运行期同步设计

日期：2026-10-30。状态：P0–P3 已在分支 `feat-model-catalog-live-sync` 实现（基线 `upstream/v2-kbrian`），P4 未做。本文设计模型目录（窗口、输出上限、输入模态、思考档位）的运行期分发方式，让上游新收录或修正的模型在几小时内到达用户，不再依赖 PR 合并和发版。

实现与初稿的差异在各节以“实现”标出。

## 1. 背景

### 1.1 现状

模型元数据现在分三层，按命中顺序：

| 层 | 来源 | 到达用户的时机 | 覆盖内容 |
|---|---|---|---|
| 供应商声明 | 供应商 `/v1/models` 响应里的 `context_length` 等字段，`extractProviderDeclaredLimits` 解析 | 用户点“刷新模型列表”时 | 只有限额，且多数供应商不提供 |
| 构建期快照 | `scripts/generate-model-catalog.mjs` 合并 Codex `models.json` 与 models.dev，写入 `catalog.generated.ts` | 每日 PR → 合并 main → 下次发版 | 限额、模态、思考档位 |
| 运行期思考补充 | `thinkingLive.ts` 在客户端直接拉 models.dev，24h 缓存 | 启动后几秒 | 只补思考档位，且只在快照未命中时生效 |

最后一层兜底是 `PROVIDER_FALLBACK_LIMITS`。

### 1.2 问题

1. 快照的更新链路有两个人工环节。`update-model-catalog.yml` 用默认 `GITHUB_TOKEN` 开 PR，PR 的 CI 由 `github-actions[bot]` 触发，需要维护者批准。2026-10-01 到 2026-10-30 共 24 次 CI 运行停在 `action_required`，PR #935 至今未合并，main 上的 `MODEL_CATALOG_SNAPSHOT_DATE` 停在 `2026-10-02`。
2. 即使 PR 及时合并，新数据也要等下次发版。两次发版之间发布的模型只能拿到供应商兜底限额，压缩阈值和输出预留都按兜底值计算。
3. 运行期补充只覆盖思考档位。`thinkingLive.ts` 头注释写明了原因：跨分区限额裁决（官方分区优先于托管分区）是生成期职责，客户端复制一份规则会漂移。现在已有一处需要手动同步的镜像：`OFFICIAL_SECTION_ORDER` 与生成器 `SECTIONS`。

### 1.3 目标

- 上游数据变化后，6 小时内到达在线客户端（桌面、浏览器直连、Gateway WebUI）。
- 合并与归一化规则只在生成器里存在一份。
- 远程数据缺失、损坏或不可达时，行为不差于现在的“快照 + 兜底”。
- 国内网络环境下有可用的获取路径。

不在范围内：用户手动覆盖（`limitsSource: "user"`）、请求侧的思考档位语义、Anthropic 1M 窗口请求策略。这些逻辑保持现状。

生图参数（画面比例、quality、output_format、background 等）也不在范围内。这些参数由 K-brain 图像模块的协议档案定义，经 `/v1/image/targets` 下发，K-brain 的请求代码按同一份档案校验取值。本目录的条目结构不含生图参数，models.dev 也不发布这类枚举。

## 2. 方案选择

| 方案 | 收益 | 代价与结论 |
|---|---|---|
| 只修 PR 流程（App 令牌 + 自动合并） | 改动小，main 快照每天更新 | 用户仍要等发版。保留，作为内置快照的更新方式 |
| 客户端直接拉 models.dev，把 `thinkingLive` 扩展到限额与模态 | 不需要新的发布设施 | 生成器的 Codex 合并、分区裁决、overrides、SENTINELS 都要在客户端再实现一份，漂移风险扩大。不采用 |
| 生成器输出 JSON，CI 定时发布，客户端拉取 | 规则只有一份；发布不经过 `pull_request`，不受审批影响；用户几小时内拿到 | 需要发布通道、客户端校验和缓存。本文方案 |

## 3. 必须保持的规则

| 编号 | 规则 |
|---|---|
| C1 | 远程目录与内置快照由同一个生成器、同一份规则产出，客户端只校验、不重算归一化 |
| C2 | 远程数据任何一项校验失败，整份丢弃，继续用上一份可用数据（磁盘缓存或内置快照） |
| C3 | 优先级固定：用户配置 > 供应商声明 > 远程目录 > 内置快照 > 供应商兜底 |
| C4 | 远程目录只替换 `limitsSource` 为 `catalog` / `fallback` 的条目；`provider` 与 `user` 不被改动 |
| C5 | 远程目录的生成日期早于内置快照时不采用，防止旧缓存覆盖新安装包 |
| C6 | 桌面、浏览器直连、Gateway WebUI 共用同一个加载模块，三处行为一致 |
| C7 | 推送给 K-brain 的模型元数据与客户端界面使用同一份已生效目录 |

## 4. 数据格式

发布物为 `model-catalog.v1.json`：

```json
{
  "schemaVersion": 1,
  "snapshotDate": "2026-10-30",
  "generatedAt": "2026-10-30T09:17:00Z",
  "generator": { "commit": "<sha>", "sources": ["codex models.json", "models.dev api.json"] },
  "sections": {
    "anthropic": [
      { "id": "claude-opus-4-7", "contextWindow": 1000000, "maxOutputToken": 128000,
        "inputModalities": ["text", "image", "pdf"],
        "thinking": { "levels": ["low", "medium", "high", "xhigh", "max"], "off": true } }
    ]
  },
  "minimums": { "anthropic": 8, "google": 15 },
  "sha256": "<sections 规范化序列化后的哈希>"
}
```

- `sections` 的键和条目结构与 `MODEL_CATALOG: Record<CatalogProviderId, CatalogModelEntry[]>` 一致，键的顺序就是跨分区裁决顺序。
- `minimums` 取自生成器 `SECTIONS[].min`，客户端据此做条目数校验，不需要在客户端写死。
- `schemaVersion` 只在字段语义变化时递增。新增可选字段不递增，客户端忽略不认识的字段。
- 未知的分区键（上游新增了供应商）客户端丢弃，不报错。新分区随发版进入 `CatalogProviderId`。

## 5. 生成与发布

### 5.1 生成器

`generate-model-catalog.mjs` 新增 `--json <path>`：在写 `catalog.generated.ts` 的同一处，用同一份 `sections` 数据输出 JSON。SENTINELS 和各分区 `min` 校验失败时进程退出非零，两种输出都不写。TS 文件与 JSON 来自同一次运行，内容一致由测试锁定（见第 9 节）。

### 5.2 发布工作流

新增 `.github/workflows/publish-model-catalog.yml`：

- 触发：`schedule` 每 6 小时一次，另加 `workflow_dispatch`，便于新模型发布当天手动推送。
- 步骤：检出 main → 运行生成器输出 JSON → 与数据分支上的现有文件比较 `sha256`，相同则结束 → 不同则提交到孤儿分支 `data/model-catalog`。
- 权限：`contents: write`。直接推送数据分支，不开 PR，所以不触发 `pull_request` 工作流，也不需要审批。
- 分支上只放 `model-catalog.v1.json`，可选再加签名文件（见第 8 节）。历史提交保留，便于回溯和回退。

发布地址：`https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/data/model-catalog/model-catalog.v1.json`。

选择 raw 而非 Release 资产：浏览器里的 Gateway WebUI 需要跨域读取。raw 返回 `Access-Control-Allow-Origin: *` 和 `ETag`。Release 资产下载会经过跳转，跨域响应头需实测，风险较高。上线前两者都要在 WebUI 里实测一次。

### 5.3 内置快照

`update-model-catalog.yml` 保留，用于更新安装包里的离线兜底，同时修复审批问题：

- `create-pull-request` 改用 GitHub App 令牌（`actions/create-github-app-token`），PR 由 App 身份触发 CI。
- PR 带 `governance-exempt` 标签，CI 通过后开启自动合并。
- 实现：定时任务继续独立运行生成器（数据分支为空时也能工作），两份产物同源由第 9 节的一致性测试锁定。App 令牌、自动合并分别由仓库变量 `MODEL_CATALOG_APP_ID` / 密钥 `MODEL_CATALOG_APP_PRIVATE_KEY` 与变量 `MODEL_CATALOG_AUTO_MERGE=true` 开启；自动合并还需要维护者在仓库设置里打开 “Allow auto-merge”（当前为关闭）。未配置时行为与原来相同。

## 6. 分发与可达性

客户端按顺序尝试以下地址，第一个成功的结果生效：

| 顺序 | 地址 | 适用宿主 | 说明 |
|---|---|---|---|
| 1 | Gateway `GET /api/public/model-catalog` | Gateway WebUI | Gateway 从 raw 拉取并缓存，按 `ETag` 回源，原样转发 JSON。出站请求遵循 `HTTPS_PROXY`，国内部署可经代理回源 |
| 2 | raw.githubusercontent.com 数据分支 | 全部 | 默认地址 |
| 3 | 用户自定义地址 | — | 实现：未做设置项，只保留 `configureCatalogLiveSources` 接口（见第 11 节）|

- Gateway 端点放在 `crates/agent-gateway/internal/server/http.go` 的公开路由（与 `/api/public/history-shares` 同级，不需要 Gateway 令牌），只做形状检查，不改写内容，缓存字节和 `ETag`。10 分钟内不回源；回源失败时返回上一次缓存并带 `X-LiveAgent-Catalog-Stale: 1`，没有缓存返回 503，失败后 30 秒内不重试。上游地址由 `LIVEAGENT_GATEWAY_MODEL_CATALOG_URL` / `-model-catalog-url` 配置，`off` 关闭（返回 404）。
- 实现：桌面端不经 Gateway。桌面自带的 Gateway 子进程与桌面在同一网络，代理不能改善可达性。
- 桌面端从 WebView 直接 `fetch`，与 `thinkingLive` 现在拉 models.dev 的方式相同。Tauri 配置 `csp: null`，不限制 `connect-src`。
- 国内网络环境下，raw 与 models.dev 都可能不可达，所以现在的 `thinkingLive` 也有同样问题。Gateway 代理是这个问题的主要解法；没有 Gateway 的桌面用户仍然依赖内置快照。

## 7. 客户端加载与合并

### 7.1 模块

`crates/agent-ui/src/lib/models/` 下新增 `catalogLive.ts`，结构照搬 `thinkingLive.ts`；React 胶水 `useCatalogLiveVersion` 放在已有的 `useThinkingLive.ts`：

- `loadCatalogLiveSupplement({ force?, ttlMs? })`：幂等，并发调用共享 in-flight 请求。
- 冷启动先读磁盘缓存（`localStorage` 键 `liveagent.catalogLive.v1`），哪怕已过期也先生效，网络刷新在后台进行。
- 实现：请求用 `cache: "no-cache"`，由浏览器自身的 HTTP 缓存带 `If-None-Match` 做条件请求。手动加自定义请求头会让跨域读取 raw 触发预检，所以不加。内容 `sha256` 与当前生效的相同时不递增版本号。
- 默认 TTL 6 小时，与发布频率一致。超时 30 秒。
- 任何失败静默返回 `false`，保留旧数据。
- 生效后递增模块级版本号，`useCatalogLiveVersion()` 让组件重算。`useThinkingLiveVersion()` 改为返回两路版本之和，原有 4 个档位消费者无需改动。

调用点与 `loadThinkingLiveSupplement` 相同：`crates/agent-gui/src/App.tsx` 和 `crates/agent-gateway/web/src/app/GatewayApp.tsx`。

### 7.2 校验

以下任一项不满足，整份丢弃（C2）：

1. `schemaVersion` 等于客户端支持的版本。
2. `snapshotDate` 不早于内置 `MODEL_CATALOG_SNAPSHOT_DATE`（C5）。
3. 重算 `sections` 的 `sha256` 与字段一致，用于发现截断或代理改写。
4. 每个已知分区的条目数不少于 `minimums` 中对应值。
5. 每个条目满足：`id` 非空，`contextWindow` 与 `maxOutputToken` 为正整数，`maxOutputToken < contextWindow`，模态和思考档位只含已知取值。
6. 所有分区合起来，`id` 按小写全局唯一（生成器已保证，客户端复核）。

### 7.3 合并

`modelCatalog.ts` 现在直接读静态导入的 `MODEL_CATALOG`，`getCatalogIndex` 在模块级缓存索引。改动如下：

- 新增“已生效目录”：远程目录通过校验时，用远程 `sections` 整份替换对应分区（远程缺少的已知分区保留快照）；远程里任何分区都找不到的 id，从内置快照补回。补回只看 id 是否在全局出现过，不涉及分区优先级，所以不会引入新的裁决逻辑。
- 补回的原因：上游下架或改名的模型，用户的配置里可能还在用。直接删掉会让这些模型退回兜底限额。
- 已生效目录变化时清空 `catalogIndexByProvider`，再递增版本号。
- `findCatalogModel`、`findCatalogModelAcrossProviders`、`resolveModelLimits` 等函数签名不变，调用方无需改动。

### 7.4 设置中的限额

`normalizeProviderModelConfig` 已经在加载时对 `limitsSource` 为 `catalog` / `fallback` 的条目按当前目录重新解析（C4 依赖这一点）。远程目录在设置加载之后才到达，所以需要：

- 设置存储订阅 `useCatalogLiveVersion`，版本变化时调用 `refreshCatalogDerivedModelLimits` 重解析 catalog/fallback 条目。这一步只改内存，不立即写盘。实现：GUI 挂在 `App.tsx`（加载前记下目录版本，加载途中到达的新目录不会被误记为已处理），WebUI 挂在 `useGatewaySettingsSync`。磁盘缓存在设置加载前同步生效，冷启动直接按缓存解析。
- 原来是 `fallback` 的条目，如果远程目录收录了该模型，会自动变成 `catalog` 并拿到真实限额。这正是本方案要解决的情形。

### 7.5 K-brain 推送

`crates/agent-gui/src/lib/kbrain/providerSettings.ts` 的 `resolvePushedInputModalities` 用 `findCatalogModelAcrossProviders` 给推送的模型补图片模态。远程目录生效后结果可能变化，需要触发一次设置重推，否则 K-brain 与界面看到的模态不一致（C7）。按 `AGENTS.md` 的契约地图要求，这一项要在桌面直连、Gateway 同步、WebUI 两处收集器三个表面都确认。

实现：`kBrainSettingsUpdateForCatalogRefresh` 同时比较 catalog/fallback 条目的限额与缺失的模态，有差异才写入。启动对账（原 `backfillKBrainInputModalities`）改用它；目录版本在设置加载后变化时，GUI 调 `reconcileKBrainCatalogMetadata` 补推一次。K-brain 按供应商保存模型元数据 override，同一 id 在不同供应商下限额不同不会被拒。WebUI 收到的同步设置经 `normalizeSettings` 按本端生效目录解析，不依赖桌面端重发。

### 7.6 `thinkingLive` 的去留

远程目录本身带思考档位，上线后 `thinkingLive` 只在远程目录不可达、且快照也未命中时还有作用。分两步处理：

1. 第一阶段保留，查找顺序变为：远程目录 → 内置快照 → `thinkingLive` → 通用兜底。
2. 远程目录稳定运行一个发版周期后删除 `thinkingLive.ts`、`useThinkingLive.ts` 及调用点，同时删除 `OFFICIAL_SECTION_ORDER` 这份镜像。

## 8. 安全与失败处理

| 情形 | 处理 |
|---|---|
| 网络不可达、超时 | 用磁盘缓存；没有缓存则用内置快照。不提示用户 |
| JSON 解析失败、校验失败 | 整份丢弃，保留旧数据，开发版控制台记一条警告 |
| 上游数据退化（大量模型丢失） | 生成器的 SENTINELS 与 `min` 拦截，不发布；客户端 `minimums` 校验再拦一次 |
| 发布了错误数据 | 在数据分支回退提交或手动触发工作流重新发布；客户端在下一个 TTL 内更新 |
| 代理或镜像篡改 | 第一阶段靠 HTTPS、`sha256` 字段和数值校验。是否加 minisign 签名见第 11 节 |
| 旧缓存遇到新安装包 | C5：缓存的 `snapshotDate` 早于内置快照时不采用 |

## 9. 测试

| 测试 | 内容 |
|---|---|
| 生成器一致性 | 同一次运行输出的 TS 与 JSON，解析后 `sections` 深相等 |
| 校验 | 第 7.2 节每一项各写一个失败用例，确认整份被拒、旧数据保留 |
| 合并 | 远程删掉某个 id 时从快照补回；远程新增 id 时可被 `findCatalogModelAcrossProviders` 命中；跨分区同名 id 按远程分区顺序命中 |
| 索引失效 | 远程生效后 `getCatalogIndex` 返回新数据，版本号递增 |
| 设置重解析 | `fallback` 条目在远程收录后变为 `catalog`；`user` 与 `provider` 条目不变 |
| 缓存 | 冷启动读过期缓存后后台刷新；304 只更新时间；`snapshotDate` 早于内置快照的缓存被忽略 |
| Gateway 端点 | 回源成功、`ETag` 命中、回源失败返回旧缓存、无缓存返回 503 |
| 宿主实测 | GUI 与 WebUI 各一次：断网启动、首次拉取、远程新增模型后界面窗口显示更新 |

## 10. 分阶段实施

| 阶段 | 内容 | 可独立交付 |
|---|---|---|
| P0 | 修复 `update-model-catalog.yml`：App 令牌 + 自动合并 | 是，解决快照停更 |
| P1 | 生成器 `--json`；`publish-model-catalog.yml`；数据分支 | 是，只产出数据，客户端不变 |
| P2 | `catalogLive.ts`、校验、合并、索引失效、设置重解析、K-brain 重推 | 依赖 P1 |
| P3 | Gateway `/api/model-catalog` 代理与客户端地址顺序 | 依赖 P2 |
| P4 | 删除 `thinkingLive` 与 `OFFICIAL_SECTION_ORDER` | 依赖 P2 稳定一个发版周期 |

## 11. 未决问题

1. **签名**：是否对 JSON 做 minisign/Ed25519 签名并在客户端用内置公钥验签。好处是可以防住镜像与第三方代理篡改；代价是浏览器端要依赖 WebCrypto Ed25519（需确认 WebView2 与目标浏览器版本）和一把新的签名密钥。数据分支本身的写权限与源码相同，Gateway 由部署者自己运维，第一阶段可以不签。
2. **发布频率**：6 小时是估计值。models.dev 自身的收录速度才是上限，可以看一个月的数据分支提交频率再调整。
3. **用户自定义地址**是否需要在设置界面露出。实现只保留了 `configureCatalogLiveSources` 接口，需要时在设置里加一项，调用 `configureCatalogLiveSources([自定义, 默认])`。

## 12. 源码依据

| 现状 | 位置 |
|---|---|
| 生成器、分区顺序、SENTINELS、overrides | `scripts/generate-model-catalog.mjs` |
| 每日 PR 工作流 | `.github/workflows/update-model-catalog.yml` |
| 快照数据与 `MODEL_CATALOG_SNAPSHOT_DATE` | `crates/agent-ui/src/lib/models/catalog.generated.ts` |
| 目录查找与模块级索引缓存 | `crates/agent-ui/src/lib/models/modelCatalog.ts`（`getCatalogIndex`、`findCatalogModel*`、`resolveModelLimits*`） |
| 供应商声明限额 | `modelCatalog.ts` `extractProviderDeclaredLimits` |
| 加载时按目录重解析限额 | `crates/agent-ui/src/lib/settings/index.ts` `normalizeProviderModelConfig` |
| 运行期思考补充与 `OFFICIAL_SECTION_ORDER` | `crates/agent-ui/src/lib/models/thinkingLive.ts` |
| 运行期补充调用点 | `crates/agent-gui/src/App.tsx`、`crates/agent-gateway/web/src/app/GatewayApp.tsx` |
| K-brain 推送时补模态 | `crates/agent-gui/src/lib/kbrain/providerSettings.ts` `resolvePushedInputModalities` |
| Gateway HTTP 路由 | `crates/agent-gateway/internal/server/http.go` |
| CI 停在审批的记录 | Actions 运行 41037085974 等，2026-10-01 起 24 次 `action_required` |
