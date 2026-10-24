# LiveAgent / K-brain 功能对齐验收（2026-10-24）

## 结论与基线

**当前不能认定“所有功能可用”或“已完全对齐 KB”。** 本轮进行了全套自动化回归、真实 macOS 桌面与浏览器操作，并修复了下述实际缺口；未配置外部服务和未执行的交互不记为通过。

- LA 工作区：`/tmp/la-mcp-display`，分支 `audit/full-capability-alignment`，基线 `e477819965ec43ec787d874bd46cad4ce9c10fe4`。
- KB 工作区：`/tmp/kb-mcp-display`，分支 `audit/memory-organizer-client`，基线 `24df53c0928f1c3ff9da39afe8d3e753f6108efe`。
- 基线含尚未合并的 LA #1049 / KB #52，因此结果是集成工作区验收，不是当前线上安装包验收。
- 未修改发布锁定的 KB 版本；未推送、合并或发版。
- 全部运行数据、模型配置和记忆使用 `/tmp/la-full-audit`，未导入或修改用户真实聊天和配置。
- macOS 原生 debug Tauri + WKWebView；Chrome headless WebUI：1440×950、390×950；原生记忆设置：1440×950、480×950（窗口最小宽度 480）。

## 本轮修复

| 问题 | 原因与处理 | 验证 |
|---|---|---|
| 模型目录在后端连接轮换后无法自动更新 | hook 订阅运行时连接；受管理客户端不再固定旧端口/token；显式远程连接保持隔离 | 真实 hook DOM 回归：连接变化、已挂载更新、显式 endpoint 隔离 |
| 记忆整理在 KB 模式仍显示不可用 | 增加统一 `memory_organizer` 管理命令，共用 KB organizer；桌面与 Web 共享审核/应用界面 | macOS WKWebView 与完整 Web→Gateway→KB：查看历史、生成建议、应用、刷新持久化；覆盖 null 历史、错误重试、重复点击 |
| 记忆整理只比较摘要，可能误删不同正文 | 摘要和完整未截断正文都相同才建议删除；删除时在 store 锁内验证保留项和候选项内容 | Go 回归与 race：不同正文保留、审核后编辑任一项保留；旧无内容校验建议拒绝删除并返回警告 |
| Gateway 直连 KB 时 MCP 已配置但页面为空 | 设置快照原先只投影供应商；补 `/v1/mcp` 读取与独立写入，不混入 provider 设置 | 真实 Web 桌面/移动：显示已有服务器、禁用、重载、启用，直接读取 KB 确认落盘；Go 校验删除空列表、认证、错误透传 |
| Web Skills 显示 `agent offline` | 请求落到桌面附件转发；补现有 protobuf SkillManage→固定 KB 资源接口，不增加任意 URL 代理 | 无桌面附件的真实 Web：自定义技能列表、正文预览、选择/取消并核验 KB；WebSocket 回归覆盖 list/read/settings |
| Skills 选择只保留在前端或保存被拒绝 | Gateway 设置快照和写入补 `skills` 域，写 KB `/v1/skills/settings` | 实际切换后查询 KB；类型化适配器与非法 payload/后端失败回归 |
| Skills HTTP 客户端不能共用连接恢复 | 桌面 Skills 适配器改用统一 `fetchKBrain`，失败写请求不自动重放 | 既有真实 HTTP 适配器回归与 GUI 全套 |
| Web 对 Chat Completions 下发默认联网搜索，聊天直接失败 | 共享 runtime controls 按供应商协议派生可用选项，不修改保存偏好 | 原错误真实复现；修后 Web 两种宽度发送、接收、重载；覆盖 Completions/DeepSeek/Responses/Anthropic/Gemini |

记忆整理仍是确定性去重，不表示实现了由模型生成的完整智能合并。被内容校验拒绝的操作以警告返回，用户需重新整理；不会盲目执行旧建议。

## 功能验收矩阵

“自动化”不等于真实用户端到端。“导航”只表示页面打开，不表示该页所有操作通过。

