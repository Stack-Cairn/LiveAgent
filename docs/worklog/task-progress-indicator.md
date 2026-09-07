# Durable task progress

## 目标

LiveAgent 的任务清单必须属于当前 Agent Run，而不是属于前端进程或某一段模型上下文。一次 Run 内无论发生多少次上下文压缩，任务的 ID、顺序、内容和状态都保持稳定；下一条用户消息开始新 Run 时才清空。

## 权威状态

| 层级 | 设计 |
|---|---|
| 工具协议 | `TaskCreate` 创建单个任务，`TaskUpdate` 按稳定 `taskId` 更新，`TaskList` 返回完整快照；不存在整表替换接口。 |
| 身份 | 执行器按 `nextTaskId` 分配单调递增数字 ID，模型不能指定或复用 ID。 |
| 并发 | 三个任务工具共享串行队列，避免同一工具回合并发创建时重复分配 ID。 |
| 持久化 | `TaskListState` 写入 `StoredChatContextMeta.taskList`，随现有 `context_meta_json` 和压缩 checkpoint 原子持久化；任务提交走非终态持久化通道，中途写盘失败只属于该次工具调用，不得把成功收尾的 Run 上报为 `history_persist_failed`。 |
| 压缩恢复 | 每次模型请求都从当前会话状态动态注入同一份 `runId/revision/tasks` 权威 JSON，不依赖自由文本摘要恢复任务；注入与工具同口径按 `runId` 门控，异 Run 状态视为不存在。 |
| Run 边界 | `useSendChatTurn` 在追加新用户消息前清除上一 Run 的 `taskList`，edit-resend 替换回来的历史状态同样清除；压缩、工具回合和流中恢复不清除。 |
| Checkpoint 事务 | 追加新 Segment 时，在同一 SQLite 事务中先刷新刚封存的旧活跃 Segment，再插入带 summary 的新 Segment，保证工具消息、任务状态和总消息数同步推进。 |

## UI 投影

GUI 与 Gateway WebUI 只读取成功 `TaskCreate`、`TaskUpdate`、`TaskList` 结果中的完整 canonical snapshot。投影不读取流式参数，不按文案或位置猜测身份，也不做延时序列兼容。任务工具块在 transcript 中保持 standalone 并统一隐藏，输入框上方的进度指示器以 `task.id` 作为 React key。

指示器只常驻一个按内容收缩的步进药丸；任务清单是绝对定位的 hover 浮层，指针移开或焦点离开即收起，因此任何状态下都不占据 transcript 的布局高度，也不参与 composer 的高度预留。

## 不变量

| 不变量 | 保证方式 |
|---|---|
| 压缩不能创建新计划 | 权威状态位于会话元数据；压缩摘要不拥有任务生命周期。 |
| 更新不能改变其他任务身份 | `TaskUpdate` 必须提供现有 `taskId`，只修改明确给出的字段。 |
| 最多一个进行中任务 | 执行器拒绝会产生多个 `in_progress` 的更新。 |
| 工具成功必须可恢复 | 先落盘、成功后才应用到运行时状态；失败时状态从未变更，直接返回错误。 |
| 损坏数据不阻塞会话 | 历史 `taskList` 解析失败按丢弃降级并告警，绝不让整个会话窗口无法打开。 |
| 压缩成功必须已落盘 | checkpoint 持久化返回 `false` 时按压缩失败处理，禁止切换运行时 Segment 或发布 checkpoint。 |
| 双端显示一致 | 共享 `taskProgress.ts` 只接受 canonical result details，GUI/WebUI 使用同一投影和组件。 |

## 验证

- 任务工具测试覆盖 schema、稳定 ID、并发创建、按 ID 更新、单一进行中任务、只读列表和持久化失败。
- 历史测试覆盖 `context_meta_json` 中任务状态的严格解析与恢复，以及损坏任务清单降级为丢弃而不阻塞窗口打开。
- 压缩控制器测试覆盖连续两个 checkpoint 后 `runId/revision/tasks` 完全一致。
- 历史持久化测试覆盖 checkpoint 原子刷新封存段并追加新段，以及持久化拒绝时不切换运行时 Segment。
- GUI/WebUI 投影测试覆盖成功结果优先、忽略半截参数/失败结果、用户 Run 边界和 transcript 过滤。
- GUI 与 WebUI 全量前端测试、双端 TypeScript、生产构建、镜像检查和 UI 边界检查均作为合入门禁。
