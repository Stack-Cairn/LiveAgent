# LiveAgent 架构文档

本文档树用于从当前代码实现出发，系统梳理 LiveAgent 的桌面 GUI、Tauri 后端、Gateway 服务与浏览器 WebUI。这里的 `docs/` 定位为全局架构索引；仓库已有的 `doc/` 仍保留为历史方案、专项设计与实验文档，不在本次整理中迁移或改名。

## 项目一句话

LiveAgent 是 K-brain 的桌面和 Web 交互端：模型请求、Agent、工具、审批、会话和后端资源由 K-brain 执行与持久化；Tauri/Rust 提供原生窗口、文件选择、终端、SSH 等宿主能力，Go Gateway 负责认证、连接和类型化协议中继。当前边界以 [架构总览](architecture/overview.md) 为准，功能迁移范围以 [2026-10-24 验收记录](testing/2026-10-24-full-capability-audit.md) 为准。

## 文档目录

| 文档 | 覆盖范围 | 推荐读者 |
|---|---|---|
| [architecture/overview.md](architecture/overview.md) | 系统总览、进程边界、数据流、持久化地图 | 新接手项目者 |
| [architecture/gui.md](architecture/gui.md) | 桌面 GUI、Tauri commands/services/runtime、设置与本地执行 | 前端与桌面端开发 |
| [architecture/gateway.md](architecture/gateway.md) | Go Gateway 的 HTTP/WebSocket（v2）、Session Manager、缓冲与认证 | Gateway 开发与排障 |
| [architecture/webui.md](architecture/webui.md) | 浏览器 WebUI、socket 客户端、会话流订阅、状态与安全边界 | WebUI 开发 |
| [architecture/protocols.md](architecture/protocols.md) | GUI 与 Gateway、WebUI 与 Gateway 的协议合同 | 联调与协议改造 |
| [features/chat-runtime.md](features/chat-runtime.md) | 对话运行时、模型层、流式、压缩、hooks、上传与重发 | Chat 功能开发 |
| [features/workspace-groups.md](features/workspace-groups.md) | 工作空间分组创建流程、共享侧栏实现与界面预览 | 前端开发与使用者 |
| [features/tools.md](features/tools.md) | builtin tools、MCP 动态工具、subagent（Agent/SendMessage）、工具执行边界 | 工具系统开发 |
| [features/memory.md](features/memory.md) | MemoryStore、MemoryManager、Settings Memory、自动学习与召回 | 记忆系统开发 |
| [features/skills-and-mcp.md](features/skills-and-mcp.md) | Skills root/builtin/ClawHub 与 MCP Hub/registry/runtime | Skills/MCP 开发 |
| [features/history-compaction.md](features/history-compaction.md) | V3 历史分段、FTS、分享、上下文压缩 checkpoint | 历史与上下文开发 |
| [features/config-backup-sync.md](features/config-backup-sync.md) | 配置快照、本地导入导出、WebDAV 同步与自动上传 | 设置与同步开发 |
| [design/workbench-project-tool-panes.md](design/workbench-project-tool-panes.md) | 审查 / 内网穿透 / SSH / 后台任务脱离 Right Dock 成为可拖拽拼接的 Workbench Pane（桌面端与 Web 端共用实现） | Workbench 与项目工具开发 |
| [design/planning-calendar.md](design/planning-calendar.md) | 日历管理、Todo 排期、提醒/Agent 闭环与后续扩展的产品设计 | Planning 产品与开发 |
| [design/planning-calendar-implementation.md](design/planning-calendar-implementation.md) | Planning 主线迁移、实现范围、验证结果与限制 | Planning 开发 |
| [design/planning-google-benchmark.md](design/planning-google-benchmark.md) | Google Calendar / Tasks 实测数据与 Planning 对标映射 | Planning 前端开发 |
| [design/planning-design-alignment.md](design/planning-design-alignment.md) | 最新 main 前端设计规范分析与 Planning 对齐方式 | Planning 与共享 UI 开发 |
| [design/proma-planning-reproduction.md](design/proma-planning-reproduction.md) | Proma 日程、Todo、提醒与自动化的源码分析及 LiveAgent 能力对照 | Planning 调研与开发 |
| [operations/development.md](operations/development.md) | 本地开发、构建、测试、端口、运行路径 | 日常开发 |
| [operations/deployment.md](operations/deployment.md) | CI/CD、Gateway Docker、用户自部署、桌面 Release 自动化 | 发布维护 |
| [operations/multi-agent.md](operations/multi-agent.md) | 多桌面 Agent 部署、每 Agent 凭证签发/轮换/删除、安全模型 | 多设备部署 |
| [reference/source-map.md](reference/source-map.md) | 按功能域列出的源码路径索引 | 快速定位源码 |

## 架构阅读顺序

| 顺序 | 目标 | 文档 |
|---:|---|---|
| 1 | 先建立整体进程和边界模型 | [architecture/overview.md](architecture/overview.md) |
| 2 | 理解原生宿主和 K-brain 客户端的边界 | [architecture/gui.md](architecture/gui.md) |
| 3 | 区分 Gateway 直连 K-brain 与桌面附件转发 | [architecture/gateway.md](architecture/gateway.md)、[architecture/protocols.md](architecture/protocols.md) |
| 4 | 理解 WebUI 的状态机与限制 | [architecture/webui.md](architecture/webui.md) |
| 5 | 按功能域深入 Chat、Tools、Memory、Skills/MCP、History/Compaction、配置备份同步 | `features/` |
| 6 | 需要动手时查运行命令和源码索引 | [operations/development.md](operations/development.md)、[reference/source-map.md](reference/source-map.md) |

## 当前实现的核心边界

| 边界 | 当前结论 |
|---|---|
| Agent 执行位置 | K-brain 执行模型与工具循环、审批和子代理；GUI 不回退到前端模型 SDK。 |
| Gateway 职责 | 认证、连接保持、请求路由、事件广播、WebUI 静态资源与分享页；直连 K-brain 使用明确的资源路由，桌面附件模式保留宿主转发。 |
| WebUI 职责 | 交互与展示；经 Gateway 操作后端资源。原生文件、SSH、隧道等外围能力仍需单独验证宿主可用性与权限。 |
| 设置同步 | K-brain 管理模型、凭据、MCP 和 Skills 等后端资源；主题等界面偏好与宿主配置独立。并非所有旧设置域都已迁入 KB。 |
| 历史同步 | 当前聊天与事件以 K-brain 持久化为准；保留旧 SQLite 迁移兼容层，前端维护可见窗口缓存。 |
| 文档来源 | 本文档基于当前 checkout 的源码路径、入口文件、协议定义与运行脚本整理。 |

## 与 `doc/` 的关系

| 目录 | 定位 |
|---|---|
| `docs/` | 当前实现的全局架构说明、模块地图、运行说明和源码索引。 |
| `doc/` | 既有专项文档与历史设计资料，例如 memory 方案、Gateway 协议草案、上下文压缩策略等。 |

后续如果某个专项文档已经稳定成为当前实现的一部分，可以在 `docs/` 中建立摘要与导航，但不建议把 `doc/` 直接重命名为 `docs/`，以免丢失历史上下文。

## UI 重构（临时）

- [本轮 UI 重构文档](ui-refactor/README.md)：PR 合并前删除该目录及本导航。
