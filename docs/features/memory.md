# Memory 系统

## 总体模型

LiveAgent 的记忆系统由 Rust `MemoryStore` 作为本地真相源；前端 TypeScript 记忆域分布在共享包与桌面运行时中，提供 Settings 管理、Chat prompt 注入、`MemoryManager` 工具、回合后静默提取与离线组织器。Gateway/WebUI 不拥有独立记忆库，只把 WebUI 的 memory 请求转发到桌面端。

| 层 | 路径 | 职责 |
|---|---|---|
| Rust Store | `src-tauri/src/services/memory/` | Markdown 文件读写、SQLite FTS 索引、搜索、quota、daily、organize run、audit；`mutations/evidence.rs` 是置信度契约与 evidence frontmatter 的唯一实现点。 |
| Tauri commands | `src-tauri/src/commands/integration/memory.rs` | `memory_list/read/search/write/update/delete/accept/apply_batch/quota_summary/organize_*` 等入口。 |
| 唯一真源 schema | `crates/agent-ui/src/lib/memory/schema.ts` | scope/type/confidence/action 枚举、计划/决策形状、`CONFIDENCE_CONTRACT` 常量。 |
| 配置常量 | `crates/agent-ui/src/lib/memory/config.ts` | 记忆域全部魔数（节流、窗口、簇大小、配额阶梯阈值等）。 |
| 前端 API | `crates/agent-ui/src/lib/memory/api.ts` | memory commands 的 TypeScript 封装；具体传输由宿主适配。 |
| Prompts | `src/lib/memory/prompts/{shared,injection,extraction,organizer,managerTool}.ts` | 按受众拆分：注入索引、提取指令、组织器提示、工具描述；策略文案单一来源。 |
| 提取引擎 | `src/lib/chat/memory/extractionEngine.ts` | 回合后隐藏 LLM 轮：紧凑上下文 → `SubmitMemoryPlan` 工具提交 → 单次 `memory_apply_batch`。 |
| 提取控制器 | `src/lib/chat/memory/extractionController.ts` | 会话级生命周期：同步原子认领、独立 AbortController、coalesce 队列、dispose 清理。 |
| Tool | `src/lib/tools/memoryTools.ts` | 对模型暴露 `MemoryManager`（ro/rw）；evidence 以结构化字段直传 Rust。 |
| 组织器 | `src/lib/memory/organizer/{pipeline,runRecord,quota,service}.ts` + `src/components/memory/useMemoryOrganizer.ts` | 纯函数流水线 + 类型化 v4 run 记录 + 配额阶梯 + 平凡 TS 调度服务（React 仅挂载）。 |
| Settings UI | `crates/agent-ui/src/pages/settings/memory/` + 各端 `platform.tsx` | 记忆管理、organizer 设置/历史/手动应用、配额横幅。 |

## 存储结构

| 数据 | 位置 | 说明 |
|---|---|---|
| Markdown 事实源 | `~/.liveagent/memory/...` | 记忆正文和 frontmatter 的 canonical source。 |
| SQLite index | `~/.liveagent/memory/memory-index.sqlite3` | `memory_meta`、`memory_fts`、`memory_fts_tri`、`memory_audit_log`、`memory_organize_runs`（schema v4，v3→v4 增量迁移保留历史）。 |
| Settings | `settings_save_memory` 持久化 | summary model、organizer schedule/scope/mode 等。 |
| Organize run 记录 | `memory_organize_runs` | v4 列含 `phase/final_count/compression_ratio/token_usage_total/quota_headroom_at_start`；`report` 字段存类型化 v4 报告（只经 `runRecord.ts` 解析）。 |

## Scope 与类型

| 维度 | 值 | 说明 |
|---|---|---|
| scope | `global` | 跨项目用户偏好、身份事实、长期反馈。 |
| scope | `project` | 与当前 workdir 绑定的项目记忆；写入受项目域闸门约束。 |
| type | `user` | 用户身份、偏好、习惯。 |
| type | `feedback` | 用户对 Agent 行为的长期反馈。 |
| type | `project` | 项目知识、架构约定、工作流。 |
| type | `reference` | 可引用资料。 |
| type | `daily` | Journal/日记型记忆，scope 固定为 global，按日期 append；不可作为写入类型暴露。 |

