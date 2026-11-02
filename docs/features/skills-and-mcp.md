# Skills 与 MCP

## 管理入口与侧栏快捷入口

桌面端和 WebUI 在「设置 → 资源与自动化」中统一提供 Skills、MCP、定时任务、记忆与 Hooks。Skills/MCP 复用完整的 Hub 管理界面，包括已安装资源与商店。

「设置 → 系统设置 → 侧栏快捷入口」可分别显示或隐藏 Skills、MCP、定时任务和记忆，默认全部显示。开关只影响入口可见性，不会停用资源、删除配置或停止定时任务；隐藏后仍可从设置进入管理页面。

从主侧栏打开这四类资源时，只切换右侧内容区域，保留桌面侧栏与当前聊天草稿；窄屏沿用原有的侧栏自动收起行为。四个页面共用紧凑的顶部布局。

可见性保存在 `customSettings.sidebarShortcuts`（`skills`、`mcp`、`cron`、`memory`）中，经 Gateway 在桌面端与连接该桌面 Agent 的 WebUI 间双向同步，并写入各端本地存储以便刷新后恢复。旧配置中缺少字段时按显示处理；旧版本同步消息未携带该字段时保留当前状态。

## Skills 架构

| 层 | 路径 | 职责 |
|---|---|---|
| builtin source | `crates/agent-gui/src-tauri/prompt/skills/<skill-name>` | 内置 skills 源文件。 |
| runtime root | `~/.liveagent/skills` | 用户运行时 skills 根目录。 |
| Rust service | `src-tauri/src/services/skills/*` | seed builtin、list/read/manage/install/create/validate/package/ClawHub。写侧由进程级 `skills_write_guard()` 串行化（agent 调用、gateway 转发、UI 后台安装线程、builtin seeding 四路写者）；安装走 stage-then-swap：内容（含 `_meta.json`）先在 `<root>/.staging/` 完整构建，再原子 rename 入位，读者永远看不到半成品。 |
| Frontend lib | `crates/agent-ui/src/lib/skills/*` | discover skills（仅 managed list，经 `SkillsManager list`）、build prompt、ClawHub client、install status。 |
| Tool | `src/lib/tools/skillTools.ts` | `SkillsManager`。 |
| Hub UI | `crates/agent-ui/src/pages/skills-hub/SkillsHubPage.tsx` | Installed/Store 两个视图，选择、扫描、预览、安装；宿主只提供能力适配器。 |

## Builtin Skills

| Skill | 说明 |
|---|---|
| `skills-creator` | 指导模型创建新 Skill。 |
| `skills-installer` | 指导模型安装本地/GitHub/压缩包/ClawHub Skill。 |

这两个 builtin skill 在前端 `lib/skills/builtin.ts` 中作为 always enabled 名称处理，Rust 启动或扫描时可通过 `system_ensure_builtin_skills` seed 到 runtime root。

## SkillsManager

| Action | 说明 |
|---|---|
| `read` | 读取 Skill entry file，例如 `SKILL.md`、`skill.json`、`README.md`。 |
| `list` | 列出当前对话可见的已启用 Skills。 |
| `install` | 从本地目录、`.zip/.skill`、HTTP(S)、GitHub repo/tree/blob 导入。 |
| `create` | 根据 workflow 摘要创建新 Skill。 |
| `validate` | 校验已安装 Skill。 |
| `package` | 打包为 `.skill` archive。 |
| `clawhub_search` | 搜索/浏览 ClawHub。 |
| `clawhub_install` | 按 ClawHub slug 下载并安装。 |

另有 UI 专用的后台安装 job 动作（不在 agent 工具 schema 内）：`install_start` 启动带进度的后台安装线程、`install_status` 轮询快照、`install_cancel` 协作式取消（下载与逐 skill 安装循环检查取消标记，终态为 `phase: "cancelled"`）。

## ClawHub 兼容边界

