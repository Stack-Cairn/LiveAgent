# Gateway 直连与版本兼容验证

本记录只覆盖独立 Gateway 直连 K-brain；桌面转发链路及其 5/30 分钟资源结果由 `automation.md` 记录。测试使用任务专用临时数据、随机测试 token 和本地 fixture，没有读取或改写用户会话。

## 构建与执行对象

| 对象 | 来源与身份 |
|---|---|
| LiveAgent 基线 | `upstream/v2-kbrian`，`b2049905a89462e766b4aa7d6aa76b3a4cbef144` |
| K-brain 最终开发后端 | 基线 `0dad9fdec4adbb2a6324974edc1d610c69b2a79b` 加任务修改；`kn.exe` SHA-256 `16A864EB2ADF697AC114763BB38DFF62E5E1309818B85CF0F2A518D76640E174`；源码差异 manifest `27143745D5D2BC7F60BFF8E60901B5FB6D4D4A198BC293223768BAF0B13F3CED` |
| K-brain 旧后端 | 未修改的同一 `0dad9fd` 基线构建；SHA-256 `295B6C5B4D0FFCCA0E89FD1874ED4E9B450461BDD9DE6F1F2532FADD4799C922`，没有 `session_changes` 能力 |
| 独立 Gateway 修复构建 | 当前任务工作区 Go 源码，`go build -o <临时目录>/liveagent-gateway.exe ./cmd/gateway`；SHA-256 `FC398D88AD07A9B6D0AC93EF9C0ED8A84ED168115B96D19CB66E239EAF3213F0`。此产物仅用于开发验证，未覆盖正在采样的桌面 sidecar，未写入正式发布锁 |
| 修复前 Gateway | 任务中此前的开发构建；SHA-256 `6BC739F8CDA1999FF702D431F6B5AF35F1561F73E7FDB82BC24B85E4C30FA9DB` |

Gateway 启动参数为独立的 `-http-addr`、`-agent-db`、`-kbrain-url`、`-kbrain-agent-id relay-test` 和 fixture 默认模型。token 只通过子进程环境传递，不写入提交文档或控制台。后端监听 `47441`，记录请求的透明 HTTP 代理监听 `47442`，Gateway 监听 `47443`，真实 Edge CDP 监听 `9441`；均未与桌面验证的 `1420/50052/9222/9331` 共用。

## 先失败及修复

真实进程和 WebSocket 首败保存在 `%TEMP%/liveagent-session-sync-relay-regression-red-20261028-083412`。使用相同最终前一版 K-brain 开发后端，修复前 Gateway 的八项场景为六通过、两失败：

1. `history.set_cwd` 返回 `agent offline`。浏览器请求没有分派给 Relay，而是落入桌面 Agent 路径；独立直连没有桌面连接。
2. `history.delete` 返回成功，两个已同步 WebSocket 客户端仍保留会话。Relay 在 HTTP 删除返回时立即删除别名，之后有序 changes 的 delete 找不到原别名，因而不广播。新浏览器从 Gateway 权威集合恢复也能看到该残留，直到后端重启触发完整快照才消失。

修复在 `internal/kbrain/history.go` 和 `internal/protocol/pbws/browser_relay.go` 接入移动工作目录。活动同步流保留待删除别名，直到有序 delete 交给 Gateway 后再回收；流失败或代际结束清理待删除别名并依赖完整恢复。没有活动新协议的旧模式继续立即回收。待删除集合上限为 10,000；超限先使权威集合不可用并要求新快照，再释放记录，不能静默丢变化或无限增长。

新增 `internal/kbrain/history_delete_sync_test.go` 通过真实 HTTP 和受控 changes 响应验证：原别名保留到 delete 交接、交接后释放、10,000 条预算触发失效、旧模式无订阅时立即回收，以及 cwd 正确转发。该文件没有改变 K-brain 对目录的校验规则：空值、相对路径和不存在目录仍由后端明确拒绝。

## 最终真实场景

最终 K-brain `final4` 与独立修复 Gateway 的结果保存在 `%TEMP%/liveagent-session-sync-relay-final4-ui-20261028-090053`：`manifest.json`、`results.json`、脱敏进程日志、两页 DOM 文本和截图均留在本机临时目录。14/14 场景通过。

