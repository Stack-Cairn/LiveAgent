# 工具系统

## 工具注册入口

`src/lib/tools/builtinRegistry.ts` 是本地工具系统的组合入口。`buildBuiltinToolRegistry()` 接收 workdir、provider、skills、MCP settings、runtime scope、selected system tools、subagent runtime（`SubagentRuntimeConfig`）等参数，返回：

| 字段 | 说明 |
|---|---|
| `tools` | 暴露给模型的 tool schema 列表。 |
| `executeToolCall` | 根据 tool name 分派到具体 executor。 |
| `metadataByName` | UI 和 trace 使用的工具元数据。 |
| `hasTool` | 判断工具是否可用。 |

## Builtin Tool Bundle

| Bundle | 主要路径 | 工具/能力 |
|---|---|---|
| File system | `fsTools.ts`、`fileToolState.ts` | Read/List/Glob/Grep/Write/Edit/Delete/Image 等文件能力，受 workdir 与 skills root 策略约束。 |
| Edit 容错匹配 | Rust `commands/workspace/edit_match.rs` | Edit 的 `old_string` 定位按严格度递减依次尝试：精确匹配 → CRLF/LF 行尾归一（含 BOM 容错，替换按文件主导行尾风格重渲染）→ 整行行尾空白容错 → 整行统一缩进偏移（替换文本按文件真实缩进重排）。首个命中的 pass 生效，命中非精确 pass 时结果返回 `matchStrategy` 提示模型。注意：行级 pass（行尾空白 / 缩进偏移）用 `new_string` 整体重写命中的整行窗口，窗口内上下文行原有的行尾空白会随之被规范化掉。 |
| Shell | `shellTools.ts`、`bashTimeoutPolicy.ts` | Bash/Shell 执行，chat scope 可启用 ManagedProcess。 |
| SkillsManager | `skillTools.ts` | read/list/install/create/validate/package/clawhub_search/clawhub_install。 |
| CronTaskManager | `cronTools.ts` | 创建、读取、更新、删除 cron task，查看日志。 |
| McpManager | `mcpManagerTools.ts` | MCP server CRUD、enable/disable、test/restart/stop、tools/list。 |
| Dynamic MCP tools | `mcpTools.ts` | 将已启用 MCP server 的 tool 暴露为 `mcp_<server>_<tool>`。 |
| Custom system tools | `customSystemTools.ts` | HTTP test 等系统工具，由 Settings 中 selectedSystemTools 控制。 |
| MemoryManager | `memoryTools.ts` | list/read/search/write/update/delete/accept，支持 global/project/daily 语义。 |
| TodoWrite | `todoTools.ts` | 会话内任务清单全量替换写入，仅 `runtimeScope=chat` 可用；状态存于内存（按 conversationId），不落盘、不进子代理注册表。 |
| Subagent | `src/lib/subagents/*`（适配层 `agentTool.ts`、`sendMessageTool.ts`） | `Agent`/`SendMessage` 内置工具：委托持久化子代理、隔离 worktree、Message Bus。 |

## 执行边界

| 端 | 是否执行工具 | 说明 |
|---|---|---|
| GUI 本地 Chat | 是 | 工具在桌面端运行，直接调用 Tauri invoke 或前端本地逻辑。 |
| WebUI Chat | 间接执行 | WebUI 发 Chat Command 到 Gateway，实际工具仍在桌面 GUI/Tauri 运行。 |
| Gateway | 否 | Gateway 不执行业务工具，只转发 request/event 并维护 buffer。 |

## MCP 动态工具

| 阶段 | 说明 |
|---|---|
| 配置 | Settings/MCP Hub 维护 server 列表、transport、command/url/env/headers 等。 |
| 加载 | `createMcpTools()` 过滤 enabled server，调用 Tauri `mcp_list_tools`。 |
| 命名 | 动态工具名规范化为 `mcp_<server>_<tool>`，过长时截断并加 hash suffix。 |
| 调用 | 模型调用动态工具后，前端 executor 调用 Tauri `mcp_call_tool`。 |
| 诊断 | `McpManager` 可做 runtime_status/test/restart/stop/tools/list。 |

## Skills 工具边界

| 能力 | 说明 |
|---|---|
| 固定 root | Skills runtime root 是 `~/.liveagent/skills`。 |
| always-on | `skills-creator`、`skills-installer` 是 builtin always enabled skills。 |
| 文件访问 | 已启用 skill 内部文件可通过 FS tools 的 `root="skills"` 相对路径访问。 |
| 管理操作 | 创建、安装、ClawHub 安装、validate、package 应通过 `SkillsManager`。 |
| 访问策略 | `SkillAccessPolicy` 控制模型能否访问/修改 skills root。 |

## Memory 工具边界

| 操作 | 说明 |
|---|---|
| read/list/search | 可用于模型按需召回完整记忆。 |
| write/update/delete/accept | 修改 Markdown 事实源和 SQLite index，受 scope/type 校验。 |
| daily append | daily 类型通过 append 模式维护日记型记忆，不计入 ordinary quota。 |
| silent extraction | 隐式记忆提取阶段不直接让模型调用 mutation，而是解析 plan 后由 LiveAgent 应用。 |

