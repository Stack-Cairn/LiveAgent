# 2026 H2 能力路线图：五大前沿能力补齐计划

| 元数据 | 内容 |
|---|---|
| 状态 | Approved / 排期执行中 |
| 版本 | v1.0 |
| 日期 | 2026-08-21 |
| 范围 | Plan Mode · MCP 工具懒加载 · MCP OAuth · 浏览器自动化 · 语义检索/代码库索引 |
| 估算口径 | 人·周（熟悉本仓库的开发者），总量约 15–17 人周，双人并行约 10–12 周 |

> 背景：对照 2026 年业界前沿（Claude Code / Codex CLI / Antigravity / OpenClaw / Claude Cowork），LiveAgent 在安全执行底座（OS 沙箱、审批、checkpoint）、上下文工程与远程架构上已达到开源前沿甚至局部领先，但在智能层（plan mode、语义检索）、触达层（浏览器自动化）与 MCP 生态完整度（OAuth、工具懒加载）上存在明确缺口。本文件是这五项能力的总体开发计划与验收基线。

## 0. 排期总览

| 阶段 | 内容 | 估算 | 依赖 |
|---|---|---|---|
| **P1**（wk 1–3） | ① Plan Mode（TS 轨）② MCP 工具懒加载（TS 轨）③ MCP OAuth（Rust 轨，并行） | 1.5 + 1.5 + 3 人周 | 无 |
| **P2**（wk 4–7） | ④ 浏览器自动化（Phase A: 托管 Playwright-MCP 预设 → Phase B: 原生 CDP 工具） | 1 + 3.5 人周 | 懒加载（减 context 压力）、OAuth 收尾 |
| **P3**（wk 6–11） | ⑤ 语义检索/代码库索引（Rust 轨，与 P2 并行启动） | 5–6 人周 | 无硬依赖 |
| **P4**（wk 12） | 收尾：evals 冒烟集、文档、release gate 增项、i18n 补全 | 1 人周 | 全部 |

每个特性统一遵循仓库既有纪律：

1. 先出 `docs/design/` 设计文档，再动代码；
2. 涉及远程能力的改动同步更新 `proto/v2/gateway.proto`，保 GUI/WebUI parity（`scripts/check-ui-boundaries.mjs` 门禁）；
3. i18n 双端（`agent-ui` 公共层 + gateway web）；
4. 上线项写入对应 release gate 检查表。

---

## 1. Plan Mode（1.5 人周）

**目标**：「只读探索 → 提交计划 → 用户批准 → 切执行」的模式闸门，对齐 Claude Code。价值/成本比最高，原料（AskUserQuestion、Task 工具、readonly subagent、审批模型）全部现成。

### 方案要点

- 会话运行时新增 `planMode` 状态；在 `runAgentConversationTurn.ts` 的 `resolveToolGate` 前叠加一层 **mode-aware policy**：只读工具放行，非只读工具**直接不注入给模型**（复用现有 deny-不发送机制，省 token）。
- 新工具 `ExitPlanMode(plan_markdown)`：触发审批卡片，复用 `toolApproval.ts` 的 pending/settle 模型——approve 切回 tools/agent-dev 模式并把计划注入上下文（挂 `context_meta_json`，跨压缩存活，同 Task 工具）；deny 留在 plan mode 并把用户反馈回传。
- Plan mode 下子代理强制 `readonly` mode（机制已有）；批准后可选一键把计划转成 `TaskCreate` 清单。
- WebUI parity：审批走现有 `chat_queue.tool_approval` 通道（proto 几乎零改动）；模式切换在 chat command 上加一个字段。

### 改动点

`lib/tools/toolPolicy.ts` · 新 `lib/tools/planModeTools.ts` · `pages/chat/turns/runAgentConversationTurn.ts` · `agent-ui` 计划审批卡片组件 · system prompt 段落 · `gateway.proto` 微调

### 验收

- [ ] plan mode 下任何写操作不出现在模型工具表
- [ ] 拒绝计划可带反馈继续规划
- [ ] 压缩后计划不丢
- [ ] WebUI 可远程批准

---

