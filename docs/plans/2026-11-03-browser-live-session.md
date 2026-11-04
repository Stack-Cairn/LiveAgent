# 浏览器 live 会话修复实施与验收

创建：2026-11-03。更新：2026-11-04。

严格 live、同 target 恢复、禁止脚本重放、目标归属、dedicated/headless 隔离和显式会话重置已实现，并经过真实 Chromium 故障注入、race 检测与独立复审。2026-11-04 03:48:30 UTC，用户反馈“先通过，推送PR”，接受当前已记录的验收限制并授权本次提交、推送与 PR 交付。日常 Edge 授权后接管、真实扩展 repin 和 WebUI 仍未实测通过；该决定不改变各项实际结果，required CI 将在提交后跟进。

用户已启动完整 Goal，并授权确认验收条件后直接提交、推送和创建 PR，无需再次请求提交许可。本次明确反馈覆盖此前待用户决定的人工验收及外部阻塞关口；未运行的验证、基线失败和发行锁状态继续如实保留。

## 工作区与基线

用户明确授权本任务使用 worktree，覆盖本机项目规则中的 worktree 禁止约定。实施位于 `.worktrees/browser-live-session/` 下的两个独立仓库，分支均为 `fix-browser-live-session`。

| 仓库 | 最初基线 | 已安全 fast-forward 的当前 HEAD |
|---|---|---|
| LiveAgent | `3e0f1869b46499a3a79658310b5bacae20062f7f` | `fdf56a9516ba5ba3a64219a0c130b7f0736ecd4f` |
| K-brain | `b143a82738a80112acd47bd001e6b5d311a13125` | `235167c21780db38e23a2b012a3f0eb96321293d` |

2026-11-04 11:22 +08:00，通过 GitHub API 只读核对两个仓库当前远端 `main`，均与上表当前 HEAD 相同。这次核对没有 fetch、rebase 或改动索引；提交前若基线再次更新，仍须重新核对差异和适用验证。

原工作区的分支和用户既有改动不纳入任务，不执行 stash、reset、恢复或擅自提交。LiveAgent 当前 tracked 产品代码及发行锁未修改；任务文件为本计划与配套验收文档。K-brain 包含浏览器实现和回归测试补丁。

已读取会话注入的全局规则与原项目 `AGENTS.md`；新 worktree 没有额外 `AGENTS.md`。工作区外全局文件及真实用户数据目录的文件读取曾被工具拒绝，未通过其他方式绕过。

## 已确认的问题与实现

原始首次 session 失效的具体触发条件缺少运行日志，不能认定用户关页、profile 损坏或陈旧端点就是首次根因。源码和实验确认以下独立问题：

- live 发现失败后会转向 dedicated，改变用户选择的 profile。现改为明确失败，dedicated/headless 必须显式选择。
- `Session.Do` 曾在执行回调出错后重新打开并重跑整个脚本。现在只在脚本开始前准备连接，执行中失败保留部分输出与原错误，不自动重放已可能产生副作用的操作。
- 连接与页对象曾受单次调用上下文影响。现在连接生命周期独立，单次动作仍响应调用取消、deadline、session detach 与 target 销毁。
- 已失效的 CDP session 需要移除 Rod 缓存并重新 attach。两个驱动均保留原 endpoint/target；原 target 消失时报告关闭，不改选其他标签页。
- 默认、命名和跨驱动 live 会话可能竞争同一页。现在按浏览器 UUID 与 target 原子登记归属，涵盖同一地址、localhost 别名及 query 表示。切页成功后才释放旧目标，失败保留旧页。
- 同名 dedicated/headless 曾共用 profile，导致无头调用连上有头浏览器。现按模式与名称隔离 profile；回归同时检查页面标记与浏览器实际无头 UA。
- extension 保留原 pin 目标身份，初次 attach 失败也不丢弃该身份。用户显式选择新 pin 页后，可通过 `browser_exec reset:true` 原子释放旧绑定、重新接入并执行新脚本；普通调用不静默切换。排队取消与关闭失败保留旧绑定。

