# 语义检索 / 代码库索引（CodeSearch）

| 元数据 | 内容 |
|---|---|
| 状态 | In Development |
| 版本 | v1.0 |
| 日期 | 2026-08-25 |
| 上游 | `docs/design/2026h2-capability-roadmap.md` 第 5 节（P3，5–6 人周） |
| 分支 | `feature/code-index-semantic-search` |

**目标**：大仓库摆脱 Grep 盲搜。为 opt-in 的工作区建立 per-workspace 代码索引，
提供词法（FTS5 BM25）+ 语义（本地 ONNX embedding + sqlite-vec 余弦）混合检索，
经新内置工具 `CodeSearch` 暴露给模型，返回 `file:line` + 片段。

## 1. 总体架构

```
TS (webview)                         Rust (src-tauri)
─────────────────────────────        ─────────────────────────────────────
CodeSearch 工具                       services/code_index/
  └─ invoke("code_index_search") ──►   service.rs  对外 API / 全局单例
工作区设置页（开关+进度+统计）           ├─ walker.rs   ignore 遍历 + mtime/hash 增量
  └─ invoke("code_index_*") ──────►    ├─ chunker.rs  tree-sitter 函数/类切块 + 滑窗回退
settings.workspaceResourceSettings     ├─ embedder.rs fastembed(ONNX, CPU) 批量向量化
  .codeIndexEnabled  ← 真相源          ├─ store.rs    SQLite: chunks + FTS5 + vec0
                                       ├─ search.rs   BM25 + 向量余弦 → RRF 融合
workspace_watch (已有) ────────────►   └─ jobs.rs     后台索引 job（进度/协作式取消）
  emit_activity 第三 sink                    ▲
                                       commands/integration/code_index.rs
```

复用既有基建，不发明新模式：

| 需求 | 复用来源 |
|---|---|
| SQLite 服务层（单连接 + Mutex、DDL execute_batch、schema version、integrity_check + quarantine 重建） | `services/memory/`（memory-index 同款） |
| 后台 job / 进度快照 / `AtomicBool` 协作式取消 / 前端轮询 | `services/skills/jobs.rs` |
| 实时失效 | `services/workspace_watch/` 的 `emit_activity` 旁挂第三 sink |
| per-workspace 身份 | `workdir_hash = sha256(canonicalize(workdir))[..16]`（memory/paths.rs 同款）+ `.workdir.json` 反查标记 |
| per-workspace opt-in 开关 | `SystemSettings.workspaceResourceSettings[pathKey].codeIndexEnabled`（与 skillNames/mcpServerIds 同层，Gateway settings sync 天然同步） |
| 工具注册 / 只读元数据 / 子代理继承 | `builtinRegistry.ts` bundle 体系，新 `groupId: "code-index"` |
| system prompt 注入 | `toolExecutionPrompt.ts` 的 `has("CodeSearch")` 分支——不注册即不注入 |

## 2. 存储

位置：`~/.liveagent/code-index/projects/<workdir_hash>/code-index.sqlite3`
（`.workdir.json` 记录原始路径反查；模型缓存全工作区共享：`~/.liveagent/code-index/models/`）。

```sql
PRAGMA journal_mode = WAL;  -- memory-index 同款

CREATE TABLE files (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,   -- workspace 相对路径，POSIX 分隔符
    mtime_ms     INTEGER NOT NULL,
    size_bytes   INTEGER NOT NULL,
    content_hash TEXT NOT NULL,          -- sha256，mtime 变了但 hash 没变 → 跳过
    language     TEXT NOT NULL,          -- "typescript" | ... | "plain"
    indexed_at   INTEGER NOT NULL
);

CREATE TABLE chunks (
    id         INTEGER PRIMARY KEY,     -- rowid，与 chunks_vec.rowid 一一对应
    file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    start_line INTEGER NOT NULL,        -- 1-based
    end_line   INTEGER NOT NULL,
    kind       TEXT NOT NULL,           -- "function" | "class" | "method" | "window"
    symbol     TEXT NOT NULL DEFAULT '' -- 函数/类名（可检索）
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
    content, symbol, path UNINDEXED, chunk_id UNINDEXED,
    tokenize = "unicode61 remove_diacritics 2"
);

CREATE VIRTUAL TABLE chunks_vec USING vec0(
    embedding float[384]                 -- multilingual-e5-small 维度
);

CREATE TABLE code_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version / embedding_model / embedding_dim / last_full_index_at 等
```

