# Chat Runtime 架构

## Execution Mode

| 模式 | 入口 | 工具 | 典型用途 |
|---|---|---|---|
| `text` | `runTextConversationTurn.ts` | 不启用本地工具 | 纯模型聊天、低权限文本回答。 |
| `tools` | `runAgentConversationTurn.ts` | 启用 builtin tool registry | 常规 Agent 模式，支持文件、Shell、MCP、Skills、Memory、Cron 等。 |
| `agent-dev` | `runAgentConversationTurn.ts` | 启用工具，并展示更多 debug/usage/silent memory 细节 | 开发调试与可观测性更强的 Agent 模式。 |

## 主流程

| 步骤 | 说明 | 关键模块 |
|---:|---|---|
| 1 | 收集用户输入、附件、选中模型、execution mode、workdir、system tools。 | `ChatPage.tsx`、`ChatComposerBar.tsx` |
| 2 | 加载 Skills prompt、Memory overview、hooks、历史上下文和当前 active segment。 | `useChatSkills.ts`、`memoryPrompt.ts`、`conversationState.ts` |
| 3 | 构造模型 request context，必要时先触发 pre-send compaction。 | `conversationContextBuilders.ts`、`compaction/*` |
| 4 | text 模式直接 stream assistant；tools/agent-dev 构造工具 registry 并进入 tool loop。 | `llm.ts`、`builtinRegistry.ts`、`runAgentConversationTurn.ts` |
| 5 | 流式 token/thinking/hosted search/tool status 更新 transcript，并发布 Gateway event。 | `liveTranscriptStore.ts`、`gatewayBridgeEvents.ts` |
| 6 | 工具调用通过 registry 分派到对应 executor，结果回填模型上下文。 | `lib/tools/*`、`lib/chat/conversation/run/*` |
| 7 | turn 结束后写入 chat history，生成标题，触发 silent memory extraction 和 hooks。 | `chat_history.rs`、`conversationTitleJob.ts`、`silentMemoryExtraction.ts` |

## 模型层

`src/lib/providers/llm.ts` 将应用内部 provider 映射到实际 API：

| Provider | 主要 API | 特性 |
|---|---|---|
| `claude_code` | Anthropic Messages 兼容 | thinking、cache control、toolChoice、Anthropic native web search。 |
| `codex` | OpenAI Responses 或 Completions | Responses storage、hosted search probe、OpenAI tool/search 事件聚合。 |
| `gemini` | Google Generative AI | Gemini thinking runtime、Gemini auth header、provider native search。 |
| custom provider | 按 `ProviderId` 与 request format 映射 | baseUrl/apiKey/model config/reasoning/cache 等由 settings 决定。 |

## 上下文构造

| 上下文块 | 来源 |
|---|---|
| system prompt | 默认系统提示、用户 system settings、Skills prompt、Memory overview、压缩 summary。 |
| messages | 当前 active segment 中的 user/assistant/toolResult 历史，经过 sanitizer。 |
| tools | text 模式为空，agent 模式来自 builtin registry 和动态 MCP tools。 |
| attachments | uploaded files 转成模型可见文本/图片引用，图片 bytes 按上下文策略清洗。 |
| hosted search | provider 或 probe 捕获的 search block 进入消息内容和 UI。 |

## 上下文压缩

| 触发点 | 作用 |
|---|---|
| pre-send | 发送前估算上下文，超预算时先压缩旧历史。 |
| mid-stream | 流式或工具链路中发现预算不足时中断式压缩。 |
| post-tool | 工具调用后上下文膨胀，进入下一轮前压缩。 |

压缩产物以 summary checkpoint 写入新的 history segment。UI 中会显示上下文检查点，后续请求把 summary 合并进 system prompt，并只携带未覆盖的消息窗口。

## Hooks 生命周期

| Event | 触发语义 |
|---|---|
| `agent_start` / `agent_end` | 一次主对话请求开始和结束。 |
| `turn_start` / `turn_end` | 每个模型处理轮次开始和结束。 |
| `message_start` / `message_update` / `message_end` | assistant message 流式生成阶段。 |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 工具实际执行阶段。 |

Hooks 支持 shell script 和 HTTP requests，设置由 GUI/WebUI 同步维护，执行在桌面端。

## 上传与重发

| 能力 | 语义 |
|---|---|
| 文件上传 | 仅在 tools 类模式可用；文件暂存在 `~/.liveagent/uploads`（工作区外，启动时按 30 天时效 GC），模型通过绝对路径以只读方式访问。 |
| 图片预览 | GUI/WebUI 都支持用户附件、Image 工具图片和 inline tool result 图片预览。 |
| 编辑重发 | 从目标 user message 处 truncate 后重发，保持历史语义与 GUI/WebUI 一致。 |
| 附件-only 重发 | 支持仅靠已有附件重新发起请求。 |

## 交互式提问（AskUserQuestion）

| 能力 | 语义 |
|---|---|
| 工具形态 | chat-only 内置工具；模型一次最多提 4 个问题，每题 2-6 个选项且**同轮各题选项数一致**，至多一个"推荐"项且**固定排在首位**。 |
| 挂起语义 | `execute` 在工具挂起表（toolCallId 键）上等待；用户提交后 resolve，停止按钮经 AbortSignal 以"未应答"落定（`details.cancelled`）；**3 分钟未作答按推荐项（缺省第一项）自动落定**（`details.timedOut`），卡片展示倒计时。**倒计时双端同源**：桌面端在网关上报的工具参数上盖 `__askUserQuestionDeadlineAt` 权威截止时间戳（`gatewayToolPreview` 统一盖章，execute 复用同一预置值），WebUI/重连场景按真实剩余时间倒数。 |
| 卡片 UI | `components/chat/AskUserQuestionCard.tsx`（双端镜像）：多问题以顶部 tabs 切换，单选 + 推荐标记，全部作答后提交；应答落定后只读回显。**问题与选项全部生成完毕后整卡出现**（`runAgentConversationTurn` 跳过 AskUserQuestion 的 tool_call_delta，双端不做流式渐显）。 |
| 双端应答 | GUI 直接调用 `answerAskUserQuestion`；WebUI 走 `chat_queue.tool_answer`（item_id=toolCallId，request_json=选择数组）由桌面端落到同一挂起表，协议零改动；远端应答**校验 conversation_id 与挂起提问所属会话一致**，防串会话应答。 |
| 结果回模型 | 标准 `ToolResultMessage`：content 列出每题的最终选择，`details.kind = "ask_user_question"` 驱动历史回放渲染。 |

## 运行态可观测性

| 内容 | 位置 |
|---|---|
| Usage | assistant round 的 token usage，agent-dev 更明显。 |
| Tool trace | `AssistantBubble` 中按 round 和 group 展示工具调用/结果。 |
| Hosted search | Search block 进入 transcript，保留 anchor 与聚合状态。 |
| Debug JSONL | `system_append_debug_jsonl` 可写入本地 debug 日志。 |
| Gateway stream | WebUI 可看到 token/thinking/tool/done/error 等远程事件。 |
