# v2-kbrian 与 main 功能测试报告

## 2026-10-06 真实 MCP 与缓存联合验收

- [完整记录](2026-10-06-real-mcp-cache-acceptance.md)：桌面 gpt-6-luna 实际调用官方 filesystem MCP，更新随机文件后再读取，以及写入/读回通过。
- 3轮对话、4次MCP调用、7次模型请求；供应商报告48,640/74,476输入tokens命中，累计65.31%，桌面显示65%并在历史重开后保留。
- 本次补齐本地stdio MCP读写的正向验收，不代表远程MCP/OAuth及所有工具已通过。测试服务已禁用并保留配置。

## 2026-10-06 gpt-6-luna 桌面操作验收

- [桌面实测与修复记录](2026-10-06-desktop-luna-acceptance.md)：真实聊天、重试、编辑、分支、停止、旧历史、日程创建/完成/删除、终端执行。
- 重现并修复重试准备阶段遗漏的 revision conflict 重载；消息内容变化时拒绝盲目重放。
- 默认模型切为 `gpt-6-luna` 并真实收到回复；另两个供应商模型实际报错，未宣称全模型可用。
- 下方历史“命令通过”数量包含预期拒绝及接口层检查，不能等同于完整功能可用率。设置页导航不代表功能端到端通过，真实外部连接和未执行流程仍待验收。

## 2026-10-06 通知、原生拖拽、双向时区继续验收

- [详细报告](2026-10-06-planning-notifications-sync-macos.md)：macOS 原生通知接口、授权与错误处理、测试按钮；真实到期提醒有系统 banner 展示日志。禁用通知不再领取提醒或伪造成功。
- K-brain `b1e0747` 统一日程时区 preference/revision，三端选择器双向同步、自动模式、旧版本冲突、重启持久化通过；原生保存其他系统设置不再覆盖日程时区。
- 原生 WKWebView CoreGraphics 鼠标拖拽通过；真实 Google 官方公共 ICS 导入 30 条。iCloud/Exchange 未提供测试地址，仍待真实账户验收。
- GUI 2964 通过/1 跳过，Gateway 769/769，Rust 日程 28 通过/1 忽略，Go 全量/race/vet、前端构建和类型检查通过。
- 本次更新前一轮对应待办状态，不代表私有账户同步、正式签名包或全部 main 功能已完成。

## 2026-10-06 日程补齐与 Mac 实机验收

- 详细记录：[日程补齐与 macOS 实机验收](2026-10-06-planning-followup-macos.md)。该增量更新下方旧报告中“RDATE/DURATION/VTIMEZONE 未补齐、浏览器时区未实现”的状态，不表示全部历史待办已完成。
- K-brain `ade5f3c`：订阅 recurrence 合集、PERIOD、DURATION、自定义时区与 DST、错误刷新原子保留。LA 修复 RDATE-only 手动导入漏 DTSTART；浏览器时区保存进入共享后端，失败可重试。
- Mac 真实 WKWebView 订阅/导入；本机 Chrome 直连及 Gateway 导入、去重、拖动、跨端任务同步、1440/390/480 视口通过。后端重启换端口恢复通过。
- GUI **2963 通过 / 1 跳过 / 0 失败**，Gateway **769/769**，三端类型检查、相关 Biome、Go 全量/race/vet 通过。
- 通知横幅、外部日历账户、时区偏好完整双向同步、原生拖拽、安装包升级仍未验收。未改发布附件。

## 2026-10-06 参考 ZCode 收敛传输与运行恢复

- 设计与状态边界见 `docs/design/kbrain-transport-boundary.md`；保留 HTTP/SSE，不进行 stdio/MessagePort 的形式替换。
- Prompt、Trajectory、Hooks、Usage 适配器接入统一传输；聊天和迁移不再固定启动时的地址/token；托管日程和迁移缓存使用稳定 scope，不因随机端口改变而变成另一份数据。
- 恢复等待者独立取消、共享重连；传输错误有稳定 code/cause；SSE 消费失败/取消释放 reader。
- K-brain `3ee2e3b` 新增按 client_request_id 查询持久化运行接收记录。前端丢失 ACK 后仅查询，不重发 POST；找到原 run 后继续订阅事件，未知结果仍报告错误。锁文件已更新。
- 前端全量 **2959 通过 / 1 跳过 / 0 失败**，GUI TypeScript、10 个改动源码 Biome 通过。K-brain 全量、backend race/vet 通过。
- 真实 HTTP 故障注入：丢弃运行 POST 响应，查询找回同一 run，模型工具链完成；断言一次 POST/一次查询，无重复 Read。上游为本地 fixture，不是外部模型验收。
- 新后端真实桌面重启与换端口恢复通过；Cron/Memory/MCP/Skills/Planning、1440/480 视口、日程 26 项及历史命令 22/22 通过。日志与脚本见设计文档验证节。
- 通用命令队列、完整 snapshot/delta、跨设备 owner/lease、其他剩余领域迁移不在本轮完成范围内。没有改标签或发布附件。

## 2026-10-06 后端重启后的 Load failed 修复

- 在真实 WKWebView 的日程页复现 `Load failed 重试`：原 sidecar 重启后端口和 token 改变，前端运行时仍缓存旧连接。页面仍显示旧日程数据，不能以“页面有内容”判定请求正常。
- 增加统一 HTTP transport：默认桌面连接出现网络失败或 401 后，通过原生连接命令重新取得当前端口/token；并发恢复共享同一次连接请求，客户端每次请求读取最新连接。
- 日程只读 query/export/cron.occurrences、定时任务 GET、通用客户端 GET 最多自动重试一次。写入失败只刷新连接、不自动重放；显式指定的外部地址、浏览器连接、取消操作、409 等业务错误不会触发桌面重连。
- 新增 6 个回归用例；相关测试 **118/118**，GUI TypeScript 和改动源码 Biome 检查通过。
- 真实桌面故障注入：主动终止测试 sidecar，确认新端口启动，日程无需重启应用恢复；Cron/Memory/MCP/Skills/Planning 页面没有 Load failed；1440×900、480×844 视口通过。日志 `/tmp/la-reconnect-browser.log`，脚本 `/private/tmp/desk/reconnect-verify.mjs`。
- 修复位于 LiveAgent 前端，不需改 K-brain。没有更新 beta 发布附件。

## 2026-10-06 第二轮缺项补齐

K-brain 锁文件更新为 `96b6a3cd30ac7bb6f2ed51267e360ef03187612f`，供应商适配继续集中在后端。本节覆盖上一轮列出的请求兼容与只读历史缺项，不把下方旧测试计数当作本次重跑结果。

### 已实现

