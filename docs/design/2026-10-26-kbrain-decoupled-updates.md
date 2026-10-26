# LiveAgent 与 K-brain 解耦更新设计

> 状态：草案（2026-10-26），待评审。
> 配套契约：K-brain 仓库 `docs/compatibility.md`（下称"兼容约定"）。本文描述 LiveAgent 侧
> （桌面端、Gateway、WebUI）怎么配合这份约定，以及分阶段的实施与验收方法。

## 1. 目标

| # | 规则 | 说明 |
|---|---|---|
| R1 | K-brain 可以独立更新 | LiveAgent 没有改动需求时，用户不必等 LiveAgent 发版，就能用上最新的兼容版 K-brain |
| R2 | 旧 LiveAgent + 新 K-brain，旧功能照常可用 | K-brain 主版本内只做加法；LiveAgent 忽略不认识的新字段 |
| R3 | 新 LiveAgent + 旧 K-brain，新功能自动不生效 | LiveAgent 的新功能统一按能力集探测，探测不到就隐藏或回退旧行为，不报错 |
| R4 | 不兼容的改动有明确边界 | 破坏性改动升协议主版本；自动更新只在 LiveAgent 支持的主版本内进行，出问题自动回退 |
| R5 | K-brain TUI 不受影响 | LiveAgent 的任何更新动作都不能让用户自行安装的 `kn` 失去可用性：不碰其可执行文件；破坏性存储迁移不自动安装、需用户确认，有 `kn` 在运行时推迟（见第 9 节） |

已确定的取舍（2026-10-26）：

1. 自动更新提供三种方式（启动时自动替换 / 下载后提示确认 / 只手动检查），在设置里切换；
   频道跟随 LiveAgent 的更新频道。
2. 新版 K-brain 启动失败时自动回退到上一个可用版本。
3. 兼容关系由 K-brain 发布时声明（`release-manifest.json`），LiveAgent 只认这份声明，不维护版本白名单。
4. 下载校验 `SHA256SUMS`，暂不做签名，需要时再加。
5. Gateway 远程部署与 WebUI 一并纳入。

## 2. 现状与耦合点

| 耦合点 | 位置 | 后果 |
|---|---|---|
| K-brain 随安装包锁定 | `scripts/release/kbrain.lock.json` 锁定提交与哈希；`scripts/release/prepare-kbrain.mjs` 构建时放进 `src-tauri/binaries/`；运行时 `services/kbrain_backend.rs` 的 `resolve_binary()` 只找可执行文件旁边的 `k-brain(.exe)`（调试时可用 `LIVEAGENT_KBRAIN_BINARY`） | K-brain 的任何修复都要等 LiveAgent 发版才能到达用户，例如 K-brain#58（删除"结果未知"的生图记录） |
| 协议版本写死为字符串 | 健康检查：桌面端 Rust `kbrain_backend.rs`（`health.version == PROTOCOL_VERSION`）、前端 `lib/kbrain/bootstrap.ts`（浏览器直连）；连接对象 `lib/kbrain/runtimeConnection.ts`。响应与事件：桌面前端 `client.ts`、`queueClient.ts`、`trajectory.ts`、`providers/runtime/textOnlyRuntime.ts` 对运行受理、会话状态、事件流、队列、轨迹、文本生成的响应用 `!== KBRAIN_PROTOCOL_VERSION` 严格比对，缺字段也拒绝；Gateway `internal/kbrain/client.go` 只比对 StartRun 响应与 SSE 事件（`version` 非空且不等才拒绝），`backend_queue_client.go` 严格比对队列响应。Gateway 没有协议健康检查 | K-brain 一升主版本，旧客户端会拒绝连接或拒绝响应；没有"兼容范围"的概念；Gateway 连上不兼容的 K-brain 时只在具体请求上失败，报不出原因 |
| 能力探测零散 | 五处各自请求 `/v1/health`：`historyMigration.ts`（`session_exists !== 1`）、`client.ts` `startRun`（`permission_modes`，只在 always / auto_edit / auto_review 时请求，不支持时直接报错）、记忆总开关（桌面端由 `agent-ui-adapters/kbrainSettings.ts` 请求 health，`MemorySwitch.tsx` 判断 `memory_switch !== 1`；宿主不提供 `getCapabilities` 时改看设置文档里有没有 `memory.enabled`）、`agent-ui/lib/imaging/client.ts`（`image`，`image.version` 严格相等）、Gateway（`backend_queue_client.go` 的 `session_queue != 1`、`client.go` 的 `permission_modes`） | 判断方式不统一（`!== 1` / `!= 1` 在能力值升级后会误判为不支持）；`image_model_toggle`、`computer_session_approval` 不按能力名探测，而是靠响应里有没有 `imageModel` 字段、权限请求里有没有 `allow_always` 选项隐式判断 |
| 启动参数是隐式契约 | `kbrain_backend.rs` 以 `kn backend -listen -data-dir -parent-stdio [-legacy-desktop-dir]` 启动，`kbrain.lock.json` 的 `requiredBackendFlags` 登记必需参数 | `prepare-kbrain.mjs` 只检查锁文件里登记了 `-parent-stdio`，从不检查二进制本身是否支持这些参数；运行时换版本也没有校验 |
| TUI 与后端共用数据 | 两者默认都用 `~/.liveagent`（后端可被 `LIVEAGENT_HOME` / `K_BRAIN_HOME` 覆盖）；各子系统自带格式版本，没有全局存储版本 | 自动回退可能让旧 K-brain 打开新格式数据 |
| Gateway 远程 K-brain | Gateway 通过 `-kbrain-url` 连外部 K-brain 作为远程会话目标，生图另走 `-image-kbrain-url`（可能是另一个实例）；Docker 镜像不含 K-brain；仓库里没有远程 K-brain 的部署与升级文档 | 远程部署者无法判断该配哪个 K-brain，升级也没有依据 |

