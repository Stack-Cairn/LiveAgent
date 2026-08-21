# Plan Mode（计划模式）设计与实现基线

| 元数据 | 内容 |
|---|---|
| 状态 | Implemented / 首版实现基线 |
| 版本 | v1.0 |
| 日期 | 2026-08-21 |
| 所属计划 | [2026 H2 能力路线图](./2026h2-capability-roadmap.md) P1-① |

## 1. 需求与语义

「只读探索 → 提交计划 → 用户批准 → 自动进入执行」的模式闸门，对齐 Claude Code 的 plan mode：

1. 用户在 composer 打开「计划」开关（仅 agent 执行模式可见）后发起的 turn 处于 plan mode；
2. plan mode 的 turn 里，模型**只拿到只读工具** + `ExitPlanMode` + 子代理协作工具（Agent/SendMessage，Agent 强制 readonly）；
3. 模型完成调研后调用 `ExitPlanMode(plan)` 提交完整计划（markdown），渲染为交互卡片挂起等待；
4. 用户「批准并开始执行」→ 关闭 plan 开关 + 自动入队"开始执行"续轮（带 `planModeEnabled:false` 快照）；本轮剩余部分仍处于 plan mode，模型收到指令简短收尾；
5. 用户「要求修改」（可附反馈）→ 反馈作为工具结果回传，模型留在 plan mode 继续完善；
6. 计划**无应答超时**：待决计划跨 run 存活，直到用户批准、退回或提交被新计划覆盖（对话式范式下"不批准"就是继续对话，无需超时裁决）；停止/删除会话则随会话清理。

## 2. 核心设计决策

| 决策 | 取向 | 理由 |
|---|---|---|
| 写工具处理 | **注册表组装层直接裁掉**（`filterForPlanMode`），非 deny 后备拦截 | 模型根本看不到写工具：省 token、无泄漏面；沿用 deny-不发送的既有取向 |
| 执行层后备 | `resolveToolGate` 加 plan-mode 分支兜 seed 恢复等旁路 | 语义与工具表一致，双保险 |
| 批准后本轮行为 | **不做轮中工具热切换**；本轮收尾，续轮全工具执行 | 工具表在 turn 起始冻结；轮中扩充依赖 pi-agent-core 行为（P1-② spike 范围），首版不冒险 |
| 模式开关载体 | `ChatRuntimeControls.planModeEnabled` | 复用 settings → composer → 队列快照 → 网关覆盖的现成管线 |
| 归一化方向 | 仅显式 `true` 生效（限制性开关与联网/思考相反） | 旧配置/远端缺失字段不得把历史会话意外锁进只读 |
| 跨端合并方向 | **只能收紧**（任一来源要求 plan mode 即生效） | 同 `strictestCommandSafetyMode`（P3#9）：远端陈旧快照的 false 不得关闭本地 plan mode |
| system prompt 段 | turn 级冻结注入（`withAgentRuntimeContext`，与 frozenTaskListContext 同列） | run 内恒定，保护前缀缓存；轨迹数组同步记录保持同口径 |
| 子代理 | `parseSubagentBatch(forceReadonly)`：显式 worktree 按参数错误**拒绝**（非静默降级），缺省/复用身份收敛 readonly | 全仓 fail-closed 取向；模型收到明确指引后重试 |
| ExitPlanMode 元数据 | `isReadOnly: true` | 工具本身无副作用（仅挂起等待）；计划卡片即审批门，不应再叠工具审批 |
| 远端应答通道 | `chat_queue.plan_decision` action 字符串 + `request_json` | 与 tool_answer/tool_approval 同模式，**零 proto 改动、零 breaking 风险**（Go relay 与 Rust relay 均把 action 当不透明字符串转发） |
| 批准回调异常 | 吞掉并 console.warn，不污染工具结果 | 批准事实已落定；续轮入队失败不应让模型看到错误 |

## 3. 组件与文件

**共享契约层（agent-ui，端无关）**
- `lib/chat/planMode.ts` — 工具名、长度常量、`PlanDecision`/`ExitPlanModeResultDetails` 类型、待决/已批准参数标记、容错解析（对标 `askUserQuestion.ts`）
- `components/chat/PlanModeCard.tsx` — 计划卡片：markdown 渲染（内滚动）、倒计时（时钟可比性校验同 AskUserQuestionCard）、批准/要求修改（附反馈）、落定态展示
- `components/chat/assistant-bubble/ToolCallItem.tsx` — 按工具名分派（同 AskUserQuestion），details 优先、流式参数兜底
- `lib/tools/builtinToolCatalog.ts` — `exit_plan_mode` 目录条目（conditional，CHAT_ONLY）
- `lib/settings/types.ts` / `index.ts` — `planModeEnabled` 字段 + 归一化
- `components/chat/ComposerModelControls.tsx` — 「计划」RuntimeToggleChip（sky 色系，仅 agent 模式渲染）

