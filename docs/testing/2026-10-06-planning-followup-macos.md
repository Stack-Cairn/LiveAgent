# 日程补齐与 macOS 实机验收（2026-10-06）

## 范围与环境

- K-brain `main`：`ade5f3c`；LiveAgent `v2-kbrian`，源码锁文件同步完整后端提交号。
- 实际 Apple Silicon Mac，原生 LiveAgent debug 进程和 WKWebView；测试数据目录 `/tmp/la-desktop/home`。未替换用户正式配置。
- Chrome 使用本机 `/Applications/Google Chrome.app`，自动化以 headless 模式运行。桌面视口 1440，移动视口 390/480。
- 浏览器直连真实 K-brain；Gateway 网页经本地 Gateway、真实桌面命令转发至同一个后端。网页使用当前源码的开发服务器。
- HTTP 日历源是本地可控 ICS fixture；不代表真实 Google、iCloud 或 Exchange 账户验收。
- 没有改发布标签、附件或执行发布工作流。已有 beta 安装包不包含这些源码更新。

## 本轮补齐

1. **订阅解析移至后端并扩展兼容**：`DTSTART/RRULE/RDATE` 合集、去重、`EXDATE`、单次覆盖/取消，`RDATE;VALUE=PERIOD`，`DURATION`，嵌入式 `VTIMEZONE`。按日/周计算的时长与按小时计算的时长分别处理夏令时。
2. **失败刷新保留已有记录**：先在候选快照中同步和验证，成功后提交；格式错误、超长标题等失败不会部分改写已有日程。成功重试清理错误并移除源中不再存在的活动。
3. **手动导入漏首条修复**：ical.js 的 RDATE-only 展开未包含 DTSTART，前端补入首条，并按实际时间判断 EXDATE，避免 UTC 与本地表示不同导致误导入。
4. **浏览器时区设置**：保存到 K-brain 的日程 timezone，同时保留浏览器偏好；错误明确上报，后续保存即使偏好值未变也可重试。日程时区不会改变 cron 的实际触发时区，设置说明已修正。

## 验收结果

| 场景 | 本轮结果与边界 |
| --- | --- |
| 原生订阅创建、读取 | 通过；真实后台刷新，RDATE 两条，嵌入 Eastern 时区转换为正确 UTC 时间，时长两小时 |
| 订阅只读 | 通过；真实 native mutation 拒绝编辑 |
| 错误源与恢复 | 通过；坏 ICS 保留原记录并显示后端错误；恢复后清错、更新标题、保留记录 ID、删除失效 occurrence |
| 原生 UI 文件导入 | 通过；WKWebView 的文件 input、预览、导入到后端。文件通过 DataTransfer 注入，未操作 Finder 选择文件窗口 |
| 浏览器及 Gateway 文件导入 | 通过；文件输入→预览两条→导入→原生查询两条；再次导入跳过两条已有内容 |
| 拖动日程 | 通过；Mac Chrome 中真实 pointer down/move/up，起始时间改变、两小时持续时间不变，后端读回确认；未将此记录为原生 WKWebView 拖拽验收 |
| 浏览器时区 | 通过；设置页面选择 America/New_York，原生后端读回一致；刷新网页保留偏好；通过 UI 恢复原日程时区 |
| 三端共享任务 | 通过；Gateway 创建→直连网页及原生查询可见；直连网页完成→Gateway 消失；390 宽网页创建、完成、重载一致 |
| 页面与布局 | 原生 1440/480、直连网页及 Gateway 1440/390 均无页面横向溢出；截图留档。日程、日程设置导入入口共享组件由类型检查及自动测试覆盖，未逐个重复所有入口操作 |
| 后端重启 | 通过；终止专用测试 sidecar 后新端口启动，无需重载桌面恢复；Cron/Memory/MCP/Skills/Planning 页面无 Load failed |

跨端测试首次遇到 `agent offline`，检查发现测试桌面的 Remote 配置为禁用。使用运行时 `gateway_connect` 连接本地测试 Gateway 后重跑通过，未修改持久 Remote 配置。文件选择器首次因 Gateway 同时有三个 file input 导致测试选择器歧义，限定 ICS input 后通过；不是应用导入失败。

## 自动化检查

- K-brain：`go test -p 1 ./...`、`go test -race ./internal/planning ./internal/backend`、相关包 `go vet` 通过。
- GUI 前端：**2963 通过、1 跳过、0 失败**。
- Gateway 前端：**769 通过、0 失败**。
- GUI、共享 UI、Gateway TypeScript 通过；4 个修改的 TypeScript 源码文件 Biome 通过。
- GUI/Gateway 生产前端构建通过；GUI 仍有现有大 bundle 警告。源码 sidecar 锁定、准备与打包契约测试 **13/13**，未生成或发布新的安装包。
- 最终后端二进制再次替换专用测试 sidecar 后，重连测试、既有日程回归和订阅 fixture 验收全部重跑通过。
- 新增覆盖：重复日期集合、PERIOD、夏令时日/小时时长、全天排他结束日、取消覆盖、历史时区最终转换、跨窗口长活动、非法值类型、失败刷新回滚、未支持 RANGE 的显式错误、手动导入 EXDATE 等价时间、时区保存失败重试。

## 尚未完成或不能据此认定完成

- **可见 macOS 通知**：本次测试桌面设置了 `LIVEAGENT_DISABLE_NOTIFICATIONS=1`。现有代码在该模式仍将提醒完成记作成功；提醒状态不能作为系统通知已展示的证据。本轮未改此测试开关语义，未验收横幅、通知权限、专注模式、休眠唤醒后的实际展示。
- **真实外部订阅服务**：未测试私有 Google/iCloud/Exchange 日历、认证过期、网络代理和真实订阅账户。
- **全局时区偏好的完整双向同步**：本轮验证浏览器保存→共享日程后端；多个客户端的设置选择器不会因此自动统一，自动时区模式和重启后偏好归属仍需独立验收。
- **完整 RFC 5545/5546**：`RANGE=THISANDFUTURE` 显式拒绝；METHOD:CANCEL 不是普通可替换订阅快照；零/负时长拒绝。事件规则最多迭代 100000 次，时区规则最多 10000 次；极老/高密度规则可返回错误。订阅仅展开过去 30 天至未来一年。
- 原生 WKWebView 拖拽、Finder 文件选择、签名安装包升级迁移、独立终端日程工具、全部 main 功能重验不属于本次通过结论。

## 证据与复现

本机脚本目录 `/private/tmp/desk`：

- `planning-followup-native.mjs`：真实桌面订阅 HTTP fixture、错误与恢复、两档窗口。
- `planning-followup-native-import.mjs`：WKWebView 文件 input 导入。
- `planning-followup-browser.mjs`：直连网页设置、导入、去重、拖动、两档视口。
- `planning-followup-gateway.mjs`：Gateway 当前源码的导入、去重、拖动、两档视口。
- `planning-followup-cross-client.mjs`：直连网页/Gateway/原生三端数据一致性。
- `reconnect-verify.mjs`、`planning_verify.mjs`：sidecar 重启与既有日程回归。

日志在 `/tmp/planning-followup-*.log`、`/tmp/la-planning-{full,types,webtests}.log`；截图在 `/tmp/desk/planning-followup-*.png`。报告、日志、脚本与截图同步到桌面审计目录的 `planning-followup-macos` 子目录。脚本是本机验收工具，使用固定测试端口和测试数据，不应直接指向正式数据目录。
