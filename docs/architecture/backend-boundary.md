# 后端边界

本文件是「统一网络通信」重构的**第一交付物**。它把当前 234 个 `#[tauri::command]` 分成三类,
决定哪些进入 `crates/backend`(独立进程、禁 tauri 依赖)、哪些永远留在 Tauri 壳、哪些直接删除。

**这份分类是后续所有阶段的前提。** 分错一个,后端就会被迫 `use tauri::`,headless 模式编译不出来。

## 划分标准

| 判据 | 归属 |
|---|---|
| 读写数据、执行计算、操作文件系统/进程/网络 | **后端** |
| 在某台机器的**图形界面上产生可见效果**(原生对话框、文件管理器、托盘、窗口、通知、全局快捷键、系统剪贴板) | **前端专属** |
| 只为「桌面端主动拨向公网 Gateway」这一拓扑而存在 | **删除** |

判断口诀:远程模式下,这个 command 在**后端那台机器**上执行还有意义吗?
`system_pick_folder` 会在服务器上弹一个你看不见的对话框 —— 那它就是前端专属。

## 总量

| 类别 | 数量 |
|---|---|
| 后端(`crates/backend`) | **195** |
| 前端专属(Tauri 壳) | **18** |
| 删除 | **21** |
| 合计 | **234** |

数据来源:`crates/frontend/src-tauri/src/lib.rs` 第 43–286 行的 `tauri::generate_handler![…]` 块。
该区间内非空非注释行共 234 条,全部匹配 `<mod>::<mod>::<cmd>,` 形式,无重复、无遗漏。

> ⚠️ 统计时注意两个坑:
> 1. 该块以 `        ]`(**不带分号**)结尾,按 `];` 搜索会落空并一路扫到文件尾,
>    把 `commands::app::WindowPinState` 这类**类型引用**误计为 command。
> 2. 最后一条注册是 `services::proxy::proxy_get_server_info`,**不在 `commands::` 命名空间下**,
>    只按 `commands::` 前缀过滤会漏掉它。

---

## A. 后端(195)

进 `crates/backend`,同时暴露为 HTTP/WS JSON API。前端与 Node 引擎都是它的客户端。

| 模块 | 数量 | 备注 |
|---|---|---|
| `chat_history` | 16 | 含 `chat_history_upsert_active_segment` / `append_segment` —— 见下方「落库时机」 |
| `git` | 33 | 34 减去 `git_open_system_file_location` |
| `memory` | 23 | |
| `terminal` | 23 | 含 SSH、本地端口转发、SSH tab |
| `fs` | 16 | 17 减去 `fs_open_workspace_path` |
| `system` | 14 | 18 减去 4 个图形/剪贴板类 |
| `settings` | 13 | |
| `cron` | 10 | 注册名多为 `automation_*` |
| `sftp` | 10 | |
| `subagent_store` | 8 | |
| `process` | 6 | `managed_process_*` |
| `mcp` | 6 | |
| `subagent_worktree` | 4 | |
| `hook` | 3 | |
| `shell` | 2 | `shell_run`、`runtime_cancel` |
| **`tunnel`** | **5** | 从 gateway 模块救回并重写,见下 |
| **`provider_usage`** | **2** | 从 gateway 模块救回,见下 |
| **`workspace_watch`** | **1** | 从 gateway 模块救回,见下 |

### 从 gateway 模块救回的 8 个

`commands/integration/gateway.rs` 里注册了 28 个 command,但其中 8 个**与中继拓扑无关**,
只是恰好登记在这个文件里。它们是真实产品功能,必须进后端:

| Command | 实际做什么 | 依据 |
|---|---|---|
| `workspace_watch_set` | 工作区文件监听 | `gateway.rs:299` 只调 `workspace_watch.set_desired(WatchSource::Local, …)` |
| `provider_usage_query` | 查 provider 用量 | `gateway.rs:18` 只调 `provider_usage_service.query()` |
| `provider_usage_test` | 测试用量查询配置 | 同上 |
| `tunnel_state` | 隧道列表 | ✅ P2-30 已重写并改名(原 `gateway_tunnel_state`) |
| `tunnel_create` | 建隧道 | ✅ |
| `tunnel_update` | 改隧道 | ✅ |
| `tunnel_close` | 关隧道 | ✅ |
| `tunnel_check` | 探测本地端口 | ✅ 改为同步等探活完成 |