取舍：

- **正文不落 chunks 表**：检索结果的片段在返回时按 `path:start_line-end_line`
  现读文件（索引可能落后于磁盘几秒，现读保证片段与真实内容一致，也省一半体积）。
  FTS5 的 content 列是检索載体，snippet 由现读渲染。
- **单 FTS 表（unicode61）**，不建 trigram 双表：代码主体是 ASCII 标识符，
  unicode61 把 `_`/`-` 当分隔符恰好让 `foo bar` 命中 `foo_bar`；中文注释/文档字符串
  的查询能力由 multilingual embedding 的语义路承担。（memory-index 的 trigram
  双表方案针对纯中文正文，代码场景体积翻倍不值。）
- **vec0 rowid = chunks.id**：删除文件时先收集 chunk id，逐表删除，同一事务提交。
- schema 变更策略与 memory 相同：`code_index_meta.schema_version` 不匹配 → 整库
  DROP 重建（索引是缓存，重建无数据损失，比 ALTER 迁移简单可靠）。

sqlite-vec 经 `rusqlite::ffi::sqlite3_auto_extension` 进程级注册一次（crate 自带
静态库链接进 bundled SQLite）。注册对 memory/history 等其他连接无副作用——vec0
模块可用但不使用即零开销。

## 3. Walker（增量）

- `ignore::WalkBuilder`：尊重 `.gitignore`/`.ignore` + 内置排除
  （`node_modules/`、`target/`、`.git/`、`dist/`、`build/`、二进制扩展名、
  `> 1 MiB` 单文件、非 UTF-8 文件）。
- 增量判定：mtime 相同 → 跳过；mtime 变了 → 算 sha256，与 `files.content_hash`
  相同 → 只更新 mtime；不同 → 重切块重嵌入。索引中消失的路径 → 级联删除。
- 配额：单仓库默认上限 50k 文件 / 500 MiB 源码量，超限 job 报错并提示排除目录
  （防止把 home 目录当工作区拖垮机器）。

## 4. Chunker

tree-sitter 按语法切块，首批语言：TS/TSX/JS、Rust、Go、Python、Java。

- 提取节点：函数 / 方法 / 类（类取签名 + 文档注释，方法单独成块），携带
  `symbol` 名与行号范围。
- 超长节点（> ~6k 字符 ≈ 模型 512 token 上下文的安全余量）内部再滑窗。
- 无 grammar 的语言与 Markdown/纯文本：固定滑窗（80 行窗口、20 行重叠）。
- 块内容 = 原文 + 头部一行上下文（`// path:line symbol`），这一行同时进 FTS
  与 embedding 输入，提高路径/符号词的可检索性。

## 5. Embedder

- `fastembed` 6.x（ONNX Runtime CPU），默认模型 **multilingual-e5-small**
  （384 维）——路线图待拍板项按其建议落定：中文用户占比高，多语模型优先；
  纯英 bge-small 留作后续可配置项。
- e5 前缀约定：入库块加 `passage: `，查询加 `query: `（fastembed 不自动加）。
- 懒初始化 + 进程级单例（`OnceLock<Mutex<TextEmbedding>>`）；首次使用从
  HuggingFace 下载模型到 `~/.liveagent/code-index/models/`（数百 MB 级，
  job 的 `downloading` 阶段有进度）。此后完全离线。下载失败 → job 报错并
  提示网络（“本地优先”指推理不依赖 provider API，首次取模型仍需一次网络）。