## 2. MCP 工具懒加载 / ToolSearch（1.5 人周）

**目标**：MCP server 多开不再吃爆 context，对齐 Claude Code 的 ToolSearch 机制。

### 方案要点

- 新建 `lib/mcp/toolCatalog.ts`：会话启动仍 `tools/list`（拿 name+description），但**超过阈值（默认约 12k tokens schema 量，走 `tokenLedger` 估算，可配置）即不注入 schema**，system prompt 只留一行摘要「N 个 MCP 工具可通过 ToolSearch 检索」。
- 新内置工具 `ToolSearch(query)`：对 catalog 做 BM25/子串检索（量小，内存即可，不落 FTS），返回 top-K 完整 schema 并将其加入会话级 **activation set**；activation set 持久化到 `context_meta_json`（跨压缩、跨恢复）。
- 名字映射沿用 `mcpTools.ts` 现有 FNV-1a 截断规则，ToolSearch 返回可直接调用的规范名。
- 保留 `McpManager tools` action 作为手动兜底。

### 关键技术风险

`agentRunner.ts` 每轮请求的工具表需支持**轮中扩充**（ToolSearch 返回后下一请求即含新工具）。工具表按请求组装，理论可行，但要验证 `pi-agent-core` 对轮间工具集变化的容忍度——**第 1 天先做 spike 验证**，不行则降级为「turn 边界生效」。

### 验收

- [ ] 挂 5 个 server（>80 工具）时首轮 prompt 体积下降 ≥70%
- [ ] 检索命中的工具当轮/次轮可调用
- [ ] 压缩后 activation set 不丢

---

## 3. MCP OAuth（3 人周）

**目标**：按 MCP 规范支持 OAuth 2.1，接通托管 MCP server（当前仅静态 headers）。

### 方案要点

- Rust 侧新增 `src-tauri/src/services/mcp_oauth.rs`，接入 `mcp.rs` 的 `HttpTransport`/`SseTransport`：401 + `WWW-Authenticate` → RFC 9728 资源元数据 → RFC 8414 AS 元数据 → 无 client_id 时走 RFC 7591 动态注册 → **Authorization Code + PKCE**（系统浏览器 + `127.0.0.1` 随机端口 loopback 回调）→ 拿 token 重试原请求；`ensure_initialized` 现有的 404 重试链路旁挂 token 刷新。
- 依赖：`oauth2` v5 + `keyring` v3（macOS Keychain / Windows Credential Manager / Linux secret-service；无 secret-service 环境降级加密文件）。
- **凭据纪律沿用现有取舍**：token 只进 keychain，`mcpOps.ts` 的 `McpServerConfig` 仅存 `auth: { type: "none"|"headers"|"oauth" }` + 元数据/presence——Gateway settings sync 与 WebDAV 备份天然不含 token。
- 远程限制明确化：授权流只能在**桌面机**完成（系统浏览器在桌面弹出）；WebUI 侧通过 gateway 事件展示 "authorization required" 状态并引导。device-code 流留作后续。
- UI：MCP server 卡片加 Connect/授权状态/Reauthorize；`McpManager test` action 输出 auth 诊断。

### 验收

- [ ] 接通至少 2 个真实托管 MCP server
- [ ] token 过期自动刷新无感
- [ ] 卸载 server 清理 keychain 条目
- [ ] 重启后免重授权

---

## 4. 浏览器自动化（4.5 人周，两阶段）

**目标**：补上 2026 年 agent 主战场空白，从「能用」到「原生」。

### Phase A — 托管 Playwright-MCP 预设（1 周，P2 开头先发）

- 在 MCP registry 卡片体系里加「官方推荐连接器」预设：一键启用 `playwright-mcp` / `chrome-devtools-mcp`（stdio 走现有 MCP 基建），LiveAgent 托管其进程生命周期、检测 Node 运行时并给出引导。
- 零新协议成本，立刻可用，同时为 Phase B 收集交互模式反馈。

### Phase B — 原生 `Browser` 工具（3.5 周）

