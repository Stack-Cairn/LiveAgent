# LiveAgent 插件系统

## 设计结论

LiveAgent 采用“声明式扩展点 + 本地 Rust 权威管理器 + WASI 默认沙箱 + 显式 Full Trust 兼容层”的混合插件架构。它吸收 DeepSeek Harness（DSH）中包清单、贡献点、依赖解析和生命周期管理的优点，但不复制 DSH 的单宿主执行模型：LiveAgent 的桌面端才是执行真相源，Gateway 只转发受限管理请求，GUI 与 WebUI 共享展示层而使用不同宿主适配器。

| 目标 | LiveAgent 方案 | 原因 |
|---|---|---|
| 默认安全 | `wasi-command`，不预开放目录、环境变量或网络 | 第三方代码不应天然继承桌面进程权限 |
| 生态兼容 | `process` + `process.fullTrust` 显式授权 | 兼容 Node/Python 等插件，同时让风险可见 |
| Agent 集成 | Tool、Prompt Section、observe-only Hook | 覆盖能力、上下文和观测，不允许插件绕过 Agent 策略 |
| 双端一致 | `agent-ui` 共享 Plugin Hub，GUI/WebUI 注入不同 `PluginClient` | 保持一套 UI，不混入 Tauri/Gateway 传输细节 |
| 远程安全 | Gateway 仅支持 list/enable/grant/configure/uninstall | 浏览器不能安装包，也不能执行插件代码 |
| 可重现调用 | package hash、version、generation、contribution provenance | 更新、启停或改授权后拒绝旧快照调用 |
| 配置安全 | v1 只接受非敏感 JSON Schema Settings | 配置会进入 Inventory 并可由 WebUI 管理，秘密值必须等专用 Secret Store API |
| 对话式创建 | 需审批的 `PluginCreate` 生成 Workspace 级声明式 Prompt 插件 | 用户只描述可复用行为，不需要写 Manifest、WASM 或手动安装目录 |

## 从 DeepSeek Harness 学到什么

本方案对 `workspace/deepseek-harness` 当前 `47f943859bef60e4160492346772ded9b24f765a` 做了源码级对照。DSH 实际包含两层插件模型：一层是由 pnpm 安装、Profile/Bundle patch 组合的静态 Cordis 插件树；另一层是 Agent 可动态定义、带 Host/Client 两半与人工批准的 Dynamic Cordis Package。LiveAgent 复用其架构原则，不复制其具体运行时。

| DSH 机制 | 源码结论 | LiveAgent 取舍 |
|---|---|---|
| Context + `inject` | Cordis 以稳定 service key 解耦实现，缺少依赖时 Fiber 等待，而不是手写启动顺序 | Manifest 保留版本化 plugin/capability 依赖；v1 不把整个 LiveAgent 重写成插件内核 |
| Reversible effects | Tool、Prompt、listener 等注册随 Fiber dispose 自动撤销 | 使用每轮不可变 Snapshot 与 generation fencing；启停/更新后下一轮重建贡献点 |
| Stable Plugin / immutable Package / exact Run ID | Dynamic Cordis 把稳定插件、不可变版本和激活尝试分离，并拒绝 stale run 调用 | 使用稳定 plugin id、内容寻址 package hash、SemVer 和单调 generation，Tool/Hook 都校验来源 |
| Authoritative Inventory | DSH 的 Inventory 每次直接读取 Loader/Fiber，不维护第二份生命周期缓存 | SQLite + 当前依赖/授权解析是唯一权威；Gateway/WebUI 不保存第二份插件状态 |
| Guarded data boundary | Dynamic runner 对 schema、plain JSON、Content Block 和跨 realm 对象做严格归一化 | Rust 安装时编译 Draft 2020-12 schema，调用时校验输入/输出，只接受 text Content Block |
| Node `vm` sandbox | 禁止 `require`/timer/`fetch` 并引导走 service，但源码注明异步 body 可逃逸同步 `vm` timeout | 默认改用 Wasmtime/WASI，执行 fuel、epoch timeout、内存/Table/IO 限制；Node/Python 只走显式 Full Trust |
| Host/Client dynamic code | DSH 可把批准后的 Client half 下发浏览器执行，并以 run id 做过期保护 | v1 明确不向 WebUI 下发或执行插件代码；浏览器只调用受限管理面 |
| Typed event modes | DSH 区分 emit/waterfall/parallel/serial，部分 Hook 可拦截或重写请求 | v1 只开放有序、非阻断的 observe-only Hook；可修改 Agent 决策的 middleware 暂不开放 |
| Profile package manager | `dsh plugin` 直接把 pnpm 作为安装器，并根据 `dsh.bundle` 重建层次 | LiveAgent 使用 `.lap`/ZIP/目录、staging、完整性清单和内容寻址 Store，不在桌面产品中嵌入 npm 供应链 |

