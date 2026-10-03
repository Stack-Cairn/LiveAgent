# 通知

日程提醒、定时任务结果与 Agent `Notify` 工具统一经桌面端的 `NotificationService` 弹出系统通知。设计原则是只做系统和项目没有的部分：

| 能力 | 由谁负责 |
| --- | --- |
| 历史记录、未读 | 操作系统通知中心 |
| 免打扰 | 系统专注模式 / 勿扰（macOS、Windows、Linux 桌面环境） |
| 点击回到应用 | 系统激活应用；Windows 再次启动的 exe 由单实例插件转发到已运行实例 |
| 投递 | `tauri-plugin-notification` |
| 类别开关 | 系统设置 `notifications` 键（与 `defaultTimeZone` 同一套存储与同步） |
| 本地化文案 | 前端按界面语言经 `notifications_set_labels` 推送（后端没有界面语言） |

## 后端

`crates/agent-gui/src-tauri/src/services/notifications/mod.rs`

- `NotificationService::notify(Notice)`：读取设置开关 → 按 key 节流 → 清洗标题（≤120 字符）与正文（≤500 字符）→ 调用插件。返回 `sent` / `disabled` / `throttled` / `disabledByEnv`，插件报错时返回错误。
- 类别与默认值：日程提醒开、定时任务失败（含超时）开、定时任务成功关、Agent 消息开；测试通知不受开关影响。
- 节流只用内存时间戳：定时任务按「任务 + 结果」5 分钟一条，Agent `Notify` 30 秒一条。节流只在投递成功后开始计时。
- `LIVEAGENT_DISABLE_NOTIFICATIONS=1` 时不调用插件（测试 / 自动化环境）。
- 命令：`notifications_set_labels`、`notifications_test`、`notifications_notify`（Agent 工具）、`notifications_open_settings`（macOS 定位到本应用，Windows 打开通知总页，Linux 返回 `E:unsupported`）。

## 接入

- 日程提醒（`services/planning/mod.rs`）：worker 的领取、租约、退避重试与补发语义不变；只有插件报错才算失败并重试，类别关闭、节流视为已处理。到点超过 24 小时才被领取的提醒（应用长时间未运行）不再补弹。
- 定时任务（`services/automation/notifications.rs`）：bash / http 运行写入、prompt 运行完成、prompt 超时三处在事务提交后上报 `RunFinished`；跳过的运行与启动时补记的上次进程遗留运行不通知。正文取输出摘要（优先 stderr / stdout 首行，≤200 字符）。
- Agent `Notify`（`crates/agent-gui/src/lib/tools/notifyTool.ts`）：参数只有 `title`、`body`；结果用英文告诉模型是否已发送；分享聊天记录时按内置工具脱敏。

## 设置

设置 → 通用 → 通知（`crates/agent-ui/src/pages/settings/NotificationsSection.tsx`）：四个类别开关；桌面端另有「发送测试通知」与「打开系统通知设置」。WebUI 可以修改开关（经系统设置同步到桌面端），通知只在运行桌面端的电脑上弹出。

## 已知限制

- `tauri-plugin-notification` 在桌面端把真正的发送放进后台任务并丢弃结果：系统层面未展示（用户关闭了通知、Windows 绿色版未注册应用标识、Linux 没有通知守护进程）时仍返回成功，权限状态也无法读取。设置页因此提供测试通知与系统设置入口。
- macOS 开发构建（`tauri dev`）以「终端」身份发送；打包后的 .app 以本应用身份发送。
- 需要通知上的按钮、点击后跳到具体日程 / 运行，或真实权限状态时，再按平台换成原生实现（macOS `UNUserNotificationCenter`、Windows toast 激活回调、Linux D-Bus action）。