| 场景 | 处理规则 |
|---|---|
| Store identity | ClawHub Skill 以 `ownerHandle + slug` 作为唯一身份；React key、安装任务、已安装状态和 `_meta.json` 回读不得只按 slug 合并。 |
| list 缺 owner | `/api/v1/skills` 条目缺少发布者时，详情/安装前通过精确搜索按 `updatedAt`、version、downloads 等字段懒解析 owner；无法唯一匹配时明确失败，不盲选发布者。 |
| 下载/详情 | 所有已解析的详情和 `/api/v1/download` 请求都携带 `ownerHandle`，避免重名 slug 返回 HTTP 409。 |
| 非便携名称 | 仍严格执行 Agent Skills 小写名称规范；ClawHub 官方语义是 slug 与目录显示名分离、互不派生，因此单 Skill 包的非法 `name` 一律修复而非拒绝：优先改写为 registry slug（payload 缺 slug 时从下载 URL query 兜底解析），slug 不可用时回退为规范化后的 `name`；原名、规范名和转换类型写入 `_meta.json`。 |
| 原始内容 | 名称兼容转换只发生在下载临时目录，不修改注册表下载包；合法 `name` 即便与 slug 不同也保持原样；slug 与规范化 `name` 都不可用（如 Windows 保留名）时仍按严格校验拒绝。 |

## Skills 选择与 Prompt 注入

| 阶段 | 说明 |
|---|---|
| 扫描 | `discoverSkills()` 调用 Tauri 或 Gateway skill APIs，读取 runtime root 中的 Skill metadata。 |
| 选择 | Settings/Skills Hub 管理 `settings.skills.selected`，builtin always-on 自动合并。 |
| 注入 | Chat tools 模式下，`useChatSkills` 和 `lib/skills/index.ts` 生成当前对话可见 skills prompt。 |
| 访问 | 模型对 Skill 内文件的维护应通过 FS tools 的 skills root 能力和 `SkillsManager` 配合完成。 |

## MCP 架构

| 层 | 路径 | 职责 |
|---|---|---|
| MCP settings | `settings.mcp.servers`、`settings.mcp.selected` | server 配置与启用选择。 |
| MCP Hub UI | `crates/agent-ui/src/pages/mcp-hub/*` | server form、registry browser、preview drawer、install draft。 |
| Registry client | `crates/agent-ui/src/lib/mcpRegistry/index.ts` | official registry、Smithery、Glama 等 registry 归一化。 |
| Rust runtime | `src-tauri/src/commands/integration/mcp.rs` | stdio/http/sse server lifecycle、tools/list、call_tool、test/restart/stop/status。 |
| Dynamic tools | `src/lib/tools/mcpTools.ts` | 把 enabled MCP server 的工具暴露给模型。 |
| Manager tool | `src/lib/tools/mcpManagerTools.ts` | MCP 配置 CRUD、诊断与生命周期控制。 |
| Write path | `src/lib/settings/mcpOps.ts` | 唯一的 MCP 配置写路径：`McpSettingsOp`（upsert/patch/remove/setEnabled）+ 纯 reducer `applyMcpOps`，按 id 合并进 `setSettings(prev => ...)`；工具读取走 `getMcpSettings` 实时 getter（权威 `settingsRef`），不做 turn 级快照，读改写决策与提交在同一同步段内完成，从根上消除多写者覆盖。 |

## MCP 动态工具生命周期

| 阶段 | 说明 |
|---|---|
| 配置 | 用户在 MCP Hub/Settings 添加 server，支持 stdio/http/sse 等 transport。 |
| 选择 | 只有 enabled 且 selected 的 server 会进入 runtime 工具加载。 |
| List tools | 前端调用 Tauri `mcp_list_tools`，Rust 端启动/同步 server 并返回 tool info。 |
| 命名 | 前端把 server/tool 名规范化为 `mcp_<server>_<tool>`，避免冲突和过长。 |
| Call tool | 模型调用动态工具，前端 executor 调用 Tauri `mcp_call_tool`，结果进入 tool trace。 |
| 管理 | `McpManager` 做 add/update/delete/enable/disable/status/test/restart/stop/tools/list。写操作一律先 commit 配置、后 best-effort 停旧 runtime（stop 失败降级为 warning，由下次 `ensure_client` 配置判等自愈）。非 chat 作用域（如 cron）禁止写操作与 restart/stop，test/tools/diagnose 强制 `persist=false` 走瞬时连接，不触碰共享连接池。 |
| Runtime pool | `McpRuntimeManager` 的 clients map 锁只做 get/insert 短持有，绝不在持 map 锁时锁单个 client 或 spawn——同 id 调用在 client 锁上串行，不同 server 互不阻塞。 |