最重要的差异是信任边界。DSH 的 Cordis 是应用内部框架，很多静态插件与核心进程处于同一 TypeScript 信任域；LiveAgent 是带本地文件、终端、凭据和远程 WebUI 的 Tauri 桌面应用，因此插件系统必须保留一个不可插件化的 Rust 权威内核。插件可以贡献能力，但不能替换安装器、权限判定、Gateway 白名单、Agent Tool 审批或执行沙箱。

### 暂不照搬的能力

| 能力 | v1 决策 | 后续开放条件 |
|---|---|---|
| 浏览器 Client 插件代码 | 不支持 | 需要 CSP/模块签名、独立 realm、DOM/网络 capability broker 与跨页 run fencing |
| 可修改/阻断 Agent 的 Hook | 不支持 | 需要明确 event mode、优先级、超时、冲突合并、审计与失败策略 |
| 插件间可调用 Service | 暂不支持；Capability 仅为版本化依赖令牌 | 需要 typed ABI、provider 选择、调用授权、取消、流控与稳定性承诺 |
| Secret Settings | 不支持并在安装时拒绝 Secret schema | 需要 Desktop Secret Store、opaque handle、按插件授权与永不下发 WebUI 的 redaction contract |
| Marketplace 自动更新 | 不支持 | 需要发布者签名、可轮换 Trust Store、透明日志、回滚与供应链治理 |

## 进程与数据流

```text
.lap / 插件目录
  -> staging 校验（路径、符号链接、大小、integrity）
  -> ~/.liveagent/plugins/store/<sha256>/
  -> plugins.sqlite3（安装、作用域、配置、授权、审计）
  -> PluginTurnSnapshot
       -> Tool Registry -> allow/ask/deny -> WASI/Full Trust runtime
       -> Prompt builder -> provenance 标签 -> system prompt
       -> observe Hook dispatcher -> 生命周期审计

WebUI -> protobuf PluginManage -> Go 白名单 -> Desktop PluginManager
      （Gateway 不保存插件包，也不运行插件）
```

## 代码地图

| 层 | 路径 | 职责 |
|---|---|---|
| Rust manager | `crates/agent-gui/src-tauri/src/services/plugins/` | Manifest、安装、SQLite、依赖、权限、运行时、Snapshot、审计 |
| Tauri commands | `crates/agent-gui/src-tauri/src/commands/integration/plugins.rs` | GUI 管理与 Agent 调用入口 |
| Agent adapter | `crates/agent-gui/src/lib/tools/pluginTools.ts` | 动态 Tool Bundle、Prompt provenance、Hook dispatch |
| Conversation builder | `crates/agent-gui/src/lib/tools/pluginManagerTools.ts` | 将明确的用户创建意图映射为受审批的 `PluginCreate` |
| Shared contract | `crates/agent-ui/src/lib/plugins/types.ts` | Inventory、Contribution、Client 合同 |
| Shared UI | `crates/agent-ui/src/pages/plugin-hub/PluginHubPage.tsx` | 安装、授权、启停、配置、卸载 |
| Gateway protocol | `crates/agent-gateway/proto/v2/gateway.proto` | 受限 `PluginManage` request/response |
| WebUI adapter | `crates/agent-gateway/web/src/lib/plugins/client.ts` | 将共享 `PluginClient` 映射到 Gateway RPC |
| Manifest Schema | `docs/reference/plugin-manifest.schema.json` | 插件清单的机器可读 v1 规范 |

## 插件包

插件可以是目录、`.lap` 或 `.zip`。`.lap` 是 ZIP 容器，根目录必须直接包含 `manifest.json`。

