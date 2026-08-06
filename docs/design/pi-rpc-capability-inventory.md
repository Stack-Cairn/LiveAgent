# pi RPC 迁移 · crates/core 能力去留清单

> 目的：Node core（184 文件 / 约 55,800 行）将被 `pi --mode rpc` 替代。本清单逐项列出每个能力的现状与迁移判定，「决策」栏已全部拍板（2026-08-05）。
> 数据来源：2026-08 逐文件摸底（含 esbuild 可达性分析）。配套文档：[pi-rpc-event-contract.md](./pi-rpc-event-contract.md)。

## 总览

| 类别 | 规模 | 处置 |
|---|---|---|
| A. pi 已有原生对应 | ~25,000 行 | 迁移后直接删 |
| B. pi 无对应的差异化能力 | ~20,000 行 | 逐项决策：Rust 重写(MCP/内置) / 砍掉 |
| C. 部分重叠 | 见 §C | 逐条核对 pi 0.80.x 覆盖度 |
| D. 死代码 + 纯 UI | ~10,000 行 | 直接删，无需决策 |

关键事实：core 本来就构建在 `pi-agent-core`/`pi-ai` 之上（agent loop 是包了 1,858 行业务壳的 pi `Agent`），不是自研引擎。对外仅 4 个 loopback HTTP 端点；反向通过 `callBackend` 调 Rust 约 110 个命令。

---

## A. pi 原生已覆盖 —— 迁移后删除（无需逐项决策）

| 能力 | 现有实现 | pi 对应 |
|---|---|---|
| Agent loop（工具循环/思考档/参数守卫） | `chat/runner/agentRunner.ts` (1,858) + `turns/runAgentConversationTurn.ts` (1,209) | pi agent loop 本体 |
| 上下文压缩 | `chat/compaction/` (14 文件) | pi compaction（含 auto/threshold/overflow） |
| 文件工具 Read/Write/Edit/Glob/Grep/List | `tools/fsTools.ts` (1,976) | pi 内置编码工具 |
| Bash | `tools/shellTools.ts` 的 Bash 部分 | pi 内置（RPC 还有独立 `bash` 命令） |
| TodoWrite / 文件读快照防脏写 | `tools/todoTools.ts`, `tools/fileToolState.ts` | pi 已有 |
| MCP 工具接入（消费侧） | `tools/mcpTools.ts` (326) | pi 原生 MCP |
| Skills 发现/加载 | `skills/index.ts` 主体 | pi 原生 skills |
| 多 provider 流式分发 | `providers/runtime/streamByApi.ts`（本就转发 pi-ai） | pi-ai |
| 会话持久化（基础） | `chat/history/` 基础部分 | pi session 文件（已决策独占 + 圈养 `.liveagent`） |

---

## B. pi 无对应 —— 逐项决策

处置选项说明：**Rust-MCP** = 用 Rust 写成 MCP server 挂给 pi；**Rust-内置** = 逻辑移入 Rust backend（不经过模型工具）；**pi-ext** = 写 pi TS 扩展（违背"不维护 TS"目标，仅在别无他法时选）；**砍** = 放弃该能力。