## MCP Registry

| Source | 作用 |
|---|---|
| official registry | 从 `registry.modelcontextprotocol.io` 读取官方 server 列表与 package metadata。 |
| Smithery | 搜索 Smithery server，并尝试解析 install draft 或 manual draft。 |
| Glama | 搜索 Glama MCP server 列表。 |

Registry card 会被归一化为统一的 `McpRegistryCard`，其中 `installDraft` 表示可直接生成 server config，`manualDraft` 表示需要用户手工补全。

## 示例：免 Key 的网页搜索与页面抓取

LiveAgent 不内置网页搜索 MCP。需要时可手动接入 Parallel 提供的远程 MCP server（Streamable HTTP）：无需 API key 即可使用 `web_search`（网页搜索）和 `web_fetch`（按 URL 抓取页面并提取为 markdown）。这是第三方服务，默认不启用，按需导入；查询与 URL 会发送给 Parallel，匿名请求的速率限制较低。

将以下内容保存为 JSON 文件（如 `parallel-mcp.json`）：

```json
{
  "mcpServers": {
    "parallel-search": {
      "type": "http",
      "url": "https://mcp.parallel.ai/mcp"
    }
  }
}
```

导入解析见 `src-tauri/src/services/skills/external_mcp.rs`：接受 `mcpServers` 包装或裸 server map；`type` 支持 `http`（含 `streamable-http`）、`sse`、`stdio`，省略时有 `url` 即按 `http` 处理；`headers`、`timeout`（毫秒）可选，未填 timeout 时按 60000 导入。

| 步骤 | 操作 |
|---|---|
| 导入 | MCP Hub →「本地导入」→「从文件导入」，选择上述 JSON，勾选 `parallel-search` 后点「导入」。也可点「添加」手动填写：Transport 选 `http（Streamable HTTP）`，URL 填同一地址。 |
| 选择 | 导入后 server 默认启用，确认卡片开关为开。若当前工作空间的「配置 Skills 与 MCP」为「自定义」，还需在其中勾选 `parallel-search`；「全部关闭」时不暴露任何 MCP。 |
| 发现工具 | 在 tools 模式的对话中让模型调用 `McpManager`（`action: "tools"`，`server_id: "parallel-search"`），应返回 `web_search`、`web_fetch`（匿名时还会列出 `web_decisions`）。它们在对话中以 `mcp_parallel-search_web_search` 等动态工具名出现。 |
| 试搜索 | 例如「搜索 MCP 规范的最新版本」，tool trace 中应出现 `mcp_parallel-search_web_search` 调用及结果摘录。 |
| 试抓取 | 例如「抓取 https://modelcontextprotocol.io 并总结」，应出现 `mcp_parallel-search_web_fetch` 调用。 |

匿名访问适合试用和轻量使用。需要更高额度时，可在 Parallel Platform 创建 API key，并按其文档以 `Authorization: Bearer <key>` 请求头发送：写入配置的 `headers`，或在卡片编辑的 Headers 一栏填 `Authorization=Bearer <key>`。LiveAgent 不展开 headers 中的环境变量，key 会以明文保存在 MCP 设置中，含 key 的配置文件不要提交到仓库。鉴权方式、计费与限额以 [Parallel MCP 文档](https://docs.parallel.ai/integrations/mcp/quickstart) 为准。旧 endpoint `https://search.parallel.ai/mcp`（Parallel 文档标为 legacy，仍在服务）同样免 key，只提供 `web_search` 和 `web_fetch`。

## GUI/WebUI Parity 要点

| 区域 | 注意事项 |
|---|---|
| Skills Hub | 公共页面提供 installed/store、preview drawer、install job 状态，并以 `ownerHandle + slug` 推导 ClawHub 安装身份；两端注入各自能力。 |
| MCP Hub | 公共页面提供 server form、registry browser、preview drawer、install draft；两端注入各自运行时能力。 |
| i18n | 双端有各自 `i18n/config.ts`，新增文案要同步。 |
| settings sync | Skills/MCP settings 从 GUI 经 Gateway 同步到 WebUI，WebUI 修改再回写 GUI。 |
| shims | WebUI 的 Tauri invoke 实际走 Gateway，不应假设浏览器有本地权限。 |
