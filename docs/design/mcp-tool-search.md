# MCP 工具懒加载（ToolSearch）设计与实现基线

| 元数据 | 内容 |
|---|---|
| 状态 | Implemented / 首版实现基线 |
| 版本 | v1.0 |
| 日期 | 2026-08-21 |
| 所属计划 | [2026 H2 能力路线图](./2026h2-capability-roadmap.md) P1-② |

## 1. 问题与目标

MCP server 一多，工具参数 schema 会吃掉大量 context（每轮请求都要付）。目标：schema 总量超过阈值时，只把「用得上的」MCP 工具注入模型请求，其余延迟到检索命中后激活——对齐 Claude Code 的 ToolSearch 机制。

## 2. Spike 结论（roadmap 标记的关键技术风险）

对 `pi-agent-core` 0.84.2 的源码核查与真实集成测试得出：

1. `Agent.continue()` 在 loop 启动时对 `state.tools` 拍快照（`createContextSnapshot` 的 `.slice()`），**loop 内不重读**——轮中改 `agent.state.tools` 无效；
2. 但执行侧 `prepareToolCall` 的查找/schema 校验用的也是这份快照——**只要工具始终全量注册，执行永远可达**；
3. runner 自己的 `streamFn` 在**每轮请求**时经 `filterRequestTools` 组装出站工具表——provider 原生搜索桥已在生产中使用「执行层可见、请求层隐藏」这一机制。

**结论：无需触碰 pi-agent-core。** 全部 MCP 工具照常注册执行层，出站请求按「激活集」动态过滤；ToolSearch 激活后**同一 run 的下一轮**立即可见。集成测试
`agent-runner.test.mjs: "requestToolFilter re-evaluates per round"` 以真实 pi-agent-core 正式验证了该行为（轮 1 不含延迟工具 → 轮内激活 → 轮 2 包含且可执行）。

## 3. 核心设计

| 决策 | 取向 | 理由 |
|---|---|---|
| 分层 | **执行层全量注册，请求层过滤** | 执行永远可达（loop 快照约束）；模型看不到的 schema 不付 token |
| 阈值 | 估算 tokens > 12k（`MCP_TOOL_DEFERRAL_THRESHOLD_TOKENS`）才启用 | 低于阈值时多一次检索回合不划算；估算与 `tokenLedger` 同口径（schema JSON） |
| 激活集 | 会话级内存 Map（conversationId → Set），跨 turn 保持，会话销毁清理 | 跨压缩天然不丢（独立于消息历史）；重启后模型重新检索一次即可。`context_meta_json` 持久化留作后续 |
| 检索 | 轻量线性评分：词项对 name(×3)/serverLabel(×2)/description(×1) 子串命中加权 | 目录最多几百条，不引入 FTS；默认返回 5 条、上限 10 |
| 直呼未激活工具 | **放行并自动激活**（executor wrapper） | 执行层本就找得到；激活保证后续轮次请求含 schema，避免模型困惑 |
| 引导 | ToolSearch 工具 description 内嵌「N 个工具来自哪些 server 被延迟」 | 工具描述随每轮请求可见，无需改 system prompt（保护前缀缓存） |
| Plan mode 交互 | plan mode 下不注册 ToolSearch | MCP 工具非只读，plan mode 本就不在表内，激活无意义 |
| 缓存代价 | 激活会改变请求工具表 → 前缀缓存作废一次 | 懒加载固有代价（Claude Code 同）；激活是低频事件，省下的常量开销远大于此 |

## 4. 组件与文件

- `crates/agent-gui/src/lib/tools/toolSearchTools.ts`（新）— `ToolSearch` 工具（检索+激活）、`shouldDeferMcpTools` 阈值判定、`getMcpToolActivation`/`clearMcpToolActivation` 会话级激活集、`buildMcpRequestToolFilter` 请求层谓词
- `crates/agent-gui/src/lib/chat/runner/agentRunner.ts` — 新增 `requestToolFilter` 参数，叠加进 `filterRequestTools`（每轮请求重估）
- `crates/agent-gui/src/lib/tools/builtinRegistry.ts` — `toolSearch` 参数：超阈值时注入 ToolSearch bundle；返回值带 `mcpToolDeferralActive` 标志
- `crates/agent-gui/src/pages/chat/turns/runAgentConversationTurn.ts` — 传 `toolSearch`、构建 requestToolFilter、executor 直呼自动激活
- `crates/agent-gui/src/pages/ChatPage.tsx` — 会话销毁时清理激活集
- 目录/i18n/分享脱敏清单（TS + Rust）同步 `ToolSearch` 条目

## 5. 已知边界（首版）

1. **激活集不落盘**：重启后新会话由模型重新 ToolSearch（一次工具回合）；直呼激活兜底保证历史中出现过的工具名仍可直接调用。后续按 `taskList` 路径补 `context_meta_json` 持久化。
2. **阈值暂为常量**（12k tokens）：`shouldDeferMcpTools` 已支持注入阈值，设置项待接（roadmap 待拍板项 c）。
3. **仅主会话生效**：子代理注册表与 Cron auto-prompt 不启用延迟（各自 fresh context，工具量可控）；后续可按需扩展。
4. **压缩预算按全量估算**：`combinedTools`（含延迟工具）进压缩预算 → 轻微高估、提前压缩，方向保守安全。

## 6. 测试

- `test/tools/tool-search-tools.test.mjs` — 5 用例：阈值判定（含注入阈值）、schema、检索排序+激活+空命中引导+参数错误、会话隔离+清理、请求谓词活引用语义
- `test/chat/agent-runner.test.mjs` — **轮中激活集成测试**（真实 pi-agent-core）：轮 1 请求不含延迟工具 → 轮内激活 → 轮 2 请求包含 → 两次调用均真实执行
- `test/tools/builtin-registry-subagent-mcp.test.mjs` — 低于阈值不注册 ToolSearch、判定口径一致性

全量基线：agent-gui 2464/2464、三端 tsc 零错误、biome 与 main 基线持平。