| # | 能力 | 现有实现 | 行数(活) | 说明 | 建议 | 决策 |
|---|---|---|---|---|---|---|
| B1 | **长期记忆系统**（抽取/gating/注入/MemoryManager 工具） | `memory/`(活代码) + `tools/memoryTools.ts` + `chat/memory/` | ~3,700 | 每轮后隐藏 LLM 抽取轮 + system prompt 注入。存储本就在 Rust MemoryStore，Node 只是编排壳 | Rust-内置（抽取轮由 Rust 独立调 LLM）+ Rust-MCP 暴露 MemoryManager | ✅ Rust 全包：抽取+工具+注入 |
| B2 | **Cron 定时任务** | `automation/backend.ts` + `tools/cronTools.ts` | ~700 | 调度/执行本就在 Rust，Node 只有工具壳和 prompt 类任务的租约协议 | Rust-MCP（工具壳）；prompt 类 cron 由 Rust 直接驱动 pi 进程 | ✅ Rust-MCP |
| B3 | **会话生命周期 Hooks** | `automation/hookRunner.ts` (306) | ~300 | 8 种事件 × command/http；告警事件前端本来就不消费 | Rust-内置（挂在 pi 事件流上触发） | ✅ Rust-内置 |
| B4 | **Subagents：worktree 隔离/消息总线/名册/调度** | `subagents/` 差异化部分 | ~1,500 | pi 有基础 subagent 扩展，但无 worktree apply/cleanup、SendMessage 总线、持久身份名册 | 待定：先验证 pi 原生 subagent 够不够用，不够再谈 | ✅ 全量保留，Rust 重写编排层（Agent/SendMessage 为 MCP 工具，子代理为 Rust 派发的 pi 进程，worktree/总线/名册照搬） |
| B5 | **SSHManager（SSH + 全套 SFTP）** | `tools/sshManagerTools.ts` | 1,119 | 执行在 Rust SSH 服务，Node 是工具壳 | Rust-MCP | ✅ Rust-MCP |
| B6 | **TunnelManager 内网穿透** | `tools/tunnelManagerTools.ts` + `tunnels/` | ~470 | 同上，Rust 执行 | Rust-MCP | ✅ Rust-MCP |
| B7 | **ManagedProcess 长驻进程** | `tools/shellTools.ts` 部分 | ~500 | start/stop/status/read_log | Rust-MCP | ✅ Rust-MCP |
| B8 | **ReadTerminal 读用户终端** | `tools/terminalTools.ts` | 138 | Rust 执行 | Rust-MCP | ✅ Rust-MCP |
| B9 | **AskUserQuestion 结构化提问** | `tools/askUserQuestionTools.ts` + `chat/askUserQuestion.ts` | ~610 | 挂起等前端选择，带超时/默认答案 | Rust-MCP（挂起转前端，复用审批通道） | ✅ Rust-MCP（复用审批通道） |
| B10 | **McpManager（模型自助管理 MCP server）** | `tools/mcpManagerTools.ts` | 994 | pi 能消费 MCP 但没有"模型自己增删改测 MCP 配置"这层 | Rust-MCP 或砍（价值存疑） | ✅ 保留，Rust-MCP |
| B11 | **SkillsManager + ClawHub 市场** | `tools/skillTools.ts` | 755 | skill CRUD/打包/安装；ClawHub 在 Node 里已是死的（hubFetch 存根） | skill CRUD → Rust-MCP；ClawHub → 砍 | ✅ skill CRUD → Rust-MCP；ClawHub 砍 |
| B12 | **Skill 目录访问白名单** | `tools/skillAccessPolicy.ts` | 253 | 只许模型碰本轮选中的 skill 目录 | 依赖 B11 决策；pi 原生 skills 无此策略 | ✅ 保留（⚠ 更正：pi **没有** permission/路径保护系统，security.md 明言 No Built-in Sandbox；路径拦截只能靠 TS 扩展的 `tool_call` block，或由 Rust-MCP 侧自行收口——落地方式待定） |
| B13 | **Settings 配置领域模型** | `settings/` | 4,373 | 类型/默认值/归一化/分片保存/gateway 同步差量合并。已决策"Rust 生成 pi 配置"，则此域必须整体移入 Rust | Rust-内置（无可回避，工作量大头之一） | ✅ 拆分：引擎相关入 Rust，UI 相关入前端 |
| B14 | **工具审批** | `tools/toolApproval.ts` | 126 | 已决策：pi `extension_ui_request` → approval.rs → 前端。会话内免审记忆移到 Rust | Rust-内置（已定） | ✅（⚠ 前提修正：`extension_ui_request` 由扩展的 `tool_call` 处理器发起，不是 pi 内置审批协议——本项需要一个最小 TS 扩展作为挂点，是"零 TS 扩展"的唯一已知例外） |
| B15 | **防休眠 powerActivity** | `system/powerActivity.ts` | 47 | 流式期间防休眠，15min TTL | Rust-内置（几十行的事） | ✅ Rust-内置 |
| B16 | **本地反代头覆盖协议** | `providers/proxy.ts` | 230 | base64 上游头覆盖包，为绕 WebView forbidden headers 而生。pi 进程没有 WebView 限制，可能整个不需要了 | 疑似可砍，需确认调用方 | ❌ 砍（pi 与其他调用方均不走；与"纯 compat 不建反代"自洽） |
| B17 | **CLI 身份版本管理** | `providers/cliIdentityCore.ts` | 202 | claude_code/codex/xai 身份版本 | 待定：取决于 pi 的 provider 配置能力 | ❌ 砍。main 上已于 2026-07-31 删除（PR #351, `0f95b836`）；当前分支的 cliIdentity 全套（core `cliIdentityCore/cliIdentityUpdates/customHeaders` 的 UA 注入、前端 `ProviderIdentityDrawer`/`CliIdentityUpdateHost`）是目录迁移从删除前基底搬来的复活残留，须随迁移清除。pi 原生订阅 OAuth（claude/codex/xai）为替代路径 |
| B18 | **工具启停策略/组策略/Bash 超时策略** | `toolPolicy.ts` + `bashTimeoutPolicy.ts` | ~110 | 按 provider 定超时等 | Rust-内置（生成 pi 配置时施加） | ✅ Rust-内置（生成 pi 配置时施加） |
| B19 | **mode: "text"（纯文本无工具模式）** | `turns/runTextConversationTurn.ts` + `textOnlyRuntime.ts` | ~820 | 前端 chat_send 有 `mode` 字段 | pi 无直接对应；可用"空工具集 + set_model"模拟，或砍 | ❌ 砍掉 text 模式（前端入口同步下线） |