## Evidence 与置信度契约

写入/更新的证据（confidence、source_quote、reasoning、aliases、supersedes、conflicts_with、override_reject）由 TS 以**结构化字段**传给 Rust（`MemoryEvidenceArgs`）；Rust `mutations/evidence.rs` 负责渲染 canonical frontmatter 并执行契约：

- `high` 需要 ≥5 字符的逐字引用，否则降为 `medium`；`medium` 需要非空引用，否则降为 `low`；降级记录 `auto_downgraded: true`。
- Mutation 响应回传 `appliedConfidence/autoDowngraded`，`MemoryManager` 工具结果附降级提示。
- 全系统只有 Rust 一处写 frontmatter、一处读回（索引 reconcile），TS 不做任何序列化。

## Quota 语义与阶梯

| 项 | 说明 |
|---|---|
| ordinary memory | 非 daily 的 global/project 记忆；每 scope 上限 500。 |
| `memory_quota_summary` | 按 scope 返回 used/limit/headroom/archived/unreviewed/最老未审核天数。 |
| 配额阶梯 | `organizer/quota.ts` 按最紧 scope 的 headroom 分级：normal(>100)/notice(≤100)/degraded(≤50)/critical(≤20)/exhausted(≤5)；非 normal 时设置抽屉显示横幅，组织器提示词注入压缩目标（不做静默自动归档）。 |
| daily | 不计入 ordinary quota。 |

## 召回路径

| 路径 | 说明 |
|---|---|
| Overview 注入 | Chat 每轮调用 `memory_index_overview`，`prompts/injection.ts` 渲染紧凑 Memory Index（30/桶、16KB 帽）加入 system prompt。 |
| MemoryManager | 模型可显式 `list/read/search` 召回更多条目，必要时 mutation。 |
| Search | SQLite FTS5/BM25 与 trigram 辅助中文/短词检索，结果再按 scope、review、daily 衰减等排序。 |
| Project shadow | 当前项目记忆可在 overview 中覆盖同 slug/同语义 global 记忆。 |

## Unreviewed 与审核

| 状态 | 语义 |
|---|---|
| reviewed | 普通高可信记忆，可直接进入召回排序。 |
| unreviewed | 未审核但可用的工作记忆，overview 以 `*:h/m/l/?` 标注置信度。 |
| recent rejections | 提取校验层拒绝重写近期被用户拒绝的 slug，除非计划项携带 `override_reject`。 |
| accept | `MemoryManager`、Settings 或提取计划的 accept 项可把 unreviewed 转成 reviewed。 |

## 回合后提取（SubmitMemoryPlan 协议）

| 阶段 | 说明 |
|---|---|
| 触发 | 两个 turn runner 在回合末调用 `memoryExtraction.requestExtraction`；agent-dev 模式等待并展示，其余模式后台运行。 |
| 控制器 | 门控（空消息/过短/问候/致谢/30s 间隔/同消息去重）与认领在首个 await 前同步完成；每 run 自有 AbortController，与聊天请求信号解耦——新用户轮不会掐断在飞提取；运行中新请求进 coalesce 队列；会话删除时 `dispose` 清理。 |
| 上下文 | 自包含紧凑输入：末 4 用户轮逐字窗口（2000 字/条、12000 字/窗）+ `<workspace-mutations-this-turn>` 确定性变更摘要（项目域闸门证据）+ candidates(30)/rejections(7d)/already-written 块。不复用聊天 system prompt。 |
| 输出协议 | 模型经一次 `SubmitMemoryPlan` 工具调用提交计划（write/update/accept/delete/append_daily）。identify→match→plan 仅作提示词内推理指引。首轮未提交时以只挂该工具的追加轮重试；仍缺则记为 noop，永不丢轮。 |
| 校验 | `planTool.ts` 逐条校验（缺字段/域闸/被拒 slug/重复/超长），坏条目带码拒绝、其余照常应用。 |
| 应用 | 单次 `memory_apply_batch`（upsert/update/delete/accept + dailyAppend），与组织器、手动应用共用同一持久化路径；`op=update` 支持证据仅更新。 |
| 状态展示 | 状态行经 i18n（`chat.memoryExtraction.done/noop/partial`）渲染，不再有硬编码中文哨兵。 |