可复用的现有机制：LiveAgent 自己的更新器（`commands/app/update.rs`、`lib/appUpdates.ts`）读 GitHub
releases，按 tag 是否带 `-` 区分 `stable` / `prerelease` 两个频道；K-brain 的发版 workflow 用的是同一规则
（`prerelease: contains(ref_name, '-')`）。

## 3. 总体方案

```
            ┌──────────────── K-brain 发布（GitHub Release）────────────────┐
            │ k-brain-<os>-<arch>  k-brain-computer-…  SHA256SUMS            │
            │ release-manifest.json（协议主/次版本、存储迁移类型、能力列表）  │
            └──────────────┬───────────────────────────────┬────────────────┘
                           │ 自动更新（阶段四）              │ 手动部署（阶段五文档）
                           ▼                               ▼
  LiveAgent 桌面端 ── 选择可用版本 → 启动 → /v1/health ──► 能力表（阶段二）──► 各功能启用/降级
         │                    ▲ 失败自动回退                          ▲
         └─ Gateway 桥接 ─────┘                                       │
  Gateway（远程）── -kbrain-url ──► 远程 K-brain ─► /v1/health ─► 能力透传给 WebUI（阶段五）
```

五个阶段按依赖顺序推进：先让两边对"兼容"有同一套判断（协议、能力、存储），再做自动更新与回退，
最后覆盖 Gateway 与 WebUI。

## 4. 兼容协议（阶段一）

### 4.1 K-brain 侧（见兼容约定第 3 节）

`/v1/health` 在保留 `version: "kbrain.agent.v1"` 的同时新增 `protocol`、`build`、`storage` 字段；发版新增
`release-manifest.json`。

### 4.2 LiveAgent 侧的判断规则

所有检查点改为同一个判断函数：

```
解析 health:
  protocol.major 存在 → 用它
  否则 version == "kbrain.agent.v1" → major = 1, minor = 0
  否则 → 不兼容
兼容 ⇔ major ∈ LiveAgent 支持的主版本集合（当前为 {1}）
```

| 检查点 | 现在 | 改为 |
|---|---|---|
| 桌面端 Rust `kbrain_backend.rs` 健康检查 | `health.version == PROTOCOL_VERSION` | 上述判断；不兼容时错误信息写明双方主版本 |
| 前端 `bootstrap.ts`（浏览器直连） | `health.version !== "kbrain.agent.v1"` 即报错 | 同上 |
| 前端 `runtimeConnection.ts` | `protocolVersion` 字段写死 | 改为记录主版本；连接对象保留旧字段以兼容现有调用 |
| Gateway 协议健康检查 | 没有 | 新增：连接 `-kbrain-url` 与 `-image-kbrain-url` 时各请求一次 `/v1/health`，用上述判断，结果写入 Gateway 健康状态 |
| Gateway `client.go` StartRun 响应、SSE 事件 | `version` 非空且不等于 `kbrain.agent.v1` 才拒绝 | 改为按主版本判断：`version` 非空且主版本不在支持集合时拒绝 |
| Gateway `backend_queue_client.go` 队列响应 | 严格比对，缺字段也拒绝 | 同上一行 |
| 桌面前端 `client.ts`、`queueClient.ts`、`trajectory.ts`、`textOnlyRuntime.ts` 的响应与事件 | `client.ts`、`queueClient.ts` 用 `types.ts` 的 `KBRAIN_PROTOCOL_VERSION` 严格比对，`trajectory.ts`、`textOnlyRuntime.ts` 直接写字面量，缺字段也拒绝 | 主版本 1 期间不动（K-brain 保留旧字段）；支持主版本 2 时必须与上面的检查一起改为按主版本判断，否则新 K-brain 的每个响应都会被拒绝。届时以全仓库搜索 `kbrain.agent.v1` 为准，除上述文件外还有 `runtimeConnection.ts`、`scripts/release/prepare-kbrain.mjs`（锁文件 `protocol` 必须等于 v1）、`scripts/release/create-ai-release-notes.mjs` |