## C. 部分重叠 —— 逐条核对后决策

| # | 能力 | 现有实现 | 说明 | 核对动作 | 决策 |
|---|---|---|---|---|---|
| C1 | **DeepSeek DSML 工具调用修复** | `deepSeekDsmlToolCallStream.ts` (912) + `deepSeekProviderAdapter.ts` (423) | DeepSeek 把工具调用吐成 DSML 文本的流式修复 | 核对 pi 0.80.x 的 openai-compatible 通道对 DeepSeek 的实测表现 | ✅ 纯 compat：依赖 pi 内置 thinkingFormat:"deepseek" 等旗标，不带自研补丁 |
| C2 | **Gemini thought signature / xAI / Codex / Anthropic cache & 长上下文补丁** | `providers/runtime/` 各文件 | 每 provider 的 payload 脏活 | 逐个核对 pi-ai 是否已上游；未上游的要么给 pi 提 PR，要么接受降级 | ✅ 纯 compat，不建反代；实测不覆盖的接受降级或提上游 PR |
| C3 | **provider 原生搜索（hosted search）** | `hostedSearchEvents.ts` (830) + `nativeWebSearch.ts` 等 | 前端对 hosted_search 事件本来就不消费（见事件契约文档§3） | 确认 pi 对原生搜索的透传；UI 无消费者则可大幅简化 | ✅ 随 C2：依赖 pi 透传，UI 无消费者，简化 |
| C4 | **对话历史分段/分支/分享/置顶** | `chat/history/chatHistory.ts` (576) | pi session 有 fork/tree，且**重命名原生已有**（`set_session_name` RPC / `--name` / `session_info_changed` 事件）；无对应的只有"分享/置顶" | 业务元数据（置顶/分享）留 Rust 侧存储，标题走 pi session name，正文归 pi session | ✅ 置顶/分享留 Rust，标题与正文归 pi session（避免标题双写） |
| C5 | **UI 消息投影** | `chat/messages/uiMessages.ts` (1,276) | 工具卡片摘要/diff 统计等纯展示投影 | 依赖事件契约：现有前端只吃 3 个事件，此投影主要服务 `conversation_live` 快照，翻译层按需重写（Rust） | ✅ Rust 翻译层按需重写（服务 conversation_live 快照） |
| C6 | **conversation_live 快照 / 断线恢复** | `liveTranscriptStore.ts` + `gatewayBridgeEvents.ts` | 前端拉了不用（空实现），但接口语义要保 | Rust 翻译层内组装同形快照（已在事件契约文档定为规格） | ✅ |
| C7 | **模型目录/限额/思考档** | `models/` (1,451) | 与"Rust 生成 pi 配置"决策绑定 | 并入 B13 settings 迁移 | ✅ 并入 B13（引擎相关入 Rust） |
| C8 | **子代理并发信号量** | `subagents/scheduler.ts` (135) | 子代理 8 / Agent 调用 8 / Bash 4 | 并入 B4 决策 | ✅ 并入 B4（Rust 编排层实现信号量） |

