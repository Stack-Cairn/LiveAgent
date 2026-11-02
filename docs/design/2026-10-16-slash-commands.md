# 输入框“/”指令设计方案（2026-10-16）

## 2026-10-17 提交状态

本分支的桌面端目录现由 K-brain 的 GET /v1/commands 提供，保留 goal、loop、plan、compact、model、rewind、init、review 与自定义提示词。旧章节记录了早期方案，以下以当前实现为准。

- GUI：内置指令说明跟随 LA 中英文设置；裸 / 展示指令与技能分类；/model 候选直接打开模型列表，/model 名称直接切换；其他候选先进入草稿。
- /plan：无参数打开计划模式；带正文时仅当前提交启用计划模式，用户消息保留指令原文。
- /goal：后端管理 set/resume/pause/update/clear，GUI 目标栏持续展示进行中或暂停的目标；取消前确认。后端自动续跑，GUI 挂接下一轮。目标正文持久化，重载后为暂停态。
- /loop：创建、列出、取消会话绑定的 cron 提示词任务；结果经 command-notes 写入会话历史。运行中写入冲突时仍有本地面板兜底。间隔使用六段 cron 的日历步进，尚不是严格的经过时长计时器。
- 指令标签：消息开头的内置动作渲染为 command 类型，避免被识别成 Skill。init/review 与自定义模板标签、结构化提及的完整统一仍需收尾。
- 技能：GUI 从 K-brain 按工作目录读取已选技能；显式 /skill: 解析与执行的一致性仍需补测。

### 2026-10-18 评审修复

- /goal 子命令不区分大小写，新增 `/goal pause`。暂停仅在目标处于 active/continuing 时生效，否则 K-brain 返回 409，且不会取消与目标无关的普通运行。WebUI 暂无暂停入口，输入 `/goal pause` 会提示不支持。
- 用户在目标轮次中停止时，GUI 调用 goal pause（忽略 409），再读取目标状态刷新目标栏，防止后端自行发起的续跑在后台继续。挂接续跑轮次时定期核对目标状态；目标已暂停或会话不存在时立即报错。
- 会话忙或发送被拒时，指令不入队，直接报错并把草稿放回输入框。GUI 的发送层返回 false 也按被拒处理。WebUI 在已有待确认请求或请求失败时同样报错。
- 草稿带会话引用、大段粘贴或附件：GUI 按普通草稿完整发送；WebUI 以及 `/goal` 不支持，报错并保留草稿。
- 指令名按目录写法发送。草稿开头是 Skill 标签时不按指令执行；编辑排队消息时也不按指令执行。编辑排队的 WebUI 指令轮次后，正文一旦改动，就去掉其指令语义。
- Gateway 只把带指令语义的聊天请求和 slash_command_list/goal_manage/loop_manage 转发给声明了 `COMPOSER_COMMANDS_V1` 的桌面端。clearGoal、createLoop、cancelLoop 会改状态，不自动重发。
- 提示词模板的 list/expand 转发链路（3.5 末尾）已停用：提示词指令改为随聊天请求带 `prompt_command`，由 K-brain 展开。proto 字段保留。
- K-brain 侧：loop 的 cron 间隔不少于 60 秒（秒字段必须固定）；`GOAL_MET` 判定为严格前缀，即去掉前导空白和 markdown 标记后以 `GOAL_MET` 开头，且后一个字符不是字母、数字、`_` 或 `-`。

### 尚未完成，PR 保持草稿

- WebUI 类型检查与构建已修复；目标栏、composer-action 的 TS 事件处理与完整的目标指令透传尚未完成端到端验收。不能把 proto 和 Rust 转发已存在当成功能可用。
- /loop 后台运行的实时转录同步尚未验收。
- 目标循环的并发停止、更新、重试去重和持久化失败恢复仍需专项审查。
- 完整验收矩阵及两端界面证据尚未补齐。
- 本次不包含其他任务的文档、测试生成文件、.alma 或本地调试脚本。