## 组织器（scan → cluster → plan → gate → apply）

| 阶段 | 说明 |
|---|---|
| 调度 | `organizer/service.ts` 一次性 `setTimeout` 从 `organizerNextRunAt` 唤醒；禁用或 frequency=none 时不 arm 任何定时器；Run Now 经 `pokeMemoryOrganizer()`（window 事件总线已删除）。 |
| scan | `memory_quota_summary` + 全量 list/read；记录 `quota_headroom_at_start`。 |
| cluster | >8 条时 LLM 主题聚类（`SubmitMemoryTopicClusters`），失败回退结构聚类（scope:hash:type × 8）。 |
| plan | 每簇 `SubmitMemoryOrganizePlan` 工具提交（keep/merge_into/delete/mark_review/rewrite_hint），带全局清单与配额压缩目标；簇级失败隔离。 |
| gate | `pipeline.ts` 独立重算 risk（cross_scope→high、低置信→high、reviewed→≥medium 等），按 trigger×mode×risk×confidence 决定自动应用或排队；拒绝分桶记录。 |
| apply | scheduled 自动应用低风险；manual 存入 v4 报告待面板复核（`memory_apply_batch` 按 groupId 保证合并先写后删）。 |
| 记录 | 每相位更新 run 行；完成时写 `final_count/compression_ratio/token_usage_total` 与类型化 `report`（v4）；旧版报告在面板降级为只读摘要。 |

## Gateway/WebUI 边界

| 场景 | 实现 |
|---|---|
| 共享纪律 | schema、config、API、organizer 纯逻辑与 Settings 组件位于 `crates/agent-ui`；平台差异只进各端 `pages/settings/memory/platform.tsx`。 |
| WebUI MemoryPanel | 通过 `memory.manage` 转发到桌面端；desktop 桥的 `handle_memory_manage_sync` 为显式 match（新增命令需加臂）。 |
| WebUI organizer | Run Now 创建 pending run（`pokeMemoryOrganizer` 恒 false → QueuedRemote 提示），实际执行依赖桌面端认领。 |
| 提取/组织执行 | 仅桌面端（`prompts/*`、`extraction/*`、`organizer/{pipeline,service}`、`memoryTools` 不进入 WebUI 宿主）。 |
| Project scope | WebUI 请求必须带 workdir，Gateway bridge 透传到 Rust，避免 project memory 失真。 |

## 常见排障入口

| 问题 | 优先检查 |
|---|---|
| 记忆没有写入 | 控制器 skip 原因（console.debug）、`SubmitMemoryPlan` 是否提交、`planTool` 拒绝码、`memory_apply_batch` warnings、MemoryStore audit log。 |
| 提取被跳过 | `extractionSkipReason` 门控（过短/问候/节流/同消息）、coalesce 队列。 |
| 搜不到记忆 | `memory-index.sqlite3` 是否 reconcile、FTS 行是否存在、scope/workdir 是否正确。 |
| WebUI project memory 错位 | `memory.manage` payload 是否带 workdir，Gateway bridge 是否透传。 |
| quota 显示不对 | `memory_quota_summary`、`deriveQuotaLadder` 阈值、面板横幅。 |
| organizer 0 合并 | run 记录 `report.rejectionBuckets` 分桶、mode 注入、`shouldQueueDecision` 矩阵。 |
| daily 标题异常 | `daily_slug_local_date`、`daily_title_for_meta`、Settings Journal 渲染。 |
