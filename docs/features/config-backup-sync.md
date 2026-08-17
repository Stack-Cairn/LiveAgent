# 配置备份与同步

## 总体模型

把「服务商 / MCP / 系统设置 / 技能启用态」四域打包成一份 JSON 快照，支持导出到本地文件，或同步到用户自己的 WebDAV 网盘以在多台设备间共用。

这是**桌面独占能力**。快照的采集与应用都直接触碰 SQLite 与本地文件系统，符合「桌面是唯一执行工具、唯一持久化数据的地方」这一核心不变量。WebUI 侧没有这个分区，Gateway 不参与任何一步。

| 层 | 路径 | 职责 |
|---|---|---|
| 快照采集/校验/应用 | `src-tauri/src/commands/config/settings/backup_snapshot.rs` | `collect_backup_snapshot` / `validate_backup_manifest` / `apply_backup_snapshot`；应用前自动备份到 `~/.liveagent/backups/`。 |
| 本地导入导出 | `src-tauri/src/commands/config/settings/backup_io.rs` | rfd 文件对话框 + 解析校验 + 写入。 |
| WebDAV 编排 | `src-tauri/src/commands/config/settings/webdav_sync.rs` | 同步配置存取、远端路径拼装、上传/下载、校验和验证。 |
| WebDAV 传输 | `src-tauri/src/services/webdav.rs` | PROPFIND / MKCOL / PUT / GET，超时分级、响应体大小上限、日志脱敏、坚果云等服务商的定向错误文案。 |
| 自动同步 | `src-tauri/src/services/webdav_auto_sync.rs` | 防抖上传任务、抑制守卫、skills 缓存。 |
| 前端 IPC | `crates/agent-gui/src/lib/backup/index.ts` | 命令封装 + 标脏通知 + 状态事件类型。 |
| Settings UI | `crates/agent-gui/src/pages/settings/BackupSyncSection.tsx` | 本地备份组 + WebDAV 同步组。 |

## 备份范围

**在范围内**：服务商配置（含 API 密钥）、MCP 服务器、系统设置、技能启用态。

**不在范围内**：对话历史、记忆库、上传文件、SSH 私钥、WebDAV 凭据本身。

技能启用态存在 webview localStorage 而非 SQLite，后端读不到，因此导出时由前端拼进 payload，导入时由后端回传给前端写回。

> **WebDAV 凭据必须排除在快照之外。** 若随快照流转，A 机器的凭据会覆盖 B 机器，形成同步循环。为此同步配置存在独立表 `backup_sync_settings` 而不是 `system_settings` —— 后者的 `save_system` 采用「DELETE 整表 → 按固定 key 白名单重新 INSERT」的写法，任何不在白名单里的 key 都会在下一次系统设置保存时被静默抹掉。

## 安全取舍

**快照中的服务商 API 密钥是明文的**，与 cc-switch 的做法一致。

这不违反「Gateway 从不持有真实密钥」的不变量 —— 那条不变量约束的是 Gateway↔WebUI 这条不可信链路，而 WebDAV 端点是用户自己持有、自己认证的。但明文仍是真实风险，配套三项缓解：

1. UI 上明确告知导出文件含明文密钥，应当像密码一样保管。
2. WebDAV 账号密码本身**从不**进入任何快照。
3. manifest 预留 `encryption` 字段（当前恒为 `"none"`），为后续加密留出无破坏性的升级路径。

## 远端布局

```
{remote_dir}/v1/{profile}/
  ├── manifest.json   # 元信息 + config.json 的 size 与 sha256
  └── config.json     # 快照本体
```

默认 `liveagent/v1/default/`。

版本段 `v1` 夹在中间而非最外层，使用户在 WebDAV 客户端里看到的是一个干净的顶层目录。协议或 schema 不兼容演进时更换该段，让新旧客户端各读各的。

`profile` 支持同一账号下隔离多套配置（如 work / personal）。