初始化与恢复有界：未绑定目标的暂态打开失败最多重开一次；绑定后只尝试原目标的协议恢复。取消、拒绝和永久错误立即返回。已确认关闭的 target 不包装内部 `context.Canceled`，避免调用方误判为用户取消。

## 验收范围

可复制提示词、操作步骤和预期结果见 [浏览器修复桌面验收操作](2026-11-03-browser-live-session-acceptance.md)。

| 场景 | 验证方式 | 完成标准 |
|---|---|---|
| 初次与延迟授权 | 日常 Edge 原 profile，用户延迟允许原生调试授权 | 不启动替代 profile，成功连接后复用同一目标，用户可见登录态保留 |
| 拒绝、超时、取消 | 拒绝授权、等待到 deadline、客户端停止 | 清楚报告实际原因，不 fallback，不执行或重放脚本，后续独立调用可继续 |
| session 失效而 target 存活 | 测试自有真实 Chrome 执行 detach；日常 profile 连续调用 | 执行前 attach 同 target，原文档标记保留 |
| 执行中 detach / 关页 | 本地计数页 POST 后注入失效 | 及时返回，保留部分输出，副作用仅一次 |
| 原 target 关闭 | 用户关闭专用页并保留无关页 | 明确报错，无关页不变 |
| 浏览器重启 | 测试自有浏览器与日常同 profile 分别检查 | 只恢复原 endpoint/target；无法恢复时明确失败，不跟随新实例 |
| 命名隔离、切页失败 | default/named、跨驱动、并发占用及无效目标 | 会话不抢占，失败切页保留原页与归属 |
| dedicated / headless | 同名会话交替设置和读取标记 | 页面独立，headless 确实为无头浏览器 |
| extension | 固定页、初次 attach 失败、取消 pin / repin、显式重置 | 固定身份与错误清楚，显式选择后才接入新 pin 页 |
| 桌面与 WebUI 集成 | 当前源码、当前 sidecar、真实供应商执行工具 | 核对进程路径、二进制哈希与原始工具结果；桌面结果不能代替 WebUI 实测 |

协议故障注入属于自动化专用场景，不能记成人工 UI 已通过。

## 自动化结果

K-brain 使用 mise Go 1.27.0、`GOTOOLCHAIN=local`；普通测试 `CGO_ENABLED=0`。测试显式隔离数据目录，保存原 Go 缓存位置，清空 CDP URL/WS 环境覆盖。LiveAgent 的受管理 Go 版本仍按本仓库配置。实际浏览器测试通过 `ROD_BROWSER_BIN` 指定测试自有 Chromium，不使用日常 profile。

