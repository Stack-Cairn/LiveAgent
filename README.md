<p align="center">
  <img src="crates/agent-gui/src-tauri/icons/icon.png" width="128" height="128" alt="LiveAgent" />
</p>

<h1 align="center">LiveAgent</h1>

<p align="center">
  <strong>Your Local-First AI Agent Desktop</strong><br/>
  多模型接入 · 本地工具执行 · MCP & Skills 生态 · 远程 Gateway
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blueviolet" />
  <img alt="Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-FFC131?logo=tauri&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-B7410E?logo=rust&logoColor=white" />
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

<p align="center">
  <a href="#核心能力">核心能力</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#下载与部署">下载与部署</a> •
  <a href="#faq">FAQ</a> •
  <a href="docs/">文档</a>
</p>

---

## 为什么是 LiveAgent?

LiveAgent 是一个 **本地优先** 的 AI Agent 桌面客户端。它将大语言模型的推理能力与本地系统工具深度整合,让 AI 能够真正操作你的文件系统、执行命令、管理定时任务,同时通过 Gateway 实现远程访问与协作。

> **桌面端是真相源** — 所有工具执行、持久化和秘钥都留在本地,Gateway 只做中继。

- **真正动手的 Agent** — 不止于对话:读写文件、精确编辑、执行 Bash、托管长驻进程
- **生态完全开放** — MCP 协议桥接任意外部工具,Skills 技能包按需加载
- **本地与远程兼得** — 桌面端独立可用,部署 Gateway 后浏览器随处操控

---

## 核心能力

### 🧠 多模型与对话

- **多模型路由** — Claude(Anthropic)与 Codex(OpenAI)双协议,支持自定义 Base URL 接入第三方兼容服务
- **富文本渲染** — Markdown 流式渲染,内建 KaTeX 公式、Mermaid 图表与 Monaco 代码预览
- **历史压缩** — Segment + Summary Checkpoint 双层持久化,长对话不丢上下文
- **国际化** — 内建 i18n 多语言框架

### 🔧 本地工具执行

- **文件系统全能力** — `Read` / `Write` / `Edit` / `Delete` 精确读写,`Glob` / `Grep` 模式与正则搜索
- **Bash 与长驻进程** — 非交互式命令执行(cwd / timeout),`ManagedProcess` 托管 dev server 等常驻任务
- **Sub-Agent 委派** — 独立子代理并行执行,worktree 隔离,自动合并
- **隧道暴露** — `TunnelManager` 一键将本地服务暴露公网

### 🧩 MCP 与 Skills 生态

- **MCP 协议桥接** — Tauri 端原生桥接任意 stdio / http MCP Server,无限扩展工具能力
- **Skills 技能包** — 渐进式披露、按需加载,支持安装 / 创建 / 打包与 ClawHub 生态

### 💾 记忆与自动化

- **持久化记忆** — Markdown + SQLite FTS 全文检索,跨会话知识管理
- **定时任务** — bash / http / prompt 三种 Cron 任务类型,后台自动执行

### 🌐 远程 Gateway

- **浏览器随处访问** — Go + gRPC 网关,WebUI 远程操控本地 Agent
- **断线可恢复** — 有界 seq window 补齐短时断线,桌面端持久化兜底
- **一键部署** — Docker multi-stage 镜像(约 30MB),支持 Railway CI/CD

---

## 快速开始

### 环境要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | >= 22 | 前端构建 |
| pnpm | >= 10 | 包管理 |
| Rust | stable | Tauri 桌面后端 |
| Go | >= 1.25 | Gateway(可选) |
| protoc | latest | gRPC 代码生成(可选) |

### 桌面客户端

```bash
# 安装依赖
pnpm --dir crates/agent-gui install

# 开发模式(热重载)
make dev

# 构建发行版
make build
```

### Gateway 服务(可选)

```bash
# 启动 Gateway 开发服务
make dev-gateway

# 启动 WebUI 开发服务
make dev-webui

# 构建 Docker 镜像并健康检查
make gateway-docker-smoke
```

---

## 下载与部署