## Subagent（Agent / SendMessage）

子代理域整体位于 `src/lib/subagents/`，按严格分层组织：

| 层 | 文件 | 职责 |
|---|---|---|
| L1 纯领域 | `types.ts`、`protocol.ts`、`errors.ts`、`validate.ts`、`policy.ts`、`prompts.ts`、`bus.ts`、`roster.ts`、`utils.ts` | 类型与常量、UI wire protocol、结构化错误、批量校验、readonly/worktree 工具选择与 apply/cleanup 决策、system prompt 构造、Message Bus 渲染、roster/template 汇总。无 IPC、无副作用。 |
| L2 ipc | `ipc/store.ts`、`ipc/worktree.ts` | 持久化与 worktree 的 Tauri invoke 端口（`subagent_*` 命令），null→absent 归一，同一 run 的写入串行化；测试可注入替身。 |
| L3 runtime | `scheduler.ts`、`store.ts`、`run.ts` | `SubagentScheduler` 信号量并发调度；`SubagentConversationStore` 是会话级唯一真源（roster、latest run、hydrated 私有上下文 LRU、Message Bus）；`run.ts` 是单次 run 状态机（worktree 创建 → tool loop → apply/cleanup → 持久化）。 |
| L4 工具适配 | `agentTool.ts`、`sendMessageTool.ts`、`cards.ts`、`index.ts` | 生成 `Agent`/`SendMessage` 的 tool schema 与 executor、per-agent 卡片 tool call/result、对外导出面。 |

`Agent` 工具语义：

| 能力 | 说明 |
|---|---|
| 结构化参数 | `agents` 数组（每项 `id/prompt/name/role/identity/template/mode/apply_policy/allowed_output_paths/resume/retain_worktree`）+ 顶层 `concurrency`，单次最多 8 个 agent 并行。 |
| 稳定 id 与复用 | 同一会话内复用 id 即恢复该子代理的私有上下文；`name/role/identity/template` 只在 id 首次创建时生效，对既有 id 传入不同值会被拒绝。`resume=false` 为同一 id 开启全新私有上下文。 |
| mode | `readonly`（新 agent 默认，只读工具）用于调研/评审；`worktree` 在隔离 git worktree 内提供文件+shell 工具。resume 的 agent 默认沿用上次 mode。 |
| apply_policy | `none`（默认，不回灌）/`auto`（自动 apply patch）/`explicit`（仅当所有变更文件命中 `allowed_output_paths` 才 apply；路径必须解析进 workspace）。`retain_worktree=true` 保留可安全清理的 worktree 供复查。 |
| 原子校验 | 校验失败时不启动任何 agent，返回结构化错误并附上当前 roster 与已启用模板列表；`AgentPromptTemplate.enabled` 生效，`template` 只能引用已启用模板（按 id 或 name 解析）。 |
| SendMessage | `to=parent`（父私有）/`to=*`（共享广播）/`to=<agent id>`（直达），收件人按 roster 校验，未知收件人直接拒绝；channel 为 direct/shared/decision/question，消息在下一轮 turn 边界投递。 |
| 持久化 | run 在每个 turn 边界通过 `subagent_run_save` 增量落盘，中断的 run 可从最后完成的 round 恢复；run status 含 `cancelled`。identity/run/message/worktree 各有 Tauri 命令族（见 architecture/gui.md）。 |
| UI 协议 | details kind 为 `subagent_batch`/`subagent_card`/`subagent_message`；per-agent 卡片以 `subagent_card: true` 标记的合成 tool call 渲染，被拒绝的 Agent 调用也会可见渲染；`lib/subagents/protocol.ts` 在 GUI/WebUI 间逐字节镜像（scripts/mirror-manifest.json）。 |

## 工具改造检查表

| 改动 | 必查 |
|---|---|
| 新增 builtin tool | schema、executor、metadata、UI trace details、agent-dev 可观测性。 |
| 新增 Tauri-backed tool | Rust invoke command、前端 invoke 参数、错误消息、权限边界。 |
| 修改 MCP 配置 | GUI/WebUI Settings/MCP Hub 两端、Gateway settings sync redaction。工具侧写入必须走 `settings/mcpOps.ts` 的 `McpSettingsOp` id 级合并（`applyMcpOps`），禁止全量替换 `settings.mcp`；读取必须走 `getMcpSettings` 实时 getter（权威 `settingsRef`），禁止 turn 级快照；读改写决策与提交必须在同一同步段内（await 之后重读）。 |
| 修改 Skills 行为 | services/skills/*、lib/skills 双端复制、Skills Hub installed 状态。所有对 skills 根目录活动目标的落盘必须持 `skills_write_guard()`，安装走 stage-then-swap（`<root>/.staging` 构建 + `fs::rename` 原子入位），禁止直接向活动目录逐文件写。 |
| 修改 Memory 行为 | MemoryStore、MemoryManager、Settings Memory 双端、Gateway memory.manage。 |