| 检查 | 已收到的结果与范围 |
|---|---|
| K-brain `go build ./...`、`go vet ./...` | 显式重置完成后再次全部通过，最终 backend/helper 已从同一未变化的 dirty 源码快照构建 |
| browser / tools 定向测试 | session 恢复、模式、工具解析、取消、extension fixture 等通过；新增重置 12 项通过 |
| `TestRealSession*`、`TestDriverParity`、`TestE2EHeadless`、`TestE2ELiveAttach` | 真实 Chrome 两轮通过，含 detach、断连接、原页关闭、重启与取消；parity 十项动作在两个驱动实际断言 |
| `TestManagedModeIsolation` | 两个驱动 × default/shared 四组通过，同时断言 headless UA |
| `TestPreflightReviewLiveRegistryEndpointAliases` | 四种驱动组合 × 相同地址/localhost/query，共 12 组通过 |
| `TestPreflightReviewChromedpDetachBeforeCall` | 调用前 detach 后恢复同 target，原文档变量保留 |
| `TestPreflightReviewInFlightTargetLoss` 与 Rod 关闭分类回归 | 两驱动 × detach/关页连续 10 轮通过；失效后约 2–13ms 返回，partial 保留，callback/effect 均为 1 |
| live target claim race | 连续 30 轮通过 |
| browser 全包 `-race` | 显式重置完成后：169 pass、2 skip、0 fail，无 DATA RACE 报告。两个跳过项为需要 Windows symlink 权限的 `TestProfileScanFindsPortFile`、`TestDiscoverViaJSONVersion` |
| tools 浏览器相关 `-race` | 49 pass、0 skip、0 fail；含 `TestBrowserExecReset*` 的协议调用链与等待超时 |
| `TestExtensionRealChrome` | 真实测试自有 Chromium 执行通过；包含显式重置后重新连接 relay、同 pin 目标与测试 cookie 内容保留，新脚本仅一次 |
| K-brain 全量 | 初轮 4451 pass、10 fail、46 skip；其中浏览器分类父/子失败已修正并完成上述 10 轮回归，其余 8 项有无补丁基线复现证据；不宣称整套全绿 |
| LiveAgent 12 批前端/Node 测试 | 初轮 4515 项：4504 pass、10 fail、1 skip；失败的基线与重跑结论见下节 |
| GUI、Gateway WebUI build | 均通过，含 TypeScript 检查 |
| GUI、WebUI lint | 原命令受 Windows `lineEnding:auto` 影响，要求将 LF 改 CRLF；显式按仓库 LF 规则检查分别 352 / 154 个文件，均通过，无源码格式化 |
| Rust `cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests` | 通过，仅已有 warnings |
| `go -C crates/agent-gateway test ./...` | 全部通过 |
| `node scripts/check-mirror.mjs` | 通过 |
| `node --test scripts/release/prepare-kbrain.test.mjs` | 5/5 通过，含开发覆盖与 release 拒绝覆盖 |
| 两仓库 `git diff --check` | 通过；提交前须再次检查 |

LF 检查命令为 `pnpm --dir crates/agent-gui exec biome check src/ --line-ending=lf` 和对应 WebUI 命令。仓库 `.gitattributes` 明确使用 LF；本轮未改 Biome 配置或批量转换无关文件。

### 全量失败的无补丁对照

独立代理将 K-brain 当前 HEAD 归档为无补丁快照，核对 1282 个 Git blob 全部一致，再用相同 mise 工具链和隔离环境执行定向测试。对照源码未修改，未将失败归因于浏览器补丁。

| 无补丁基线失败 | 证据与重跑结论 |
|---|---|
| cmd/kn ExecutableIntegration、DefaultModeIgnoresStdinEOF | health 未就绪；日志没有直接打印状态码，不能推定也是 401 |
| cmd/kn ParentExitCancelsActiveSSE、InvalidImageConfig | 前者创建 session 返回 401；后者 `/v1/health` 返回 401 |
| backend FilesystemRootConfinementAndText | Windows symlink 权限不足 |
| planning PersistenceCASIdempotencyAndRollback | Windows 文件权限 `0600` 断言失败 |
| tools ManagedProcessWaitCursorAndStop、RealHTTPProviderFileLoop | 两项初次失败，后者明确为 PowerShell 不识别 `printf`；仅子进程指定 Git Bash 后 2/2 通过 |
| LiveAgent permission 两个 shell 用例、trajectory 两个 bash 用例 | 无补丁同样失败；仅子进程指定 Git Bash 后对应套件 10/10、7/7 通过 |
| LiveAgent planning timezone | 首次 POST 401 在无补丁 baseline 复现 |
| Edge measure | 独立三轮全部通过，初轮偶发失败未复现 |
| native upload marker、planning lazy migration 两个前端断言 | 单独重跑相关两文件，13/13 通过 |

本地忽略证据位于 `.liveagent/baseline-go-results.json`、`baseline-go-failures.jsonl` 与 `baseline-results.json`。不把整个 tools 套件统一改成 Git Bash：其中一些测试明确使用 PowerShell 语法，这样做会引入反向环境失败。

## 开发集成与真实桌面结果

本地 `start-tauri-dev.bat` 从任务 worktree 启动，端口 1442，与 Tauri devUrl 一致；脚本由 `.git/info/exclude` 忽略且 `git ls-files -- start-tauri-dev.bat` 无输出。其他任务服务及正式客户端不停止、不替换。