## 1. 目标

在 GUI 和 Gateway WebUI 的输入框里支持与 Codex、Claude Code 相近的“/”指令：输入“/”弹出指令列表，选中后执行本地动作，或展开成提示词。

对标的指令依据两款工具的公开文档整理，本次未逐条核对其最新版本：
- 两者都有：/new 或 /clear（开新对话）、/compact（压缩上下文）、/model（切换模型）、/init（生成项目说明文件）、/review（代码评审）、/status、/mcp、/help。
- 自定义指令：Claude Code 读取 `.claude/commands/*.md`，Codex 读取 `~/.codex/prompts/*.md`，都支持 `$ARGUMENTS` 这类参数占位。

## 范围

以前端（共享 UI、GUI、Gateway WebUI）为主。另外为 WebUI 补一条提示词模板的转发链路，涉及 Gateway 协议和桌面端 Agent，见 3.5。K-brain 不改，只使用已有接口。

## 2. 现状

- 输入框已有“/”弹层，但只用来插入 Skill 标签，且只在启用了 Skill 时生效（`MentionComposerInternals.tsx:1428-1434`，`MentionComposer.tsx:863/867`）。
- 弹层标题 “Skills” 写死为英文，未走 i18n（`MentionComposerOverlays.tsx:122-130`）。
- 发送时正文里的 `/name` 会被当作 Skill 引用解析（`agent-ui/src/lib/skills/index.ts:215-245`）。
- 前端没有任何指令派发实现。
- K-brain 后端已有对应能力：
  - 手动压缩：`POST /v1/sessions/{id}/compact`（`compact.go:31`）。GUI 已有调用（`useManualCompaction.ts`，`ChatPage.tsx:1712`），WebUI 有对应结果处理。
  - 切换模型：`PATCH /v1/sessions/{id}`。
  - 新建会话、取消运行、模型列表、Skills 列表、MCP 列表。
  - Markdown 提示词模板展开：`/v1/prompts/templates/{name}/expand`（`prompts.go:67`）。GUI 客户端 `expandMarkdown` 已写好（`agent-gui/src/lib/kbrain/prompts.ts:119`），但还没有调用方。
- K-brain 的 TUI 已有一套完整的指令注册表（`internal/tui/registry.go:18-78`），并约定：
  - 自定义提示词放在 `~/.liveagent/prompts/*.md`；项目内的 `.liveagent/prompts/*.md` 只对受信任项目生效。
  - 内置指令名优先（`prompt_templates.go:22-35`）。
  - 提示词展开后放回输入框，由用户确认再发送。

## 3. 设计

### 3.1 指令类型

在共享 UI（agent-ui）新增指令注册表，指令分三类：

| 类型 | 行为 | 例子 |
|---|---|---|
| 动作 | 不发消息，直接执行前端或后端动作 | /new、/clear、/compact、/model、/stop、/status、/help |
| 提示词 | 调用后端展开模板，结果填回输入框，由用户确认后发送 | 自定义 prompts、/init、/review |
| Skill | 保持现有行为，插入 Skill 标签 | 已启用的 Skills |

重名时，内置指令优先于自定义提示词，自定义提示词优先于 Skill。这与 TUI 的规则一致，弹层里同名的低优先项不显示。

### 3.2 触发与交互

- 输入框开头输入“/”：弹出“指令 + 提示词 + Skills”合并列表，按类型分组，不依赖是否启用了 Skill。
- 正文中间输入“/”：保持现状，只匹配 Skill，避免打断路径输入。
- 复用现有弹层、键盘处理（↑/↓、Tab/Enter、Esc、输入法 Enter 抑制）和过滤逻辑，`MentionContext.trigger` 新增 `"command"`。
- 选中动作指令：
  - 无参数的直接执行。
  - 有参数的在输入框留下 `/compact ` 这样的文本，等用户补参数后按 Enter 执行。
