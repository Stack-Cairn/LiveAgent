# 通知

日程提醒、定时任务结果与 Agent `Notify` 工具统一经桌面端的 `NotificationService` 弹出系统通知。设计原则是只做系统和项目没有的部分：

| 能力 | 由谁负责 |
| --- | --- |
| 历史记录、未读 | 操作系统通知中心 |
| 免打扰 | 系统专注模式 / 勿扰（macOS、Windows、Linux 桌面环境） |
| 点击回到应用 | macOS 由通知委托调出主窗口；Windows 再次启动的 exe 由单实例插件转发到已运行实例 |
| 投递与权限 | macOS（从 .app 运行）：`UNUserNotificationCenter`；其它平台与 `tauri dev`：`tauri-plugin-notification` |
| 类别开关 | 系统设置 `notifications` 键（与 `defaultTimeZone` 同一套存储与同步） |
| 本地化文案 | 前端按界面语言经 `notifications_set_labels` 推送（后端没有界面语言） |

## 后端

`crates/agent-gui/src-tauri/src/services/notifications/mod.rs`

- `NotificationService::notify(Notice)`：读取设置开关 → 按 key 节流 → 清洗标题（≤120 字符）与正文（≤500 字符）→ 调用插件。返回 `sent` / `disabled` / `throttled` / `disabledByEnv`，插件报错时返回错误。
- 类别与默认值：日程提醒开、定时任务失败（含超时）开、定时任务成功关、Agent 消息开；测试通知不受开关影响。
- 节流只用内存时间戳：定时任务按「任务 + 结果」5 分钟一条，Agent `Notify` 30 秒一条。节流只在投递成功后开始计时。
- `LIVEAGENT_DISABLE_NOTIFICATIONS=1` 时不调用插件（测试 / 自动化环境）。
- 命令：`notifications_set_labels`、`notifications_test`、`notifications_notify`（Agent 工具）、`notifications_permission` / `notifications_request_permission`、`notifications_open_settings`（macOS 定位到本应用，Windows 打开通知总页，Linux 返回 `E:unsupported`）。投递与权限命令会等待系统回调，在后台线程执行。

### macOS 原生通道（`services/notifications/macos.rs`）

插件在 macOS 上走已弃用的 `NSUserNotificationCenter`：从不请求授权，应用不会出现在「系统设置 → 通知」中，也读不到真实权限。从 .app 运行时改用 `UNUserNotificationCenter`：

- 首次发送（或设置页「允许通知」）时请求授权；被拒绝返回 `permissionDenied`，计为已处理而不重试。
- 委托 `willPresentNotification` 返回 banner + list + sound，应用在前台时也显示横幅；`didReceiveNotificationResponse` 调出主窗口。
- `tauri dev` 的裸二进制没有 bundle（`currentNotificationCenter` 会抛异常），此时回退插件，并以「终端」身份发送。
- 系统只给签名标识与 bundle id 一致、Info.plist 已绑定的 .app 授权（否则 `UNErrorDomain error 1`）。`tauri.macos.conf.json` 设 `signingIdentity: "-"`，本地 `tauri build` 自动做临时签名；发版流程以 `APPLE_SIGNING_IDENTITY` 覆盖为开发者证书。

## 接入

- 日程提醒（`services/planning/mod.rs`）：worker 的领取、租约、退避重试与补发语义不变；只有插件报错才算失败并重试，类别关闭、节流视为已处理。到点超过 24 小时才被领取的提醒（应用长时间未运行）不再补弹。
- 定时任务（`services/automation/notifications.rs`）：bash / http 运行写入、prompt 运行完成、prompt 超时三处在事务提交后上报 `RunFinished`；跳过的运行与启动时补记的上次进程遗留运行不通知。正文取输出摘要（优先 stderr / stdout 首行，≤200 字符）。
- Agent `Notify`（`crates/agent-gui/src/lib/tools/notifyTool.ts`）：参数只有 `title`、`body`；结果用英文告诉模型是否已发送；分享聊天记录时按内置工具脱敏。

## 设置

设置 → 通用 → 通知（`crates/agent-ui/src/pages/settings/NotificationsSection.tsx`）：四个类别开关；桌面端另有「发送测试通知」与「打开系统通知设置」。WebUI 可以修改开关（经系统设置同步到桌面端），通知只在运行桌面端的电脑上弹出。

## 已知限制

- Windows / Linux 仍用插件：插件把真正的发送放进后台任务并丢弃结果，系统层面未展示（Windows 绿色版未注册应用标识、Linux 没有通知守护进程）时仍返回成功，也读不到权限。设置页因此提供测试通知与系统设置入口。
- 开发实例（`tauri dev`）与已安装的正式版默认共用 `~/.liveagent/config.sqlite`，两边的日程 worker 都会领取提醒；被开发实例领走的提醒以「终端」身份发出。同时运行时请给开发实例设置 `LIVEAGENT_CONFIG_DIR`。
- 通知上的按钮（稍后提醒等）、点击后跳到具体日程 / 运行尚未实现；需要时可在 macOS 委托与 Windows toast 激活回调里扩展。
