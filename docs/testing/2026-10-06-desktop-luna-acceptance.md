# 2026-10-06 桌面端 gpt-6-luna 实测

## 环境和结论

- 实際打开并操作 macOS `LiveAgent Acceptance.app` 的 WKWebView，不用 HTTP 命令派发代替桌面功能验收。
- 测试程序：`/Users/a/Applications/LiveAgent Acceptance.app`；测试后端配置：`/tmp/la-desktop/home/config.json`。没有覆盖 `/Applications/LiveAgent.app` 或用户正式配置。
- LA 分支 `v2-kbrian`；KB 基线 `b1e0747`。本次修改仅在 LA，未更新发布附件、标签或触发发布工作流。
- 按用户要求，在桌面模型选择器中切换到 `gpt-6-luna`；后端 `/v1/settings` 读回确认 `defaultModel` 为 `gpt-6-luna`，新对话也显示该模型。
- 结论：下列核心流程已通过，但不能据此宣称全部功能可用。自动测试、设置页打开、原生命令测试和完整桌面业务验收分别记录。

## 桌面业务实测

| 功能 | 实际操作与结果 |
| --- | --- |
| 真实模型聊天 | `gpt-6-luna` 返回 `LUNA_DESKTOP_OK`，不是模拟供应商 |
| 重试回复 | 修复前实际鼠标点击确认复现 history revision conflict；修复后生成新分支并收到 `LUNA_DESKTOP_OK` |
| 编辑重发 | 编辑已有用户消息并发送，收到 `EDITED_LUNA_OK`；原会话保留 |
| 创建分支 | 点击回复的创建分支、确认，新增侧栏会话并显示历史回复 |
| 停止生成 | 发送长输出请求后点击停止，运行结束、按钮恢复；界面显示 `Fetch is aborted`，提示仍需改善 |
| 历史重开 | 离开会话进入日程，再打开历史，回复和停止记录保留 |
| 已删除模型的旧历史 | 打开既有 `deleted-model history repro`，显示原用户消息和助手回复，没有 unknown model 错误；本次未重复执行模型删除 |
| 日程活动 | 使用全天活动表单创建 `Desktop Luna acceptance event`，保存后在日历显示；点击预览和移入回收站后从日历消失 |
| 日程任务 | 添加 `Desktop Luna acceptance task`，点击完成后从未完成列表移至已完成列表（11→12） |
| 桌面终端 | 切换 Agent 模式、新建并展开终端，通过终端输入控件执行 `pwd`，截图显示工作目录和新提示符；随后关闭测试终端并恢复 Chat 模式 |
| 设置导航 | 点击17个设置入口，未观察到 Load failed/Failed to fetch；只算导航检查，不算保存、连接、执行等功能通过 |

终端测试中 AppleScript 键入受输入法影响，首次 marker 输入无效；随后通过终端粘贴事件和 Enter 执行 `pwd`，以实际目录输出为成功证据，未将键入动作或无输出 marker 判为通过。

## 修复

根因：K-brain 模式下重试/编辑会先创建分支。原来只有历史替换和普通分支处理版本冲突，`prepareEditResend` 直接调用分支接口，因此后台历史 revision 更新后，重试仍报 `K-brain history revision conflict; reload the conversation`。

现在重试准备和普通分支共用 `branchConversationWithReload`：

1. 首次冲突时重新请求权威历史窗口。
2. 用稳定消息 ID 找回锚点，比较内容 hash；消息已被修改或移除时终止，要求用户重新选择。
3. 最多重试一次。网络或其他错误不重放，持续冲突仍返回错误。

## 浏览器与自动回归

- 同一前端直接连接当前 KB，在 Chrome 1440×900 实际发送、重试，收到 `BROWSER_LUNA_OK`。
- 390×844 下编辑重发收到 `MOBILE_EDIT_LUNA_OK`，无横向溢出、无捕获到的页面异常。
- 浏览器首次尝试点击回复动作被输入栏遮挡；向下滚动会话后正常完成，没有强制点击或移除遮罩。未单独修改布局。
- 新增冲突恢复测试覆盖一次重载、内容变化、锚点丢失、持续冲突、非冲突错误。
- 相关回归 17/17；GUI 全量 2967 通过、1 跳过、0 失败；Gateway 前端 769/769；GUI/Gateway TypeScript、3个修改源码 Biome、git diff 检查通过。
- 之前已启动的 Rust 全量为1102通过、5忽略；这些自动测试不代表真实外部连接可用。

## 实际失败和待验收项

- 之前默认的 `Claude Fable 5.1` 返回上游429 `model_cooldown`；抽测 `gpt-5.4-mini` 返回上游400 `model_not_found`。切换 Luna 后可聊天，但没有修复外部供应商的不可用模型。
- 停止提示仍为英文技术错误。重试确认框描述“删除之后内容”，而KB路径实际创建分支保留原会话，文案与行为仍需统一。
- 真实 MCP工具、Skills执行、定时任务触发与产物、Hooks、语音、SSH/SFTP、远程连接、备份恢复、真实子代理执行、文件拖放和完整CLI交互，本轮没有逐项桌面端正向验收，不能记为通过。
- iCloud/Exchange真实订阅、OAuth、WebDAV等缺少专用测试条件，仍需独立验收。此前Google公开ICS测试不等于这些账户同步通过。
- 17个设置页只做导航检查；已有命令脚本中的预期拒绝、超时、无连接错误不计入正向功能通过率。
- 当前beta附件没有本次修复，正式安装包升级没有验收。

## 证据

- 脚本和WKWebView截图：`/private/tmp/all-features/desktop/`。
- 聊天：`luna-send.png`、`luna-retry-fixed.png`、`edited-luna.png`、`stopped.png`、`branch-created.png`、`deleted-model-history.png`。
- 日程：`event-created.png`、`task-created.png`、`task-completed.png`；终端：`terminal-pwd.png`。
- 浏览器：`browser-retry-1440.png`、`browser-edit-390.png`。
- 回归日志：`/tmp/desktop-retry-{tests,typecheck,biome}.log`、`/tmp/desktop-fixed-{gui,web,web-types}.log`、`/tmp/desktop-browser-chat.log`。
- 报告和证据同步到桌面审计目录的 `desktop-luna-acceptance/`。