```text
example-plugin/
├── manifest.json
├── integrity.json
├── runtime/
│   └── plugin.wasm
└── prompts/
    └── context.md
```

安装器执行以下检查：

| 检查 | 限制 |
|---|---|
| 解压后总大小 | 128 MiB |
| 单文件大小 | 32 MiB |
| 文件数量 | 4096 |
| Manifest | 1 MiB，SemVer、引擎范围、贡献点与权限交叉校验 |
| Prompt source | 512 KiB，必须位于包内 |
| 路径 | 禁止绝对路径、`..`、符号链接、大小写冲突与重复项 |
| 完整性 | `integrity.json` 必须逐文件 SHA-256 精确覆盖包内容 |

`integrity.json` 示例：

```json
{
  "algorithm": "sha256",
  "files": {
    "manifest.json": "<hex sha256>",
    "runtime/plugin.wasm": "<hex sha256>",
    "prompts/context.md": "<hex sha256>"
  }
}
```

完整性清单只能证明“安装内容与清单一致”，不能证明发布者身份。当前本地插件 v1 没有 Marketplace 信任根；无 `integrity.json` 的开发包必须显式选择 `allowUnsigned`。未来接入插件市场时，应在现有 package hash 之上增加发布者签名和可轮换 Trust Store，而不是改变运行协议。

为避免把未验证元数据误展示成发布者身份，v1 会拒绝 `publisher.keyId`；只有 Marketplace Trust Store 和签名校验真正落地后才开放该字段。

## Manifest

最小 WASI 插件示例：

```json
{
  "$schema": "../../docs/reference/plugin-manifest.schema.json",
  "schemaVersion": 1,
  "id": "com.example.workspace-insight",
  "name": "Workspace Insight",
  "version": "1.0.0",
  "publisher": { "id": "example", "name": "Example" },
  "engines": { "liveagent": ">=1.3.0", "pluginApi": "^1.0.0" },
  "runtime": {
    "kind": "wasi-command",
    "entry": "runtime/plugin.wasm",
    "scope": "workspace",
    "timeoutMs": 30000,
    "fuel": 50000000
  },
  "permissions": [
    { "id": "agent.tools.register" },
    { "id": "agent.promptSections.contribute" },
    { "id": "agent.hooks.observe" }
  ],
  "contributes": {
    "tools": [
      {
        "id": "workspace-insight",
        "modelName": "workspace_insight",
        "description": "Summarize supplied workspace notes",
        "inputSchema": { "type": "object" },
        "handler": "workspace_insight",
        "readOnly": true
      }
    ],
    "promptSections": [
      {
        "id": "workspace-guidance",
        "source": "prompts/context.md",
        "position": "agent-context",
        "maxTokens": 800
      }
    ],
    "hooks": [
      {
        "id": "turn-observer",
        "event": "turn_start",
        "observeOnly": true,
        "handler": "turn_observer",
        "timeoutMs": 2000
      }
    ],
    "settings": [
      {
        "id": "general",
        "schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "prefix": { "type": "string", "title": "Output prefix" },
            "includeStats": { "type": "boolean", "title": "Include statistics" }
          }
        }
      }
    ]
  }
}
```

## 权限与审批

| Contribution / Runtime | 必需权限 | 运行规则 |
|---|---|---|
| `tools` | `agent.tools.register` | 注册进现有 Tool Registry；插件工具默认 `ask`，显式策略可改为 `allow/deny` |
| `promptSections` | `agent.promptSections.contribute` | 注入内容带 plugin/version/contribution 标签；未声明时单 section 正文默认 2000 token units，所有插件连同 provenance 包装合计最多 16000 |
| `hooks` | `agent.hooks.observe` | v1 只允许 `observeOnly=true`，不能修改事件或阻断 Agent |
| `process` | `process.fullTrust` | 安装和授权都必须显式确认；继承本地用户进程权限 |

Manifest 申请权限不代表已经获得权限。插件只有在启用、依赖满足、全部申请权限已授予且无故障时才进入 `active`。启停、更新、配置和授权都会推进 `generation`；Agent turn 快照携带旧 generation 的调用会被拒绝。

Plugin API v1 只开放表中四个权限 id。`paths`、`origins`、`keys` 是为后续 Capability Broker 预留的字段，v1 必须为空；安装器会拒绝未知权限或非空限定符，避免插件误以为宿主已经执行了文件、网络或密钥边界。