- Chat Completions 推理文本的持久化/同协议同 endpoint 同模型回放、重复工具名、模型专属思考参数、`max_completion_tokens`。
- Responses encrypted reasoning items 回放、终态去重、include 合并、Grok/xAI cache/reasoning 字段清理。
- Gemini thinkingConfig、parametersJsonSchema、工具图片、连续角色合并、版本路径及拦截/错误终态处理。
- `reasoning: off` 不再在 backend 丢失；按协议显式关闭。不支持关闭的模型降为最低支持档位，不能宣称完全停止内部推理。
- 删除全部配置模型后仍能读取历史；消息、revision、分页 offset 使用同一快照。继续推理仍须配置可用模型。
- Windows TerminalSession 原生 ConPTY、Job Object、取消/缩放/退出码；已补测试并交叉编译，尚未 Windows 实机验收。Unix Resize/Close 的数据竞争已修复。

### 本次验证

| 范围 | 结果 |
| --- | --- |
| K-brain 全量 `go test -p 1 ./...` | 通过 |
| AI/protocol/backend/tools race；相关包 vet | 通过 |
| Windows amd64 tools/backend 测试交叉编译、tools vet；amd64/arm64 CLI 构建 | 通过；未运行 Windows 测试程序 |
| LiveAgent 请求/历史/revision conflict/provider settings 回归 | 25/25 |
| 源码 sidecar 构建/准备/打包契约测试 | 13/13；未执行发布 |
| 真实 runKBrainTurn → 新后端 → 本地 Anthropic fixture → Read → 签名回放 | 通过；不是外部供应商验收 |
| 新 sidecar 的真实 WKWebView | Cron/Memory/Skills/MCP/Planning 导航、健康检查、1440/480 视口通过 |
| 桌面终端与文件操作 | 创建、输入、标记读回、缩放、重命名、关闭及文件读写通过 |
| 桌面历史命令 | 22/22 |
| 日程回归 | 26 项断言通过：重启恢复、CRUD、冲突、幂等、回收恢复、cron 图层及两档视口 |

实际测试 sidecar 路径为 `crates/agent-gui/src-tauri/binaries/k-brain-aarch64-apple-darwin`，最终二进制 SHA-256：`d7d46f6b5dd95645489f7c9d93f3fe616a5cff5475cb92de0cbabdeb6e2c665c`；已终止旧后端并由真实桌面重新启动。测试使用 `/tmp/la-desktop/home`，没有替换用户正式配置。

详细实现、日志路径及限制见 `K-brain/docs/2026-10-06-provider-compatibility-followup.md`。桌面日志位于 `/tmp/la-remaining-{desktop,terminal,history,planning}.log`，前端测试为 `/tmp/la-remaining-frontend.log`。

### 仍未完成的范围

- 真实供应商及完整多轮原生搜索；模型别名/中转站的字段容忍度。
- Windows 真机 ConPTY/进程树/WSL sandbox；`bashrun` 独立 interactive 模式尚未接入新 ConPTY。
- 下方既有审计中的独立 TUI 日程工具、特殊 ICS、通知、浏览器全局时区和完整压缩重构；本次保持已有日程迁移，没有宣称全功能完成。
- 签名安装包、升级迁移、全部 main/v2 功能重验。本次没有修改标签、发布附件或触发发布工作流，现有 `v2.0.0-beta.1` 附件不包含这次新代码。

## 2026-10-06 请求兼容性增量验证

本次将 K-brain 锁定为 `d303a06`，保持 provider 请求构造在后端：

- 修复 Anthropic adaptive thinking、旧模型预算超限、签名和 redacted thinking 的后端持久化/同 endpoint 同模型回放，以及内置搜索 JSON 分片导致的流中断。
- 编辑历史保留现有运行时能力，避免使用已删除模型重建 agent，同时避免丢失工具和记忆配置。
- 前端增加 session/run 请求体测试，确认自定义 provider ID 原样传递、`reasoning: off` 到达后端、当前用户消息不会重复导入历史。
- 相关前端测试 **25/25**；GUI/Gateway TypeScript 均通过。测试目录被现有 Biome 配置忽略，未将该文件的 Biome 检查记为通过。
- K-brain 全量 `go test -p 1 ./...`、AI/protocol/backend race 检查、CLI 编译及帮助入口均通过。
- 真实前端 `runKBrainTurn` 调用本次编译的后端，经本地 Anthropic HTTP fixture、真实 Read 工具和带签名的后续请求完整跑通。日志 `/tmp/kbrain-compat-live.log`，脚本 `/private/tmp/desk/compat-live.mjs`。
- macOS 真实 WKWebView 再次检查 Cron、Memory、Skills、MCP、Planning 导航，Planning 在 1440/480 视口无横向溢出；日志 `/tmp/la-compat-desktop.log`。桌面进程仍加载基线 sidecar，本次新内核的验证是前述独立端到端测试。
- 核对 `v2.0.0-beta.1` 已是 prerelease，8 个附件名称、大小和 GitHub SHA256 digest 均与 `v1.3.8-beta.8` 对应附件一致。本次没有改标签、上传附件或触发发布工作流。

**剩余项**：Chat Completions/Responses reasoning 回放和专属参数、Gemini 请求兼容、各协议显式关闭思考、零可用模型时的独立历史读取、真实供应商与新桌面 sidecar 验收、Windows PTY。日程已有迁移保持不变，本次没有宣称全部 main/v2 功能重新验收完成。

后端完整进度：`K-brain/docs/2026-10-06-provider-compatibility-followup.md`。下方计数与截图保留为此前测试基线，不是本次重新全量执行的结果。

- **测试日期**：2026-10-05 至 2026-10-06（Asia/Shanghai）
- **测试仓库**：LiveAgent
- **测试提交**：原桌面全量命令基线为 `510b5a25` / 代码 `1105ae43`；日程测试针对基线 `d13a21d1` 之上的本次 `feat(planning): port calendar and tasks to v2 desktop` 提交内容。
- **对比基准**：`origin/main` HEAD `8e8cf46f`；共同祖先 `e63588a1`
- **提交差**：本次日程提交前，v2 领先 main `62` 个提交、main 领先 v2 `19` 个提交（日程以适配后的新提交移植，原 main 提交仍在差集中）。
- **K-brain 侧**：日程后端提交 `45d34c3` + 空提醒轮询修复 `550a410`；旧发布标签仍为 `v0.107.4`，本轮未创建标签。
- **报告目的**：验证 main 已有功能在 v2 分支是否存在、可测试、可用，列出不能使用或尚未补齐的功能，并记录本轮修复。

> 本报告替代此前 `6091a16e` 版本。此前版本基于一个错误环境（混入 `typescript@5.4.5`）得出"TypeScript 4 个错误"的 P0 结论，并声明浏览器验证未执行；两者均已在本轮澄清。

> 2026-10-06 日程更新：已移植 `75d582c5` 的日程主体并适配 v2。下方原有计数是移植前基线；最新测试结果、已验证范围与限制见「日程移植验证」。

## 原基线结论（最新日程结果见迁移验证）

v2 当前**全部自动化测试通过、类型检查通过、代码质量检查通过**，并在真实浏览器中完成了端到端验证。