- `intra_threads` 上限 4：索引是后台任务，不与前台抢核。
- 模型锁按**单批**（batch 64）拿放，不按整文件持有；批间对等锁的查询让路
  （查询优先，`QUERY_WAITERS` 计数）——否则大文件一次锁几十秒，后台索引期间
  检索的限时等锁（5s）必然超时，hybrid 全数降级词法。让路有上限（5s），
  查询侧异常不会把索引饿死。
- Cargo feature 裁剪：`default-features = false` + `hf-hub-rustls-tls` +
  `ort-download-binaries-rustls-tls`（不要 image-models；TLS 与仓库统一 rustls）。

## 6. 混合检索（RRF）

```
lexical:  SELECT chunk_id, bm25(chunks_fts) FROM chunks_fts WHERE chunks_fts MATCH ?  LIMIT 50
semantic: SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 50
fused:    RRF  score(c) = Σ_r 1 / (60 + rank_r(c))       -- k=60 经典常数
```

- `mode: "hybrid" | "semantic" | "lexical"`，默认 hybrid；`path?` 前缀过滤
  （SQL LIKE 于 files.path）。
- FTS 查询词经 memory-index 同款引号转义，防 MATCH 语法注入。
- 返回 top-N（默认 8，上限 20）：`path:start-end` + `symbol` + 现读片段
  （单块截断 ~1200 字符），附 RRF 分与来源（lexical/semantic/both）。

## 7. 生命周期与 job

- **真相源**：`workspaceResourceSettings[pathKey].codeIndexEnabled: boolean`
  （默认 false，per-workspace opt-in——隐私 + 磁盘考量）。设置页开关翻转时
  同步 invoke `code_index_enable`（触发后台全量索引 job）或
  `code_index_disable`（删除该 workspace 的索引目录）。
- 后台 job 照抄 skills 模式：`OnceLock<Mutex<HashMap<job_id, state>>>` 注册表、
  phase（`queued → downloading-model → walking → chunking → embedding → done`）、
  `AtomicBool` 协作式取消、完成后保留 1 小时、前端轮询快照。同一 workspace
  同时只允许一个 job。
- **实时失效**：`workspace_watch` 的 `emit_activity`（已有 250ms debounce）旁挂
  第三 sink → `code_index::notify_workspace_activity(workdir, changed_paths)`。
  service 内部核对该 workdir 已启用且非 job 进行中，将变更路径入队，2s 静默窗
  后跑一次小增量（只处理入队路径，验收要求增量 < 2s）。增量路径应用与全量
  遍历同源的排除规则（内置目录/扩展名 + .gitignore 链），gitignore 的密钥
  文件不会经 watch 路进入索引。watch 未覆盖时（会话未打开）的对账：
  CodeSearch 执行层发现“设置已开启但本地索引缺失”时自动触发一次 enable；
  search 发现存量文件缺向量（词法降级期入库）且模型已就绪时自动安排增量
  job 回填。
- **重建**：`code_index_rebuild` = 全量 job（job 内先 reset——先过“同 workdir
  单 job”闸门再清库，避免与进行中的 job 竞争毁掉现有索引）。健康库的 reset
  直接删除 db 文件；`.quarantine/corrupt-<ts>/` 只留给损坏路径（integrity_check
  失败时 open 自动隔离重建，隔离区仅保留最近 2 份）——“损坏一键重建”验收项。

## 8. 工具面（TS）

- 新 `groupId: "code-index"`（`BuiltinToolGroupId` 三处：agent-ui contracts、
  gui builtinTypes、gateway web builtinTypes）。
- `lib/tools/codeSearchTools.ts`：单工具 `CodeSearch(query, mode?, path?, max_results?)`，
  `isReadOnly: true`（plan mode 天然可用；toolPolicy 零配置——`group:code-index`
  回落到 isReadOnly ⇒ allow）。执行 = `invokeWithAbort("code_index_search")`。