`LIVEAGENT_KBRAIN_BINARY` / `LIVEAGENT_KBRAIN_COMPUTER_BINARY` 指向本 worktree `.liveagent/kbrain-browser/` 的源码构建。`prepare-kbrain.mjs` 复制并校验实际 SHA-256；其收据的 sourceRevision 来自发行锁，不能冒充本地 dirty 源码 revision。

最终构建已包含显式重置。构建前后 dirty 源码指纹一致，为 `DBD6B1513383F68155A72B9B2C3DFDF6E001139FD08F77FE20F8485B045A84F8`；backend SHA-256 为 `CA74287B8A82D0818F529F02225AB79187C19408AE59CCEA3E5998E0DCA98976`，helper 为 `1AD6B2AE4FB1A2FDCDD6F34B5633B16180FE04F5865F314D45E951B9CF346359`。最新验收客户端 PID 69428 的实际映像为本 worktree `target/debug/liveagent.exe`，其 backend 子进程 PID 60968 来自上述构建目录，1442 前端返回 HTTP 200，原生窗口正常响应。此前就绪等待器误用了 `crates/agent-gui/src-tauri/target/debug/liveagent.exe`，该等待器的超时不表示客户端启动失败。

用户要求使用现有真实数据与供应商。此前已通过桌面 UI 确认真实数据目录、已有 `RightCode` 和 `gpt-6.1-sol`，并展开实际工具结果完成以下部分验收；这批结果来自新增修正前的构建，不能冒充最终构建验收：

- 日常 live 两轮等待原生授权超时，未取得 target，未观察到静默启动独立 Chromium。成功接管和原 profile 登录态尚未验证。
- 同名 dedicated/headless 实际串页，已由后续源码修正及四组真实浏览器测试覆盖；最终桌面复验已通过，见下表。
- 显式 headless 停止后连续调用可读取原标记；阻塞 JS 在 3 秒 timeout 后返回 deadline、中断提示与前条时间戳，后续新调用保留原 target 和标记。
- 显式 dedicated 原页关闭后返回 target closed，未选保留页；另一命名 headless 不受影响。

不从模型摘要推定通过：须检查客户端展开的原始工具结果。所有自动化浏览器及 profile 为测试自有；这些结果不证明日常 Edge profile 的授权和恢复。

最终构建通过真实供应商完成显式受管模式的桌面复验，已在“轨迹”逐项核对原始 `browser_exec` 结果：

| 最终桌面场景 | 实际结果 |
|---|---|
| 同名模式隔离与连续调用 | `headless:final-check` 的初始 target 为 `24628E1498EEE843FBC232F44D1A1A98`，dedicated 为 `2E627B07FDF3393A2019C3E20438B4CE`；各自标记与 target 连续调用保持独立 |
| 显式重置与普通调用 | `reset:true` 后 headless 新 target 为 `6883CE2AC58DFDA1B0A298759388478B`，新标记及 `count=1`；后续普通调用复用该 target，dedicated 原 target 与标记保持 |
| 重置后的超时恢复 | 2 秒 deadline 返回中断错误与 `deadline-before`，后续调用仍为同 target、标记与 `count=1` |
| 再次重置及副作用不重放 | 再次显式重置后 target 为 `FD62F6BB8AFD0F622230A0DCE2CDAE0B`；阻塞求值先将 `effect` 加一再超时，保留 `deadline-v2`；独立后续调用为同 target，`marker=reset-v2,count=1,effect=1` |
| 主动取消及后续调用 | timeout 为 180 秒的阻塞调用在客户端停止后于 19.74 秒返回 `context canceled`，保留 `cancel-final-2`；后续独立调用仍为 `FD62F6BB8AFD0F622230A0DCE2CDAE0B`，读数为 `marker=reset-v2,count=1,effect=1,cancelEffect=1` |
| 实际运行模式 | 进程检查确认 headless 使用独立的 `headless-profile-final-check` 且带 `--headless`；dedicated 使用 `dedicated-profile-final-check`，没有该参数 |