- 发送拦截：草稿以已注册的动作指令开头时，不进入 `useSendChatTurn`，改走指令执行。
- 发送时的 Skill 解析要跳过已注册的动作指令名，避免把 `/compact` 识别成 Skill。
- 未知的 `/xxx` 按普通文本发送，不报错。

### 3.3 内置指令（第一期）

| 指令 | 行为 | 依赖 |
|---|---|---|
| /new，别名 /clear | 新建对话；不删除历史，与 GUI 现有新建对话行为一致 | 现有新建会话入口 |
| /compact | 手动压缩当前会话 | 现有 `useManualCompaction` |
| /model [名称] | 无参数时打开模型选择；有参数时按名称切换 | 现有模型选择器、`PATCH /v1/sessions/{id}` |
| /stop | 停止当前运行 | 现有停止入口 |
| /status | 在对话里插一条本地卡片，显示模型、上下文占用、工作目录，不发给模型 | 会话状态、用量事件 |
| /help | 列出全部可用指令 | 注册表 |

Claude Code 的 `/compact` 可以附带压缩要求，但 K-brain 的 `CompactRequest`（`protocol.go:395`）只有 `conversation_id`、`client_request_id`、`expected_revision` 三个字段，不支持附带要求，所以 /compact 不接参数。

### 3.4 提示词指令（第二期）

- 列表来源：`GET /v1/prompts?workdir=`。展开使用已有的 `expandMarkdown` 和 `/expand` 接口，目录约定沿用 TUI。
- 参数：`/name 参数` 中，`/name` 后的文本作为参数传给后端展开。
- 展开结果替换输入框内容，不自动发送。
- /init 和 /review 作为内置提示词模板提供：
  - /init 让 Agent 生成项目说明文件。
  - /review 复用现有的 code-review Skill 插入逻辑（`useComposerActions.ts:64-89`）。

### 3.5 分端实现

- 共享 UI 只定义注册表、类型、弹层和发送拦截。
- 具体动作通过宿主接口 `ComposerCommandHost` 注入：
  - GUI 用 K-brain 客户端实现。
  - WebUI 用 Gateway 实现。
- 某端不支持的指令在弹层里隐藏，不显示禁用项。
- 涉及镜像文件时两端同步修改，完成前运行 `node scripts/check-mirror.mjs`。
- WebUI 的请求不由 Gateway 直接调用 K-brain。Gateway 校验 agent_request 后转给桌面端 Agent，由桌面端调用 K-brain，Skill 列表就走这条链路（`internal/protocol/pbws/guard.go:54`，`services/gateway/envelope_handler.rs:1016`）。以下提示词模板转发是早期方案，现已停用（见 2026-10-18 评审修复），仅作记录：
  - `crates/agent-gateway/proto/v2/gateway.proto` 新增 `PromptTemplateListRequest/Response` 和 `PromptTemplateExpandRequest/Response`，加入 GatewayEnvelope 和 AgentEnvelope 的 payload；按 `buf.gen.yaml` 重新生成 Go 和 WebUI 的 TS 代码，桌面端 Rust 的生成代码同步更新。
  - `guard.go` 把两个请求加入直通白名单，对模板名、参数和 workdir 做长度上限校验。
  - 桌面端在 `envelope_handler.rs` 和 `gateway_bridge.rs` 处理这两个请求，转调 K-brain 的 `GET /v1/prompts?workdir=` 和 `POST /v1/prompts/templates/{name}/expand`。
  - WebUI 的 `ComposerCommandHost` 用这两个请求实现提示词指令，行为与 GUI 一致。

### 3.6 第三期指令

第三期把第 4 节原先列出的 6 条指令全部做进来，都只复用两端已有的界面和接口，K-brain 和 Gateway 协议不再改动。