这三组在阶段 2 迁移时必须**脱离 `GatewayController`**,改为直接持有各自的 service。

### 隧道要重写,不是照搬 —— ✅ 已完成(P2-30)

隧道的用途是:agent 在工作机上起了个 dev server(如 `:5173`),用户想从浏览器看效果。

- **旧**:桌面端把端口注册到公网 Gateway,Gateway 开 `/t/{slug}` 公开反代,并重写 HTML 属性、
  CSS `url()`、注入 shim、改 CSP(`internal/server/tunnel_rewrite.go` 424 行 +
  `tunnel_proxy.go` 781 行)。
- **新**:后端**就在**那台工作机上,且已有网络接口,直接反代到 `localhost:5173`。
  **slug 注册协议、跨中继分帧、公开无认证入口全部不需要。**

**「路径前缀重写是否必要」已定案:不必要,因为不挂子路径。** 每条隧道占一个独立端口,
路径 1:1 —— dev server 发的 `<script src="/assets/main.js">` 本来就是对的。挂
`/t/<id>/` 才需要重写它发出的每个 URL,那等于把上面那 1,205 行用 Rust 重写一遍。

认证改为「首访 `?t=<token>` → HttpOnly cookie → 302 到干净路径」:浏览器标签页发不了
`Authorization` 头,所以后端密码在这里用不上。强度与旧架构的「不可猜 slug」相当,
但端口可被扫到而 token 不能。