Prompt Section 的 `position` 只接受 `system-leading`、`workspace-context`、`agent-context`、`system-trailing` 四个取值，未声明时按 `agent-context` 处理。该词表同时决定注入顺序，安装期即拒绝表外取值——否则 Manifest 可以写下一个宿主根本不认识、最终静默落回默认档位的字符串。同一档位内按 plugin id、contribution id 稳定排序。

Settings schema 使用 Draft 2020-12，并在安装时编译、保存时完整验证。由于配置会随 Inventory 返回桌面 GUI，并可经 Gateway 到达 WebUI，v1 明确不支持秘密配置；包含 `writeOnly: true`、`format: "password"` 或 `x-liveagent-secret: true` 的 Settings schema 会在安装时被拒绝。不要把 API key、token 或密码放进插件 Settings。

`runtime.scope` 控制启停和配置的作用域，不代表常驻实例生命周期：

| Scope | 启停与配置 | 调用中的 `workspace` |
|---|---|---|
| `workspace` | 使用当前 Workspace 覆盖；没有覆盖时回退到全局默认 | 始终传入实际绝对 Workspace 路径 |
| `application` | 忽略 Workspace 参数，统一读写全局状态与配置 | 仍传入发起调用的实际 Workspace 路径 |

## Runtime 协议

WASI 和 Full Trust process 使用同一 JSON Lines 协议：每次调用启动一个命令，stdin 输入一个 JSON 对象，stdout 输出一个 JSON 对象。

请求：

```json
{
  "protocolVersion": 1,
  "pluginId": "com.example.workspace-insight",
  "pluginVersion": "1.0.0",
  "packageHash": "<sha256>",
  "generation": 3,
  "contributionId": "workspace-insight",
  "handler": "workspace_insight",
  "arguments": {},
  "workspace": "/absolute/workspace/path",
  "config": {}
}
```

响应：

```json
{
  "content": [{ "type": "text", "text": "result" }],
  "details": { "items": 3 },
  "isError": false
}
```

| Runtime | 隔离与限制 |
|---|---|
| `wasi-command` | WASI Preview 1 command；无预开放目录、环境变量或 socket；2 MiB 输入/输出；256 KiB stderr；64 MiB 线性内存、Table/实例数量、fuel 与 epoch timeout 限制 |
| `process` | 每次调用启动子进程；包目录为 cwd；超时杀进程树；同样限制 stdin/stdout/stderr；属于 Full Trust |
| `declarative` | 只允许 Prompt/Settings，不允许 Tool 或 Hook，没有可执行 runtime |

## 依赖与生命周期

插件可在 `requires.plugins` 中声明插件 SemVer 依赖，在 `requires.capabilities` 中声明能力依赖，并通过 `provides.capabilities` 提供能力。解析器只把已启用、已授权且自身依赖可用的插件视为 Capability 提供者，并检查缺失、禁用、版本不兼容和依赖环。v1 Capability 是用于装配顺序和兼容性判断的版本化依赖令牌，不是插件间 RPC；可调用 Service Broker 属于后续 API 版本。

每个 Agent run 只在开始时生成一次 `PluginTurnSnapshot`。Tool、Prompt Section 和 observe Hook 都携带同一份 plugin version、package hash 与 generation；Hook 调度不会重新扫描实时 Manifest。插件若在 run 中途更新、改授权或切换启停，旧 Tool/Hook 调用会被 fencing 拒绝，下一个 run 才看到新贡献点。

| Phase | 含义 |
|---|---|
| `installed` | 已安装但尚未完成作用域决策 |
| `disabled` | 当前全局或 Workspace 作用域未启用 |
| `blocked` | 缺权限、配置未满足 schema、依赖/Capability 不可用或存在依赖环 |
| `active` | 可贡献 Tool/Prompt/Hook |
| `failed` | Runtime/Hook 最近执行失败；重新授权、启停或成功 Tool 调用可恢复 |

## GUI 与 WebUI

