# 日程通知、原生拖拽与共享时区验收

日期：2026-10-06，Apple Silicon Mac / macOS 26.5.1。后端 K-brain `b1e0747`，前端 LiveAgent `v2-kbrian`。

## 实现

### macOS 通知

- 日程通知改用 `UNUserNotificationCenter`。原插件桌面 `show()` 内部异步投递并忽略错误，不能用其返回值判断系统已接受。
- 新路径先检查授权和 alert 设置，再等待系统添加请求的 completion；失败不确认成功，保留后端重试。前台 delegate 请求 Banner/List/Sound。
- 每条提醒使用稳定 reminder ID 作为系统通知标识；这有助于替换同一 ID，但不宣称跨崩溃 exactly-once。
- `LIVEAGENT_DISABLE_NOTIFICATIONS=1` 时直接跳过领取；测试按钮明确报禁用，不再消费提醒并伪装已通知。
- 桌面系统设置增加“测试系统通知”，由用户操作请求权限。日常后台提醒不自动弹权限申请。
- 非 macOS 仍使用既有插件，未将本轮结论外推至 Windows/Linux。

### 共享日程时区

- 三种客户端的设置选择器直接使用 `timezone.get` / `timezone`，不再通过各自旧的 system settings 偏好作为日程事实源。
- 保存携带 `expectedRevision`，旧版本写入明确冲突；远端修改约两秒内读回。错误不会被下一次后台轮询立即隐藏。
- 自动模式保存空 preference，统一跟随 **K-brain 所在机器** 的系统时区，重启时重新解析。用户原有日程时区按显式偏好保留。
- 原生保存字体、代理等系统设置不再顺带把旧日程时区推回后端。其余非日程模块仍有原有本地时区配置，本轮不宣称所有后台业务日期计算已合并。

### 订阅

- 增加 Google/iCloud/Outlook-Exchange 获取已发布 ICS 地址的说明，明确只读订阅与账户登录、CalDAV、Graph 的区别。
- `webcal://` 和前后空格正规化；错误区分 401/403、404/410、429、HTML/非法 ICS，公开错误不带私有 URL 或响应正文。

## 实际验收

| 范围 | 结果 |
| --- | --- |
| 原生测试通知 | 系统设置按钮调用成功；macOS `usernoted` 日志明确记录 `Presenting ... as banner` |
| 到期提醒 | 创建真实 todo + reminder，后台领取一次，系统日志按同一个 reminder ID 记录 banner 投递，后端 `notified`、attempts=1 |
| 真实原生拖拽 | CoreGraphics 生成鼠标按下、移动、释放，WKWebView 收到 `isTrusted:true` 事件；活动起始时间移动一小时，持续一小时不变，真实后端读回确认 |
| 双向时区 | 直连浏览器→Gateway→原生设置选择器；原生写入→两网页；自动模式、浏览器重载、旧 revision 拒绝均通过 |
| 后端重启 | 换端口后桌面恢复；共享时区 preference/revision 保留；Google 日历 30 条仍存在 |
| Google 真实外部服务 | 官方美国节假日公共 ICS，HTTP 200，120685 bytes，后台实际导入 30 条，无订阅错误；验收后删除测试订阅 |
| iCloud / Exchange 真实账户 | **待验收**：测试目录无现有订阅，未提供专用 URL。没有读取用户个人账户数据库或钥匙串，也没有以本地 fixture 替代真实账户结果 |
| 视口 | 原生设置 1440/480、网页时区 390 无页面横向溢出；原生 480 设置仍为既有双栏布局，内容较窄，不宣称移动布局重构完成 |

通知使用专用测试 bundle：`/Users/a/Applications/LiveAgent Acceptance.app`，bundle ID `com.xiaofei.liveagent.acceptance`，测试数据 `/tmp/la-desktop/home`。这不是发布安装包，未覆盖 `/Applications/LiveAgent.app`。已关闭禁用通知环境变量，实际请求并允许该测试应用通知。

一开始在 `/tmp` 运行的 bundle 被 macOS 拒绝（UNErrorDomain Code=1，系统日志为 client validation failure）；注册并移到用户 Applications 目录后请求授权成功。最终结论基于 Applications 中真实运行的测试应用。

完整屏幕截图接口在当前环境返回 `could not create image from display`；因此**横幅验收证据是系统通知服务的展示日志，不是横幅截图或人工目视确认**。应用内设置截图单独留档。专注模式、休眠唤醒及正式签名安装包仍需各自验收。

拖拽最初被自动化通过 DOM 点击菜单后残留的 Base UI 关闭层截获。追踪发现 pointerdown 命中 `data-base-ui-inert`；真实点击关闭层后，原生鼠标拖拽通过。没有为测试移除覆盖层或伪造 DOM pointer 事件，也没有修改本来可用的拖拽实现。

## 自动测试

- K-brain 全量 `go test -p 1 ./...`，planning/backend race 与 vet 通过。
- GUI **2964 通过 / 1 跳过 / 0 失败**；Gateway **769/769**。
- 新 React DOM 用例覆盖远端状态刷新、revision 保存、自动模式、错误在轮询后保留及再次保存恢复。
- Rust 日程测试 **28 通过 / 1 忽略**；cargo check、macOS debug build 通过（既有 unused/dead-code warnings）。
- GUI/Gateway 构建、共享 UI 类型检查、修改源码 Biome 通过；源码锁定/准备/打包契约 **13/13**。

## 证据

本机 `/tmp` 日志：

- `planning-native-drag.log`：真实鼠标拖拽断言。
- `planning-timezone-sync-final.log`：三端双向同步与自动模式。
- `planning-notification-delivery-proof.log`、`planning-reminder-banner-proof.log`：系统横幅展示记录。
- `planning-acceptance-{go-race,go-full,vet,gui-tests,web-tests,rust-tests,rust-check-final,reconnect,lock-tests}.log`。

验收脚本 `/private/tmp/desk/planning-native-drag.mjs`、`planning-timezone-sync.mjs`，CoreGraphics helper `/tmp/planning-mouse-activate.swift`。脚本使用当前测试 PID/端口，复跑前需要更新。报告、脚本、应用内截图、日志同步桌面审计目录 `planning-notifications-sync-macos`。

未修改发布标签、附件或触发发布工作流；现有 beta 附件不包含本轮代码。
