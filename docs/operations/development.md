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
| `make dev-stack` | 后台一键启动 Gateway、WebUI、桌面 LiveAgent 三端。 |
| `make dev-stack-status` | 检查三端和 MCP Bridge 状态。 |
| `make dev-stack-logs` | 查看三端最近日志。 |
| `make dev-stack-stop` | 停止由三端脚本管理的进程。 |
| `make check-fast` | 编译、lint、基础测试与错误检查。 |
| `make check-all` | 执行 fast、完整测试与 Proto 契约检查。 |
| `make check-strict` | 执行 all，并将 Biome/Rust warning 视为错误。 |
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

桌面开发和打包也需要 Go：Tauri 启动前会从当前工作区源码构建 Gateway sidecar，并嵌入对应
WebUI。先使用根 `mise.toml` 对齐 Go、Node、pnpm、Rust 等工具链，再在仓库根安装全部 workspace
依赖，确保桌面和 Gateway WebUI 均可构建：

```bash
mise install
pnpm install --frozen-lockfile
pnpm --dir crates/agent-gui tauri dev
```

`tauri dev` 和 `tauri build` 的前置 hook 自动执行 `scripts/prepare-gateway.mjs`，先完成 WebUI
typecheck/Vite build，再构建 `crates/agent-gui/src-tauri/binaries/liveagent-gateway-<target-triple>`
（Windows 带 `.exe`）。目标架构来自 Tauri 的构建目标；直接准备其他目标时可传
`--target <rust-triple>`。生成的 sidecar 属于本地构建产物，不提交到 Git。正式安装包和 Windows
portable 包携带 Gateway 与嵌入的 WebUI，运行时无需 Go、Node 或 pnpm。

直接调用 Cargo 不执行 Tauri hook。首次在干净工作区运行 Rust check/test/build 前，先准备本机
sidecar；Go Gateway 或 WebUI 源码变更后也应重新准备：

```bash
node scripts/prepare-gateway.mjs
cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
```

## 桌面本机托管

全新桌面配置默认开启远程访问并启用「在此电脑托管 Gateway」。单独运行 `tauri dev` 或正式客户端
即可后台启动本机 Gateway，健康检查确认本次启动的服务就绪后，桌面自动连接。进入设置的远程访问
页面查看 WebUI 地址，复制自动生成的访问令牌登录。本机服务只监听 loopback；修改端口会重启本机
服务，关闭窗口到托盘时继续运行，真正退出或桌面进程结束时回收。

已有配置会保留远程访问开关、外部 Gateway 地址和令牌；升级不会擅自接管已有外部服务。原本明确
关闭的远程访问保持关闭。需要迁移到本机托管时，在远程访问页面开启对应选项；需要连接已有服务时
关闭「在此电脑托管 Gateway」并配置外部地址和令牌。本机端口已被占用时会显示启动失败，应选择空闲
端口或切换到外部连接后重试。

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

## 一键启动三端

跨平台脚本 `scripts/dev-stack.mjs` 统一管理 Gateway、Gateway WebUI 和桌面 LiveAgent：

```bash
make dev-stack
make dev-stack-status
make dev-stack-logs
make dev-stack-stop
```

也可以在 macOS、Linux 和 Windows 直接通过 pnpm 调用：

```bash
pnpm dev:stack
pnpm dev:stack:status
pnpm dev:stack:logs
pnpm dev:stack:stop
```

默认端口为 Gateway `50052`、WebUI `5173`、桌面前端 `1420`、MCP Bridge `9223`，默认本地
Gateway token 为 `dev-token`。脚本遇到已由外部进程占用且健康的端口时只复用，不会在 stop 时
终止该外部进程。进程检测、HTTP 健康检查、日志和状态文件均由 Node 实现；Windows 停止托管进程
时调用系统自带的 `taskkill`，macOS/Linux 使用进程组信号。

`dev-stack` 单独启动的 Gateway 由该脚本管理。要让桌面连接这个开发服务，在桌面远程访问设置中
开启远程访问、关闭「在此电脑托管 Gateway」，填写 `http://127.0.0.1:50052` 和 `dev-token`；
如果通过环境变量修改了开发端口或令牌，填写相应值。浏览器访问 `http://localhost:5173` 使用独立
Vite WebUI。桌面本机托管模式不会自动接管或复用 `dev-stack` 的 Gateway，已有桌面连接配置也不会
被脚本替换。

## 统一编译与检查

跨平台主入口为 `scripts/check.mjs`，macOS、Linux 和 Windows 推荐通过 pnpm 调用：

```bash
pnpm check:fast
pnpm check:all
pnpm check:strict
```

也可以在提供 Make 的环境中运行 `make check-fast`、`make check-all`、`make check-strict`。

| 级别 | 检查范围 |
|---|---|
| `fast` | diff、脚本测试、Shared UI 边界/typecheck、GUI build、嵌入 WebUI 的 Gateway sidecar build、三端完整 lint 诊断、Rust check、golangci-lint、Go tests。 |
| `all` | `fast` + 自动发现的 GUI/WebUI/release 测试、Rust all-target/doc tests、Proto lint/breaking。 |
| `strict` | `all` + rustfmt、Clippy、三端完整 Biome 诊断，并将相对基线变更文件中的 Biome warning 视为错误。 |

所有级别都会执行检查脚本单测、Shared UI 边界和独立 TypeScript typecheck；Biome 使用
`--max-diagnostics=none`，不会隐藏超出默认上限的诊断。`strict` 仍输出三端全量诊断，但只把
相对 `LIVEAGENT_CHECK_BASE_REF`（默认依次选择 `origin/main`、`main`）新增或修改源码中的 warning
升级为失败，避免通过关闭规则掩盖历史诊断。GUI 与 WebUI 测试文件由
`scripts/run-node-tests.mjs` 递归发现，避免手写目录列表或依赖 shell glob。

完整文本日志和结构化 JSON 报告默认写入操作系统临时目录下的
`liveagent-check-<user>/<timestamp>-<profile>-<pid>/check.log` 与 `report.json`。JSON 包含运行元数据、
汇总计数及每一步的命令、工作目录、状态、退出码和耗时。需要失败后继续执行其他检查时设置
`LIVEAGENT_CHECK_KEEP_GOING=1`；需要固定报告位置时设置 `LIVEAGENT_CHECK_REPORT_PATH`。当前已在
macOS ARM64 实跑验证；Windows/Linux 仍应在对应机器或 CI 上完成平台验证。

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
