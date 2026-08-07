# settings 契约分裂：现状归类与收敛路线（任务 #9）

日期：2026-08-07。本文是任务 #9 的第一阶段产出：把两份 settings 的漂移逐块归类，
说明哪些是真分叉（没有）、哪些是合法差异，并给出后续收敛的推荐路径。
止血带门禁已上线：`make check-settings-drift`（CI 已接）。

## 结论先行

**两份 settings/index.ts 之间不存在同名函数的逻辑分叉。**
前端版（2666 行）是 core 版（2183 行）的**严格超集**：core 的每一行都按原顺序
出现在前端版里（除下述登记过的 core 独有行）。所谓"420 行漂移"实为：

- 前端在共享逻辑之上追加了约 500 行**纯 UI 符号**；
- core 额外持有 **providerIdentities**（CLI 身份，引擎独用，前端整个 repo 无引用）；
- 若干 import 路径差异（`../i18n` vs `../../i18n`、`shared/` vs `system/`）。

`mcpOps.ts`、`normalize.ts` 两侧逐字节相同。`storage.ts` 是**有意的两个实现**
（core 走 HTTP callBackend 只取引擎所需分片；前端走 tauri invoke + localStorage
UI 偏好 + gateway 同步），不是副本，不在收敛范围。

`core/src/i18n/config.ts` 只是 7 行的 Locale shim（类型 + normalizeLocale），
不是前端 4523 行翻译表的副本 —— "i18n 目录去留"问题消解：保留 shim 即可。

## 漂移逐块归类

### A. 前端独有（纯 UI，core 不需要）

| 块 | 符号 | 归类 |
|---|---|---|
| Theme 交互 | `resolveEffectiveTheme` / `getNextTheme` / `subscribeToSystemThemePreference` / `THEME_OPTIONS` / `SYSTEM_THEME_MEDIA_QUERY` | window.matchMedia，DOM 独有 |
| RightDock 状态机 | `getRightDockWriterId`（localStorage）、`updateRightDockProjectState`、tab 开关/tombstone/合并全套、`DEFAULT_RIGHT_DOCK_FILE_TREE_STATE`、`rightDockToolKindForTabId`、`RightDockTabKind` | 多客户端 UI 布局同步 |
| settings 更新器 | `updateSystem/updateMcp/updateAgents/updateSsh/updateSkills/updateMemorySettings/updateCustomProviders/setSelectedModel/updateUpdateSettings/updateChatTranscriptWidth/updateRightDockWidth` 等 | React setState 风格包装,core 直接读不改写 |
| 杂项 UI | `CLOSE_WINDOW_BEHAVIOR_OPTIONS`、`CODEX_REQUEST_FORMAT_LABELS`（文案）、`isValidSystemProxyHost`（表单校验）、`isThinkingAlwaysOnForModel`、`updateChatRuntimeControlsForProvider`（设置面板写路径） | 表单/展示层 |
| SSH 项目关联 | `getSshProjectHostIds` / `updateSshProjectHostIds` / `removeSshHostFromProjectAssociations` | 设置页写路径 |

### B. core 独有（引擎专用）

- `providerIdentities: CliIdentitySettings`（customSettings 字段 + normalize 调用）。
  消费方全在 core：engine.ts、cronPromptRunner、conversationTitle、memory organizer、
  providerRuntimeConfig。前端 repo 零引用；backend 的 `settings_load_all` 也不返回
  customSettings，所以 core 里它恒为 `normalizeCliIdentitySettings(undefined)` 的
  默认值 —— 目前实际上是"默认值直通"，将来 CLI 身份持久化落地时才有真数据。

### C. import 路径差异（同物异位）

- `i18n/config`：core 是 7 行 shim，前端是完整翻译表；两者的 `Locale/DEFAULT_LOCALE/normalizeLocale` 语义一致。
- `fontFamily`：core `shared/fontFamily.ts`（15 行纯 normalize），前端 `system/fontFamily.ts`（224 行，含 DOM 应用/本地字体枚举），前端超集。
- `shared/id.ts`：前端版多 WebView 降级路径（crypto.randomUUID 缺失时的手搓 UUID），core 版直接调 randomUUID。语义兼容（core 跑 Node 22，randomUUID 恒存在）。
- transcript 宽度常量：前端从 `transcript-width/transcriptWidthModel.ts` 导入，core 就地定义同值。数值一致性由门禁的 VALUE_GUARDS 守着。

## 磁盘格式（Never break userspace 审计）

持久化面完全没动、也不需要动：

- SQLite（backend `settings_load_all` / `settings_save_*`）：providers/system/mcp/agents/ssh/remote/memory 七个分片。两侧读的是同一批端点、同一套 normalize。
- localStorage `liveagent.ui-settings.v1`：skills/chatRuntimeControls/customSettings/updates/selectedModel/theme/locale/closeWindowBehavior，前端独有。
- gateway 同步 payload（`sync.ts`，前端独有）：字段白名单机制，未受影响。

## 收敛路线（后续任务，按风险从低到高）

1. **【低】前端 index.ts 重排为 "镜像段 + UI 追加段"**：把前端文件重排成
   「与 core 逐字一致的前缀 + 文件末尾的 UI-only 追加区」，门禁即可从
   "有序子序列"升级为 wireEvents 式的"前缀逐字比对"，drift 检测从行级模糊
   变成字节级精确。纯移动代码，无语义变化，但 diff 巨大，需要单独一轮评审。
2. **【中】UI 符号拆出 `settings/ui.ts`**：前端把 A 类符号移入新文件，
   index.ts 退化为 core 的纯镜像 + re-export。约 76 个 import 调用点不用改
   （barrel re-export 兜住），但 500 行搬家 + 内部私有依赖
   （`normalizeChatRuntimeReasoningForLevels` 等需要 core 侧导出或复制）要理顺。
3. **【高】消副本**：前端直接 import core 源（跨 crate 相对路径 / workspace 包 /
   构建期生成镜像三选一）。牵扯 vite、tauri、测试 loader 三套解析，且 core 的
   `settings/index.ts` import 链会把 providers/models 一串模块拖进前端 bundle，
   需要先量 bundle 影响。这是终态，但必须等 1、2 落地后单独立项。

在 1-3 落地前，`check-settings-drift` 保证两侧不再悄悄分叉。

## 本任务改动清单

- 新增 `scripts/check-settings-drift.mjs`（门禁脚本，含 core 独有行白名单与
  transcript 宽度常量值守卫）。
- `Makefile` 新增 `check-settings-drift` 目标；`.github/workflows/ci.yml` 接入。
- 本文档。
- **未改任何 settings 运行代码** —— 归类阶段刻意零行为变化。