1. LiveAgent GUI 全量 Node 测试：`2902` 个测试，`2901` 通过、`0` 失败、`1` 跳过。
2. Gateway WebUI Node 测试：`475/475` 通过。
3. Gateway Go 测试：`go test ./...` 全部通过（21 个包）。
4. K-brain Go 测试：`go test ./...` 全部通过。
5. 发布/脚本测试：`42/42` 通过。
6. Tauri Rust 库测试：`1058` 通过、`0` 失败、`4` 忽略。
7. TypeScript 检查（仓库锁定的 TS `7.0.2`）：`agent-ui`、`agent-gui`、`gateway-web` 三个包全部 `0` 错误。
8. Biome 检查：`1015` 个文件，`exit 0`，无错误无警告。
9. 浏览器端到端验证：已执行，覆盖聊天收发、旧会话加载、编辑重发、Skills/MCP/定时任务/记忆/设置各页面、项目工具能力边界、桌面与移动两种视口。
10. 桌面端（Tauri）实机验证：已执行。在真实 macOS 桌面进程里跑通 `311` 个注册命令中的 `309` 个（`323/323` 断言通过），并驱动真实 WKWebView 完成页面导航与输入区交互。

**日程的 K-brain 后端存储和后端模型工具已接入**（见下方迁移验证）；上下文压缩重构仍未补齐。上游缓存隔离修复在 v2 已有等效实现，见下。

## 测试结果汇总

| 测试项 | 结果 | 说明 |
| --- | --- | --- |
| LiveAgent GUI 全量前端 Node 测试 | ✅ 通过 | 2902 个中 2901 通过、1 跳过 |
| LiveAgent Gateway `go test ./...` | ✅ 通过 | 21 个包全部 ok |
| K-brain `go test ./...` | ✅ 通过 | 所有 Go 包通过 |
| Gateway WebUI Node 测试 | ✅ 通过 | 475/475 |
| 发布/脚本测试 | ✅ 通过 | 42/42 |
| Tauri Rust 库测试 | ✅ 通过 | 1058 通过、4 忽略 |
| TypeScript 检查（TS 7.0.2） | ✅ 通过 | 三个包均 0 错误 |
| Biome 全量检查 | ✅ 通过 | 1015 文件，无错误无警告 |
| K-brain 二进制与锁文件一致性 | ✅ 通过 | 8 个 artifact 的 sha256 与发布页 SHA256SUMS 一致 |
| 浏览器端到端验证 | ✅ 通过 | 见"浏览器验证证据" |
| 桌面端（Tauri）命令验证 | ✅ 通过 | 309/311 个命令实机跑通，323/323 断言 |
| Windows 实机验证 | ⏸ 未执行 | 无 Windows 环境；相关移植代码与脚本测试已在 macOS 通过 |

## 本轮修复

### 1. 旧会话报 "unknown model"（已修复并验证）

- **K-brain 提交**：`7604d22 fix(history): load sessions after model removal`
- **原因**：会话记录里保存的模型被删除后，`loadRuntimeByID` 直接按该模型解析供应商，找不到同厂供应商即 500。
- **修复**：解析失败时回退到 `fallbackModel()`。
- **证据**（同一会话 `78f0deea`，其记录模型 `third-model` 已从配置中删除）：

| 后端 | 版本 | `GET /v1/sessions/78f0deea/history` |
| --- | --- | --- |
| `127.0.0.1:47411` | v0.107.3 | **500** `no configured same-vendor provider for model "third-model"` |
| `127.0.0.1:47412` | v0.107.4 | **200** |

浏览器中打开该会话：历史与轨迹均 200、无页面错误；在其中继续发消息同样成功（GUI 使用当前模型胶囊，而不是会话里过期的模型）。

### 2. 删除模型后配置文件残留（已修复并验证）

- LiveAgent `crates/agent-gateway/internal/kbrain/settings.go:338` 在供应商被替换时清理过期默认值；K-brain `applySettings` 在当前 `(defaultProvider, defaultModel)` 不在投影中时重新选取默认值。
- 浏览器实测：供应商设置 → 编辑 Mock Relay → 删除模型 → 保存，`PUT` 返回 200、磁盘配置被重写、默认模型自动迁移到 `legacy/legacy-model`，旧会话历史仍为 200。

### 3. 对话 revision conflict 不再中断（已修复）

- **LiveAgent 提交**：`aab40bce fix(kbrain): reload history and unblock v2 checks`
- 新增 `isKBrainRevisionConflict`、`findReloadedMessageRef`、`reloadConversation`，接入 `replaceConversationAtMessage`、`loadEarlier`、`useBranchConversation`。
- 新增测试 `crates/agent-gui/test/chat/history-revision-conflict-reload.test.mjs`（8/8）。
- 浏览器实测编辑重发：`POST /v1/sessions/b4d9aa1e/branch`（201，分支创建）→ `POST /edit` → `POST /runs`，全程无冲突报错。

### 4. 桌面宿主能力缺失时不再泄漏内部诊断（已修复）

浏览器宿主（K-brain backend + WebUI）没有 `terminal_*` / `fs_*` / `git_*` / `gateway_tunnel_*` 这些桌面命令，之前每个项目工具入口各自把 Tauri 内部诊断（`Tauri command X is unavailable in K-brain browser mode`）直接渲染给用户。

- **提交**：`02416eea fix(ui): localise missing desktop-host capabilities`、`ad0fbb26 fix(ui): gate project tools behind desktop-host capability`
- `crates/agent-ui/src/lib/shared/hostErrors.ts` 新增 `hostAwareErrorMessage(error, unavailable, fallback)`：宿主能力缺失 → 调用方本地化文案；真实失败（权限/路径/网络）原样透出。
- `ChatPage` 拆分"用户可自行解决"（Agent 模式 / 选项目）与"当前运行面没有桌面能力"两类提示；浏览器宿主下项目工具整区标记不可用，头部按钮保持可点开。
- 内网穿透改为按宿主注入 client（`projectToolTunnelClient`），入口按能力置灰。
- 终端 / 文件树 / Git 审查 / SSH / 后台任务 / 内网穿透的每个 catch 全部走统一出口；Gateway WebUI 侧原先的英文硬编码同样接入 i18n。
- 新增 zh/en 文案：`desktopHostRequired`、`desktopTerminalOnly`、`runtimeUnsupported`、`settingsSyncing`、`webTerminalDisabled`、`webGitDisabled`、`collapsePanel`/`expandPanel` 等。

修复前实测（面板真实打开、1440×900）：

| 工具入口 | 修复前泄漏 | 修复后 |
| --- | --- | --- |
| 新建终端 | `Tauri command terminal_create is unavailable in K-brain browser mode` | 中文原因，无泄漏 |
| 新建文件树 | `Tauri command fs_list is unavailable in K-brain browser mode` | 中文原因，无泄漏 |
| 新建 SSH 连接 | `Tauri command terminal_ssh_local_forward_list is unavailable in K-brain browser mode` | 中文原因，无泄漏 |
| 新建审查 / 新建内网穿透 / 后台任务 | 无泄漏 | 中文原因，无泄漏 |