命令名已从 `gateway_tunnel_*` 改为 `tunnel_*`,事件 `gateway:tunnel-state` →
`tunnel:state`。详见 [migration/phase-2-backend.md](migration/phase-2-backend.md#隧道重写p2-30)。

### 后端专属但当前由前端触发的

| Command | 说明 |
|---|---|
| `system_begin_power_activity` / `system_end_power_activity` | 阻止系统休眠。语义上属于**执行侧** —— 该阻止休眠的是跑任务的那台机器,不是看屏幕的那台。远程模式下前端调它毫无意义。归后端。 |

### 落库时机(影响阶段 3)

`chat_history_upsert_active_segment` / `chat_history_append_segment` 目前**只在 turn 结束时被调用一次**
(`runAgentConversationTurn.ts:1217`,位于 1231 行函数的末尾)。

阶段 3 之后引擎在后端,「断线重连拉快照」的快照源**必须是引擎内存态**(含正在生成的半条消息),
不能查 SQLite,否则重连会看到会话回退到上一轮结束。详见方案风险 2。

---

## B. 前端专属(18)

永远留在 Tauri 壳,**不进后端**。浏览器形态下用运行时探测降级或禁用。

| 模块 / Command | 数量 | 理由 |
|---|---|---|
| `app::*` | 7 | 窗口行为、置顶、全局快捷键、退出确认、macOS 红绿灯位置、平台探测 —— 全是窗口/OS 级 |
| `update::*` | 3 | `app_update_check` / `app_update_install` / `app_restart`,更新的是桌面客户端自身 |
| `tray::app_tray_menu_sync` | 1 | 系统托盘 |
| `system_pick_folder` | 1 | `FileDialog::new()` 原生对话框(`system.rs:1338`) |
| `system_pick_file` | 1 | 同上 |
| `system_pick_readable_files` | 1 | 同上 |
| `system_clipboard_read_text` | 1 | 系统剪贴板;浏览器用 `navigator.clipboard` |
| `fs_open_workspace_path` | 1 | 调系统文件管理器打开路径 |
| `git_open_system_file_location` | 1 | 同上(`git.rs:3369`) |
| `open_chat_file_link` | 1 | **需拆分**,见下 |

### `open_chat_file_link` 必须拆开

`chat_file_links.rs:628` 是个混合体。`:431` 处有分支:

```rust
if inside_workspace && !open_in_file_manager { … }
```

- 文件在工作区内且不要求文件管理器 → 返回 `ChatFileLinkOpenResponse { action, kind, workdir, path, line, … }`,
  由前端在应用内打开。**这半边是纯解析,属于后端。**
- 否则 → 调 OS 打开外部编辑器/文件管理器。**这半边属于前端。**

阶段 2 拆成:后端 `chat_file_link_resolve`(返回 action + 定位信息),前端按 action 决定
应用内跳转还是调 `plugin-opener`。

上表按「含 OS 副作用」计入前端,拆分后后端会 +1、前端保持提供 OS 动作。

---

## C. 删除(21)

只为「桌面端 outbound 拨向公网 Gateway」这一拓扑存在。新架构里前端主动连后端,这些全部失去意义。

**连接管理(4)**
`gateway_connect` `gateway_disconnect` `gateway_status` `gateway_nudge_connection`

**chat 中继记账(15)** —— 对应 Gateway 里那 ~3,800 行可靠性补丁的桌面端一侧
`gateway_send_chat_ingress_batch` `gateway_commit_chat_checkpoint` `gateway_chat_claim_next`
`gateway_chat_mark_started` `gateway_chat_mark_local_started` `gateway_chat_mark_local_cancelled`
`gateway_chat_mark_queued_in_gui` `gateway_chat_complete` `gateway_chat_fail`
`gateway_chat_cancel_request` `gateway_chat_heartbeat` `gateway_chat_runtime_heartbeat`
`gateway_chat_release_lease` `gateway_chat_queue_respond` `gateway_publish_chat_queue_event`

**同步推送(1)**
`gateway_publish_settings_sync`

**本地代理自举(1)**
`services::proxy::proxy_get_server_info` —— 现在返回本地 axum 的 `base_url` + 随机 `token`
(`services/proxy.rs:97`),让前端知道去哪调 `/image-proxy` 和 `/proxy/{provider}`。
新架构下前端本来就持有后端的 `baseUrl` + 密码,这层自举多余;
且阶段 3 之后引擎在后端直连 provider,`/proxy/{provider}` 对前端也不再需要。

> 这一条是本次统计新发现的 —— 它不在 `commands::` 命名空间下,
> 按模块前缀过滤的清点方式会整条漏掉。

上述 21 个连同 `services/gateway/*.rs`(~4,000 行)、`services/gateway_bridge.rs`(~1,400 行)
在阶段 4 一并删除。

---

## 编译期防线

分类靠自觉守不住。`crates/backend/Cargo.toml` **不得出现任何 tauri 依赖** ——
一旦有人把前端专属 command 挪进后端,`cargo build -p backend` 直接失败。

这是方案风险 4 的唯一对策,不要用文档约定代替。

## 复核方法

本文件的数字全部可复现。命令名清单维护在 `docs/architecture/command-classes/` 下三个文本文件
(`backend.txt` / `frontend.txt` / `deleted.txt`,每行一个 command 名)。

```bash
cd crates/frontend/src-tauri/src

# 从注册块提取真实清单(注意块以不带分号的 `]` 结尾)
sed -n '43,286p' lib.rs \
  | rg -o '^\s+[a-z_]+::[a-z_]+::([a-z_0-9]+),$' -r '$1' \
  | sort > /tmp/registered.txt

D=../../../../docs/architecture/command-classes
cat $D/backend.txt $D/frontend.txt $D/deleted.txt | sort > /tmp/classified.txt

diff /tmp/registered.txt /tmp/classified.txt && echo "分类完整,无遗漏无幽灵"
```

新增 command 时必须同步更新对应清单文件,否则该 diff 会红。
建议在阶段 2 把这条 diff 加进 CI,让「新 command 未分类」变成编译失败之外的第二道门禁。

> 行号 `43,286` 会随 `lib.rs` 变动。若 diff 报出大量差异,先确认块边界:
> 起点是 `tauri::generate_handler![` 的下一行,终点是与之配对的 `        ]` 行的前一行。

## 交叉引用

- 总体方案与 19 项决策:`/Users/realm/.claude/plans/go-gateway-git-go-peaceful-wigderson.md`
- 当前 Gateway 职责(将废弃):Gateway 已随阶段 6 删除,`docs/architecture/gateway.md` 不再存在
- 当前整体架构(将重写):`docs/architecture/overview.md`(已按三层结构重写)
