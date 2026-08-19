# 开发与运行

## 根目录命令

| 命令 | 作用 |
|---|---|
| `make dev` | 启动桌面 GUI 开发模式，Session Workbench 正式路径默认开启。 |
| `make build` | 构建桌面 GUI。 |
| `make desktop-build-macos` | macOS 普通桌面打包。 |
| `make desktop-build-macos-release` | macOS Developer ID 签名、公证相关 release 打包。 |
| `make desktop-build-macos-intel` | Intel macOS 目标构建。 |
| `make desktop-build-macos-m` | Apple Silicon macOS 目标构建。 |
| `make desktop-build-windows` | Windows 桌面目标构建。 |
| `make desktop-build-linux` | Linux 桌面目标构建。 |
| `make dev-gateway` | 本地启动 Go Gateway 开发服务。 |
| `make dev-webui` | 本地启动 Gateway WebUI Vite 开发服务。 |
| `make dev-stack` | 后台启动 Gateway、WebUI、桌面 LiveAgent 三端。 |
| `make dev-stack-stop` | 停止由三端脚本启动的进程，不终止外部同端口进程。 |
| `make dev-stack-restart` | 重启由三端脚本管理的进程。 |
| `make dev-stack-status` | 检查三端、HTTP 入口与 MCP Bridge 状态。 |
| `make dev-stack-logs` | 输出三端最近日志。 |
| `make check-fast` | 编译前后端、运行 lint、Go 基础测试与 diff 检查。 |
| `make check-all` | 在 fast 基础上运行完整前端/Rust 测试与 Proto 检查。 |
| `make check-strict` | 在 all 基础上运行 rustfmt，并将 Biome/Rust 告警升级为错误。 |
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

## 三端本地启动脚本

统一入口是 `scripts/dev-stack.sh`。默认 Gateway 为 `http://localhost:50052`，WebUI 为
`http://localhost:5173`，桌面前端为 `http://localhost:1420`，Gateway token 为
`dev-token`。运行日志与 PID 默认写入 `$TMPDIR/liveagent-dev-stack-$UID`，不会写入仓库。

```bash
make dev-stack
make dev-stack-status
make dev-stack-logs
make dev-stack-restart
make dev-stack-stop
```

可以只操作一端：

```bash
./scripts/dev-stack.sh restart webui
./scripts/dev-stack.sh logs gateway
```

自定义 token 与端口时使用环境变量，token 不会保存到仓库文件：

```bash
LIVEAGENT_GATEWAY_TOKEN='replace-with-a-local-secret' \
LIVEAGENT_DEV_GATEWAY_PORT=50052 \
LIVEAGENT_DEV_WEBUI_PORT=5173 \
make dev-stack
```

桌面端设置中的 Gateway 地址、端口和 token 必须与脚本一致。默认填写
`http://localhost`、`50052`、`dev-token`。脚本发现目标端口已有外部进程时会复用并标记为
`external`，`stop` 不会终止该进程。

## 编译与告警检查脚本

统一检查入口是跨平台 Node 脚本 `scripts/check.mjs`。macOS、Linux 和 Windows 都可以通过
pnpm 调用；`scripts/check.sh` 仅作为 macOS/Linux 与 Git Bash 的兼容包装：

```bash
make check-fast
make check-all
make check-strict
```

脚本实时输出每项 PASS/FAIL，并将完整运行日志写入操作系统临时目录下的
`liveagent-check-<user>/<timestamp>-<profile>-<pid>/check.log`。默认在首个失败处停止；
需要一次收集全部失败时使用：

```bash
LIVEAGENT_CHECK_KEEP_GOING=1 make check-all
```

三个级别的边界：

| 级别 | 检查范围 |
|---|---|
| `fast` | diff、UI 边界、GUI/WebUI TypeScript + Vite 构建与 lint、Rust check、golangci-lint 和 Go tests。 |
| `all` | `fast` + GUI/WebUI/release 测试、Rust library tests 与 Proto lint/breaking。 |
| `strict` | `all` + Shared UI lint，并将 Biome/Rust warning 视为错误，额外执行 rustfmt 与 Clippy。 |

跨平台推荐入口：

```bash
pnpm check:fast
pnpm check:all
pnpm check:strict
```

Windows PowerShell 一次收集全部失败：

```powershell
$env:LIVEAGENT_CHECK_KEEP_GOING = "1"
pnpm check:all
```

平台边界：检查脚本不依赖 POSIX Shell，设计为支持 macOS、Linux 和原生 Windows；当前已在
macOS ARM64 实跑验证，Windows 仍需对应机器或 CI 验证。`scripts/dev-stack.sh` 使用 POSIX
进程组、`lsof`、`nohup` 和信号管理，只支持 macOS/Linux。macOS 发布脚本和 Linux AppImage
后处理脚本也分别保持其目标平台限定，不属于通用跨平台入口。

## Session Workbench 正式版契约

正式版桌面构建沿用 `VITE_LIVEAGENT_SESSION_WORKBENCH` 的默认值 `true`，安装包直接进入
Session Workbench 产品路径。`make dev DEV_SESSION_WORKBENCH=0` 只用于本地兼容性回归，不应
用于发布产物；当前版本冷启动创建单 Root Pane，不恢复历史多 Pane 布局。

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
