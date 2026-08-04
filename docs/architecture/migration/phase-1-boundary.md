# 阶段 1 · 划清后端边界

**状态:✅ 完成**(commit `099b9e01`)

## 目标

把 234 个 `#[tauri::command]` 分成三类,决定哪些进 `agent-core`(独立进程、禁 tauri
依赖)、哪些永远留在 Tauri 壳、哪些直接删除。

**不写实现代码。** 这份分类是后续所有阶段的前提 —— 分错一个,后端就会被迫
`use tauri::`,headless 模式编译不出来。

## 要求

| # | 要求 | 达成 |
|---|---|---|
| 1 | 每个 command 有明确归属和理由 | ✅ 234/234 |
| 2 | 清单机器可读,可 diff 校验 | ✅ `command-classes/*.txt` |
| 3 | 边界模糊项单独裁定并记录理由 | ✅ 见下 |
| 4 | 数字可复现,不靠手数 | ✅ 文档内附命令 |

## 划分标准

| 判据 | 归属 |
|---|---|
| 读写数据、执行计算、操作文件系统/进程/网络 | **后端** |
| 在某台机器的**图形界面上产生可见效果**(原生对话框、文件管理器、托盘、窗口、通知、全局快捷键、系统剪贴板) | **前端专属** |
| 只为「桌面端主动拨向公网 Gateway」这一拓扑而存在 | **删除** |

口诀:远程模式下,这个 command 在**后端那台机器**上执行还有意义吗?
`system_pick_folder` 会在服务器上弹一个你看不见的对话框 —— 前端专属。

## 结果

```
234 = 195 后端 + 18 前端专属 + 21 删除
```

明细见 [`../backend-boundary.md`](../backend-boundary.md) 与
[`../command-classes/`](../command-classes/)。

## 三个实质裁定

**① 从 gateway 模块救回 8 条。** `commands/integration/gateway.rs` 注册了 28 个 command,
但 8 个与中继拓扑无关,只是恰好登记在这个文件里:

| Command | 依据 |
|---|---|
| `workspace_watch_set` | `gateway.rs:299` 只调 `workspace_watch.set_desired(WatchSource::Local, …)` |
| `provider_usage_query` / `_test` | `gateway.rs:18` 只调 `provider_usage_service.query()` |
| `gateway_tunnel_{state,create,update,close,check}` | 隧道是真实产品功能 |

迁移时必须**脱离 `GatewayController`**,改为直接持有各自的 service。

**② 隧道要重写,不是照搬。** 现在桌面端把端口注册到公网 Gateway,Gateway 开
`/t/{slug}` 公开反代并重写 HTML/CSS/CSP(`tunnel_rewrite.go` 约 1000 行)。新架构下
后端**就在**那台工作机上且已有网络接口 —— slug 注册协议、跨中继分帧、公开无认证
入口全部不需要。名字应从 `gateway_tunnel_*` 改为 `tunnel_*`。

**③ `open_chat_file_link` 必须拆开。** `chat_file_links.rs:431` 有分支
`if inside_workspace && !open_in_file_manager`:成立时返回 action 让前端应用内打开
(纯解析 → 后端),否则调 OS 打开外部程序(→ 前端)。拆成后端 `chat_file_link_resolve`
+ 前端按 action 决策。

## 清点过程的两个坑(已写入文档)

1. `generate_handler![…]` 块以 `        ]`(**不带分号**)结尾。按 `];` 搜索会落空并
   一路扫到文件尾,把 `commands::app::WindowPinState` 这类**类型引用**误计为 command。
2. 最后一条注册是 `services::proxy::proxy_get_server_info`,**不在 `commands::`
   命名空间下**,只按 `commands::` 前缀过滤会整条漏掉。

> 我在清点时先后被这两个坑各绊了一次,给出过 `app` 模块 8 个和 14 个两个错误数字
> (实际 7 个)。最终锁定 `lib.rs:43-286`,块内 234 行全部匹配、零重复、零遗漏。

## 遗留缺陷

**`settings_save_remote` 是「部分删除」,三分类容不下。** 实施阶段 2 时发现:
`RemoteSettingsPayload`(`commands/config/settings/types.rs:23`)混了两类字段 ——
`gateway_url`/`gateway_port`/`token`/`agent_id` 随 Gateway 删除,
`enable_web_terminal`/`enable_web_ssh_terminal`/`enable_web_git` 等权限开关新架构仍需要。
且 `apply_config` 返回 `Result` 传播错误,是**命令不是事件**,转事件总线会丢错误语义。

处置:阶段 2 保持耦合,阶段 4 拆成两半。已记入 `backend-boundary.md`「已知分类缺陷」。

## 验证

```bash
cd crates/agent-gui/src-tauri/src
sed -n '43,286p' lib.rs \
  | rg -o '^\s+[a-z_]+::[a-z_]+::([a-z_0-9]+),$' -r '$1' \
  | sort > /tmp/registered.txt
D=../../../../docs/architecture/command-classes
cat $D/backend.txt $D/frontend.txt $D/deleted.txt | sort > /tmp/classified.txt
diff /tmp/registered.txt /tmp/classified.txt && echo "分类完整,无遗漏无幽灵"
```

已实测通过(234 条)。行号会随 `lib.rs` 变动,若大量报差异先确认块边界。

建议阶段 2 把这条 diff 加进 CI,让「新增 command 未分类」变成第二道门禁。