| 能力 | Desktop GUI | Gateway WebUI |
|---|---:|---:|
| Inventory | 支持 | 支持，经 Desktop relay |
| 安装目录/`.lap` | 支持 | 禁止 |
| 启停、授权、配置、卸载 | 支持 | 支持，经受限 `PluginManage` 白名单 |
| 执行插件代码 | Desktop Agent turn 内执行 | 不执行 |
| 保存插件包/数据库 | `~/.liveagent/plugins` | 不保存 |

WebUI 的 protobuf 白名单只接受 `list`、`set_enabled`、`set_grants`、`update_config` 和 `uninstall`，请求与响应载荷均最大 1 MiB。Go Gateway 不解析插件 Manifest，不建立第二份插件状态，也不接受 `install` 或 `invoke`。

当前管理协议使用 protobuf envelope 中的 `action + payload_json`，但 action 在 Go guard 与 Desktop Rust handler 两层均采用固定白名单，且两层都限制 1 MiB。它只承载低频管理面，不承载插件执行或秘密值；若未来开放更复杂的市场、Secret Store 或流式调用，再升级为 typed `oneof`，不在 v1 提前扩大攻击面。

## 对话式创建简单插件

用户可以直接在普通聊天中提出“把这套规则保存成插件”“创建一个以后都遵守某规范的插件”等请求。顶层 Chat Agent 会调用内置 `PluginCreate`；该工具默认策略为 `ask`，因此真正写入 Inventory 前仍显示一次工具审批。批准后 Desktop Rust 权威内核完成以下操作：

1. 将 slug 固定映射为 `com.liveagent.conversation.<slug>`，不能覆盖其他发布者或可执行插件。
2. 生成 Workspace scope 的 `declarative` Manifest，只包含一个 Prompt Section。
3. 拒绝 WASM、process、Tool、Hook、Settings、Secret、路径、网络和上下文包装标签。
4. 生成精确的 SHA-256 `integrity.json`，经标准 staging/Store 安装链再次校验。
5. 只授予 `agent.promptSections.contribute`，并在当前 Workspace 启用。
6. 返回 Plugin ID、版本、phase 和“下一条用户消息生效”的提示。

当前 Agent run 的 `PluginTurnSnapshot` 不会被中途修改，所以新插件不会反向改变创建它的那一轮；下一条用户消息开始注入新 Prompt。这同时避免模型在创建后立刻依赖尚未进入快照的能力。

实际通过预算并注入 system prompt 的 Prompt Section 会作为 `liveAgentPluginContext` provenance 写入本轮首个 assistant message，并同步到 Desktop 与 WebUI transcript。回复顶部显示“本轮已注入插件提示”，包含插件 ID、版本以及可展开查看的 snapshot revision、generation、package hash 和 contribution ID；脱敏分享视图不显示该标识。该证据证明宿主完成了注入，但不把概率性的模型遵循行为误报成确定执行。

示例对话：

```text
用户：创建一个 commit-style 插件，以后在这个 Workspace 生成 Git commit message 时必须使用 Conventional Commits，标题不超过 72 个字符，并先说明变更范围。

Agent：调用 PluginCreate（界面显示工具审批）

用户：批准

Agent：com.liveagent.conversation.commit-style 已安装并启用；从下一条用户消息开始生效。
```

`PluginCreate` 适合长期复用的模型行为、写作规范、审查清单与项目约束，不适合一次性指令。需要自定义 Tool、Hook、WASI 或 Full Trust process 时，仍使用常规插件包和 Plugin Hub 审查流程。

## 开发与验收

```bash
# 生成 protobuf
make proto

# Rust 内核
cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --lib
cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml services::plugins

# GUI / WebUI 类型检查
pnpm --filter liveagent exec tsc --noEmit
pnpm --filter @liveagent/gateway-webui exec tsc --noEmit

# 使用隔离 Store 验收一个外部 Demo
LIVEAGENT_PLUGIN_ROOT=/absolute/temp/plugin-root \
LIVEAGENT_PLUGIN_DEMO_PATH=/absolute/demo/plugin \
LIVEAGENT_PLUGIN_DEMO_WORKSPACE=/absolute/workspace \
cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml \
  validates_external_plugin_demo_end_to_end -- --ignored --nocapture
```

生产运行不设置 `LIVEAGENT_PLUGIN_ROOT`，默认使用 `~/.liveagent/plugins`。该覆盖变量只用于隔离测试和开发验收，并且必须是绝对路径。