首轮一项脚本被输入动作混入空格而触发语法错误，未记为通过；修正后已重新执行完整九次调用，并补验上述七次重置和副作用调用。`info()` 没有 targetID，身份检查使用 `tabs()`。页面 `navigator.userAgent` 与浏览器实际模式不能等同，本次以进程参数和自动化的 `Browser.getVersion` 共同核对。上述通过范围不包含日常 live、真实扩展 repin 或 WebUI。

发行锁仍为 v0.107.11 / `b143a82738a80112acd47bd001e6b5d311a13125`。正式产品分发需要先发布包含修复的 K-brain 制品，再更新 LiveAgent 锁；本地开发覆盖不代替发行步骤，未擅自创建 tag 或运行发布流程。

GitHub 只读核对已确认关联问题为 `Stack-Cairn/LiveAgent#1134`（v2.0.2 无法调用当前浏览器）。该问题已于 2026-11-03 关闭，维护者记录此前修复为 K-brain PR #83 / v0.107.10。本任务后续 PR 应解释新增 session 恢复、禁止重放、目标归属与显式重置的范围，并保留当前未验收项；不能把已关闭问题当作本轮实际验收通过，也不能把旧制品版本当作已包含本任务补丁。此次仅查看 issue，没有发布评论、创建 issue 或改动其状态。

## 需求、契约与风险核对

2026-11-04 的独立只读核对使用两个任务 worktree 的实际文件，没有运行测试或修改源码。以下测试名说明对应覆盖位置；通过数字仍以“自动化结果”为准，不能把列出测试名理解为本轮重新执行，也不能把共享通路推定为所有宿主均已验收。

| 需求 | 实现位置（K-brain） | 自动化依据 | 真实验收状态 |
|---|---|---|---|
| live 保留原 profile，不静默 fallback | `internal/browser/browser.go`、`live_connect.go` | `TestLiveFailureDoesNotStartDedicated`、`TestLiveUnavailableDoesNotLaunchDedicated` | 日常 Edge 等待授权超时错误路径已观察；授权后成功接管未通过 |
| 原 session/target 恢复与目标隔离 | `session.go`、`live_targets.go`、`rod_session.go`、`chromedp_session.go` | `TestRodReconnectKeepsEndpointAndTarget`、`TestPreflightReviewChromedpDetachBeforeCall`、`TestPreflightReviewLiveRegistryEndpointAliases` | 真实测试浏览器已通过；日常 Edge 命名隔离与重启未通过 |
| 执行中失效、超时或取消不重放 | `session.go`、`rod_page.go`、`session_errors.go`、`internal/tools/browser.go` | `TestSessionNeverReplaysInterruptedProgram`、`TestPreflightReviewInFlightTargetLoss` | 最终桌面 headless 超时及主动取消通过，计数为 1；WebUI 未通过 |
| 显式模式及显式重置 | `browser.go`、`session.go`、`internal/tools/browser.go` | `TestManagedModeIsolation`、`TestSessionDoFresh*`、`TestBrowserExecReset*` | 最终桌面同名模式隔离、reset 和后续复用通过 |
| extension 原 pin 身份与 repin 后重置 | `ext.go`、`session.go` | `TestExtensionKeepsTargetAfterInitialAttachFailure`、`TestExtensionRealChrome` | 自有测试扩展通过；实际扩展仅观察无 pin 错误路径，repin 未通过 |

### 生产者与消费者