**桌面端（agent-gui）**
- `lib/tools/planModeTools.ts` — `ExitPlanMode` 工具 + 待决计划登记表 + `answerPlanDecision`（本地/远端同一入口）+ `isPlanModeAllowedTool` + plan mode system prompt 段
- `lib/tools/builtinRegistry.ts` — `planMode` 参数：注入 ExitPlanMode bundle + `filterForPlanMode` 过滤两条 return 路径 + 子代理 `forceReadonly` 透传
- `lib/subagents/validate.ts` / `agentTool.ts` — `forceReadonly` 选项与工具描述提示
- `pages/chat/turns/runAgentConversationTurn.ts` — `planModeEnabled`/`onPlanApproved` 参数、prompt 段冻结注入 + 轨迹同口径、`resolveToolGate` 后备拦截
- `pages/chat/turns/gatewayToolPreview.ts` — ExitPlanMode 待决/已批准标记盖章
- `pages/chat/runtime/useSendChatTurn.ts` — `effectivePlanModeEnabled` 三源"只能收紧"合并、回调透传
- `pages/chat/queue/useChatTurnQueue.ts` — `plan_decision` action 分支、`enqueueComposerTurnForConversation` 支持 `runtimeControls` 覆盖
- `pages/ChatPage.tsx` — `handlePlanApprovedForConversation`（关开关 + 入队执行续轮）、会话销毁 cancel 兜底
- `agent-ui-adapters/assistantBubble.ts` — `readPlanDecisionDeadline`/`submitPlanDecision`（直连挂起表）
- `src-tauri/services/gateway_bridge.rs` — 分享脱敏清单补 `ExitPlanMode`（覆盖测试强制）

**WebUI（agent-gateway/web）**
- `lib/chat/planModeBridge.ts` — 模块级单例桥（对标 toolApprovalBridge）
- `app/GatewayApp.tsx` — handler 注册 → `chatQueuePlanDecision`
- `lib/gatewaySocketRpc.ts` — `chat_queue.plan_decision` RPC
- `agent-ui-adapters/assistantBubble.ts` — 待决/已批准状态读取（GUI 订阅登记表,WebUI 参数标记 + 本地落定 overlay）、提交走桥

## 4. 已知边界（首版）

1. **批准后本轮不解锁工具**：执行始终从续轮开始。轮中工具表扩充留待 P1-②（ToolSearch）的 spike 结论。
2. **WebUI 无法远程开/关 plan 开关**：proto `ChatRuntimeControls` 未加 `plan_mode_enabled` 字段（需 buf 工具链，`mise install` 后 `make proto && make proto-check` 可补）。远程**审批计划**（批准/退回）已完整可用——这是 parity 的关键部分。合并语义已按"只能收紧"实现，加字段后无需改逻辑。
3. **planState 未持久化到 `context_meta_json`**：计划内容依赖 ExitPlanMode 工具结果留在会话历史（压缩后由摘要承载）。若需要"跨压缩权威计划注入"（同 taskList 的 File Ledger 待遇），按 `StoredChatContextMeta.taskList` 的完全相同路径补 `planState` 字段（零 Rust 改动）。
4. Cron auto-prompt 场景不注册 ExitPlanMode（无人值守，无审批可言）；planMode 参数仅 chat scope 生效。

## 5. 测试

- `test/tools/plan-mode-tools.test.mjs` — schema、sanitize/resolve/parse、空计划拒绝、批准（含非法/串会话应答拒绝、回调触发、重复应答拒绝）、拒绝（反馈回传）、新提交覆盖旧登记、按会话 cancel 隔离（含批准落定态清理）、`isPlanModeAllowedTool` 白名单
- `test/subagents/validate.test.mjs` — forceReadonly：显式 worktree 报错、缺省/复用身份收敛 readonly、显式 readonly 通过
- `test/tools/builtin-registry-subagent-mcp.test.mjs` — plan mode 注册表过滤：只读+计划+协作工具在表、一切写能力（内置+MCP）不在表、Agent 描述带 PLAN MODE 提示
- 存量适配：`tool-argument-display.test.mjs`（新模块 mock）、`settings/normalization.test.mjs`（期望对象补 `planModeEnabled: false`）
- Rust `shared_chat_history_builtin_policy_covers_the_tool_catalog` 覆盖测试通过（脱敏清单同步）

全量基线：agent-gui 2457/2457（含 cargo 后端 940 用例）、三端 tsc 零错误、biome 与 main 基线持平。