| 场景与实际触发方式 | 断言及结果 |
|---|---|
| 两个真实 WebSocket 连接鉴权并请求不可变权威快照 | 初始一条 fixture 会话在两个连接中一致；只有一个上游 changes 请求同时在途 |
| WebSocket `history.rename` | 两个连接的有序投影均变为新标题，565 ms 内收敛 |
| WebSocket `history.pin`，true 后 false | 两端布尔值分别正确，565/562 ms；不依赖额外列表轮询 |
| WebSocket `history.get` | 返回实际保存的 `relay fixture message`，不是摘要假数据 |
| WebSocket `history.set_cwd` 到另一真实存在目录 | 两端 cwd 一致，528 ms；Windows 分隔符在断言边界归一化 |
| 移动到空 cwd | 后端明确拒绝；Gateway 权威快照仍只有原工作目录及正确数量，没有假报成功 |
| 透明代理注入后端 401 | 生产者状态失效，列表请求明确失败；解除注入后以新 generation 完整恢复，1,558 ms，最新标题保留 |
| WebSocket `history.delete` | 两个在线连接移除会话；第三个新连接恢复的权威集合为空，564 ms，无删除残留 |
| 终止并重启同测试数据根的 K-brain 进程 | 新 epoch/generation 被识别，两端重新获取空权威集合，1,057 ms |
| 两个真实 Edge WebUI 页面 | 登录后通过头像菜单实际选择 `K-brain` 目标；打开侧栏，均显示由真实后端创建并置顶的会话 |
| WebUI 会话菜单“修改标题” | 打开实际重命名对话框，填写并点击保存；后端持久化且另一页面显示同标题，289 ms，两个页面 `role=alert` 均为零 |
| WebUI 菜单“取消置顶”后“置顶对话” | 等上一动作解除 busy 后点击；后端布尔值分别为 false/true，取消置顶后在展开工作区内仍可找到同一 ID，再置顶，1,075 ms |
| WebUI 菜单“删除对话”及实际确认按钮 | 点击确认后两页都移除标题，无错误 alert，1,126 ms |

页面被 Chromium 冻结时先用 `Page.bringToFront` 恢复，再断言最终一致。测试没有把冻结页当作持续在线，也没有用截图代替 DOM、后端状态及另一真实客户端的断言。HTTP 创建用于准备会话；菜单操作单独通过实际产品控件触发。

前期浏览器测试失败均保留，不冒充产品首败：两个 URL 作为 headless Edge 命令行参数会使浏览器退出；改为单 URL 启动，再用 CDP 创建第二页。自动化还曾在登录前点击侧栏、误把重命名对话框当作行内输入、在上一个动作仍 busy 时点击下一动作，以及将已展开工作区再次折叠；最终脚本按实际控件与状态等待执行。

## 兼容与鉴权边界

| 组合或条件 | 实际验证与证据 |
|---|---|
| 新 Gateway + 旧 K-brain | `%TEMP%/liveagent-session-sync-relay-legacy-final-20261028-085300`，3/3。两个真实 WebSocket 的列表、改名、置顶/取消置顶、移动、删除通过；没有请求 snapshots 或 changes，恢复请求被拒绝，没有宣告 v2 健康 |
| 新 Gateway + capability=1 | `%TEMP%/liveagent-session-sync-relay-capability1-final4-20261028-085312`，3/3。透明代理只覆盖 health 中能力值，实际后端仍为 final4；同样保留旧列表路径，snapshots/changes 请求数为零 |
| 新 Gateway + 完整 v2 | 最终 14/14 场景；两个 raw WebSocket 加两个真实 WebUI 仍共用一个上游 changes 长轮询，代理计数 `maxActiveChanges=1` |
| K-brain token 失效再恢复 | 真实 HTTP 代理 401 注入、状态失效和新 generation 恢复通过；未通过旧模式绕过鉴权 |
| 非法工作目录 | 真后端 400 拒绝，原权威状态保持；本轮不放宽后端目录校验 |

本记录不声称已单独验证“旧 LiveAgent 完整桌面 UI + 新 K-brain”或“新 LiveAgent 完整桌面 UI + 旧 K-brain”的全部产品交互。旧组合的模块/后端验证与桌面自动化结果应由总矩阵合并；直连 WebSocket兼容不能代替完整桌面版本组合。无 token/错误 Gateway token、受限共享链接与跨窗口权限的自动化另见主验证矩阵，本记录的后端 401 场景只覆盖 Relay 上游鉴权。

## 可复跑命令与检查

```powershell
node scripts/testing/session-sync-relay.mjs `
  --output <新的任务临时目录> `
  --binary <可追溯的 kn.exe 绝对路径> `
  --gateway <当前任务 Gateway.exe 绝对路径> `
  --browser true

# 旧 K-brain 使用其真实未修改基线二进制；capability=1 场景使用 final4。
node scripts/testing/session-sync-relay.mjs `
  --output <新的任务临时目录> `
  --binary <kn.exe 绝对路径> `
  --gateway <Gateway.exe 绝对路径> `
  --legacy true --browser false

node scripts/testing/session-sync-relay.mjs `
  --output <新的任务临时目录> `
  --binary <final4 kn.exe 绝对路径> `
  --gateway <Gateway.exe 绝对路径> `
  --legacy true --capability 1 --browser false
```

`go test ./internal/kbrain ./internal/protocol/pbws ./test/websocket`、`go test ./...` 均通过。新增 delete/cwd/budget 三个回归单独 `-count=10` 通过。格式由 `gofmt` 生成。正式性能采样开始前已结束本记录的独立子进程，不在 5/30 分钟采样期间运行 Go 构建或全量测试。