- Rust 新增 `services/browser/`：以 `--remote-debugging-port` + **独立 profile**（`~/.liveagent/browser-profile`，与用户日常 profile 隔离，防凭据暴露）拉起用户已装的 Chrome/Edge，Rust 直连 CDP WebSocket。
- 工具形态沿用仓库 manager 风格：**单一 `Browser` 工具 + action 参数**（navigate / snapshot / click / type / screenshot / eval / wait / back），减少 schema 数量（与懒加载协同）。
- `snapshot` 输出 **a11y 树 + ref id**（Playwright aria-snapshot 风格），token 效率优先；`screenshot` 走现有 Image 渲染链路进聊天。
- 安全接入现有体系：新 `group:browser` 默认 `ask`；`sandboxOffline` 模式下 Browser 一律 deny（离线语义必须覆盖浏览器出网）；可选 URL allowlist。
- UI：Right Dock 加 Browser 面板（截图预览 + 当前 URL + 停止按钮）；WebUI parity 走 proto 直通。

### 验收

- [ ] 完成「打开文档站 → 检索 → 提取内容 → 截图佐证」闭环
- [ ] a11y snapshot 单页 <8k tokens
- [ ] 独立 profile 无法读取用户日常浏览器登录态
- [ ] 审批/沙箱策略生效

---

## 5. 语义检索 / 代码库索引（5–6 人周）

**目标**：大仓库摆脱 Grep 盲搜，混合检索（词法 + 语义 + 符号）。

### 方案要点

Rust 新增 `services/code_index/`（walker / chunker / embedder / store / search），复用成熟的 SQLite 服务层模式：

- **Walker**：`ignore` crate 尊重 `.gitignore` + 自定义排除；增量 = mtime + 内容哈希；接入**现有 workspace watch** 做实时失效。
- **Chunker**：tree-sitter 按函数/类切块（首批语言：TS/JS/TSX、Rust、Go、Python、Java），无 grammar 语言回退滑窗。
- **Embedder**：本地优先——`fastembed-rs`(ONNX) 跑小模型 CPU 推理，默认离线可用；provider embedding API 作为**可选**增强。模型选型待拍板（中文用户占比高，建议 `multilingual-e5-small` 级多语模型 ~120MB；备选纯英 `bge-small` 更小更快）。
- **Store**：`sqlite-vec` + FTS5 双索引，per-workspace `code-index.sqlite3`（与 memory-index 同款基建）。
- **混合检索**：FTS5 BM25 + 向量余弦，RRF 融合排序。
- 新工具 `CodeSearch(query, mode: hybrid|semantic|lexical, path?)` → `file:line` + 片段；子代理只读继承；system prompt 注入「本工作区已建索引」提示。
- 生命周期：**per-workspace opt-in**（隐私 + 磁盘考量）、后台索引 job（复用 skills 安装的 job/进度/协作式取消模式）、大小上限与配额、可挂 cron 定期重建。
- UI：工作区设置页索引开关 + 进度 + 体积统计；Trajectory 加检索详情。

### 验收

- [ ] 本仓库（约 20 万行级）全量索引 <5 分钟、增量 <2s
- [ ] 自建 30 条查询冒烟集上 hybrid top-5 命中率显著优于纯 Grep 基线
- [ ] 索引损坏可一键重建
- [ ] 关闭索引后 `CodeSearch` 不注入

---

## 6. 横切关注点与风险

| 项 | 说明 |
|---|---|
| **pi-agent-core 耦合** | ②④ 都要动轮间工具表，是外部主循环风险集中点。P1 第一周做 spike；若阻塞严重，作为「主循环内化」决策的触发点（本计划不含内化） |
| **GUI/WebUI parity** | 每特性含 proto + `agent-ui` 公共层改动，`check-ui-boundaries.mjs` 门禁保底 |
| **Evals 顺手起步** | ⑤ 的 30 条检索冒烟集 + ①④ 的场景脚本，作为 evals 框架的第一块砖（P4 收口） |

### 待拍板决策

1. embedding 模型本地选型（多语 e5-small vs 纯英 bge-small）；
2. 浏览器 Phase B 是否绑定 Chrome/Edge（不支持 Firefox）；
3. 懒加载阈值默认值（建议 12k tokens，可配置）。
