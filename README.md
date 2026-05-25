# LiveAgent

一个基于 **Tauri + React** 的桌面 AI Agent 客户端，支持多模型接入、工具调用、MCP 协议桥接和 Skills 渐进式披露。

## 项目概览

LiveAgent 由两大核心模块组成：

| 模块 | 技术栈 | 说明 |
| --- | --- | --- |
| **agent-gui** | Tauri 2 + React 19 + TypeScript + Vite 8 | 桌面客户端，负责 UI 渲染、模型路由、工具执行和会话管理 |
| **agent-gateway** | Go + gRPC + React (Web UI) | 后端网关服务，提供 HTTP/gRPC API、会话管理和嵌入式 Web 管理界面 |

### 架构层次

```
┌─────────────────────────────────────────────┐
│                 Agent GUI                    │
│   (Tauri + React 桌面客户端)                 │
├──────────┬──────────┬───────────┬───────────┤
│ 模型协议层 │ 多轮执行层  │  工具资源层  │   UI 层    │
│ pi-ai   │agentRunner│ FS/Bash/  │ Chat /    │
│ + 自定义路由│ 自定义Loop │ MCP/Skills │ Settings  │
└──────────┴──────────┴───────────┴───────────┘

┌─────────────────────────────────────────────┐
│              Agent Gateway                   │
│      (Go + gRPC 后端网关服务)                │
├──────────┬──────────┬───────────┬───────────┤
│  HTTP    │  gRPC    │  Session  │  Web UI   │
│  API     │  Server  │  Manager  │  (Embed)  │
└──────────┴──────────┴───────────┴───────────┘
```

## 核心能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 多模型接入 | ✅ 已完成 | 支持 Claude (Anthropic) / Codex (OpenAI-compatible) 等模型路由 |
| 文本流式输出 | ✅ 已完成 | 实时 streaming delta 到 UI |
| 多轮工具循环 | ✅ 已完成 | assistant → tool → toolResult → 下一轮的完整循环 |
| 文件操作工具 | ✅ 已完成 | Read / Write / Edit / List / Glob / Grep |
| Bash 命令执行 | ✅ 已完成 | 非交互式命令，支持 timeout / cwd |
| MCP 协议桥接 | ✅ 已完成 | 通过 Tauri 端桥接 MCP 工具，前端映射为 LLM 可调用工具 |
| Skills 系统 | ✅ 已完成 | 元数据渐进式披露，按需加载 SKILL.md |
| Agent 风格 UI | ✅ 已完成 | thinking 流、工具调用追踪、轮次状态展示 |
| 定时任务 (Cron) | ✅ 已完成 | 支持 bash / http / prompt 三种定时任务类型 |
| gRPC 网关 | ✅ 已完成 | Go 后端提供 HTTP + gRPC 双协议接口 |
| 国际化 (i18n) | ✅ 已完成 | 内建多语言支持框架 |

## 技术栈详情

### Agent GUI (桌面客户端)

| 类别 | 技术 |
| --- | --- |
| 框架 | Tauri 2 + React 19 |
| 语言 | TypeScript 6 |
| 构建 | Vite 8 |
| 样式 | Tailwind CSS 4 |
| UI 组件 | Radix UI + Lucide Icons |
| Markdown 渲染 | streamdown + KaTeX + Mermaid |
| LLM 协议层 | @mariozechner/pi-ai v0.65 |
| Agent 核心 | @mariozechner/pi-agent-core v0.65 |
| Diff 展示 | @git-diff-view/react |

### Agent Gateway (后端网关)

| 类别 | 技术 |
| --- | --- |
| 语言 | Go 1.25 |
| 通信协议 | gRPC + protobuf |
| Web UI | React + Vite + Tailwind CSS |

## 项目结构

```
liveagent/
├── crates/
│   ├── agent-gui/                  # 桌面客户端
│   │   ├── src/
│   │   │   ├── components/         # UI 组件 (chat, cron, ui)
│   │   │   ├── lib/
│   │   │   │   ├── chat/           # 会话逻辑
│   │   │   │   ├── tools/          # 内建工具 (FS, Bash, MCP, Cron, Skills)
│   │   │   │   ├── settings/       # 设置管理
│   │   │   │   ├── skills/         # Skills 系统
│   │   │   │   ├── providers/      # 模型 provider
│   │   │   │   └── hooks/          # 自定义 hooks
│   │   │   ├── pages/              # 页面 (Chat, Settings)
│   │   │   ├── i18n/               # 国际化
│   │   │   └── prompt/             # System Prompt 模板
│   │   └── src-tauri/              # Tauri Rust 后端
│   │
│   └── agent-gateway/              # Go 网关服务
│       ├── cmd/gateway/            # 入口
│       ├── internal/               # 内部实现 (auth, config, handler, session)
│       ├── proto/v1/               # Protobuf 定义
│       └── web/                    # 嵌入式 Web UI
│
├── doc/                            # 项目文档
│   ├── README.md                   # 详细开发文档
│   ├── compaction/                 # 上下文压缩相关文档
│   └── task/                       # 任务规划文档
│
├── scripts/                        # 辅助脚本
├── Cargo.toml                      # Rust workspace
└── Makefile                        # 构建命令
```

