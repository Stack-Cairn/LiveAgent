# 聊天引用标记显示修复

## 范围与实现

用户已启动对应 Goal，并授权直接提交、推送 PR、自动截图。2026-11-04 本地验收期间，用户补充了用户消息气泡漏过滤的截图，随后要求先推送 PR，同时继续本地验证。

- 上游基线：`274de94f5327faae22030af5995a5adac0d74097`；任务分支：`fix-chat-citation-markers`。
- 原有 Rust 工作区修改、会话同步进展文档及其他未跟踪文件保持原样，不纳入提交。
- 将原有供应商 citation 解析器移入共享模块，原有供应商导出保持兼容。
- 在共享 Markdown 展示入口过滤完整引用及流式未完成前缀。按 Markdown 语法保护代码、链接目标和真实 HTML 属性，并映射原始文本偏移。
- 长消息冻结分段复用相同的上下文范围；冻结段末尾不被当作整条消息末尾。
- 用户消息气泡只在展示时过滤，原始 token、复制、编辑、重发与持久化内容保留。
- 新增的五个直接依赖均来自已有传递依赖；锁文件仅增加 importer 声明，保留原有解析器版本。

## 契约地图

| 输入与消费者 | 处理 | 验证 |
| --- | --- | --- |
| 供应商消息解析 → 原有 runtime 导出 | 迁移实现，保留导出与语义 | 现有 provider 测试；独立复审比较 40,000 组确定性随机输入 |
| 助手正文 → 共享 Markdown → GUI、WebUI | 展示前按上下文过滤 | Markdown 渲染回归；两端历史和实际链接交互 |
| 流式正文 → 冻结分段 → Markdown | 同一上下文扫描与文档末尾状态 | 字符前缀、跨分段、长消息回归 |
| 用户正文 → UserMessageContent → GUI、WebUI | 展示时过滤 | 用户气泡回归；真实编辑后取消 |
| 原始用户文本 → token、复制、编辑、重发、存储 | 保持原数据 | 两端编辑重发测试；真实编辑器原文断言 |

## 回归与独立审查

已先观察失败，再修复并保留回归。覆盖普通正文、逐字流式前缀、重复标记、代码围栏、行内和缩进代码、Markdown 目标、GFM 自动链接、HTML 属性与隐式 tbody、转义 HTML、CRLF、缩进与原文偏移，以及长消息冻结边界。

核心复审未发现阻止合并的 P1/P2；额外 192 组宿主与偏移场景通过。用户气泡补漏复审的编辑、重发相关测试 42/42 通过，额外 11 组文件、会话、粘贴 chip 与代码混合 fixture 通过。

## 已运行验证

- 最终聚焦测试：120/120 通过，包含 Markdown、供应商、用户气泡、编辑重发与 WebUI 链接。
- GUI、WebUI production build 通过；`pnpm typecheck:ui`、`pnpm typecheck:gui`、`pnpm typecheck:webui`、`cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests`、Mirror Check、`git diff --check` 通过。
- Biome 对 1,187 个源文件的 lint 通过，含一条无关 informational diagnostic。完整 lint/check 因基线格式与行尾问题失败：GUI 236 条，WebUI 59 条；修改文件另行按 LF 检查。
- 最终全量 Node 测试的 8 批全部执行：4,517 项，4,506 通过，9 失败，2 跳过；未宣称全量通过。
- permission-mode、planning timezone 与两项 trajectory 失败已在同一依赖及后端下加载基线测试、helper 与源代码复现；两个相对 CWD 的失败在 GUI 目录重跑通过。
- 关闭本轮桌面调试进程后，直接运行 `cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml`：1,157 通过、14 失败、4 ignored，退出码 101。失败涉及 Git Bash 0xC0000142、Windows sandbox、路径解析、hook 和 worktree；当前工作区含任务开始前未提交的 Rust 改动，本 PR 未提交 Rust 代码，未将这 14 项全部归为已证实的基线失败。关闭桌面前首次重跑在 tauri-build 复制 sidecar 时 PermissionDenied；关闭后已能运行完整测试。

## 实际界面验收矩阵

| 场景 | 操作 | 预期及当前结果 |
| --- | --- | --- |
| 桌面历史消息 | 打开含原始 citation 的既有会话，刷新后重开 | 用户气泡、助手正文无标记，原始 React 输入保留；已通过 |
| 桌面链接 | 点击正常来源链接并取消外链弹窗 | URL 正确，取消后会话正常；已通过 |
| 桌面代码 | 查看行内代码及两行 Python 围栏 | 内容及代码样式保留；已通过 |
| 桌面窄窗口 | 将 viewport 改为 390 宽，再查看两种消息 | 无横向溢出、无 pageerror；已通过 |
| 桌面编辑取消 | 编辑含 marker 的用户消息，再按 Escape | 编辑器保留原文，取消后恢复干净气泡；已通过 |
| WebUI 同类交互 | 1280/390 宽度打开同一会话，检查链接、刷新和编辑取消 | 用户/助手气泡干净、代码链接正常，编辑原文保留，无溢出和 pageerror；已通过 |
| 两端实际流式 | 分别从桌面和 WebUI 发送含原始 marker 的真实供应商提示；观察 DOM 直到唯一结束标识 | 两次发送的四组宿主观察均无用户/助手 marker 泄漏，原始输入仍在；已通过 |

截图的“修复前”使用相同历史消息，临时通过 CDP 响应拦截关闭新增的展示过滤。未改写历史消息或撤销源码；PR 必须明确注明为对照重放。已取得桌面用户气泡的有效前后对比及两端助手修复后截图；仅发布经过目视检查的图片。

## 后续记录

关联上游 issue：#1151；PR：#1153，目标 `main`。修复提交 `b42c1eaa3f759e975c27c5843a3739a637d4b6ca` 已推送至 fork，PR head 核对一致、无冲突且非 draft。已发布两端有效截图并补进 PR 正文。

桌面发起真实供应商输出时记录桌面 97 次、WebUI 18 次 DOM 更新；WebUI 发起时记录桌面 95 次、WebUI 35 次。四组均断言原始用户及助手输入含 marker，展示无泄漏，并等待本次唯一完成标识。

首轮 CI 的 GUI、两组 GUI frontend、Gateway WebUI、Docker Smoke、三平台 Desktop Gateway、Shared UI Boundaries、Diff Hygiene 和合规检查通过；Tauri Rust Check 按变更范围跳过。Gateway 的 Go 测试首轮在 `TestV2KBrainCommandsWithoutDesktop` 中等待 hello 时收到 `HistorySyncStatus`，仅重跑失败 job 后在 `TestV2ComposerRejectionReplaysAfterReconnectWithoutHistory` 出现同类帧顺序错误。两次均已读取具体失败日志，未擅自修改无关 Go 代码；该问题正在独立核查。最终 CI 状态以 PR 最新 head 的 checks 为准，尚未全部通过前不宣告目标完成。