**上传顺序是「先 PUT config.json 再 PUT manifest.json」**，这是有意的。manifest 是「这份备份可用」的信号，最后写入；中途失败时远端留下的是旧 manifest + 新 config，下载侧的 sha256 校验会拦下这个不一致，而不会把残缺配置当成合法快照应用。

所有远端读写由一个全局 mutex 串行化 —— 上传是两步 PUT，并发执行会让两个文件来自不同快照。

## 自动同步

**只上传，不下载。** 自动拉取远端会在用户毫无察觉的情况下覆盖本机配置，出错方向不可接受，因此拉取永远是手动动作。

### 触发与防抖

| 触发源 | 位置 | 说明 |
|---|---|---|
| 后端 | `save_providers` / `save_mcp` / `save_system` | 在 `tx.commit()` 成功**之后**调用 `mark_dirty()`，回滚的事务不会误触发。这三个函数是 SQLite 侧唯一的写入咽喉，天然覆盖 Gateway 发起的写入。 |
| 前端 | `persistSettings`（`src/lib/settings/storage.ts`） | 四域任一变更时调用 `settings_backup_mark_dirty`，同时把最新 skills 快照送给后端缓存。fire-and-forget，失败绝不冒泡成「保存失败」。 |

> 为什么不用 SQLite `update_hook`：`open_db()` 每次调用都新建一个 `Connection`（全仓 69 处调用），而 `update_hook` 是 per-connection 的；且当前只启用了 rusqlite 的 `bundled` feature。

脏信号走一个容量 1 的 channel —— 已有未处理信号时新信号直接丢弃，防抖窗口本就会把它们合并成一次上传。窗口为 1s 静默 + 10s 硬上限；没有上限的话，持续编辑（例如逐字输入 API Key）会不断刷新防抖窗口，无限推迟上传。

### 抑制

下载并应用远端快照期间持有 `AutoSyncSuppressionGuard`（RAII 引用计数）。应用快照走的正是 `save_providers` / `save_mcp` / `save_system`，不抑制就会把刚从远端拉下来的数据原样推回去。

本地导入路径（`settings_backup_apply_import`）**有意不抑制** —— 用户主动从文件导入的配置应当传播到远端。

### skills 缓存

自动上传没有前端参与，而 skills 存在 localStorage，因此后端缓存前端最近一次送来的启用态。缓存为空时上传会**省略** skills 域，而不是写入空值 —— 省略在下载侧表现为「不动本机技能设置」，写空值会把它们全部清掉。

### 状态反馈

后台同步的结果通过 Tauri 事件 `backup-sync-status-updated` 推送，载荷 `{ lastSyncAt, lastError }`。手动同步的成败由命令的返回值同步告知前端，不走这个事件 —— 所以收到事件就意味着「后台自动同步」。

## Tauri 命令

| 命令 | 说明 |
|---|---|
| `settings_backup_export` / `settings_backup_peek_import` / `settings_backup_apply_import` | 本地导入导出；peek 只解析校验、不写入，供确认对话框展示来源设备与条目数。 |
| `settings_backup_load_sync_config` / `settings_backup_save_sync_config` | 同步配置存取。**回传前端的视图不含密码**，只用 `hasPassword` 告知是否已设置。 |
| `settings_backup_test_sync_connection` | PROPFIND Depth=0 探活，不解析 XML。 |
| `settings_backup_fetch_remote_info` | 只拉 manifest，供上传/下载前的确认对话框。远端无备份时返回 `null`。 |
| `settings_backup_upload` / `settings_backup_download` | 手动同步。 |
| `settings_backup_mark_dirty` | 前端标脏 + 缓存 skills。 |

**密码回填**：前端未修改密码时传 `passwordTouched: false`，后端沿用库里的旧值。这是 cc-switch 记录过的真实 bug —— UI 给密码框填掩码占位符后原样提交，会把占位符当成新密码写库，用户下次同步就认证失败。
