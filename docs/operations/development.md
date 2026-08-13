# 开发与运行

## 根目录命令

| 命令 | 作用 |
|---|---|
| `make dev` | 启动桌面 GUI 开发模式。 |
| `make build` | 构建桌面 GUI。 |
| `make desktop-build-macos` | macOS 普通桌面打包。 |
| `make desktop-build-macos-release` | macOS Developer ID 签名、公证相关 release 打包。 |
| `make desktop-build-macos-intel` | Intel macOS 目标构建。 |
| `make desktop-build-macos-m` | Apple Silicon macOS 目标构建。 |
| `make desktop-build-windows` | Windows 桌面目标构建。 |
| `make desktop-build-linux` | Linux 桌面目标构建。 |
| `make dev-gateway` | 本地启动 Go Gateway 开发服务。 |
| `make dev-webui` | 本地启动 Gateway WebUI Vite 开发服务。 |
| `make proto` | 生成 Gateway proto。 |
| `make webui` | 构建 Gateway WebUI 静态资源。 |
| `make gateway-build` | proto + webui + Gateway 构建。 |

## 包管理与子项目

| 子项目 | Manifest | 说明 |
|---|---|---|
| Rust workspace | `Cargo.toml` | 根工作区，包含 Tauri/Rust crate。 |
| 共享 UI | `crates/agent-ui/package.json` | GUI/WebUI 共用的 React 应用 UI 与领域逻辑。 |
| GUI frontend | `crates/agent-gui/package.json` | 桌面 React/Tauri 前端依赖与脚本。 |
| Gateway | `crates/agent-gateway/go.mod` | Go Gateway 依赖。 |
| Gateway WebUI | `crates/agent-gateway/web/package.json` | 浏览器 WebUI 依赖与构建脚本。 |

## 常用检查命令

| 场景 | 命令 |
|---|---|
| GUI build | `pnpm -C crates/agent-gui build` |
| WebUI build | `pnpm -C crates/agent-gateway/web build` |
| Gateway tests | `cd crates/agent-gateway && go test ./...` |
| Gateway lint | `cd crates/agent-gateway && golangci-lint run ./...` |
| Proto 检查 | `make proto-check`（buf lint + 对 origin/main 的 breaking 检查） |
| Tauri/Rust tests | `cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml` |
| 前端专项测试 | `pnpm -C crates/agent-gui test:frontend` |
| diff 空白检查 | `git diff --check` |
| 当前改动 | `git status --short` |

工具链版本由根 `mise.toml` 固定（git 跟踪），`mise install` 一键对齐，CI 使用相同版本。

实际脚本名称可能随 package.json 调整，运行前以当前 manifest 为准。

## 运行时路径

| 路径 | 说明 |
|---|---|
| `~/.liveagent/config.sqlite` | 桌面端 settings 数据库。 |
| `~/.liveagent/chat-history.sqlite3` | Chat history 数据库。 |
| `~/.liveagent/memory/` | Memory Markdown 根目录与 `memory-index.sqlite3`。 |
| `~/.liveagent/skills` | Skills runtime root。 |
| `~/.liveagent/default-project` | 首次安装/空 workdir 时的默认项目目录。 |
| `~/.liveagent/debug/*.jsonl` | debug JSONL 日志。 |

## Gateway 开发关注点

| 项 | 说明 |
|---|---|
| HTTP | `internal/server/http.go` 注册 `/ws/v2*` 三链路、`/api/status`、`/api/files/import`、public share 和静态资源。 |
| Proto | 改 `proto/v2/*.proto` 后执行 `make proto`（buf 生成 Go+TS），生成物随源同 PR 提交；`make proto-check` 把关破坏性变更。 |
| Shutdown | `make dev-gateway` 应支持 Ctrl+C 后 HTTP 干净退出。 |
| WebUI embed | Gateway build 通常依赖 `make webui` 先产出静态资源。 |
| 新增桌面端能力 | `proto/v2/gateway.proto` 加信封臂（编号只增不改）→ `make proto` → v2 直通白名单（`internal/protocol/pbws/guard.go`）放行 → 各端生成物随源同 PR 提交；新增网关本地操作则在 v2 帧（`proto/v2/gateway_ws.proto`）加臂。 |
| 弃用惯例 | Go `// Deprecated: <原因；替代物；删除条件>`、Rust `#[deprecated]`、TS `@deprecated`、proto `option deprecated`；弃用代码原地保留只修 bug，删除前先经使用打点观察。 |

## Gateway 分层（新代码放哪里）

| 代码类型 | 位置 |
|---|---|
| 传输机制（写泵/背压/心跳，帧格式无关） | `internal/transport/wscore` |
| v2 协议编解码/握手/直通/扇出 | `internal/protocol/pbws` |
| 跨协议域逻辑（终端门控、Origin 校验等） | `internal/protocol/shared` |
| chat 命令编排 | `internal/chatcmd` |
| 会话状态与关联路由（transport 无关） | `internal/session` |
| 日志装置与协议使用打点 | `internal/observability` |
| HTTP 入口与 public share | `internal/server` |

## GUI/WebUI 共享 UI 改造检查

| 改动类型 | 代码位置与检查范围 |
|---|---|
| Settings、Skills Hub、MCP Hub | 公共页面只修改 `crates/agent-ui`；平台差异放各宿主 `src/agent-ui-adapters/*` 或页面扩展注册表，并在两端验证。 |
| Chat 侧边栏、输入栏、公共消息视觉 | 公共 JSX/CSS 只修改 `crates/agent-ui`；GUI/WebUI 各自数据控制器、流式状态和虚拟列表仍分别检查。 |
| 上传、剪贴板、目录选择 | 公共交互契约位于 `agent-ui`，Tauri/Gateway/browser 实现位于各宿主适配器。 |
| Provider 设置 | 公共 Settings UI、两端 provider 适配器、Rust settings、Gateway redaction 和模型请求层。 |
| Memory | Rust MemoryStore、共享 Memory 页面、两端 `agent-ui-adapters/memoryOrganizer.ts`、Gateway memory.manage 和 MemoryManager tool。 |
| 边界检查 | 执行 `pnpm check:ui-boundaries`，防止应用目录重新出现公共页面副本或共享层直接依赖具体宿主。 |

## 文档任务边界

本文档树只描述当前架构，不要求启动 dev server 或跑 build。若后续文档改动伴随代码改动，应按触达模块补充对应 build/test。