同一类问题在设置页里还有三处，本轮（`1105ae43`）一并修掉——这些入口只有点了按钮才会暴露，所以逐页遍历时容易漏掉：

| 入口 | 触发命令 | 修复前泄漏 | 修复后 |
| --- | --- | --- | --- |
| 关于 → 检查更新 | `app_update_check` | `Tauri command app_update_check is unavailable in K-brain browser mode` | 中文原因，无泄漏 |
| 关于 → 预览更新公告 | `app_release_announcement_preview` | `Tauri command app_release_announcement_preview is unavailable in K-brain browser mode` | 中文原因，无泄漏 |
| 备份与同步 | `settings_backup_load_sync_config` | `Tauri command settings_backup_load_sync_config is unavailable in K-brain browser mode` | 中文原因，无泄漏 |
| SSH → 导入 | `fs_roots` | `扫描失败: Tauri command fs_roots is unavailable in K-brain browser mode` | 中文原因，无泄漏 |

- `AboutSection.tsx` 删除本地 `errorMessage`，检查更新 / 查看公告 / 预览公告的 catch 改走 `hostAwareErrorMessage(error, t("settings.aboutDesktopHostRequired"))`。
- `BackupSyncSection.tsx` 的 `errorText(error)` 增加 `unavailableMessage` 参数并统一走 helper，覆盖读取配置、保存、上传、下载、导出、导入六条路径。
- `SshSection.tsx` 的导入扫描 catch 改走 `hostAwareErrorMessage(scanError, t("settings.sshImportDesktopHostRequired"))`。
- 新增 zh/en 文案 `settings.aboutDesktopHostRequired`、`settings.backupSyncDesktopHostRequired`、`settings.sshImportDesktopHostRequired`；新增回归测试 `crates/agent-gui/test/shared/host-command-unavailable.test.mjs` 两条（设置页出口 + 双语文案），该文件现为 `7/7`。

### 5. K-brain 运行时版本锁定（已完成）

- `scripts/release/kbrain.lock.json` 由 `555a920`/`v0.107.3` 更新为 `7604d22`/`v0.107.4`。
- 8 个 artifact 的 `sha256` 全部与发布页 `SHA256SUMS` 逐一核对一致。
- `scripts/prepare-kbrain.mjs --target aarch64-apple-darwin` 成功，产物 `-version` 输出 `k-brain v0.107.4`。

### 6. 发布

- LiveAgent `v2.0.0-beta.1` prerelease 已发布，tag 指向 `2a60137a`，8 个资产复制自 `v1.3.8-beta.8`，未重新构建。
- 发布说明已更新为包含本轮修复（`gh release edit --notes-file`），仍为 prerelease、8 个资产、digest 未变。
- **注意**：`v2.0.0-beta.1` 的 tag 触发 `Desktop Release` 与 `Gateway Docker` 两条 `push: tags` 工作流。任何对该 tag 的 `git push --force`（包括把它指到新提交再指回来）都会重新触发这两条流水线；本轮误操作触发过两次，均已 `gh run cancel` 取消，未产生新资产，release 与 tag 已恢复到原始状态。后续如需让发布源指向新提交，应改用 `workflow_dispatch` 或另开新 tag。

## 从 main 移植的提交

以下提交已在本轮移植进 `v2-kbrian`（`-x` 保留来源信息，冲突处手工三方合并）：

| v2 新提交 | 来源 main 提交 | 说明 |
| --- | --- | --- |
| `3631760b` | `7659c306` | 刷新模型目录 |
| `30c133da` | `dc892311` | 修复公开地址端口与动态资源路径 |
| `b496d38e` | `6efdc218` | 文本文件跨平台保持 LF |
| `0cc2f346` | `8bd6bc30` | 规范化 Windows worktree 路径 |
| `1b702659` | `a6ff213f` | Windows 下分批执行 Node 测试 |
| `ef69b438` | `419ae859` | 供应商模型列表一键清空 |
| `4a153c66` | `ab388c2b` | Relay 模型 id 的月日后缀匹配 |
| `f6c9019b` | `ee8ff00f` | macOS 窄窗口侧栏为红绿灯让出标题栏高度 |
| `03eedfc2` | `8e8cf46f` | 兼容 2026-07-28 新版 MCP 协议，探测失败回退 `initialize` |
| `16fcaeba` | `fb62575b` | 消息时间戳智能显示年月日（保留 v2 分享弹窗与 rewind 改动） |
| `92567968` | `4b211fe3` | Memory 只看待审核筛选（保留 v2 `loading||error||backendManaged` 守卫） |
| `a650bc37` | —（新增） | 时间戳格式专项测试（5 个） |
| `aab40bce` | —（新增） | revision conflict 自动重载 + 锁文件更新 + 过期测试修正 |
| `02416eea` | —（新增） | 桌面宿主能力缺失本地化 |
| `ad0fbb26` | —（新增） | 项目工具按桌面宿主能力边界收口 |
| `1105ae43` | —（新增） | 设置页（关于 / 备份与同步 / SSH 导入）不再泄漏宿主诊断 |
| `8506dcbe` | —（新增） | 本报告的浏览器证据与设置页修复记录 |

## main 已有功能逐项核对

### ✅ 已确认可用

| 功能 | main 提交 | v2 状态 |
| --- | --- | --- |
| MCP 新版协议兼容与旧协议回退 | `8e8cf46f` | 代码与测试均在 v2；MCP 添加流程浏览器实测 `200 PUT /v1/mcp`（本轮复验列表为 `1/1 已启用`） |
| Markdown 删除线只认 `~~text~~` | `8959a5f2` | 专项 `5/5` 通过 |
| macOS 窄窗口侧栏避让 | `ee8ff00f` | 代码已在 v2；无自动化测试，未在 macOS 桌面端截图验证 |
| 消息时间戳智能显示年月日 | `fb62575b` | 已移植，专项测试 `5/5` 通过 |
| Relay 模型日期后缀匹配 | `ab388c2b` | 代码与测试均在 v2 |
| 供应商模型列表一键清空 | `419ae859` | 已移植，浏览器实测"清空"按钮存在（模型删除后配置清理已单独验证） |
| Memory 未审核筛选 | `4b211fe3` | 已移植，浏览器实测 `待审核` 筛选 `aria-pressed` false → true 且列表过滤生效 |
| Windows Node 测试批处理 | `a6ff213f` | 已移植；脚本测试通过，未在 Windows 实机执行 |
| Windows worktree 路径规范化 | `8bd6bc30` | 已移植；Rust 库测试 1058 通过 |
| 隧道公开地址端口与动态资源路径 | `dc892311` | 已移植；Gateway 隧道测试通过，GUI `gateway-public-url.test.mjs` 在 v2 存在 |
| SSH 同主机连接复用 | `a4895c46` | **已在 v2**：`ssh_session.rs`、`ssh_channel.rs` 与 main 逐字节一致；`sshManagerTools.ts` 仅 import 路径不同（v2 走 `@liveagent/app`）；`ssh-manager-tools.test.mjs` 20/20 通过，含 `session_reused` 断言 |
| 供应商模型列表缓存隔离 | `a51fc99b` | v2 经 K-brain `POST /v1/settings/providers/{id}/models` 取模型，代码已带 `cache:"no-store"`，Rust 代理 `Vary` 已含 `x-liveagent-upstream-origin` 并有 3 个 vary 测试；上游修复在 v2 已等效，无需移植 |
| K-brain 工作区树与迁移 | `6d359b11` | 浏览器实测工作空间页面正常 |
| 回答一键分享 | `8955764e` | 浏览器实测分享 UI 存在（`管理已分享会话（0）`、分享开关） |