旧 LiveAgent 在主版本 1 期间不受影响，因为 K-brain 保留了旧字段。

### 4.3 契约样例

LiveAgent 每次发布（含预发布；v2 目前都是预发布）时，把桌面端与 Gateway 实际发送的请求样例（脱敏）导出到 K-brain 仓库的
`internal/backend/testdata/la-contract/<LiveAgent 版本>/`，K-brain 的"旧客户端回放"测试据此保证 R2。样例由 LiveAgent 现有
集成测试的请求录制生成，脚本放在 `scripts/release/`。

## 5. 能力表与统一降级（阶段二）

### 5.1 单一能力来源

- 桌面端：K-brain 启动成功后，Rust 侧保存一次 `/v1/health` 结果，经 `kbrain_backend_connection` 一并交给前端；
  前端 `lib/kbrain/capabilities.ts` 提供 `hasCapability(name, minVersion = 1)`，按"大于等于"判断。
  要同时改两处：Rust 的 `KBrainBackendConnection` 现在只有 `base_url` / `token` / `protocol_version` / `storage_id`
  四个字段，要加上能力集；前端 `setKBrainRuntimeConnection` 按白名单复制字段，不改会把能力集丢掉。
- 刷新：现在前端只在请求失败时重新拉连接（`transport.ts`），Rust 不主动推送。K-brain（重新）启动成功后，
  Rust 发出 `kbrain:connection-changed` 事件，前端收到后重新拉连接与能力集；请求失败触发的重连照旧保留。
- Gateway：保存远程 K-brain 的 health 结果，经同步协议下发给 WebUI（阶段五）。
- WebUI 与桌面端共用 `agent-ui` 里的同一个判断函数，宿主只负责提供能力数据。

### 5.2 现有功能登记

| LiveAgent 功能 | 依赖的能力 | 现在 | 改为 |
|---|---|---|---|
| 启动迁移跳过与批量确认（#1062） | `session_exists` | `!== 1` 判断，单独请求 health | `hasCapability("session_exists")` |
| 权限模式 always / auto_edit / auto_review | `permission_modes` 列表 | 只在选这三种模式时由 `startRun` 请求 health，不支持时直接报错，没有降级（Gateway `client.go` 相同） | 读能力表；设置界面与输入框据此隐藏不支持的模式 |
| 记忆总开关 | `memory_switch` | 桌面端：`kbrainSettings.ts` 适配器单独请求，`MemorySwitch.tsx` 判断 `!== 1`；WebUI 等不提供 `getCapabilities` 的宿主：按设置文档里有没有 `memory.enabled` 隐式探测 | 读能力表；隐式探测保留为没有能力数据时的兜底 |
| 图像工作台 | `image` | `imaging/client.ts` 单独请求 | 读能力表 |
| 供应商模型生图开关 | `image_model_toggle` | 隐式探测：开关只在 K-brain 回传 `imageModel` 字段时显示（`ProviderModal.tsx`），发送端同样按该字段判断（`providerSettings.ts`） | 保留现有字段判断，同时登记能力名，新代码统一用 `hasCapability` |
| Computer Use 会话级授权 | `computer_session_approval` | 隐式探测：权限请求里没有 `allow_always` 选项时不提供"本会话始终允许"，已退回逐次授权（`runKBrainConversationTurn.ts`、`toolApprovalArgs.ts`） | 保留现有选项判断，登记能力名 |
| Gateway 会话排队 | `session_queue` | Gateway 单独请求，`!= 1` 判断 | Gateway 读自己保存的能力表，按"大于等于"判断 |
| 删除"结果未知"的生图记录（K-brain#58） | 无（服务端放行即生效） | — | 旧 K-brain 仍返回 409，前端现有文案即可，无需新能力 |

### 5.3 新功能的约束

- 依赖新 K-brain 行为的功能，必须在本表登记能力名，并有"能力缺失"时的测试。
- 新请求字段只在能力存在时发送：K-brain 的请求解码使用 `DisallowUnknownFields`，旧 K-brain 收到未知字段会返回 400。
- 预检技能 `la-kb-preflight` 的关口 1（契约地图）增加一项：新功能是否在能力表登记、是否有降级测试。

