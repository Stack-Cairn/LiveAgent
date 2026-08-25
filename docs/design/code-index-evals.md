# 代码索引检索冒烟集（30 条）

| 元数据 | 内容 |
|---|---|
| 状态 | v1（随 feature/code-index-semantic-search 落地） |
| 上游 | `docs/design/code-index.md` §11 · 路线图 §5 验收项 2 |
| 用途 | hybrid top-5 命中率 vs 纯 Grep 基线；作为 evals 框架的第一块砖（P4 收口） |

## 评测协议

- **被测对象**：本仓库（LiveAgent）全量索引后的 `CodeSearch(query, mode="hybrid")`。
- **命中判定**：top-5 结果中任一条的 `path` 命中「期望文件」列即记 1，否则记 0。
- **Grep 基线**：把 query 原样交给 `Grep`（pattern=query 的字面检索，
  output_mode=files, head_limit=5）；中文与意图式查询预期基线大量脱靶——这正是
  语义路要补的缺口。
- **通过线**：hybrid 命中率 − Grep 基线命中率 ≥ 25 个百分点，且 hybrid 绝对命中率 ≥ 80%。

## 查询集

意图式英文（10）：

| # | query | 期望文件（任一命中即可） |
|---|---|---|
| 1 | where is the cooperative cancellation flag for skill install jobs | `src-tauri/src/services/skills/jobs.rs` |
| 2 | quarantine corrupted sqlite database and rebuild | `src-tauri/src/services/memory/schema.rs`, `src-tauri/src/services/code_index/schema.rs` |
| 3 | debounce file system events before emitting workspace activity | `src-tauri/src/services/workspace_watch/watcher.rs` |
| 4 | how are MCP tools lazily activated to save context | `src/lib/tools/toolSearchTools.ts` |
| 5 | plan mode filters out non-readonly tools from the registry | `src/lib/tools/builtinRegistry.ts`, `src/lib/tools/planModeTools.ts` |
| 6 | OAuth PKCE authorization code flow for MCP servers | `src-tauri/src/services/mcp_oauth/flow.rs` |
| 7 | reciprocal rank fusion of lexical and semantic search results | `src-tauri/src/services/code_index/search.rs` |
| 8 | per workspace settings tombstone cleanup after 90 days | `src/lib/settings/workspaceProjects.ts` |
| 9 | retry pending websocket envelope when gateway reconnects | `src-tauri/src/services/gateway/` 下任一 |
| 10 | duplicate builtin tool name should throw during registration | `src/lib/tools/builtinRegistry.ts` |

意图式中文（10）：

| # | query | 期望文件 |
|---|---|---|
| 11 | 技能安装任务的进度快照怎么给前端轮询 | `src-tauri/src/services/skills/jobs.rs` |
| 12 | 记忆索引的中文分词兜底方案 | `src-tauri/src/services/memory/mod.rs`（trigram FTS 表） |
| 13 | 工作区文件变化如何触发代码索引增量更新 | `src-tauri/src/services/code_index/service.rs`, `src-tauri/src/services/workspace_watch/emit.rs` |
| 14 | 子代理只读模式是在哪里强制的 | `src/lib/tools/builtinRegistry.ts`, `src/lib/subagents/` 下任一 |
| 15 | 聊天历史数据库放在哪个文件 | `src-tauri/src/commands/history/history_db.rs` |
| 16 | 沙箱模式下禁止 stdio MCP 服务器 | `src/lib/tools/mcpManagerTools.ts` |
| 17 | 检查点回滚时怎么恢复文件前像 | `src-tauri/src/commands/workspace/checkpoint.rs` 或同名模块 |
| 18 | 工具审批的挂起和确认模型 | `src/lib/chat/toolApproval.ts` 或同名 |
| 19 | 代码块按函数和类切分的实现 | `src-tauri/src/services/code_index/chunker.rs` |
| 20 | 嵌入模型首次下载失败后怎么降级 | `src-tauri/src/services/code_index/embedder.rs`, `src-tauri/src/services/code_index/search.rs` |
| 21 | keychain 里保存 OAuth token 的封装 | `src-tauri/src/services/mcp_oauth/` 下任一 |

符号/半符号（9，词法路应稳赢，验证 hybrid 不伤词法）：

| # | query | 期望文件 |
|---|---|---|
| 22 | resolveToolPolicy | `src/lib/tools/toolPolicy.ts` |
| 23 | WorkspaceActivityPayload | `src-tauri/src/services/workspace_watch/emit.rs` |
| 24 | shouldDeferMcpTools threshold | `src/lib/tools/toolSearchTools.ts` |
| 25 | sqlite3_vec_init auto extension | `src-tauri/src/services/code_index/schema.rs` |
| 26 | workdir_hash sha256 16 | `src-tauri/src/services/memory/paths.rs`, `src-tauri/src/services/code_index/paths.rs` |
| 27 | MEMORY_SCHEMA_DDL | `src-tauri/src/services/memory/mod.rs` |
| 28 | buildToolsSuffix available tools | `src/lib/chat/runner/toolExecutionPrompt.ts` |
| 29 | INDEX_CANCELLED_ERROR | `src-tauri/src/services/code_index/jobs.rs` |
| 30 | createBuiltinMetadataMap isReadOnly | `src/contracts/builtinTools.ts` |

## 运行方式（人工/脚本皆可）

1. 对本仓库 `code_index_enable` 并等 job `done`；
2. 逐条调 `code_index_search`（mode=hybrid, maxResults=5），按上表判命中；
3. Grep 基线：同 query 走 Grep 字面检索取前 5 文件；
4. 汇总两列命中率，对照通过线。

> 脚本化落地（evals runner）在 P4 收口时随 evals 框架一并提交；本文件先固化
> 查询与判定标准，保证人工评测可复现。