### 日程移植验证（2026-10-06，迁入 K-brain 前的历史记录）

- **main 提交**：`75d582c5`（169 个文件、+23046/−279）
- **已移植**：日历日/周/月/日程视图、任务和子任务、日历/列表管理、回收站、重复事件、导入导出、iCal 订阅与提醒，以及对应 Rust、前端和网关协议代码及测试。
- **v2 适配**：保留 K-brain 管理记忆的实现，不恢复已删除的前端记忆整理器；Planning 工具类型改用现有 `agentTypes`，不重新引入旧模型运行库；重新生成 Protobuf 和依赖锁文件。
- **定时任务图层修复**：从内置 K-brain 的 `/v1/cron` 及任务运行记录接口读取真实任务，而不是旧桌面 SQLite 自动化表。新增 Rust HTTP 测试检查认证、带斜线任务 ID、运行记录和未来触发时间；桌面实测图层任务 ID 与 K-brain 一致。预测使用内置 K-brain 调度器实际采用的系统时区，不因桌面日历显示偏好而改变任务执行时刻。历史受 K-brain 现有保留策略限制。

| 最新检查 | 结果 |
| --- | --- |
| GUI Node 前端测试 | 2948 项：2947 通过、1 跳过、0 失败 |
| Gateway WebUI Node 测试 | 769/769 通过 |
| Rust 库测试 | 1102 通过、5 忽略、0 失败；忽略项包含需手动启动的浏览器夹具 |
| Gateway Go 全量测试 | 全部通过；新增纯 K-brain 日程能力边界 WebSocket 测试单独通过 |
| 三个前端包 TypeScript | 全部通过 |
| GUI / WebUI 生产构建 | 全部通过 |
| Biome | 1071 文件通过 |
| UI 边界 / diff hygiene | 通过 |

**实际界面与命令验证**：

- 真实 macOS WKWebView 创建并完成任务，创建全天活动；重启桌面进程后核对数据库，任务状态与活动均保留。
- 桌面命令验证列表创建、任务编辑、旧 revision 冲突、同一 requestId 重试幂等、软删除、恢复、永久删除、导出与无效时间范围拒绝。
- 实际切换周、月、日程视图，核对同一活动可见；窄屏日视图和任务视图可用，并实际创建和完成窄屏任务。
- 1440×900 与 480×844 的真实桌面窗口均无页面横向溢出，已查看截图。480 是桌面窗口最小宽度，不等同于手机设备实测。
- 回访定时任务、记忆、Skills、MCP、日程及设置；设置中的日程列表与前述创建数据一致。
- Chromium 1440×900 与 390×844 验证仅连接 K-brain 的浏览器提示及重试：显示本地化能力说明，无未捕获页面异常、无横向溢出。
- 本地实机脚本与截图：`/tmp/desk/planning_verify.mjs`、`/tmp/desk/planning-desktop.png`、`/tmp/desk/planning-mobile.png`；这些临时文件不随仓库提交。

**迁移前边界（第 1–3 项现已由下节更新取代）**：

1. 日程数据仍由桌面 Rust `PlanningStore` 保存，尚未迁入 K-brain；纯 K-brain 浏览器不能 CRUD 日程。已用 `E:desktop_required` 返回本地化说明，避免内部 Tauri 错误或误报 Agent 离线。不能把本轮称为完整前后端分离。
2. `PlanningQuery` / `PlanningMutate` 的桌面实现和单元测试已移植，但 K-brain 模型运行时尚未注册这两个工具；自然语言操作日程未验证可用。
3. 网关连接桌面端的协议、序列化与变更广播代码已移植，尚未进行桌面 + Gateway + 两个浏览器客户端的实机同步测试。
4. ICS 导入、重复事件和订阅数据处理有自动化覆盖；真实外部订阅服务、系统通知授权/投递、拖拽跨日修改及 Windows 实机尚未逐项验证。
5. 通用时区设置尚未同步到 K-brain 调度器；定时任务依然按后端系统时区执行。日程显示时区不能被解释为已改变后端任务执行时区。
6. Rust 构建可完成；旧自动化表的日程查询辅助函数在生产构建中不再使用，有 dead-code 警告，未用 suppress 注解掩盖。

本轮不更新 `v2.0.0-beta.1` 标签、不替换发布资产、不触发标签发布流程。

### 日程迁入 K-brain 验证（2026-10-06，最新）

**结构与迁移**：

- K-brain `45d34c3` 新增 `<sessionsDir>/planning.json` 持久化存储及鉴权接口 `POST /v1/planning`，承担日历、列表、任务、事件、重复规则、回收站、提醒租约和订阅刷新。
- LiveAgent GUI、原生命令和 Gateway 转发到同一后端。前端每 2 秒刷新；桌面不再启动可写的旧日程运行时，仅保留系统通知及一次性迁移读取。旧 Rust 领域测试保留为测试代码，不能视为新 Go 实现所有语义均已覆盖。
- 旧 SQLite 表保留，迁移来源 ID 持久化；同一来源重启不重复覆盖。不同记录冲突或非空目标中的重名日历会报错并中止迁移，不静默丢数据。迁移请求上限 4 MiB。
- `PlanningQuery` / `PlanningMutate` 已注册到 K-brain **backend 模型运行时**；实测工具查询、授权拒绝、授权写入和重启恢复。独立终端模式模型运行时尚未注册这两个工具，未验证真实模型自然语言调用。
- 定时任务图层也统一为 K-brain 的 `cron.occurrences` 计算，不再由桌面重复展开。使用调度器系统时区，不改变任务实际执行时区。
- 修复旧提醒迁移重发、重复事件提醒 ID、禁用提醒/清空截止日期仍提醒、关联任务完成后仍提醒、提醒稍后重试保留 notifiedAt 等问题；增加错误类型与非整数输入回滚测试。

**自动化与构建**：

