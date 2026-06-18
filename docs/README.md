# LiveAgent 架构文档

本文档树用于从当前代码实现出发，系统梳理 LiveAgent 的桌面 GUI、Tauri 后端、Gateway 服务与浏览器 WebUI。这里的 `docs/` 定位为全局架构索引；仓库已有的 `doc/` 仍保留为历史方案、专项设计与实验文档，不在本次整理中迁移或改名。

## 项目一句话

LiveAgent 是一个以桌面端为本地执行核心的 Agent 应用：GUI 负责用户体验与本地工具执行，Tauri/Rust 负责系统能力与持久化，Go Gateway 负责远程连接与协议中继，WebUI 通过 Gateway 操作同一个本地 Agent 会话。

## 文档目录

| 文档 | 覆盖范围 | 推荐读者 |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | 系统总览、进程边界、数据流、持久化地图 | 新接手项目者 |
| [architecture/gui.md](architecture/gui.md) | 桌面 GUI、Tauri commands/services/runtime、设置与本地执行 | 前端与桌面端开发 |
| [architecture/gateway.md](architecture/gateway.md) | Go Gateway 的 HTTP/gRPC/WebSocket、Session Manager、缓冲与认证 | Gateway 开发与排障 |
| [architecture/webui.md](architecture/webui.md) | 浏览器 WebUI、socket 客户端、SharedWorker、状态与安全边界 | WebUI 开发 |
| [architecture/protocols.md](architecture/protocols.md) | GUI 与 Gateway、WebUI 与 Gateway 的协议合同 | 联调与协议改造 |
| [features/chat-runtime.md](features/chat-runtime.md) | 对话运行时、模型层、流式、压缩、hooks、上传与重发 | Chat 功能开发 |
| [features/tools.md](features/tools.md) | builtin tools、MCP 动态工具、delegate/subagent、工具执行边界 | 工具系统开发 |
| [features/memory.md](features/memory.md) | MemoryStore、MemoryManager、Settings Memory、自动学习与召回 | 记忆系统开发 |
| [features/skills-and-mcp.md](features/skills-and-mcp.md) | Skills root/builtin/ClawHub 与 MCP Hub/registry/runtime | Skills/MCP 开发 |
| [features/history-compaction.md](features/history-compaction.md) | V3 历史分段、FTS、分享、上下文压缩 checkpoint | 历史与上下文开发 |
| [operations/development.md](operations/development.md) | 本地开发、构建、测试、端口、运行路径 | 日常开发 |
| [operations/deployment.md](operations/deployment.md) | CI/CD、Gateway Docker、用户自部署、桌面 Release 自动化 | 发布维护 |
| [reference/source-map.md](reference/source-map.md) | 按功能域列出的源码路径索引 | 快速定位源码 |

## 架构阅读顺序

| 顺序 | 目标 | 文档 |
|---:|---|---|
| 1 | 先建立整体进程和边界模型 | [architecture/overview.md](architecture/overview.md) |
| 2 | 理解桌面端为什么是执行真相源 | [architecture/gui.md](architecture/gui.md) |
| 3 | 理解远程访问如何转发到桌面端 | [architecture/gateway.md](architecture/gateway.md)、[architecture/protocols.md](architecture/protocols.md) |
| 4 | 理解 WebUI 的状态机与限制 | [architecture/webui.md](architecture/webui.md) |
| 5 | 按功能域深入 Chat、Tools、Memory、Skills/MCP、History/Compaction | `features/` |
| 6 | 需要动手时查运行命令和源码索引 | [operations/development.md](operations/development.md)、[reference/source-map.md](reference/source-map.md) |

## 当前实现的核心边界

| 边界 | 当前结论 |
|---|---|
| Agent 执行位置 | 桌面 GUI/Tauri 本地执行模型请求、工具调用、文件系统、Shell、MCP、Skills、Memory、Cron prompt。 |
| Gateway 职责 | 认证、连接保持、请求路由、事件广播、可恢复 Chat Event Store、WebUI 静态资源与公网分享页承载。 |
| WebUI 职责 | 浏览器端操作台。它不直接执行工具，也不持有本地文件系统权限，所有高权限能力都经 Gateway 回到桌面端。 |
| 设置同步 | GUI 是真实设置来源；WebUI 存脱敏快照，敏感 key 只允许用户显式输入新值后单向传回 GUI。 |
| 历史同步 | GUI 写 SQLite 历史，Gateway 只转发 history request 与 sync event；WebUI 维护本地可见缓存。 |
| 文档来源 | 本文档基于当前 checkout 的源码路径、入口文件、协议定义与运行脚本整理。 |

## 与 `doc/` 的关系

| 目录 | 定位 |
|---|---|
| `docs/` | 当前实现的全局架构说明、模块地图、运行说明和源码索引。 |
| `doc/` | 既有专项文档与历史设计资料，例如 memory 方案、Gateway 协议草案、上下文压缩策略等。 |

后续如果某个专项文档已经稳定成为当前实现的一部分，可以在 `docs/` 中建立摘要与导航，但不建议把 `doc/` 直接重命名为 `docs/`，以免丢失历史上下文。