| 生产者 → 消费者 | 更新或不适用的依据 | 测试及覆盖边界 |
|---|---|---|
| Rod/chromedp → session manager | `Backend` 的 `Prepare` / `Invalidate` 由两个驱动实现；准备发生在回调前，回调失败保留输出且只执行一次。见 `internal/browser/browser.go:38`、`session.go:102`、`rod_page.go:13`、`chromedp_session.go:13` | `TestSessionPreparationFailureDoesNotExecuteProgram`、`TestRodPageCallTargetLifetime`、`TestPreflightReviewInFlightTargetLoss` |
| Session → `BrowserExec()` / `browser_exec` | `internal/tools/browser.go:47` 增加可选 `reset`，74 行按显式值选择 `Do` / `DoFresh`；`session.go:75` 在同一 gate 内等待并关闭后清除绑定 | `TestBrowserExecResetSchema`、`TestBrowserExecResetFlow`、`TestSessionDoFreshCloseFailureKeepsBinding`、排队取消测试 |
| 工具定义和结果 → agent、模型及 subagent | `internal/agent/agent.go:374` 注册实际定义；`tool_execution.go:106` 传递原始参数；`internal/tools/tools.go:137` 保留 partial 与 Failed/Cancelled；subagent 使用同一工具并过滤禁用项（`subagent.go:122`） | 现有 `TestBrowserExecReachesModel`、`TestExecuteResultPreservesStructuredStatus`；没有识别到 subagent 专项 reset/recovery 测试 |
| 共享 runtime → `kn run` | `cmd/kn/run.go:151` 初始化 runtime，再按 availability 创建 agent | 现有 `TestToolRuntimeInitializationAndDisabledTools`、`TestToolRuntimeBrowserExecRealChrome`、`TestRunJSONToolEvents`；没有 CLI 专项浏览器中断/reset 事件测试 |
| 共享 runtime → HTTP agent runs | `cmd/kn/backend.go:88` 初始化；`internal/backend/server.go:1543` / 1546 保留原始参数、文本、content、failed 与 cancelled | 使用共享工具与 runtime 测试；没有 HTTP 专项浏览器恢复/reset 事件测试，不据此声称前端已通过 |
| 共享 runtime → ACP | `cmd/kn/acp.go:46` / 77 初始化并创建 agent；`internal/acp/translate.go:79` 转交输入，101 / 112 保留错误文本与 content | 现有 `TestToolKindMap`；没有 ACP 专项部分输出/reset 恢复测试 |
| agent 事件 → TUI | `internal/tui/tui.go:936` 初始化 manager，1769 / 1781 保留参数；`internal/tui/browser.go:12` 从 code 注释提取标题，53 行委托 manager 切驱动 | 现有 `TestBrowserStepLabel`、`TestBrowserDriverPalette`、`TestToolResultFullyVisibleWhenExpanded`；没有 reset 专项标签或中断渲染测试 |
| 工具 schema 与对话 → routing / failover | `internal/agent/agent.go:654` / 661 传入当前工具定义；`internal/routing/failover.go:271` / 328 的重试边界只包围 provider `Complete` / `Stream`。tool-call delta 提交流后不再切 provider（349 / 356 / 375）；provider 成功后才在 `agent.go:699` 调用 `runTools`。因此该边界不重新执行 browser 回调 | 现有 `TestFailoverDiscardsPreCommitHTTPFailure`、`TestFailoverDoesNotRepeatAfterCommittedDelta`、`TestFailoverCancellationDoesNotStartFallback`，以及 provider 的 `TestStreamDoesNotRetryAfterToolCallRow`。没有 browser 专项 failover 集成测试；模型后来主动提出新动作属于新的工具调用，不等于 provider 自动重放 |
| 原生 browser → 独立 MCP server / HTTP MCP routes | 不适用：`internal/mcp/serve.go:14` 仅注册不含 browser 的 `tools.All()`；`internal/backend/mcp.go:54` / 67 使用 `s.mcp.ToolsFor`。HTTP agent runs 仍按上行使用原生工具 | 不把 MCP 路由当作原生 browser 的消费者，不要求为未注册工具新增恢复测试 |
| HTTP 事件 → LiveAgent 桌面、Gateway 与 WebUI | 后端生产契约已核对；这次有界核对没有穷举 sibling 的每个 adapter 或证明所有显示路径 | 最终桌面原始轨迹有实际证据；WebUI 登录前被 Cua 拒绝，Gateway/WebUI 恢复专项验收仍缺失 |
| 行为 → `docs/liveagent-backend.md` 与现有兼容说明 | HTTP 契约更新不适用：本任务没有新增 HTTP endpoint 或 envelope 字段；该文档未定义 `browser_exec` helper 参数与恢复/reset 契约。`reset` 属于 `BrowserExec()` 动态提供的工具 schema，既有 HTTP 事件保留原始参数。本计划记录行为与边界，现有兼容矩阵的 partial 状态未提升 | 文档不代替运行验证；正式发布还受发行锁约束 |