## 6. 存储版本（阶段三）

K-brain 侧按兼容约定第 8 节实现 `kbrain-storage.json`（`version` / `minReader`），以及"数据比自己新就拒绝打开"。
LiveAgent 侧：

- 自动更新安装前读取 `release-manifest.json` 的 `storage.migration`：
  - `none` / `additive`：按用户选择的更新方式处理。
  - `breaking`：三种更新方式下都不自动下载、不自动安装，只在设置里显示"有需要手动确认的新版本"。用户
    点击安装时弹出确认框，写明：
    - 升级后无法自动回退到旧版本，K-brain 会先备份受影响的数据；
    - 用户自行安装的 `kn`（TUI）若低于该版本，将无法打开数据，需要升级到不低于该版本的 `kn`。LiveAgent 用 PATH
      中的 `kn -version` 检测其版本并显示在确认框里（检测不到时也照常提示），同时给出与该版本匹配的安装命令
      （`install.sh` 用 `K_BRAIN_VERSION=<tag>`，`install.ps1` 用 `-Version <tag>`）。不能只提示 `kn update`：它只装
      GitHub latest，也就是最新正式版，预发布频道的 `breaking` 版本靠它装不到；阶段三在 K-brain 侧让
      `kn update` 支持指定版本与预发布频道后，再改为提示对应的 `kn update` 命令。
- 后端以退出码 `75`（数据目录忙，兼容约定第 8 节）退出时，说明 TUI 等其他 K-brain 进程正在使用数据、
  破坏性迁移被推迟：不记入 `bad`，不回退，提示"请关闭正在运行的 kn 后重试"，并提供"重试"按钮。
  确认框本身也提示"请先关闭所有 `kn`"：旧版 `kn` 不持有数据目录锁，K-brain 只能靠进程检测发现它（兼容约定第 8 节）。
- 后端以退出码 `76`（存储版本不可读，例如用户在 TUI 里装了更新的 `kn` 并已迁移数据）退出时，不算版本坏了：
  不记入 `bad`，直接显示 7.4 表中"读不了当前存储"那一行的提示与"下载新版本"入口。
- 回退前读取 `<data-dir>/kbrain-storage.json`：候选版本 `release-manifest.json` 里的 `storage.version`（它能写出、
  也就能读的最高存储版本）低于数据的 `minReader` 时，不回退到它，而是提示用户（见 7.4）。

这一阶段放在自动更新之前，因为回退保护依赖它。

## 7. 桌面端 K-brain 自动更新（阶段四）

### 7.1 设置项

在"设置 → 关于/更新"现有的 LiveAgent 更新区域下新增"K-brain 后端"一栏：

| 设置 | 选项 | 默认 |
|---|---|---|
| 更新方式 | 启动时自动下载并在下次启动时替换 / 下载后提示确认 / 只手动检查 | 下载后提示确认 |
| 频道 | 跟随 LiveAgent 的更新频道（不单独设置） | — |
| 当前版本 | 显示正在运行的 K-brain 发布版本、来源（安装包自带 / 已下载）、协议主次版本 | — |
| 操作 | 检查更新、立即重启 K-brain（无运行中的任务时可用）、恢复为安装包自带版本 | — |

频道规则：LiveAgent 频道为 `stable` 时只考虑 K-brain 正式版；为 `prerelease` 时考虑全部发布。

### 7.2 本地布局

```
~/.liveagent/kbrain/
  versions/<发布版本>/k-brain(.exe)
  versions/<发布版本>/k-brain-computer(.exe)
  versions/<发布版本>/release-manifest.json
  state.json   { "active": "<版本>", "lastGood": "<版本>", "bad": ["<版本>", ...], "pending": "<版本>" }
```

- 上面以默认数据根 `~/.liveagent` 为例；后端数据根被 `LIVEAGENT_HOME` / `K_BRAIN_HOME` 覆盖时，放在该数据根下的 `kbrain/`。
- 不写入安装目录：安装目录可能只读（Windows Program Files、macOS 签名的 .app），也会被 LiveAgent
  自身的更新覆盖。
- 保留三份：当前 `active`、上一个可用 `lastGood`、安装包自带版本。更旧的已下载版本在切换成功后删除。
- 安装包自带版本被选为 `active` 时，先把它与它的 `release-manifest.json` 复制到 `versions/<版本>/`。安装目录会被
  LiveAgent 自身的更新覆盖，复制后旧的自带版本在 LiveAgent 升级后仍可作为 `lastGood`。为此 `prepare-kbrain.mjs`
  把 manifest 放进安装包（与二进制同目录），其哈希写入 `kbrain.lock.json`；运行时据此得到自带版本的发布版本、
  协议与存储信息。