| 指令 | 行为 | 复用的入口 |
|---|---|---|
| /rewind | 回退当前会话最近一轮 Agent 的文件改动，沿用行内回退按钮的预览、确认弹窗和冲突检测 | `CheckpointRewindProvider`（`agent-ui/src/lib/chat/checkpointRewind.tsx`） |
| /resume | 打开历史会话搜索 | 侧栏的 `conversationSearchRequestKey`，GUI 动作总线的 search-conversations 走同一条路径 |
| /permissions | 打开设置的“系统工具”分区，AI 审批与执行模式在这里 | 两端的 `openSettings("systemTools")` |
| /mcp | 打开 MCP 设置 | `openSettings("mcp")` |
| /memory | 打开记忆设置 | `openSettings("memory")` |
| /agents | 打开 Agent 设置 | `openSettings("agents")` |

实现要点：

- 输入框和转录区不在同一棵 Provider 子树里。`CheckpointRewindProvider` 按会话 id 登记“回退最近一轮”，`requestCheckpointRewindLatest(conversationId)` 返回 started、none 或 busy。ChatComposerBar 在 Agent 模式下按本输入框的会话补上 /rewind；没有检查点或正在运行时，在指令面板里报错，不发消息。
- /rewind 不接参数，只回退最近一轮。要回退更早的轮次，仍用转录区每条用户消息上的回退按钮。
- 设置类指令在共享层只传 `permissions | mcp | memory | agents`，两端宿主各自映射到本端的设置分区 id，映射表保持一致。
- WebUI 原先没有接会话搜索的请求键，这次在 `GatewayAppView` 里补上并传给侧栏。
- 背景 Pane：GUI 的背景 Pane 同样提供设置类指令和 /resume；WebUI 的背景 Pane 沿用第一期口径，只有 /stop。两端背景 Pane 的 /rewind 都由 ChatComposerBar 按该 Pane 的会话补上。

### 3.7 i18n

指令名保持英文，与 Codex、Claude Code 一致。说明文字、分组标题、错误提示走 i18n，并顺手修复 “Skills” 标题写死英文的问题。

## 4. 本次不做

- /compact 附带压缩要求：后端接口不支持。
- /rewind 选择任意轮次：转录区已有逐条回退按钮，指令只做最近一轮。
- /mcp、/memory、/agents 在输入框里直接增删配置：只打开对应设置页，管理操作仍在设置页完成。

## 5. 测试

- 单元测试：注册表重名优先级、触发位置判断、发送拦截、Skill 解析排除指令名、参数解析。
- 组件测试：弹层分组与键盘交互，覆盖输入法 Enter；无 Skill 时“/”仍可弹出。
- 端到端：两端各验证 /new、/compact、/model、/stop、/help；第二期验证提示词展开后不自动发送。
- 转发链路：`guard.go` 白名单与长度校验的单元测试；桌面端两个请求的处理测试；WebUI 端到端验证提示词展开后不自动发送。
- 第三期：注册表与分发覆盖 6 条新指令；没有挂载回退 Provider 时 /rewind 返回 none；两端宿主的设置分区映射一致。
- 门禁：GUI 和 WebUI 测试、typecheck、lint、UI 边界检查。`scripts/check-mirror.mjs` 已在上游 b00f8357（#399）删除，由 UI 边界检查取代，见 `docs/worklog/issue-752-search-workspace-navigation.md`。

## 6. 交付顺序

1. 第一期：注册表、触发、发送拦截，以及 6 个内置动作指令，两端同步。
2. 第二期：自定义提示词，加上 /init、/review，两端同步提供，包含 WebUI 的转发链路。
3. 第三期：/rewind、/resume、/permissions、/mcp、/memory、/agents，两端同步，见 3.6。

## 7. 待确认

1. /clear 采用“新建对话、保留历史”还是“清空当前对话”。本方案默认前者。
2. 指令执行状态和结果的展示方式：本方案用本地卡片，不进入模型上下文。
3. 自定义提示词是否另外兼容读取 `.claude/commands` 和 `~/.codex/prompts`。本方案默认不读，只沿用 K-brain 的目录。