## 快速开始

### 环境要求

- **Node.js** >= 18
- **pnpm** (推荐最新版)
- **Rust** (桌面客户端构建)
- **Go** >= 1.25 (网关构建，可选)
- **protoc** + **protoc-gen-go** + **protoc-gen-go-grpc** (网关构建，可选)

### 安装与运行

```bash
# 安装前端依赖
pnpm --dir crates/agent-gui install

# 启动桌面客户端开发环境
make dev

# 构建桌面应用
make build
```

### 网关服务 (可选)

```bash
# 启动网关开发服务
make dev-gateway

# 启动网关 Web UI 开发服务
make dev-webui

# 构建网关二进制
make gateway-build

# 构建网关 Docker 镜像
make gateway-docker-build

# 构建并健康检查网关 Docker 镜像
make gateway-docker-smoke

# 构建全平台
make build-linux
make build-linux-arm
```

### Make 命令速查

| 命令 | 说明 |
| --- | --- |
| `make dev` | 启动 Tauri 开发环境 |
| `make build` | 构建 Tauri 桌面应用 |
| `make dev-gateway` | 启动 Go 网关服务 |
| `make dev-webui` | 启动网关 Web UI |
| `make gateway-build` | 构建网关二进制 |
| `make gateway-docker-build` | 构建网关 Docker 镜像 |
| `make gateway-docker-run` | 本地运行网关 Docker 镜像 |
| `make gateway-docker-smoke` | 构建并健康检查网关 Docker 镜像 |
| `make all` | 同时构建 GUI 和网关 |
| `make clean` | 清理构建产物 |
| `make help` | 查看所有可用命令 |

## 内建工具

| 工具分类 | 工具 | 说明 |
| --- | --- | --- |
| 文件系统 | `Read` | 读取文件，支持分页 |
| 文件系统 | `Write` | 创建/覆盖写入文件 |
| 文件系统 | `Edit` | 精确文本替换 |
| 文件系统 | `Delete` | 删除文件或目录 |
| 文件系统 | `List` | 列出目录内容 |
| 文件系统 | `Glob` | Glob 模式文件搜索 |
| 文件系统 | `Grep` | 正则表达式内容搜索 |
| Shell | `Bash` | 非交互式命令执行 |
| 网络 | `HttpGetTest` | HTTP 测试请求 |
| 协议 | `MCP Tools` | MCP 协议工具桥接 |
| 系统 | `Cron Tasks` | 定时任务管理 (bash/http/prompt) |
| 系统 | `Skill Tools` | Skills 读取与管理 |
| 浏览器 | `Chrome DevTools` | 浏览器自动化 (通过 MCP) |

## 支持的模型

通过应用层的自定义 providerId 接入：

| Provider ID | 实际模型 | 说明 |
| --- | --- | --- |
| `claude_code` | Anthropic Claude 系列 | 映射到 pi-ai 的 `anthropic` 模型 |
| `codex` | OpenAI Codex 系列 | 通过 OpenAI-compatible API 接入 |

支持自定义 Base URL、API Key 配置，兼容第三方 OpenAI-like 服务。

## 文档

| 文档 | 位置 | 说明 |
| --- | --- | --- |
| 开发文档 | [doc/README.md](doc/README.md) | 项目详细技术文档，含 pi-ai / pi-agent-core / pi-coding-agent 深度分析 |
| CI/CD 与发布 | [docs/operations/deployment.md](docs/operations/deployment.md) | Gateway Docker、用户自部署、桌面 Release 自动化 |
| 上下文压缩 | [doc/compaction/](doc/compaction/) | V2/V3 对话历史存储与压缩方案 |
| 网关规范 | [doc/webui-gateway-spec.md](doc/webui-gateway-spec.md) | Web UI 与 Gateway 交互规范 |
| 任务规划 | [doc/task/](doc/task/) | 开发任务与重构计划 |

## License

Private