- `bad` 列表里的版本不再自动安装；用户手动检查时可见但标注"上次启动失败"。

### 7.3 更新流程

1. **检查**：从 `Stack-Cairn/K-brain` 的 releases 中按频道筛选最新版本，跳过 `bad` 中的版本，
   读取其 `release-manifest.json`。`protocol.major` 不在 LiveAgent 支持集合内的版本直接跳过（R4）。
   没有 `release-manifest.json` 的旧发布不参与自动更新。`storage.migration` 为 `breaking` 的版本不进入
   第 2–5 步的自动流程，只在设置里提示，按第 6 节由用户手动确认安装。
2. **下载**：下载本平台的 `k-brain`、`k-brain-computer` 与 `SHA256SUMS` 到临时目录，逐个校验哈希，
   不一致则丢弃并记录。网络沿用 LiveAgent 更新器的代理设置。
3. **冒烟检查**：运行 `k-brain -version`，输出格式为 `k-brain <发布版本>`，去掉 `k-brain ` 前缀后必须等于 manifest
   的版本；不读写数据（兼容约定第 6 节固定了这个格式）。
4. **待切换**：移入 `versions/<版本>/`，`state.json` 写入 `pending`。
5. **切换**：
   - "启动时自动替换"：下次 LiveAgent 启动时使用 `pending`。
   - "下载后提示确认"：提示用户，确认后若没有运行中的任务，立即重启 K-brain；否则等下次启动。
   - "只手动检查"：用户在设置里点"检查更新"后走第 1–4 步，再按"下载后提示确认"切换。
6. **确认可用**：新版本就绪且 `/v1/health` 兼容后，`active = pending`，原 `active` 成为 `lastGood`。

`resolve_binary()` 的选择顺序改为：`LIVEAGENT_KBRAIN_BINARY`（调试） → `pending`（仅在切换时尝试一次）
→ `active` → 安装包自带。

### 7.4 自动回退

"可用"的判定：进程启动成功、在超时内输出就绪信号、`/v1/health` 返回 `status: ok` 且主版本兼容、
`-prepare-storage` 预检（若需要）通过。

| 失败情形 | 处理 |
|---|---|
| 切换到 `pending` 时启动失败或不兼容 | 记入 `bad`，回到 `active`，界面提示"新版本 K-brain 启动失败，已回退到 <版本>" |
| 以退出码 `75` 退出（数据目录被 TUI 等进程占用，破坏性迁移推迟） | 不算失败，不记 `bad`；仍用 `active` 启动，提示用户关闭 `kn` 后重试切换 |
| 以退出码 `76` 退出（存储版本不可读） | 不算失败，不记 `bad`；按下面"读不了当前存储"一行处理 |
| `active` 启动失败（例如文件被安全软件删除） | 依次尝试 `lastGood`、安装包自带版本；成功者成为新的 `active` |
| 启动成功后 2 分钟内连续两次意外退出 | 视同启动失败，按上一行回退 |
| 候选回退版本读不了当前存储（`minReader` 更高） | 不回退到它；提示用户"数据已由更新的 K-brain 升级，请重新下载该版本或升级 LiveAgent"，并提供"重新下载"按钮 |
| 全部候选都失败 | 保持现有的启动失败界面，附上每个版本的失败原因 |

时限：每次启动尝试仍沿用 `STARTUP_TIMEOUT`（15 秒），而前端 `DEFAULT_DESKTOP_BOOTSTRAP_TIMEOUT_MS` 是 20 秒、
`connectKBrainBackendWithRetry` 重试 2 次。整条回退链（`pending` → `active` → `lastGood` → 安装包自带）最多四次尝试，
会超出前端预算。处理方式：

- 回退链在 Rust 的 `kbrain_backend_connection` 内完成，`pending` 只试一次，失败后直接回到已知可用的 `active`，
  常见情况最多两次尝试。
- Rust 在每次尝试开始时发出 `kbrain:startup-progress` 事件（当前尝试的版本、第几次、上一次的失败原因）；
  前端启动页收到事件就重置等待计时并显示"正在回退到 <版本>"，避免在回退进行中先显示启动失败。

崩溃计数：现在没有退出监视，进程死后由下一个调用 `ensure_started` 的地方（Gateway 桥接、生图导出、规划等）
懒重启。阶段四在 `KBrainBackendManager` 里加一个退出监视，把意外退出的时间记到 `state.json`；"2 分钟内两次"按
这里的记录判断，懒重启路径在启动前先检查这个计数。

所有回退都写入 `<数据根>/kbrain/update.log`，设置里可查看。

### 7.5 与锁定版本的关系