| 检查 | 本轮结果 |
| --- | --- |
| K-brain `go test -p 1 ./...` | 全部通过；并行跑两次命中 TUI 流式任务时序测试超时，该测试在原始提交和新提交单跑均通过，最终串行全量通过 |
| K-brain 日程 + backend race | 通过，覆盖 HTTP 鉴权、权限门控、原子存储、并发冲突、幂等、迁移、重复事件拆分、提醒、后台订阅 |
| Gateway Go 全量 | 通过，含不依赖桌面连接的 Planning WebSocket 转发 |
| Rust 库测试 | 1102 通过、5 忽略；新增 SQLite 迁移读取/来源稳定/保留旧行测试，移除旧 HTTP cron 投影测试 |
| GUI / WebUI 前端 | 2947 通过、1 跳过 / 769 通过 |
| TypeScript / Biome | agent-ui、GUI、WebUI 类型检查通过；1071 文件 Biome 通过 |
| GUI / WebUI 生产构建 | 通过；GUI 有大 chunk 提示 |
| K-brain 准备/校验/源码构建脚本 | 13/13 通过（全部发布/脚本 44/44）；本机实际从锁定提交构建 backend + computer helper 并安装 sidecar |
| Rust debug 构建 | 通过；旧 automation 辅助实现仍有 dead-code 警告，未加 suppress |

**实际跨端验证**：

1. 最新 Go 后端和 Rust 桌面重启后，原 SQLite 的任务、完成状态、全天事件仍可见；原生命令跑通创建、编辑、CAS 冲突、requestId 幂等、软删除、恢复、永久删除、导出和 cron 范围校验。
2. 同时运行真实 Gateway、直连 GUI 浏览器和 macOS 桌面。Gateway 页面创建任务后，直连浏览器与原生查询可见；直连浏览器完成任务后 Gateway 自动同步。
3. Gateway 在 390×844 创建/完成任务，同步到 1440×900 直连浏览器；刷新页面后再次核对原生任务状态。无未捕获页面异常、无页面横向溢出，已查看手机宽度截图。
4. 原生桌面 1440×900、480×844 验证活动可见和布局，回访定时任务、记忆、Skills、MCP、日程、设置。
5. 临时证据：`/tmp/desk/planning_cross_client.mjs`、`/tmp/la-planning-cross-client.log`、`/tmp/la-planning-latest-native-test.log`、`/tmp/desk/kbrain-planning-gateway-mobile.png`。均不作为仓库产物提交。

**打包与启动**：

锁文件已改为 K-brain `550a410` 完整提交 ID，并删除指向旧 `v0.107.4` 的下载映射，避免带上不支持日程接口的旧二进制。发布 CI 原有流程仍从锁定源码构建。本地首次开发需执行：

```sh
pnpm build:kbrain:source
# 已有 K-brain clone 时可离线利用其中的锁定提交：
# pnpm build:kbrain:source --source-dir /path/to/K-brain
pnpm prepare:kbrain
```

源码构建使用独立 detached checkout，不把开发者未提交内容冒充锁定提交；同时构建后端及 computer helper 并记录 SHA-256。未重新发布 `v2.0.0-beta.1`，未修改其标签和资产。

**剩余边界**：

- 特殊 ICS 的 RDATE、DURATION、自定义 VTIMEZONE 尚未完整支持；外部真实订阅、系统通知授权/投递、拖拽跨日、Windows 实机未逐项验证。
- 提醒使用租约和确认机制；进程在通知发出后、确认前崩溃仍可能重试，不保证严格仅投递一次。
- 日程默认时区 API 可用，桌面设置已连接；浏览器全局时区偏好尚未全部对接后端。日程时区不控制 cron 调度器时区。
- 单个 session 目录仅支持一个 backend 进程；多进程共享同一 JSON 文件没有跨进程锁。
- 全量快照 import 是替换而非 revision 合并。多来源迁移冲突需要人工处理，不自动覆盖。
- 未生成签名安装包、未跑安装包升级迁移；本轮完成的是源码、debug 桌面与固定源码 sidecar 验证。

### ❌ 未移植

#### 1. 上下文压缩重构

- **main 提交**：`79c3ac35`（93 文件、+8669/−5456）、`7d3839ff`（回归修复）
- **v2 状态**：v2 已有压缩实现与部分测试（`compaction-controller`、`compaction-file-ledger`、`compaction-policy`、`compaction-seam-row`、`compaction-token-ledger` 存在），但 main 新增的 `compaction-binding`、`compaction-bridge`、`compaction-checkpoint`、`compaction-prompt`、`compaction-summarize`、`compaction-transcript`、`compaction-abort`、`compaction-observer` 在 v2 缺失。
- **结果**：v2 基础压缩逻辑可用，main 的完整回归覆盖未补齐。
- **补齐建议**：移植缺失测试，重点验证缓存共享 fork、流式降级梯、取消、文件 ledger 与压缩后继续对话。

## 浏览器验证证据

环境：Vite dev server `localhost:1420`（`crates/agent-gui`）→ K-brain `127.0.0.1:47412`（v0.107.4，fixture `/tmp/la-fix/new`），Chrome headless CDP 驱动，视口 1440×900 与 420×860。

已实测通过（均为真实鼠标点击驱动，不是合成 `.click()`）：

