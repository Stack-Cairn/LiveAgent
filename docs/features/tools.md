# 工具系统

## 工具注册入口

`src/lib/tools/builtinRegistry.ts` 是本地工具系统的组合入口。`buildBuiltinToolRegistry()` 接收 workdir、provider、skills、MCP settings、runtime scope、selected system tools、delegate runtime 等参数，返回：

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
| Shell | `shellTools.ts`、`bashTimeoutPolicy.ts` | Bash/Shell 执行，chat scope 可启用 ManagedProcess。 |
| SkillsManager | `skillTools.ts` | read/list/install/create/validate/package/clawhub_search/clawhub_install。 |
| CronTaskManager | `cronTools.ts` | 创建、读取、更新、删除 cron task，查看日志。 |
| McpManager | `mcpManagerTools.ts` | MCP server CRUD、enable/disable、test/restart/stop、tools/list。 |
| Dynamic MCP tools | `mcpTools.ts` | 将已启用 MCP server 的 tool 暴露为 `mcp_<server>_<tool>`。 |
| Custom system tools | `customSystemTools.ts` | HTTP test 等系统工具，由 Settings 中 selectedSystemTools 控制。 |
| MemoryManager | `memoryTools.ts` | list/read/search/write/update/delete/accept，支持 global/project/daily 语义。 |
| Delegate/Subagent | `delegateTools.ts`、`delegate/*` | 创建委托 Agent、worktree、子代理消息与结果管理。 |

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

## Delegate/Subagent

| 能力 | 说明 |
|---|---|
| delegate tools | 模型可把子任务交给子代理，带独立身份、运行记录和结果。 |
| worktree tools | 可创建隔离 worktree，应用或清理子代理变更。 |
| message tools | 父子代理之间可通过工具传递 Markdown 上下文和消息。 |
| history | subagent identity/run/message 持久化在 Tauri 命令族中。 |

## 工具改造检查表

| 改动 | 必查 |
|---|---|
| 新增 builtin tool | schema、executor、metadata、UI trace details、agent-dev 可观测性。 |
| 新增 Tauri-backed tool | Rust invoke command、前端 invoke 参数、错误消息、权限边界。 |
| 修改 MCP 配置 | GUI/WebUI Settings/MCP Hub 两端、Gateway settings sync redaction。 |
| 修改 Skills 行为 | services/skills.rs、lib/skills 双端复制、Skills Hub installed 状态。 |
| 修改 Memory 行为 | MemoryStore、MemoryManager、Settings Memory 双端、Gateway memory.manage。 |