`kbrain.lock.json` 继续存在，用来决定安装包自带哪个 K-brain（离线可用、兜底）。
只有 LiveAgent 需要依赖新能力才能发布某个功能时，才需要更新锁定；仅为让用户拿到 K-brain 修复，
不再需要发 LiveAgent。

锁定版本若带 `breaking` 存储迁移（`prepare-kbrain.mjs` 读 manifest 时检查），LiveAgent 的发布说明必须写明，
并且新版 LiveAgent 首次启动这个自带版本前弹出第 6 节的同一确认框（含 PATH 中 `kn` 的版本）；用户拒绝时
保持上一个可用版本（7.2 节复制到 `versions/` 的旧自带版本或已下载版本），相关新功能按能力缺失处理。
如果 `versions/` 里没有任何可用版本（例如全新安装，或升级前从未运行过实现了 7.2 节复制逻辑的 LiveAgent），
拒绝就意味着 K-brain 不可用：显示专门的界面，说明原因，提供"确认并升级数据"与"稍后再说（退出）"两个选项，不做静默降级。这样随安装包到来的破坏性迁移也不会在用户不知情时让 TUI 失效。

## 8. Gateway 与 WebUI（阶段五）

- **协议检查**：按 4.2 节改为只认主版本。远程 K-brain 主版本不兼容时，Gateway 在健康状态里给出明确原因，
  WebUI 显示"远程 K-brain 版本（主版本 N）与当前 Gateway 不兼容"，不再显示笼统的连接错误。
- **能力透传**：Gateway 把远程 K-brain 的能力集放进下发给 WebUI 的连接信息，WebUI 用与桌面端相同的
  `hasCapability` 判断。经桌面端桥接时，由桌面端提供它所连 K-brain 的能力集。
- **两个实例分开处理**：会话走 `-kbrain-url`，生图走 `-image-kbrain-url`，两者可能是不同实例、不同版本。
  Gateway 分别保存两份 health 结果；会话相关能力取前者，`image` 等生图能力取后者（现在 WebUI 的 image 探测已经
  经 Gateway 转发到生图实例，见 `internal/kbrain/images.go`、`internal/handler/image.go`）。
- **部署文档**：新增 `docs/operations/remote-kbrain.md`：
  - 用 K-brain release 产物运行 `kn backend -listen <地址> -data-dir <目录>`，令牌通过
    `K_BRAIN_BACKEND_TOKEN` 传入；
  - 提供 Docker 示例（基础镜像 + 下载并校验 `SHA256SUMS` 的入口脚本）与 docker compose 示例（Gateway + K-brain）；
  - 升级方法：按 `release-manifest.json` 判断主版本与存储迁移类型，`breaking` 时先备份数据目录；
  - 手动回退方法：换回上一版本二进制；数据 `minReader` 更高时不可回退。
- Gateway 自身不做自动下载：远程部署由运维控制版本更合适。

## 9. TUI 不受影响

原则：LiveAgent 的任何更新动作都不能让用户自行安装的 `kn` 失去可用性。

TUI 与 LiveAgent 启动的后端读写同一个 `~/.liveagent`（`kbrain_backend.rs` 以它作为 `-data-dir`），
所以影响 TUI 的途径只有两条：可执行文件与共享数据。对应保证：

| 途径 | 风险 | 保证 |
|---|---|---|
| 可执行文件 | 自动更新覆盖用户的 `kn` | 只写 `~/.liveagent/kbrain/versions/`；不触碰 PATH 中的 `kn`、`install.ps1`/`install.sh` 的安装目录，也不调用 `kn update` |
| 更新状态 | 与 TUI 的 `update.json` 更新提示互相干扰 | LiveAgent 的状态只在 `~/.liveagent/kbrain/state.json`；K-brain（含 TUI）不读写 `kbrain/` 目录 |
| 接口与参数 | 为 LiveAgent 加的东西改变 TUI 行为 | health 字段、`release-manifest.json`、能力表只在后端模式与发布产物中；`kn` 交互模式的参数和行为不变 |
| 共享数据：加法迁移 | 新后端写的数据旧 TUI 读不了 | 兼容约定第 8 节：加法迁移后旧版仍可读写；阶段三用旧版 `kn` 实测 |
| 共享数据：破坏性迁移 | 旧 `kn` 打不开数据 | 不自动安装；安装前确认并显示 PATH 中 `kn` 的版本与匹配版本的安装命令（第 6 节、7.5 节）；旧 `kn` 遇到更高 `minReader` 时拒绝打开而不损坏数据 |
| 共享数据：并发 | TUI 正在运行时后端做迁移 | 兼容约定第 8 节：带锁的 `kn` 靠共享锁/独占锁，不带锁的旧 `kn`（v0.107.6-beta.22 及以前）靠后端的进程检测；两种情况都让破坏性迁移推迟，后端以退出码 75 退出，LiveAgent 继续用 `active` 版本。另外第一个 `breaking` 发布之前，带锁的 K-brain 必须已发布至少一个正式版周期 |
| 回退 | 回退版本改动 TUI 的数据 | 回退只切换 LiveAgent 使用的二进制；`minReader` 检查保证不会用读不了的版本打开数据 |