- **聊天收发**：输入 → 发送 → 流式回复渲染（`echo: v2 sweep roundtrip … / Answer / This is streamed verification text.`），消息时间戳显示为 `22:36`；`1 轮 · 1 步`，`上下文 1%`。
- **打开旧会话**：`deleted-model history repro` 正常加载，历史与轨迹均 200，无页面错误。
- **轨迹视图**：点开「轨迹」标签后按轮次渲染（SYSTEM / USER / ASSISTANT + 工具行 + `1 ms` 耗时），点回「对话」正常。
- **编辑重发**：分支创建 201 → `/edit` → `/runs`，无冲突报错。
- **Skills 页面**：商店列表与分类筛选渲染正常（`全部 2`，其余分类 0）；功能总开关 `role="switch"` 实测 `false → true → false`；本地导入面板打开正常（Claude Code / Codex / CodeBuddy / Agent Skills 四个来源）。
- **MCP 页面**：已配置 `fixture-mcp`（STDIO）显示 `1/1 已启用`；「添加」菜单 → 对话框字段完整（Server Name / Transport / Timeout / Command / CWD / Args / Env / 描述 / 文档链接），实测新增 `v2-sweep-mcp` 后变为 `2/2` 并持久化。
- **定时任务**：新增任务 → 类型选择（Shell 脚本 / Http 请求 / Auto Prompt）→ Shell 表单（任务名称 / Cron / 描述 / 工作空间 / 脚本 / 超时）；实测保存 `v2 sweep task`（`0 0 3 * * *`）后列表显示 `1 个任务`，`GET /v1/cron` 返回同一任务，磁盘持久化。
- **记忆**：新建记忆对话框需要 **slug 输入框 + 正文 textarea**（只填正文会被拒绝）；保存后 `全局 1 / 500`，出现 `1 条记忆待审核` 横幅与「通过」按钮；点行选中 → 「通过」后横幅消失、条目转为已审核。
- **供应商设置**：五个供应商标签页（Anthropic / OpenAI / Gemini / Grok / DeepSeek）与卡片渲染正常；OpenAI 下两张卡片（Legacy Vendor / Mock Relay），行内「复制 Base URL 和 API Key / 编辑 / 删除」入口齐全；模型删除后配置清理已在上一轮验证。
- **设置各分区**：系统设置 / 供应商设置 / 提示词模板 / Skills / MCP / 定时任务 / 记忆 / Hooks / 系统工具 / Computer Use / 语音输入 / SSH / Remote / 快捷键 / 备份与同步 / 关于，`nav.settings-nav` 共 `16` 个入口，逐个点击全部渲染，无 console 错误。
- **设置页交互**：提示词模板「新增模板」、Hooks「新增 Hook」、MCP「添加」、WebDAV「设置同步」（服务商预设对话框）、备份「导出配置」均正常打开，无异常。
- **主题切换**：浅色（`aria-pressed=true`）→ 深色后 `documentElement.className` 变为 `dark`，切回浅色后为空。
- **Computer Use**：当前运行面提示为中文（"这个浏览器宿主背后没有桌面端"），无内部诊断。
- **项目工具能力边界**：面板真实打开（`data-state=open`、`inert=false`）后，「新建项目工具」按钮为 `disabled`，六个入口（终端、文件树、审查、内网穿透、SSH、后台任务）全部只显示中文原因，全页扫描无 `unavailable in K-brain` / `WebUI shim does not implement` 字样。
- **设置页泄漏扫描**：16 个设置分区 + 5 个侧栏页面逐页扫描，加上 关于/备份/SSH/Hooks/定时任务/记忆/Computer Use/语音输入/Remote 的主要按钮点击，修复后全为 0 泄漏。
- **移动端 420×860（deviceScaleFactor 2）**：应用正常渲染聊天与输入区，`innerWidth = 420`、`scrollWidth - clientWidth = 0`（无横向溢出），无 JS 错误；侧栏收为 Sheet（符合预期）。

## 与 zcode 前后端分离架构的对比

用户指定的参考实现为 `/Users/a/code/harness/zcode`（`zcode cli` 对应 k-brain，`zcode desktop` 对应 liveagent）。

### zcode 的结构

- pnpm monorepo，`packages/{rpc,services,shared,client,server,web,ui,desktop,…}` + `apps/zcode-cli`。
- `@zcode/rpc` 分 7 层：foundation（Emitter/Disposable）→ serialization → protocol → channels → ipc → proxy-channel → remote。
- `architecture-policy.yaml` 约束：`maxFileLines 400`、`maxContractLines 300`、`maxPublicMethods 12`、`forbidCycles`、`forbidDeepImports`，由 `scripts/architecture/architecture-check.mjs` 强制。
- `packages/server/src/{entry-stdio,stdio,entry-http,http}.ts`：同一服务端两种传输；stdio 把 `console` 重定向到 stderr，保证 RPC 帧干净。
- `packages/desktop/src/{main,host,renderer,preload,scheduler,shared}`：main 只做窗口与进程，host 是单窗口服务所有者。
- 客户端两种模式：`desktop-continuous`（在线）与 `web-remote-replayable`（可恢复），见 `packages/ui/src/v4/agentV4ConnectionHandshake.ts:41`。

### LiveAgent 现状

- 304 个 Tauri `invoke` 命令（`crates/agent-gui/src-tauri/src/lib.rs`）+ 13 条 K-brain HTTP 路由（`crates/agent-gui/src/lib/kbrain/client.ts`）+ 307 个 agent-gui TS/TSX、558 个 agent-ui、209 个 Rust 文件。

### 关键差异

1. **缺少统一的服务注册/依赖注入**：UI 直接调用宿主 `invoke`。本轮修掉的终端/CUA/Git 泄漏正是这个缺失的"能力边界"造成的。
2. **宿主 shim 实现重复且已漂移**：`crates/agent-gui/src/shims/tauriCore.ts` 与 `crates/agent-gateway/web/src/shims/tauriCore.ts` 各自维护一套。
3. **两种客户端模式未显式建模**：网关桥接是 continuous，WebUI 是 replayable，但没有像 zcode 那样在类型层面区分。

### 建议

- 引入能力注册表 + `isAvailable` 门控（`rightDockRegistry.tsx` 的 `isAvailable`/`RightDockToolCapabilities` 已是雏形）。
- 引入 zcode 式的架构检查门禁（文件行数、循环依赖、深层导入）。
- 把宿主能力缺失的处理集中到 `hostErrors` 这样的单一出口（本轮已开始）。

## 桌面端（Tauri）命令验证

上一版报告把"桌面端专属能力本身未在桌面实机复测"列为未完成项：所有浏览器结论验证的是"缺能力时不再泄漏诊断"，而不是桌面命令真的能跑。本轮补齐了这一项。

### 方法

应用在 debug 构建下注册了 `tauri-plugin-mcp-bridge`（`crates/agent-gui/src-tauri/src/lib.rs`），它在 `0.0.0.0:9223` 起一个 WebSocket，可以对真实 WKWebView 执行 JS。据此搭了一套 harness（`/tmp/desk/`）：

1. `extract.mjs` 从 `generate_handler![...]` 抽出全部注册命令，再解析每个 `#[tauri::command]` 的参数表，得到 `311` 条命令及其必填/可选参数。
2. `bridge.mjs` 是 WebSocket 客户端；`harness.mjs` 的 `call(command, args)` 通过 `invoke(...)['then'](ok, err)` 起调并轮询 `window` 上的槽位取结果。
3. `run_all.mjs` 串起 12 个分组的用例脚本，统计通过数与覆盖率。

**插件已知限制**：`execute_js` 的原生求值路径会拒绝含 `await ` / `async ` / `.then(` / `Promise.` 的脚本，回退到一条恒超时的 IPC 路径。因此 harness 统一用中括号取值 `invoke(...)['then'](ok, err)` 起调，再轮询结果槽位，不使用 `await`。

### 环境

```
LIVEAGENT_HOME=/tmp/la-desktop/home ./target/debug/liveagent
```

应用自起 `k-brain backend -listen 127.0.0.1:0`（子进程），窗口指向 Vite dev server `localhost:1420`。

> **注意**：本次会话中 `/private/tmp/liveagent-fix/target/` 被环境反复回收，`k-brain` 兄弟二进制一度消失，导致 `kbrain_backend_connection` 报 `No such file or directory`。改用 `CARGO_TARGET_DIR=/tmp/la-target` 重新构建、并把 `k-brain` 放到稳定路径后复测通过。该报错是环境问题，不是产品缺陷。

### 结果

**`323/323` 断言通过，`0` 失败。** 按分组：