## D. 直接删除（无需决策）

- **死代码 ~4,600 行**（esbuild 从 index.ts 不可达，184 文件中仅 158 可达）：memory/organizer 整套 (1,993)、skills ClawHub 客户端及卡片 (866)、`chat/messages/` 文件链接/变更统计系 (~560)、`cliIdentityUpdates.ts`、`modelVendor.ts`、`seedLongConversation.ts`、各存根（`hubFetch.ts`、`runtimeEnv.ts`、`turns/automation.ts`）等。
- **纯 UI 模块**：`i18n/` (4,583)、字体族常量、`transcript-width/`、`builtinToolCatalog.ts` —— 引擎不需要（若前端有引用，迁到前端包）。
- **debug/**：所有调用点写死 `enabled: false`。
- **基础设施随迁移消亡**：`index.ts`、`backendClient.ts`、`events.ts`（HTTP 传输层被 stdio JSONL 取代）。

---

## 决策状态

**全部决策已于 2026-08-05 拍板完成**，见各表「决策」栏。要点：

- 差异化能力（memory/subagents/cron/hooks/SSH/tunnel 等）全部保留，落地为 Rust-MCP 工具或 Rust 内置逻辑，**零 pi TS 扩展**。
- provider 补丁走纯 compat 路线：依赖 pi models.json 的 `compat` 旗标（`thinkingFormat`、`cacheControlFormat` 等）+ 自定义 headers；不建本地反代，不覆盖的接受降级或提上游 PR。
- 砍掉：B16 本地反代头覆盖协议、B17 CLI 身份版本管理（main 已删于 PR #351，本分支残留为迁移复活，需清除）、B19 text 模式（前端入口同步下线）、ClawHub 市场。
- pi 能力依据（2026-08-05 对照 pi 0.83.0 本机文档复核）：models.json 支持 per-provider/per-model 的 `baseUrl`/`headers`/`api`/`compat`/`thinkingLevelMap`/`oauth`。**更正**：pi 并非没有 payload 中间件——扩展钩子 `before_provider_headers`/`before_provider_request`/`after_provider_response` 可改头、整体替换 payload、读响应头。"纯 compat"的真实边界是本项目"零 TS 扩展"约束，不是 pi 能力缺口；若 C2 实测出旗标覆盖不了的 payload 补丁，"写一个小扩展"是客观存在的第三选项（目前政策禁用）。
- **"零 pi TS 扩展"有一个已知例外**：B14 审批依赖的 `extension_ui_request` 不是 pi 内置协议，而是扩展调 `ctx.ui.*` 在 RPC 模式下的投影；拦截工具调用的唯一挂点是扩展的 `tool_call` 事件（可 `{block: true}`）。落地 B14/B12 至少需要一个最小 TS 扩展，或改走别的机制。