## 10. 安全

- 下载来源固定为 `Stack-Cairn/K-brain` 的 GitHub releases，不接受页面或配置中的其他地址。
- 每个文件按 `SHA256SUMS` 校验；`SHA256SUMS` 与产物来自同一个 release。暂不做签名。哈希校验只能防止传输损坏和
  部分篡改，不能防止 release 本身被替换。需要时在 `release-manifest.json` 增加签名字段，再要求校验。
- 从用户数据目录执行二进制可能被安全软件拦截；拦截表现为启动失败，由 7.4 的回退兜底，并在提示中说明原因。

## 11. 分阶段实施与验收

每个阶段单独提 PR、单独验收；涉及两仓库的阶段先合 K-brain 再合 LiveAgent。

验收矩阵中的版本记号：

- **LA旧**：本设计实施前的 LiveAgent 正式/预发布版（当前为 v2.0.0-beta.23）
- **LA新**：完成该阶段的 LiveAgent
- **KB旧**：本设计实施前的 K-brain（当前为 v0.107.6-beta.22）
- **KB新**：完成该阶段的 K-brain
- **TUI**：KB新 的 `kn` 交互模式

### 阶段一：兼容协议

| 改动 | 仓库 |
|---|---|
| health 新增 `protocol` / `build` / `storage`（`storage` 先固定为 1/1）；发版新增 `release-manifest.json` 并纳入 `SHA256SUMS`；health 契约、启动契约、旧客户端回放测试；TUI 冒烟测试 | K-brain |
| 桌面端 Rust 与前端健康检查、Gateway 响应与事件检查改为只认主版本；Gateway 新增协议健康检查；契约样例导出脚本 | LiveAgent |

| 组合 | 验收 |
|---|---|
| LA旧 + KB新 | 正常启动、对话、生图、Gateway 远程会话；旧 `version` 字段仍被接受 |
| LA新 + KB旧 | 正常启动；缺 `protocol` 字段时按主版本 1 处理 |
| LA新 + KB新 | 正常；设置里能看到 K-brain 协议主次版本 |
| LA新 + 伪造主版本 2 的 K-brain | 桌面端与 Gateway 都给出"主版本不兼容"的明确错误，不再报笼统的连接失败 |
| TUI | 交互模式启动、对话、退出行为不变 |

### 阶段二：能力表与统一降级

| 改动 | 仓库 |
|---|---|
| 能力登记表（兼容约定 4.2）随 health 契约测试校验 | K-brain |
| `capabilities.ts` 与 `agent-ui` 共用判断；第 5.2 节逐项迁移；补齐 `image_model_toggle`、`computer_session_approval` 的降级 | LiveAgent |

| 组合 | 验收 |
|---|---|
| LA新 + KB旧（去掉若干能力的模拟后端） | 对应功能隐藏或回退旧行为，其他功能不受影响，无报错 |
| LA新 + KB新 | 全部功能可用；能力值升为 2 时仍判定为支持 |
| LA旧 + KB新 | 不受影响 |
| WebUI（经桌面桥接） | 与桌面端行为一致 |
| TUI | 不变 |

### 阶段三：存储版本

| 改动 | 仓库 |
|---|---|
| `kbrain-storage.json` 读写；`minReader` 超出时 TUI 与后端都拒绝打开；数据目录共享锁/独占锁与退出码 75；破坏性迁移前备份；manifest 的 `storage.migration`；`kn update` 支持指定版本与预发布频道 | K-brain |
| 读取存储标记与 manifest，供阶段四的回退保护使用 | LiveAgent |

| 组合 | 验收 |
|---|---|
| KB新 打开没有标记的旧数据 | 视为版本 1，正常使用，写入标记 |
| KB旧 打开 KB新 写过的数据（加法改动） | 正常使用 |
| KB新 遇到 `minReader` 更高的数据 | TUI 与后端都明确拒绝，数据文件不变（哈希一致） |
| LA新 + KB新 | 设置里显示存储版本 |
| TUI | 与后端模式同等受保护 |
| KB新 后端做加法迁移后，用 KB旧 的 `kn` 交互模式打开 | 启动、读写会话、退出正常 |
| 带锁的 KB新 `kn` 运行中，KB新 后端需要破坏性迁移 | 后端以退出码 75 退出，数据文件不变（哈希一致），`kn` 继续正常使用 |
| 不带锁的 KB旧 `kn` 运行中，KB新 后端需要破坏性迁移 | 进程检测发现它，后端以退出码 75 退出，数据文件不变（哈希一致） |
| KB新 交互 TUI 需要破坏性迁移 | 先在终端确认才迁移，迁移前完成备份；`acp`、`run` 等非交互入口拒绝打开并给出提示 |
| 后端遇到 `minReader` 更高的数据 | 以退出码 76 退出，数据文件不变 |