| 分组 | 结果 | 覆盖内容 |
| --- | --- | --- |
| 终端 + 文件系统 | 24/24 | 终端创建/列表/输入/尾部读取/改名/关闭；文件读写改删、目录、glob、grep、mention |
| Git | 41/41 | 状态、发现仓库、分支增删改切、diff、log、提交详情/diff/与远端比较、暂存/取消、ignore、fetch/pull/push、stash、远端、clone（含同步与任务两种）、worktree 增删、丢弃、init |
| 聊天历史 | 22/22 | 列表/分页/搜索/工作目录、upsert、窗口读取、revision 校验、改名/置顶/改 cwd/改模型/分享、分支、追加分段、删除、两个迁移分页 |
| 设置 | 22/22 | 十个配置域的读取与保存回环、CCSwitch/Cherry Studio 导入、SSH patch/known_host、备份同步配置、WebDAV 连接与远端信息、STT 密钥与自检 |
| 记忆 | 21/21 | 路径信息、列表、搜索、索引概览、配额、当日、近期拒绝、写入/读取/更新/通过/删除、批量应用、整理运行 |
| 自动化 | 13/13 | Cron 表达式校验、快照、Hooks 应用、Cron 增删、运行记录、立即执行、prompt run 领取/释放/完成、revision 冲突 |
| Shell + 托管进程 | 14/14 | `shell_run`（含退出码）、会话 start/wait/stop、取消、托管进程 start/status/日志/wait/stop/clear |
| 子代理 + 轨迹 | 20/20 | 身份 upsert/list、run save/list/load/prune、消息 append/list、轨迹事件与窗口、分段读写、轮次解析 |
| SFTP + SSH | 24/24 | 10 条 SFTP 命令、SSH 终端标签页、SSH 执行/延迟/重连/SFTP 开关、交互提示应答、本地端口转发 |
| 备份 | 3/3 | 显式路径导入预检、拒绝非备份文件、导入应用 |
| 其余 | 61/61 | checkpoint、workspace grants、hooks、browser、app、system、cua、mcp、gateway、proxy、provider、kbrain |
| 补充 | 31/31 | 内存整理读写、记忆项目删除/清空、图片读取与预览、聊天文件链接、`replace_from_message`、子代理 worktree、MCP OAuth、STT 全流程 |
| 收尾 | 50/50 | 文本/文件导入、图片剪贴板链路、Skills 元数据与正文、原生选择器、Gateway 聊天全链路、托盘、隧道、更新安装 |

**未调用的 2 条**：`app_restart` 与 `app_confirmed_exit` —— 它们会终止当前进程，无法在同一个会话里既执行又继续断言。两条在源码层面已核对（`commands/app/update.rs`、`commands/app/app.rs`）。

### 本轮发现的参数契约（非缺陷，供后续用例参考）

实现过程中若干命令报"缺参数/参数类型不符"，逐一核对源码后确认是我方调用形状不对，命令本身行为正确：

| 命令 | 正确形状 |
| --- | --- |
| `terminal_stream_input` | `bytes` 为字节数组，不是 `data` 字符串 |
| `terminal_read_tail` | 必填 `project_path_key` |
| `fs_write_text` | `mode` 只接受 `"rewrite"` |
| `fs_edit_text` | 先 `fs_read_editable_text` 拿到 `mtimeMs`/`contentHash` 再传 |
| `cron_validate_expression` | 六段式（秒 分 时 日 月 周） |
| `memory_write` | `memoryType` 只接受 `user`/`feedback`/`project`/`reference` |
| `memory_organize_run_update` | `status` 只接受 `pending`/`running`/`succeeded`/`failed`/`skipped`/`cancelled` |
| `subagent_identity_upsert` | `lastMode` 只接受 `readonly`/`worktree` |
| `subagent_message_append` | `channel` 只接受 `direct`/`shared`/`decision`/`question` |
| 部分历史/轨迹/设置命令 | 未标注 `rename_all = "snake_case"`，参数走 camelCase |

### 桌面 UI 验证

除命令外，还用同一桥接驱动真实 WKWebView 做了页面级验证（`ui_suite.mjs`，`8/8` 通过）：

- 应用外壳渲染（`document.title === "LiveAgent"`、`#root` 存在）。
- 侧栏五个入口（Skills / MCP / 定时任务 / 记忆 / 设置）逐个点击，各自打开对应面板（`Skills Hub`、`MCP Hub`、`定时任务`、`记忆` 等标题切换）。
- 返回对话后输入区可交互（`contenteditable` 存在）。
- 全程无未捕获页面错误。

**一处需说明的界面文案**：桌面端打开 Skills 页会显示"Skills 需要 Agent 模式"。这是 `SkillsHubPage.tsx` 里 `AgentModeRequired` 组件的既有设计（项目未处于 Agent 模式时的门控），不是缺陷；点"切换至 Agent 模式"即可进入。

### 仍未覆盖

- `system_pick_folder` / `system_pick_file` / `system_prepare_preview_file_save` / `system_save_preview_file` / `settings_backup_export` 会弹出原生模态框并阻塞到人工点击。用例以有界超时确认"命令已进入 `rfd` 等待用户"，未做真实点击。
- 原生模态框弹出期间应用主线程仍可响应（实测 DOM 查询与其它命令均正常返回）。

## 未完成验证

- 未在 Windows 实机执行 Windows worktree、Node 测试批处理与路径回归。
- 未执行真实远程 SSH 复用测试（无外部 SSH 主机）；SSH/SFTP 相关命令已通过参数契约与域级拒绝路径验证。
- 未执行带 K-brain 二进制的 Tauri 桌面打包与安装包冒烟测试。
- macOS 窄窗口标题栏避让无自动化截图比对。
- 桌面端命令与页面交互已在真实 macOS 桌面进程复测（见"桌面端（Tauri）命令验证"）；仍未覆盖的是 5 个原生模态框命令的真实点击，以及 `app_restart` / `app_confirmed_exit` 这两条会终止进程的命令。
- Gateway WebUI 已起真实实例并验证日程跨端读写；其它所有页面的 Gateway 端完整回归仍未覆盖。

## 后续建议

1. 日程后端与跨端同步已完成本轮验证；继续补充特殊 ICS 语义和真实通知投递测试，另行移植压缩重构（`79c3ac35` + `7d3839ff`）。
2. 在 Windows CI 上跑 worktree 与脚本回归。
3. 把"宿主能力缺失"的浏览器回归固化成自动化用例（当前只在项目工具面板有源码级断言），任何新入口都应走 `hostAwareErrorMessage`。
4. 把桌面端命令 harness 固化成仓库内的测试脚本（当前在 `/tmp/desk/`）：`extract.mjs` 已能从 `generate_handler!` 自动派生命令与参数表，新增命令即可被自动纳入覆盖统计。
5. 为 5 个原生模态框命令补可点击的验证路径（例如给 `rfd` 注入可编程后端），使覆盖率达到 100%。