| 功能域 | 本轮证据 | 状态与边界 |
|---|---|---|
| 桌面启动、KB 连接 | 实际启动 debug 桌面，健康检查、动态端口、设置加载 | 实机通过；非签名安装包/升级验收 |
| 退出和后端生命周期 | 原生 close 配置为 exit 后关闭窗口；其拥有的 KB 42 ms 内退出；独立 KB 健康检查仍成功 | 实机通过一次；托盘隐藏不等于退出，长期挂起/唤醒另验 |
| 对话、流式和工具循环 | 桌面→KB→本地 SSE 供应商夹具→真实 Read 文件→第二轮结果；Web 发送和重载 | 指定链路实测通过；不是外部模型质量、首字延迟或供应商缓存验收 |
| 模型发现、目录重连 | 目录 DOM、供应商协议与设置回归 | 自动化通过；各外部供应商账号未逐一验收 |
| 编辑重发、取消、队列、历史分页/恢复 | GUI 全套与 KB/Gateway 回归 | 自动化覆盖；没有把全部历史操作逐项实机验收 |
| 计划模式、确认/自动编辑/完全访问/always/auto review | 真实 KB fixture 模式授权集成测试、审批配置回归 | 自动化；真实小模型审批效果未验收 |
| Skills | Web 无桌面附件：列表、正文、选择写回；桌面资源 HTTP 集成测试 | 指定操作通过；外部商店搜索/安装、原生目录拖入未实测 |
| MCP | 桌面/Web 列表，Web 启停配置持久化，KB MCP 单测 | 配置链路通过；本轮没有完成真实外部 MCP 服务的模型工具调用验收 |
| Memory | 桌面/Web 整理建议与应用、记忆 CRUD 自动化、正文误删回归 | 指定操作通过；长期自动学习质量/增长曲线未验收 |
| 日程/任务 | Web 两档创建任务、保存、重载；桌面页面导航；KB planning 回归 | 本地任务链路通过；非完整日历/订阅验收 |
| Cron 定时任务 | 桌面/Web 页面导航；KB HTTP Bash run-now/cancel/持久化回归 | 自动化覆盖执行；本轮未完成每种任务类型的桌面表单操作 |
| 原生文件和 Git | 真实 Tauri 写文件、列目录、git status | 宿主 IPC 通过；非全部文件树/Git UI 交互验收 |
| 终端 | 真实 Tauri 创建、输入、读取输出、resize、rename、close | 宿主 IPC 通过；Windows shell 回退与终端 UI 全交互未验收 |
| 子代理、轨迹、用量、时长 | GUI fixture→真实 KB→子代理工具与轨迹集成回归 | 自动化通过；未做长期并行压力验收 |
| 图像工作台 | 桌面/Web 导航；无图像身份/供应商时显示不可用 | 尚未端到端验收，不记为可用 |
| Browser / Computer Use | KB 模块测试，前端保持普通工具交互 | 未做真实屏幕控制、权限授权和浏览器任务验收 |
| SSH/SFTP/隧道/后台进程 | 设置/工作台入口检查、现有自动化 | 未配置远端主机；Web 直连 KB 不能推定具备所有桌面附件服务 |
| 语音输入/STT | 设置页导航、自动化 | 未提供语音服务凭据和麦克风验收 |
| WebDAV/备份、快捷键、托盘、更新 | 设置页导航与既有单测 | 外部同步、系统快捷键、签名安装/升级未验收 |
| Google/iCloud/Exchange、系统通知 | 相关后端回归存在 | 无真实订阅账号和通知横幅验收，未通过 |
| Windows/Linux | 平台相关单测 | 本轮仅 macOS；不能宣称 Win pwsh/Git Bash 或 Linux 实机通过 |
| 内存泄露 | 运行约 30 分钟的单点 KB RSS 约 37–43 MB；退出回收检查 | 单点观测不能证明无泄露；仍需长稳压测、连接/会话增长与堆分析 |

## 自动化结果与复跑