- 注入条件：`buildBaseBuiltinToolBundles` 按 `params.codeIndexEnabled`（由
  runAgentConversationTurn 从 workspaceResourceSettings 读出后传入）决定是否
  推入 bundle。**不注册 ⇒ 模型工具表与 system prompt 均无 CodeSearch**——
  “关闭索引后不注入”验收项。
- 子代理：同 params 重建 bundle，只读工具无需降级处理，天然继承。
- system prompt：`toolExecutionPrompt.ts` 加 `has("CodeSearch")` 分支，声明
  “本工作区已建代码索引，语义/混合检索优先于盲目 Grep”。

## 9. UI 与 i18n

- `WorkspaceGeneralSettingsPanel` 加“代码索引”区：开关（写 draft 的
  `codeIndexEnabled`）+ 状态行（未启用 / 索引中 x% / 就绪：N 文件 · M 块 ·
  体积）+ 重建按钮。索引 job 进行中每 1.5s 轮询 `code_index_status`（响应含
  activeJob 与最近完结 job，失败终态由 lastJob 暴露）。
- 文案进 `agent-ui` 共享翻译（zh-CN + en-US 成对），key 前缀
  `workspaceSettings.codeIndex.*`。

## 10. WebUI parity（分期）

- **随本期自动可用**：开关经 settings sync 同步；CodeSearch 工具在桌面端执行，
  WebUI 聊天（chat_queue 驱动桌面端）天然可用；Trajectory 检索详情走既有直通。
- **留作 follow-up**：WebUI 远程查看索引进度/统计与触发重建，需要新增
  `CodeIndexManage` 直通臂（与 `MemoryManage{command,args_json}` 同款）。因其
  需要 buf 重新生成 Go/TS proto stub（本地未装 mise 工具链），且不在路线图
  验收项内，proto 增项与 gateway 转发臂随下一次 proto 变更一并提交。
  Web shim 对 `code_index_*` 命令抛出明确的“桌面端专属”错误而非静默失败。

## 11. 验收（对照路线图）

- [ ] 本仓库（约 20 万行级）全量索引 < 5 分钟、watch 增量 < 2s
- [ ] 自建 30 条查询冒烟集上 hybrid top-5 命中率显著优于纯 Grep 基线
      （冒烟集落在 `docs/design/code-index-evals.md`，作为 evals 框架第一块砖）
- [ ] 索引损坏可一键重建（quarantine + 全量 job；integrity_check 失败自动触发）
- [ ] 关闭索引后 `CodeSearch` 不注入（工具表与 system prompt 均不出现）

## 12. 风险

| 风险 | 处置 |
|---|---|
| ort/onnxruntime 链接与打包（各平台 dylib/静态库差异） | `ort-download-binaries` 构建期获取；release gate 增加三平台 bundle 冒烟项（P4） |
| 模型首次下载体积/失败 | job `downloading-model` 阶段可见、可取消；失败不影响词法检索可用性（降级 `mode:"lexical"`）；初始化失败不缓存为终态——下次 enable/rebuild 重试（`ensure_ready`），检索路非阻塞探测（下载中也立即降级返回，不被拖住）；词法降级期入库的文件带 `has_vectors=0` 标记，模型就绪后由增量 job 回填向量 |
| 大仓库嵌入耗时 | 批量 embed（batch 64）+ 增量为主；全量仅 enable/rebuild 时发生；模型锁按单批拿放且批间对查询让路（查询优先），检索的查询嵌入限时等锁（5s）正常最多等一批推理；超时降级词法 |
| 索引落后磁盘 | 片段现读文件；watch 增量 + CodeSearch 层对账兜底；遍历出错时跳过“消失文件”删除对账（不可读 ≠ 不存在） |