### 八项风险

| 风险 | 证据或未覆盖边界 |
|---|---|
| 模式、配置与显式选择的优先级 | 有 `TestSessionModeSelection`、`TestSetDriverEnvPinWins`、`TestLiveFailureDoesNotStartDedicated` 覆盖。显式 session 前缀决定模式；extension 先于 engine 分派；live 失败直接返回，不以 dedicated 替代 |
| 并发、重入与迟到操作 | 有 `TestSessionCloseWaitsForActiveProgram`、`TestSessionDoFreshWaitsForProgramAndHonorsCancellation`、`TestLiveTargetClaimIsAtomic` 覆盖；session gate 串行化执行、reset 和 drop，目标归属在进程级互斥锁内原子登记 |
| 身份与键 | 有 `TestRodReconnectKeepsEndpointAndTarget`、`TestRodClosedTargetDoesNotSelectAnotherPage`、`TestRealSessionBrowserRestartKeepsOriginalIdentity`、端点别名测试覆盖。保存原 accepted endpoint 与 target，以 browser UUID 归并别名；不能把新浏览器端口或随机 sessionID 当作原身份 |
| 对抗性输入与脚本副作用 | 有 `TestSessionInvalidatesOnlyKnownProtocolFailures`、`TestSessionNeverReplaysInterruptedProgram`、执行中 target loss 测试覆盖。错误分类使用协议类型与精确代码/消息；页内任意字符串不作为重放依据。此前独立对抗复审修正后未发现可证实的 P0/P1/P2；本次未重复该复审 |
| 平台 | Windows 真实执行与自动化证据如前文。未建立完整 Windows/macOS/Linux 日常 profile 验收矩阵；部分现有测试没有显式浏览器路径时会 skip，不能把可构建当三平台验收通过。两个 Windows symlink skip 仍单列 |
| 生命周期与回滚 | 有 `TestSessionKeepsBoundTargetAfterStartupAttachFailure`、`TestRodClosedDuringAttachNormalizesError`、`TestRodPageCallReleasesCallContext`、`TestRealSessionFirstCallCancellationDoesNotPoisonNextCall`、`TestConnectLiveCancellationRemainsCancellation` 覆盖。调用取消优先，启动 attach 失败保留绑定，Close 失败不清除原状态 |
| 可选子系统 | 有 `TestToolRuntimeInitializationAndDisabledTools`、`TestBrowserExecNoManager`、`TestExtensionNamesCannotSilentlySharePinnedTab`、`TestExtensionKeepsTargetAfterInitialAttachFailure` 覆盖。禁用时不注册工具，extension 保持单 pin 约束；真实 repin 仍未验收 |
| 用户可见文案与状态 | 工具描述说明保留原 target 与显式 reset；关闭错误指向新 session，执行失败返回 partial 与未重放提示。有 `TestSessionNeverReplaysInterruptedProgram`、`TestRunBrowserCodeStatementError`、`TestRunBrowserCodeNeutralizesOnError` 覆盖。TUI/ACP/LiveAgent 各专项恢复呈现仍非完整验收 |

显式重置的执行顺序另需保留：`internal/tools/browser.go:85` 在 session 回调内解析 helper，`session.go:88` 在此之前执行用户明确要求的 reset。按工具当前“先释放旧绑定，再运行本次代码”的定义，非空但语法错误的脚本也可能已经重置，报错不会恢复旧绑定；空白代码则在选择 session 前拒绝。没有识别到 malformed-helper + `reset:true` 专项测试，不将这一顺序问题标为已覆盖或新增严重性结论。本轮没有为此改动产品行为。

