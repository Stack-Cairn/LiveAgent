# 2026-10-07 工具调用、Windows shell 与浏览器初始化复核

## 已落地

LA source lock 更新到 KB `ffb1309415dd4006eca74276e55dfd25cb4c9cfd`（main，包含 `b04eaea` 的工具与浏览器修复）。LA 分支为 `v2-kbrian`，不改变前端工具所有权，不另起模型调用层。

参考 zcode CLI 的 shell provider、execution-command 和工具结果处理：复用单一执行适配器，而非同步/异步分别拼 shell 命令。按用户要求：

- macOS/Linux 默认优先 Bash，而非登录 shell（例如 zsh）。
- Windows 默认 `pwsh → Git Bash → Windows PowerShell → cmd`；支持标准目录、用户 Git 安装目录及 git.exe 推断。
- 显式 shell / K_BRAIN_SHELL 覆盖仍优先；仅可执行文件不可用时回退，执行失败不会换 shell 重跑。
- `Bash`、`ManagedProcess` 接受可选 shell 参数；同步、yield、托管进程使用相同的编码、引号和退出码处理。
- PowerShell `& '带空格的程序路径'` 与 CMD `&` 不再被当成 POSIX 后台执行。保留真实后台操作约束、权限、沙箱及运行归属检查。

## browser subsystem not initialized

根因：只有 TUI 初始化 browser manager，LA 的 backend 入口却已经注册 browser_exec。

KB 的 backend、run、ACP 现在在注册工具前初始化 runtime，并按配置处理浏览器模式、CDP、禁用状态与 computer policy。退出时释放；工具调用时再真正启动浏览器，不在应用启动时强制打开窗口。

额外修复：

- 实机 fill 超时和非 ASCII 字符问题：Rod / chromedp 共用 input、textarea、contenteditable 填写逻辑和事件；readonly/disabled 返回明确错误。
- 模型发送 `await goto(...)`、`print(await js(...))` 时兼容执行。
- chromedp 首次调用结束后取消上下文原先会销毁浏览器，现已将浏览器生命周期和每次调用取消分离；同会话排队调用也支持取消。

## 已执行测试

- KB 全量 `go test -p 2 ./...` 通过；相关 tools/browser/backend/cmd/kn race 测试通过。
- Windows amd64 后端及 tools 测试程序交叉编译通过。
- LA 前端 2979 项：2978 通过、1 跳过、0 失败；typecheck 通过。
- 真实 Chrome，分别使用 Rod 和 chromedp：页面导航、input/textarea/contenteditable、中文/emoji、焦点、readonly 拒绝及第二次调用保留状态通过。
- 既有测试覆盖基础14工具的 schema，文件工具 HTTP 循环、技能注册、图片、托管进程、终端、权限拒绝、运行归属、MCP 与客户端委托工具。
- 新增跨平台 CI；首轮 Windows 发现 ConPTY 输出错误继承父控制台，`ffb1309` 补充 STARTF_USESTDHANDLES。另修正长短路径比较和把流式输出误当成进程已退出的测试断言。重跑：[Tool runtime compatibility](https://github.com/Stack-Cairn/K-brain/actions/runs/37620303591)。交叉编译本身不算 Windows 实机验收。
- 最终 CI **Windows、macOS、Ubuntu 三个 job 全部通过**。Windows 原生运行确认 PowerShell 7、Windows PowerShell、CMD、Git Bash、带空格中文脚本路径、同步/异步退出码、ConPTY 输入输出/resize/cancel 均通过；WSL 因未配置发行版跳过。

## LA macOS 真实模型验收

隔离配置 `/private/tmp/kb-cache-acceptance/`，开发桌面端搭配新 KB，模型为配置中的 `gpt-6-luna`。测试站点只绑定 `127.0.0.1:18765`；没有操作正式用户浏览器标签页。

第一轮验证实际暴露并调用 browser_exec、Bash，得到页面标题 `LA_BROWSER_OK_中文` 和 Bash 版本 `3.2.57(1)-release`。该轮发现模型使用 await 导致解析报错，因此随后修复并重测；旧错误保留在历史中，不抹除。

最终第二轮：

1. `browser_exec` 执行含 await 的导航和填写，点击后读到 `AWAIT_OK_中文`。
2. 第二次独立 `browser_exec` 再读标题，仍为 `AWAIT_OK_中文`。
3. `Bash` 显式 `shell=bash`、`yield_time_ms=1`，启动 `sleep 1; printf ASYNC_OK`。
4. `ProcessWait` 收到 completed、exit_code=0、`ASYNC_OK`。

最终轮四次工具调用均没有 error。通过后端历史断言核对；桌面聊天重开、轨迹页显示实际参数、结果、过程及完成状态。

## 范围与待验收

- 不是所有第三方 MCP、浏览器扩展连接、电脑控制权限或所有 Windows 安装方式的逐项实机全覆盖，不能声称“所有工具在所有环境均已验证”。
- Windows CI 覆盖可执行文件顺序、PowerShell/CMD/Git Bash、中文输出、退出码、同步/异步、进程取消及 ConPTY；WSL 需要额外安装发行版，未自动启用。
- 浏览器仍需可用 Chrome/Chromium、CDP 或扩展；computer_exec 仍需原生 helper 和系统授权。
- 本次仅推源码和 LA 后端锁定版本，未创建 release；已安装 beta 需升级到包含该 revision 的构建才生效。

证据：`/private/tmp/kb-tool-acceptance/session.json`、`/private/tmp/all-features/desktop/tool-browser-await-async.png`、`tool-final-reopened.png`、`tool-final-trajectory.png` 及测试日志，复制到桌面审计目录 `tool-runtime-windows-browser/`。