安装包由 GitHub Actions 自动构建、签名并发布,请前往 [**GitHub Releases**](https://github.com/Stack-Cairn/LiveAgent/releases/latest) 获取最新版本。

### 系统要求

| 平台 | 要求 |
|---|---|
| macOS | Intel(x64)与 Apple Silicon(aarch64)双架构 |
| Windows | x64,需 WebView2 运行时(Windows 11 已内置) |
| Linux | x86_64,需 WebKitGTK 4.1(Ubuntu 22.04+ / Debian 12+ 等) |

### macOS 用户

从 [Releases](https://github.com/Stack-Cairn/LiveAgent/releases/latest) 下载对应芯片的 DMG,打开后将 LiveAgent 拖入「应用程序」:

- Apple Silicon(M 系列):`LiveAgent-<版本>-macOS-aarch64.dmg`
- Intel:`LiveAgent-<版本>-macOS-x64.dmg`

> 安装包已签名并通过 Apple 公证,首次启动无需在安全设置中手动放行。

### Windows 用户

从 [Releases](https://github.com/Stack-Cairn/LiveAgent/releases/latest) 按需选择一种安装方式:

| 方式 | 文件 | 适合 |
|---|---|---|
| 安装向导 | `LiveAgent-<版本>-Windows-x64-Setup.exe` | 大多数用户 |
| MSI 包 | `LiveAgent-<版本>-Windows-x64.msi` | 企业分发 / 静默安装 |
| 便携版 | `LiveAgent-<版本>-Windows-x64-portable.zip` | 免安装,解压即用 |

### Linux 用户

从 [Releases](https://github.com/Stack-Cairn/LiveAgent/releases/latest) 按发行版选择:

| 格式 | 适用发行版 | 安装方式 |
|---|---|---|
| AppImage | 任意发行版 | `chmod +x` 后直接运行 |
| DEB | Debian / Ubuntu 系 | `sudo dpkg -i LiveAgent-<版本>-Linux-x86_64.deb` |
| RPM | Fedora / openSUSE 系 | `sudo rpm -i LiveAgent-<版本>-Linux-x86_64.rpm` |

### 需要远程访问? 部署 Gateway

桌面端开箱即用,不依赖任何服务端。只有想 **在浏览器里远程操控本地 Agent** 时,才需要部署 Gateway:

```bash
# Docker 构建(multi-stage,最终镜像 ~30MB)
docker build -t liveagent-gateway .

# 运行
docker run -p 8080:8080 -p 50051:50051 \
  -e LIVEAGENT_GATEWAY_TOKEN=your-token \
  liveagent-gateway
```

### 开发者从源码构建

参考上方 [快速开始](#快速开始),或展开下方「开发指南」查看完整 Make 命令。

<details>
<summary><b>架构总览</b> — 架构图与技术栈</summary>

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser WebUI                          │
│              React + Vite + WebSocket + Gateway API           │
└────────────────────────────┬─────────────────────────────────┘
                             │ WebSocket / HTTP
┌────────────────────────────▼─────────────────────────────────┐
│                       Agent Gateway                           │
│         Go · gRPC · HTTP · Session Manager · Event Store     │
│                    (Railway / Docker / 自部署)                 │
└────────────────────────────┬─────────────────────────────────┘
                             │ gRPC (双向流)
┌────────────────────────────▼─────────────────────────────────┐
│                        Agent GUI                              │
│                   Tauri 2 · React 19 · Rust                  │
├──────────┬───────────┬───────────┬───────────┬───────────────┤
│ 模型协议  │ Agent运行时 │  工具执行   │  Skills   │  Memory/Cron  │
│ pi-ai    │ 多轮循环   │ FS/Bash/  │  渐进披露  │  SQLite+MD    │
│ + Codex  │ + SubAgent │ MCP桥接   │  + Hub    │  FTS索引      │
└──────────┴───────────┴───────────┴───────────┴───────────────┘
```

**技术栈**

| 组件 | 技术 |
|---|---|
| **Agent GUI** · 框架 | Tauri 2 + React 19 + TypeScript 6 |
| **Agent GUI** · 构建 | Vite 8 + pnpm |
| **Agent GUI** · 样式 | Tailwind CSS 4 + Radix UI |
| **Agent GUI** · 渲染 | streamdown + KaTeX + Mermaid + Monaco Editor |
| **Agent GUI** · 后端 | Rust + Tokio + SQLite (rusqlite) + gRPC (tonic) |
| **Agent GUI** · LLM | @earendil-works/pi-ai · @openai/codex-sdk · claude-agent-sdk |
| **Gateway** · 语言 | Go 1.25 |
| **Gateway** · 协议 | gRPC + Protobuf + HTTP + WebSocket |
| **Gateway** · Web UI | React + Vite + Tailwind CSS(嵌入式) |
| **Gateway** · 部署 | Docker multi-stage · Railway CI/CD |

</details>

<details>
<summary><b>开发指南</b> — 常用 Make 命令(完整列表见 <code>make help</code>)</summary>

| 命令 | 说明 |
|---|---|
| `make dev` | 启动 Tauri 开发环境 |
| `make build` | 构建桌面应用 |
| `make dev-gateway` | 启动 Gateway 开发服务 |
| `make dev-webui` | 启动 WebUI 开发服务 |
| `make gateway-build` | 构建 Gateway 二进制 |
| `make gateway-docker-build` | 构建 Docker 镜像 |
| `make gateway-docker-smoke` | 构建 + 健康检查 |
| `make desktop-build-macos-release` | macOS 签名发布构建 |
| `make build-linux` | Linux amd64 网关 |
| `make build-linux-arm` | Linux arm64 网关 |
| `make proto` | 重新生成 Protobuf 代码 |
| `make clean` | 清理构建产物 |

</details>

<details>
<summary><b>项目结构</b> — 目录树</summary>

```
LiveAgent/
├── crates/
│   ├── agent-gui/                # 桌面客户端
│   │   ├── src/                  # React 前端
│   │   │   ├── components/       #   UI 组件
│   │   │   ├── lib/              #   核心逻辑 (chat, tools, skills, memory)
│   │   │   ├── pages/            #   页面 (Chat, Settings)
│   │   │   ├── i18n/             #   国际化
│   │   │   └── prompt/           #   System Prompt 模板
│   │   └── src-tauri/            # Rust 后端 (Tauri)
│   │
│   └── agent-gateway/            # Go 网关服务
│       ├── cmd/gateway/          #   入口
│       ├── internal/             #   核心实现
│       ├── proto/v1/             #   Protobuf 定义
│       └── web/                  #   嵌入式 WebUI
│
├── docs/                         # 项目文档
│   ├── architecture/             #   架构设计
│   ├── features/                 #   功能说明
│   └── operations/               #   运维部署
│
├── scripts/release/              # 发布自动化
├── .github/workflows/            # CI/CD (CI + Desktop Release + Gateway Docker)
├── Dockerfile                    # Gateway 容器镜像
├── Makefile                      # 构建命令集
└── Cargo.toml                    # Rust workspace
```

</details>

---

## FAQ

<details>
<summary><b>API Key 会离开本机吗?</b></summary>

不会。秘钥仅保存在桌面端本地,Gateway 只做协议中继 — 不访问文件系统、不存储任何凭据。

</details>

<details>
<summary><b>必须部署 Gateway 吗?</b></summary>

不需要。桌面客户端可独立使用全部本地能力;只有需要从浏览器远程访问本地 Agent 时,才部署 Gateway。

</details>

<details>
<summary><b>支持哪些模型?</b></summary>

内置 Claude(Anthropic)与 Codex(OpenAI)双协议,并支持自定义 Base URL 接入任何兼容的第三方服务。

</details>

<details>
<summary><b>长对话 / 断线后上下文会丢吗?</b></summary>

不会。桌面端以 Segment + Summary Checkpoint 持久化完整历史;Gateway 通过有界 seq window 补齐短时断线,重连后自动收敛。

</details>

---

## 文档

| 文档列表 | 描述 |
|---|---|
| [架构总览](docs/architecture/overview.md) | 系统分层、进程边界、数据流 |
| [GUI 架构](docs/architecture/gui.md) | 桌面客户端内部设计 |
| [Gateway 架构](docs/architecture/gateway.md) | 网关服务设计 |
| [WebUI 架构](docs/architecture/webui.md) | 浏览器端设计 |
| [协议定义](docs/architecture/protocols.md) | gRPC / WebSocket 协议 |
| [Chat 运行时](docs/features/chat-runtime.md) | Agent 对话循环机制 |
| [工具系统](docs/features/tools.md) | 内建工具实现 |
| [Skills & MCP](docs/features/skills-and-mcp.md) | 技能与协议扩展 |
| [记忆系统](docs/features/memory.md) | 持久化记忆设计 |
| [历史压缩](docs/features/history-compaction.md) | 长对话上下文管理 |
| [部署运维](docs/operations/deployment.md) | Docker、自部署、桌面发布 |
| [开发指南](docs/operations/development.md) | 本地开发环境搭建 |

---

## 贡献

欢迎提交 Issue 与 Pull Request!开发环境搭建请参考 [开发指南](docs/operations/development.md)。

提交 PR 前,请确保以下检查全部通过(与 CI 门禁一致):

**桌面客户端 · `crates/agent-gui`**

1. 类型检查与构建通过:`pnpm build`
2. 代码规范检查通过:`pnpm lint`
3. 前端单元测试通过:`pnpm test:frontend`(改动发布脚本时另跑 `pnpm test:release`)
4. Rust 后端检查通过:`cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests`(仓库根目录执行)

**Gateway · `crates/agent-gateway`(如有改动)**

1. Go 单元测试通过:`go test ./...`
2. WebUI 构建 / Lint / 测试通过:`pnpm build && pnpm lint && pnpm test`(在 `web/` 目录执行)
3. Proto 变更后重新生成并提交产物:`make proto`

**跨端一致性**

- GUI 与 WebUI 的镜像文件必须逐字节一致:`node scripts/check-mirror.mjs`
- 保持 diff 干净 (无行尾空白):`git diff --check`

---

## License

MIT © StackCairn