因此，契约生产与 Go 共享通路有证据，全部宿主专项验收及三平台矩阵仍不完整；不宣称完整预检全绿。用户接受这些已报告的限制后，按明确指令继续 PR 交付。

## 真实扩展探测与 WebUI 阻塞

2026-11-04，最终桌面构建通过真实供应商调用 `extension:final-ext-check`。调用等待 10 秒后明确报告当前 relay 没有已 pin 标签页。这只覆盖无 pin 页的错误路径；不证明扩展未安装，也不构成实际扩展 pin、repin 或 reset 验收。测试自有扩展的自动化通过范围仍如前表所述。

WebUI 集成使用本 worktree 的 `crates/agent-gateway/web`，不是桌面开发页 1442。桌面 Remote 设置显示原 Gateway 端口 50052 被其他进程 PID 45048 占用；未停止该进程。通过设置 UI 将验收客户端临时改为 47443 后，桌面显示“已连接 (v2)”。WebUI 以 `npm_config_proxy_api=http://127.0.0.1:47443`、`--host 127.0.0.1 --port 47444 --strictPort` 启动，Vite 日志确认 ready。服务 ready 不能作为页面渲染或端到端通过的证据。

通用浏览器工具首次访问 localhost 被私网策略拒绝，未修改 `browser.allowPrivateUrls`。随后用户明确授权 Cua 自有独立浏览器访问这两个本地端口，并允许通过客户端复制令牌登录；此授权不包含日常 profile。Cua 启动独立 Edge PID 49968 并 exact bind 到空白页。使用该绑定调用正式 `browser_navigate` 到 47444 时，运行时拒绝：`protected_resource_scope_invalid`，消息为 `the browser operation requires an explicit session`。重新核对接口 schema：`session` 不是必填参数，声明明确支持省略后使用 authenticated transport 的隐式生命周期会话；实际拒绝与该声明不一致。宿主同时要求会话由它管理、调用省略 session，故未自行创建会话、补传 session 或切换通道绕过该拒绝。未复制、读取、输出或写入 Gateway 令牌，未完成 WebUI 登录及工具调用。

阻塞出现后通过同一桌面设置将 Gateway 恢复为原值 50052，关闭后重开配置弹窗确认仍为 50052；端口检查确认 47443 不再监听。停止了本次 WebUI 开发进程，47444 不再提供本任务服务。50052 原占用进程保持不变，恢复配置不表示该验收客户端在原端口已成功连接。构建收据 `.liveagent/browser-final-build-evidence.json` 已由历史 `launching` 状态更新为就绪、验收部分完成，并补入主动取消和 WebUI 阻塞的结构化记录；构建哈希、源码指纹与测试计数保持原值。实际窗口与子进程就绪证据见“开发集成与真实桌面结果”。

## 尚未完成与外部阻塞

- 日常 Edge 原生“是否允许远程调试?”需用户或受支持的可信宿主处理。Cua 另返回 `browser_consent_required`，要求启动时 `existing-profile` grant 或授权宿主；普通桌面操作授权不等于该 grant。未代点或绕过。
- 日常 profile 的成功接管、登录态、延迟/拒绝授权、live 命名隔离和同 profile 重启仍待实际验收；真实 extension 及 WebUI 集成也不能记为已通过。
- 正式客户端占用旧 LiveAgent 扩展桥 19222 曾使调试客户端报端口冲突。它与 K-brain relay 不是同一条链路，不能据此断言 K-brain extension 不可用。
- 早期广泛测试曾继承宿主 `LIVEAGENT_HOME`，日志显示 `browser install` 写入真实数据根的扩展文件，MCP 测试出现 `config.json.tmp: is a directory`。已停止这类测试并改用隔离环境；真实目录读取被工具拒绝，未擅自清理、恢复或复制凭据，不能声称配置没有变化。
- 剩余日常 live / extension 桌面验收和 WebUI 集成仍未实测。用户于 2026-11-04 明确反馈“先通过，推送PR”，接受已记录的限制并要求继续交付；本次据此提交和推送，required CI 另行跟进，不把该决定或 CI 启动写成全场景验证通过。