### 阶段四：桌面端自动更新与回退

| 改动 | 仓库 |
|---|---|
| 第 7 节全部内容 | LiveAgent |

| 场景 | 验收 |
|---|---|
| 三种更新方式 | 各自按 7.3 的时机下载与切换；"只手动检查"不会自动下载 |
| 频道 | stable LiveAgent 不会拿到 K-brain 预发布；prerelease LiveAgent 会 |
| 哈希不一致 | 丢弃，不切换，记录原因 |
| 新版本启动失败（用故意损坏的二进制） | 自动回退到 `lastGood`，记入 `bad`，界面提示，不再自动安装该版本 |
| `active` 被删除 | 回退到 `lastGood` 或安装包自带版本 |
| manifest 标记 `breaking` | 三种方式下都不自动下载与安装；手动安装的确认框显示 PATH 中 `kn` 的版本与匹配版本的安装命令 |
| 切换时 `kn` 正在运行且需破坏性迁移 | 不记 `bad`，继续用 `active`，提示关闭 `kn` 后重试 |
| 锁定版本带 `breaking` 的 LiveAgent 安装包 | 首次启动前弹确认；拒绝时保持上一个可用版本 |
| 从未下载过 K-brain、只用安装包自带版本的用户升级 LiveAgent | 旧自带版本已在 `versions/` 中，可作为回退目标；新自带版本带 `breaking` 而用户拒绝时，继续用旧自带版本 |
| 全新安装，自带版本带 `breaking`，用户拒绝 | 显示 7.5 节的专门界面，不静默降级 |
| 后端以退出码 76 退出 | 不记 `bad`，显示"读不了当前存储"提示与下载入口 |
| 主版本不兼容的新发布 | 被跳过 |
| 回退目标读不了当前存储 | 不回退到它，给出提示与重新下载入口 |
| 有运行中的任务时 | 不立即重启 K-brain |
| LA旧 + 本阶段发布的 K-brain | 旧 LiveAgent 不受影响（它没有自动更新，仍用自带版本） |
| TUI | PATH 中的 `kn` 文件哈希与 `kn -version` 不变；更新前后 `kn` 均能启动、读写会话、退出；`update.json` 不被 LiveAgent 改写 |

### 阶段五：Gateway、WebUI 与部署文档

| 改动 | 仓库 |
|---|---|
| Gateway 保存并下发能力集；不兼容时的状态与 WebUI 提示；`docs/operations/remote-kbrain.md` 与 Docker 示例 | LiveAgent |

| 组合 | 验收 |
|---|---|
| Gateway新 + 远程 KB旧 | WebUI 中依赖新能力的功能隐藏，其余正常 |
| Gateway新 + 远程 KB新 | 全部功能可用 |
| Gateway旧 + 远程 KB新 | 旧 Gateway 正常工作 |
| Gateway新 + 远程主版本不兼容的 K-brain | WebUI 显示明确的不兼容提示 |
| 按部署文档从零部署与升级一次 | 文档步骤可完整执行，升级前后数据可用 |
| TUI | 不变 |

## 12. 风险与待定

| 风险 | 应对 |
|---|---|
| K-brain 某次发版违反兼容约定 | 兼容约定的发版检查清单 + K-brain 侧契约测试；LiveAgent 侧自动回退兜底，并把该版本记入 `bad` |
| 自动更新替换的是用户正在使用的后端 | 只在启动时或无运行中任务时切换；回退逻辑与本阶段同时交付并先测 |
| 现有数据没有存储标记 | 缺失按版本 1 处理（兼容约定第 8 节） |
| 自动更新让用户的旧 `kn` 打不开数据 | 破坏性迁移不自动安装、需确认并给出匹配版本的安装命令；TUI 运行时迁移推迟（第 9 节） |
| 预发布频道的 K-brain 质量波动 | 频道跟随 LiveAgent；`bad` 列表避免反复安装同一个坏版本 |
| 安全软件拦截用户目录中的可执行文件 | 由回退兜底并提示原因；后续可考虑签名 |
| GitHub API 限流或网络不可达 | 检查失败只记录，不影响正在使用的版本；沿用 LiveAgent 更新器的代理设置 |