- GUI：3442 tests，3432 pass、10 skip、0 fail（最终 `gui-acceptance-final.log`）。使用本轮编译 KB，包含真实会话、模式、工具和轨迹夹具。
- WebUI：818 tests，818 pass（最终 `web-final-final.log`）。
- Rust：1144 pass、5 ignored（`rust-all.log`）；原生 debug 构建成功。
- KB：`go test -p 1 ./...`、`go vet ./...`；memory / memoryruntime / backend 三包 race 通过。
- Gateway：`go test -p 1 ./...`、`go vet ./...`；kbrain / websocket 两包 race 通过。
- UI/GUI/Web 类型检查、完整 Biome 检查、GUI/Web 生产构建通过。保留既有构建 chunk 和 lint warning，不将其宣称为零警告。
- 脚本 44/44、UI 边界检查、virtual-core 回归通过。

初次 GUI 全套未传本轮 KB binary，固定发布包准备受网络影响，真实后端夹具在 120 秒中止；指定本地已编译 binary 重跑全部通过。联网搜索修复后原测试还预期不支持的选项为 true，已更新桌面/Web 合同断言后全绿。最初 Gateway 缺 Web embed 产物，先构建 Web 后重跑成功。真实记忆 history 返回 null 曾导致渲染错误，已修复并增加回归。原生最终复测发现历史没有按新到旧排序，已补前端排序与混合时间格式回归；一次并发全套运行出现已有命令菜单 Escape 测试失败，单文件复跑 15/15、最终全套复跑均通过，保留原始失败日志，不视作已证明消除的间歇性问题。

```sh
# 先在 KB 仓库构建；不要在 GUI 每个测试中冷编译后端。
go build -o /tmp/kbrain-audit ./cmd/kn
go test -p 1 ./...
go test -race -p 1 ./internal/memory ./internal/memoryruntime ./internal/backend

# LA 仓库
LIVEAGENT_KBRAIN_BINARY=/tmp/kbrain-audit pnpm test:gui
pnpm test:webui
pnpm typecheck:ui && pnpm typecheck:gui && pnpm typecheck:webui
pnpm lint && pnpm build:gui && pnpm build:webui
(cd crates/agent-gateway && go test -p 1 ./... && go vet ./...)
```

测试临时日志与截图在 `/tmp/la-full-audit`，不会随 Git 提交或长期保留；其中连接文件和原始请求日志可能包含测试凭据，不应打包上传。截图包括 `web-skills-{1440,390}.png`、`web-chat-fixed-{1440,390}.png`、`web-organizer-{1440,390}.png`、`native-organizer-{1440,480}.png`、`web-planning-{1440,390}.png`。

## 参考 ZCode 的边界与剩余缺口

参考本地 ZCode 的 `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts`（按能力分派宿主请求）和 `packages/services/src/session/continuousStreamCoalescer.ts`（服务侧有界流）。本轮采用明确的 UI 资源适配器→类型化 Gateway RPC→KB 固定资源接口，不把模型、工具、技能安装或记忆整理放回前端。

仍需后续完成：

1. **P1：Web 直连 KB 的外围协议清单。** PromptTemplate、Loop、文件选择/文件树、SSH、隧道等旧消息并非都具有直连 relay；有页面入口不代表服务可用。应逐项明确 KB 接口、宿主附件要求和可用性提示，再做无桌面附件与有附件两套端到端测试。
2. **P1：真实服务验收。** 外部模型与 MCP、图像、语音、日历订阅、通知和 Windows 需要对应环境；本地夹具的 cached tokens 是人工返回值，不能证明缓存达到 97%。
3. **P1：长稳与恢复。** 多客户端并发编辑、连续连接轮换、后台长任务、内存增长、挂起/唤醒、升级回滚须做长时间和故障注入验收。
4. **P2：设置多资源一致性。** provider/MCP/Skills 组合保存调用多个 KB 资源接口，不是跨资源原子事务；中途失败会返回错误并由客户端重载，可能出现部分资源已保存。
5. **P2：版本兼容与文档。** Gateway 设置读取现在需要 KB 的 MCP/Skills 资源接口；不能宣称兼容缺少这些接口的旧后端。GUI 架构文档保留的 legacy 模块地图已加醒目标记，其他旧专项文档仍应逐步核对。
