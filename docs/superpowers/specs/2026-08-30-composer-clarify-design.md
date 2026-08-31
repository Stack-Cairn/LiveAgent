# 输入框提示词澄清功能设计

日期：2026-08-30
状态：已批准

## 背景与目标

很多用户提示词水平不佳，且经常不清楚自己要什么。目标：在聊天输入框旁提供
一个「澄清」按钮，通过一个轻量 LLM 对话持续追问用户以澄清需求，最后产出
优化后的提示词放回输入框。澄清逻辑从 superpowers 的 brainstorming 技能拆编。

已确认的需求决策：

- UI 形态：输入框上方内嵌面板
- 模型：当前会话选中的主模型
- 覆盖范围：桌面 GUI 与 Web（agent-gateway）两个 surface 同时
- 结束时机：LLM 自行判定问够即出终稿；面板常驻「直接生成」按钮兜底
- 草稿处理：产物只替换文本段，附件、文件/代码/commit 提及原样保留
- 上下文感知：草稿 + 轻量工作区信息（workdir、git 分支），不含文件内容

## 架构

新增共享代码位于 `crates/agent-ui/src/components/chat/clarify/`：

```
clarify/
├── ClarifyPanel.tsx        # 内嵌面板 UI：消息气泡 + 输入行 + 操作按钮
├── useClarifySession.ts     # 状态机：消息列表、轮次、加载态、终止
├── clarifyProtocol.ts      # 终稿协议解析 + 系统提示词构建
└── clarifyTypes.ts         # ClarifyMessage / RunClarifyTurn / ClarifyResult 类型
```

`useClarifySession` 状态机：

```
idle → asking(流式) → asking(等待用户) → … → synthesizing(生成终稿) → done
```

- 持有完整消息数组（system + 交替 user/assistant），每轮整段发给 LLM，
  无服务端会话状态。
- 「直接生成」按钮：向消息末尾注入指令让 LLM 立即产出终稿。
- AbortController 贯穿：面板关闭或切换会话即取消在途请求。

## 注入接口

`ChatComposerBarProps` 新增：

```ts
runClarifyTurn?: (messages: ClarifyMessage[], signal: AbortSignal) => Promise<string>;
clarifyContext?: { workdir: string; gitBranch?: string };
```

缺省不渲染按钮（与 `mentionApps` 等 props 同一门控模式）。

GUI 宿主（`ConversationPaneHostEnvironment`）：包装现有
`streamAssistantMessage`（`crates/agent-gui/src/lib/providers/runtime/textOnlyRuntime.ts`），
模型取 `resolveEffectiveChatModelSelection` 当前值，`sessionId` 带 `clarify-`
前缀以独立于主会话。

Web 宿主（`GatewayAppView`）：新增 gateway RPC `clarify_prompt_turn`，
复用现有 WebSocket 客户端与 protobuf envelope；服务端用当前 provider 配置
执行一次文本补全并整段返回（澄清轮次短，无需流式）。

## 交互

- 按钮位于输入框底部控制行（模型选择器旁），IconSet 现有「问号/气泡」类图标。
- 点击取当前草稿文本为初始需求；草稿为空按钮禁用。
- 面板打开期间输入框本体仍可编辑，但发送按钮禁用（避免中途发送半成品草稿）。
- 产物落框后面板自动关闭，焦点回输入框，用户可继续编辑或直接发送。

## 提示词设计

系统提示词（`clarifyProtocol.ts` 常量，从 superpowers brainstorming 拆编）：

- 角色：提示词澄清助手，帮用户把模糊想法变成可直接执行的提示词。
- 规则：
  - 一次只问一个问题。
  - 问题优先给 2-4 个选项（用户可直接选）或允许开放回答。
  - 聚焦：目的（想达成什么）、约束（技术/范围/风格）、成功标准（怎样算完成）。
  - 草稿已经清楚的部分不重复问；最多问 5 轮，够了就出终稿。
  - 回复语言跟随用户草稿语言。
- 附 `clarifyContext` 的轻量工作区信息。

## 终稿协议

每轮 assistant 回复以单行标记开头：

```
[CLARIFY_QUESTION]
本周期的提问文本……

[CLARIFY_FINAL]
优化后的完整提示词……
```

- 流式接收时按行检测标记：QUESTION 把后续文本渲染为气泡；FINAL 切换到
  `synthesizing`，完成后走落框流程。
- 选标记而非 JSON：问题文本流式展示给用户，JSON 需整体解析完才能渲染，
  标记方案首 token 即可上屏；无需启用 `allowJsonOutput`。
- 解析失败兜底：无标记回复整体当 QUESTION 处理，流程不中断。

## 终稿落框

1. `final` 文本到手，面板显示完成态。
2. 通过 `MentionComposerHandle` 写入：只替换 `type: "text"` 段，提及与
   附件原样保留；以 `typeText` 打字机动画呈现。若现有 API 不足以保留
   chips/附件，实现 `replaceTextSegments(text)`，原则不变。
3. 面板关闭，焦点回输入框。

## 错误处理

| 场景 | 行为 |
|---|---|
| LLM 调用失败 | 面板内错误行 + 「重试」「关闭」；重试重发同一轮，历史保留 |
| 面板关闭 / 切换会话 | AbortController 取消在途请求，会话丢弃（不持久化） |
| 无标记回复 | 兜底当 QUESTION 渲染 |
| 超过 5 轮仍提问 | 第 6 轮起前端自动注入终稿指令，强制收尾 |
| 草稿为空 / 无模型配置 | 按钮禁用，title 提示原因（复用 `hasModels` 门控模式） |
| agent 正在运行 | 澄清仍可用（独立于会话 runtime，不占会话上下文） |
| Web RPC 失败 | 错误经 `onSttError` 同款 toast 通道上报 |

## i18n

全部文案走 `useLocale` 的 `chat.clarify.*` 键，中英两份。

## 测试

- `clarifyProtocol`：标记解析（QUESTION/FINAL/无标记/标记在流中间被切断）纯函数单测。
- `useClarifySession`：假 `runClarifyTurn` 驱动全状态转换：提问、回答、强制收尾、取消、失败重试。
- GUI 宿主包装器：mock `streamAssistantMessage`，断言参数映射（当前模型、sessionId 前缀、context 构造）。
- Web RPC：对齐 `crates/agent-gateway/test/webui/gateway-socket-client.test.mjs` 现有模式加 envelope 用例。
- 测试落 `crates/agent-gui/test/`（`.mjs`，现有惯例），不新建测试框架。

## 实施偏差记录（计划 1 落地后）

- 无模型配置：按钮隐藏而非禁用（原表：禁用+title 提示）。GUI 零模型用户本就无法澄清，影响低；Web 接线（计划 2）时统一决定。
- 面板打开期间发送：实现为 handleComposerSend 内守卫（Enter/点击静默无操作），发送按钮保持视觉启用。后续可改为视觉禁用。
- clarifyRunner 未传 sessionId（与 conversationTitleJob 同惯例）；provider 代理若按 session 隔离需补 `clarify-` 前缀。
- 计划 2（Web）应逐字复用 clarifyProtocol 标记协议；Web 宿主只需实现 RunClarifyTurn。
