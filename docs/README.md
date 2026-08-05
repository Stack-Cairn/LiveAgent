# LiveAgent 架构文档

本文档树用于从当前代码实现出发，系统梳理 LiveAgent 的前端、Rust 后端与 Node 引擎。这里的 `docs/` 定位为全局架构索引；仓库已有的 `doc/` 仍保留为历史方案、专项设计与实验文档，不在本次整理中迁移或改名。

## 项目一句话

LiveAgent 是一个后端持有全部能力、前端只做渲染的 Agent 应用：Rust 后端（`backend` + `backend`）提供唯一的网络入口和全部本地能力，Node 引擎（`core`）跑对话循环，一份前端代码经 HTTP + WebSocket 连上去——不管它跑在 Tauri 桌面壳里还是浏览器里。

## 文档目录

| 文档 | 覆盖范围 | 推荐读者 |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | 三层结构、进程边界、两种运行形态、持久化地图 | 新接手项目者 |
| [architecture/frontend.md](architecture/frontend.md) | 前端模块地图、后端客户端、宿主差异与降级、登录 | 前端与桌面端开发 |
| [architecture/protocols.md](architecture/protocols.md) | JSON over HTTP + WS：端点、认证、事件、Chat 与审批 | 联调与协议改造 |
| [architecture/backend-boundary.md](architecture/backend-boundary.md) | 后端边界的划分依据与命令分类 | 后端开发 |
| [architecture/migration/README.md](architecture/migration/README.md) | 从三语言收敛到两语言的迁移全过程与 19 项决策 | 想知道「为什么是现在这样」 |
| [features/chat-runtime.md](features/chat-runtime.md) | 对话运行时、模型层、流式、压缩、hooks、上传与重发 | Chat 功能开发 |
| [features/tools.md](features/tools.md) | builtin tools、MCP 动态工具、subagent（Agent/SendMessage）、工具执行边界 | 工具系统开发 |
| [features/memory.md](features/memory.md) | MemoryStore、MemoryManager、Settings Memory、自动学习与召回 | 记忆系统开发 |
| [features/skills-and-mcp.md](features/skills-and-mcp.md) | Skills root/builtin/ClawHub 与 MCP Hub/registry/runtime | Skills/MCP 开发 |
| [features/history-compaction.md](features/history-compaction.md) | V3 历史分段、FTS、分享、上下文压缩 checkpoint | 历史与上下文开发 |
| [operations/development.md](operations/development.md) | 本地开发、构建、测试、端口、运行路径 | 日常开发 |
| [operations/deployment.md](operations/deployment.md) | 部署形态、后端镜像与启动参数、CI/CD、桌面 Release | 发布维护 |
| [reference/source-map.md](reference/source-map.md) | 按功能域列出的源码路径索引 | 快速定位源码 |

## 架构阅读顺序

| 顺序 | 目标 | 文档 |
|---:|---|---|
| 1 | 先建立整体进程和边界模型 | [architecture/overview.md](architecture/overview.md) |
| 2 | 理解后端为什么是唯一网络入口 | [architecture/protocols.md](architecture/protocols.md) |
| 3 | 理解一份前端如何同时跑在壳里和浏览器里 | [architecture/frontend.md](architecture/frontend.md) |
| 4 | 理解「为什么是现在这样」 | [architecture/migration/README.md](architecture/migration/README.md) |
| 5 | 按功能域深入 Chat、Tools、Memory、Skills/MCP、History/Compaction | `features/` |
| 6 | 需要动手时查运行命令和源码索引 | [operations/development.md](operations/development.md)、[reference/source-map.md](reference/source-map.md) |

## 当前实现的核心边界

| 边界 | 当前结论 |
|---|---|
| Agent 执行位置 | Node 引擎（`core`）跑对话循环，工具经同一套 HTTP API 打回 Rust 后端执行。两者都在**后端**这一侧 |
| Rust 后端职责 | 唯一对外网络入口、认证与 TLS、fs/shell/git/terminal/sftp/sqlite/cron/mcp/memory/tunnel 的实现、事件广播、Node 引擎守护 |
| 前端职责 | 渲染与交互。前端不在场不阻塞后端主流程；壳专属能力靠运行时探测降级 |
| 设置与密钥 | 真相源是后端的 `~/.liveagent/config.sqlite`。前端不再持有 provider key，脱敏快照那一套随 Gateway 一起消失 |
| 历史 | 后端写 SQLite；引擎与前端都经命令读写同一个库 |
| 文档来源 | 本文档基于当前 checkout 的源码路径、入口文件与运行脚本整理 |

## 与 `doc/` 的关系

| 目录 | 定位 |
|---|---|
| `docs/` | 当前实现的全局架构说明、模块地图、运行说明和源码索引。 |
| `doc/` | 既有专项文档与历史设计资料，例如 memory 方案、Gateway 协议草案、上下文压缩策略等。 |

后续如果某个专项文档已经稳定成为当前实现的一部分，可以在 `docs/` 中建立摘要与导航，但不建议把 `doc/` 直接重命名为 `docs/`，以免丢失历史上下文。
