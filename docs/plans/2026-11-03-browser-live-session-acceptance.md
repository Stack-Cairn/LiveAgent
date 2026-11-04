# 浏览器修复桌面验收操作

本文件用于本任务补丁构建的人工验收。自动化故障注入与真实用户 profile 验收分别记录。仅当客户端确实运行本任务构建且配置来源已核实时使用以下提示词。

## 准备与当前限制

- 从 `browser-live-session/liveagent` 的本地 `start-tauri-dev.bat` 启动。Vite 和 Tauri 的地址均为 `http://localhost:1442`，不得使用其他任务的 1420 或 1432 服务。
- 验收窗口标题为 `LiveAgent — Browser Acceptance`。确认实际 EXE 位于本 worktree 的 `target/debug/liveagent.exe`；K-brain 后端位于本 worktree 的 `.liveagent/kbrain-browser/k-brain.exe`。
- 调试启动配置按用户要求使用现有真实数据与 `RightCode` / `gpt-6.1-sol`。最终构建已通过桌面 UI 发起真实供应商调用，核对原始工具结果完成显式受管模式、显式重置与超时后续调用验收；具体 target 和结果见配套记录。任务专属空数据根只作自动化与启动检查。真实目录的文件检查仍受工作区权限限制，不能据此认定此前广泛测试没有改动用户配置。
- 既有浏览器 profile 的 Cua 检查返回 `browser_consent_required`，运行时明确要求启动时 `existing-profile` grant 或授权宿主。没有这项授权时，不以其他工具绕过；由用户决定如何提供受支持的授权或亲自完成相关操作。
- 浏览器测试页只允许无破坏操作；不付款、不发帖、不提交实际外部业务表单。不读取 cookie、token 或密码。登录态仅由用户观察是否仍显示已登录。

## 可直接复制的提示词

### 1. 初次连接、延迟授权、连续调用与登录态

先由用户在日常浏览器打开一个专用测试标签页并保持选中，另留一个已登录站点供用户自行观察，再提交：

```text
使用 browser_exec 的 live:default 会话接管我日常使用的浏览器。只新建或使用专用无破坏测试页；先列出标签页标题和 URL，告诉我你选中的 target，不读取 cookie 或 token。等待我处理浏览器远程调试授权。连接成功后进入 https://example.com/，打印页面标题。下一次调用继续使用同一个 session，确认文档标记仍在，不启动独立 profile。
```

操作：授权弹窗出现后等待数秒再允许。第一次完成后再要求同一 session 设置并读取 `window.__browserAcceptanceMarker`。用户观察原浏览器登录态仍在。预期：等待授权期间不启动独立 Chromium；两次调用使用同 target 和原 profile。

### 2. 授权拒绝、超时与取消

分别在新的明确命名会话执行同一提示词：

```text
使用 browser_exec，session 为 live:approval-check，timeout 为 15 秒，连接我日常浏览器并打印 info()。如连接失败，返回实际错误；不要改用 dedicated 或 headless，也不要自动再次执行脚本。
```

操作：一轮拒绝授权；一轮不处理直到超时；一轮在等待中点击 LiveAgent 停止。需要浏览器确实再次弹出授权才构成该场景，已有授权缓存时不算。预期：拒绝、超时或取消原因清楚，未启动其他 profile，未执行页面脚本。停止后再新发一条 live 调用，允许授权后可正常执行。

### 3. 原 target 关闭

```text
在 live:target-close-check 会话打开 https://example.com/，打印 targetID 并设置 window.__browserAcceptanceMarker='target-close-check'，然后停止，等待我操作。
```

操作：用户关闭该专用页，保留另一个无关标签页。随后提交：

```text
仅复用 live:target-close-check 会话读取原页标记。原 target 不存在时返回关闭错误，不选择其他标签页，不新建替代页，也不恢复上一次脚本。
```

预期：明确报告原 target 关闭；无关标签页不变。选择新 session 才能继续新任务。

### 4. 命名隔离与默认会话反向绑定

在尚未初始化 default 的新后端中提交：

```text
先用 live:research-a 在 https://example.com/ 设置 window.__browserAcceptanceMarker='A'，再用 live:research-b 设置标记 'B'。最后首次使用 live:default。分别列出三者 targetID，确认目标不同。分别读取 A/B 标记，不能互相覆盖。不要对三个会话之外的页执行修改。
```

预期：两个命名会话和新 default 不共享 target。若明确要求 default useTab 到 A 的 target，应返回目标已占用，A 的标记不变。关闭 A 后 B 仍可继续。

### 5. 连接中断与浏览器重启

```text
在 live:restart-check 专用测试页设置 window.__browserAcceptanceMarker='before-restart'，记录 endpoint 与 targetID，只输出不含凭据的地址和标记，等待我操作。
```

操作：用户自行重启日常浏览器，再请求同 session 读取原标记。预期：只尝试原 endpoint/target；恢复失败或原目标不存在时明确报错，不改选其他页，不启动 dedicated，不重新执行上一段脚本。浏览器重启改变 endpoint/target 时允许明确失败，不能假报恢复成功。

### 6. 显式 dedicated 与 headless

```text
分别使用 dedicated:explicit-mode-check 和 headless:explicit-mode-check，进入 https://example.com/，设置各自不同的 window.__browserAcceptanceMarker，然后再用相同 session 发起第二次读取。报告实际模式与 targetID。两种显式模式不能修改我的日常浏览器页。
```

预期：显式模式仍工作；同一 session 连续调用保留各自文档标记，互不影响。

2026-11-04 首次代验收复现：同名 `dedicated:accept-explicit-1104` 与 `headless:accept-explicit-1104` 返回同一 target，后者覆盖前者标记。基线 `b143a82738a80112acd47bd001e6b5d311a13125` 已有 profile 仅按名称区分的根因。本轮已将受管 profile 按模式与名称隔离：dedicated 保留原目录，headless 使用独立目录；`TestManagedModeIsolation` 的两个驱动 × default/shared 四组均通过，并实际断言 headless 浏览器 UA。最终桌面构建已使用同名 `final-check` 复验：两个 target 不同、标记独立、连续调用身份保持；进程参数确认 headless 带 `--headless` 且 profile 目录独立。使用 `tabs()` 获取 TargetID，`info()` 没有该字段；页面 UA 不作为判断实际运行模式的唯一依据。

### 7. extension 固定页、失败与重新 pin

仅在原扩展实际可用且用户已 pin 专用页时提交：

```text
使用 extension:extension-check 读取已 pin 的专用页标题和 targetID，连续调用两次。不要启动独立浏览器，不要关闭用户浏览器。随后等待我取消 pin 或改 pin。
```

操作：用户改 pin 到另一个专用页，再请求原 session 读取原页标记。预期：保留原 target 身份，原页不可用时清楚报错，不能静默切换到新页。另一个 extension 会话名应清楚报告单一固定页约束。

确认原调用已明确失败后，由用户显式选择新 pin 页并提交：

```text
我已把扩展改 pin 到新的专用测试页。使用原来的 extension:extension-check 会话，显式设置 reset:true，只执行 info() 和 tabs()，打印新的 targetID；不要重复之前的脚本。随后再单独调用同一 session，reset:false，确认仍是新的 pin 页。
```

预期：旧连接释放后才接入当前 pin 页，新脚本仅一次；后续普通调用复用新绑定。原浏览器与旧标签页保持打开。排队等待旧脚本结束时取消或超时，应保留旧绑定，不能在后台迟到执行重置。

`reset:true` 明确要求先重置再执行本次代码。非空但存在语法错误的 helper 代码可能在重置完成后才报错；报错不代表旧绑定仍在，也不会自动恢复或重放旧脚本。修正代码后以普通调用检查当前绑定，不要为了语法错误反复重置。该组合没有专项自动化测试，完整覆盖仍有此边界。

## 8. 执行中超时、部分输出与后续调用

先使用单独命名的 headless 会话建立无破坏验收页：

```text
只使用 headless:timeout-check，导航 https://example.com/，设置 window.__laCancel='cancel-ready'，然后 tabs()，记录 targetID。完成后停止。
```

该页建立后提交：

```text
仅执行两次 browser_exec，session 均为 headless:timeout-check。第一次 timeout=3，依次执行 js('Date.now()') 和 js('new Promise(() => {})')。返回后单独执行第二次调用，timeout=10，依次执行 js('({time:Date.now(),marker:window.__laCancel,title:document.title})') 和 tabs()。禁止导航、新建页、切换会话或重试失败脚本。报告两次原始工具结果。
```

预期：第一次明确返回 `context deadline exceeded` 和脚本未重放提示，并保留前一条 `js` 的时间戳输出；第二次读取成功，marker 为 `cancel-ready`，targetID 与建立时相同。`waitFor` 返回 `false` 不能单独证明调用超时。

2026-11-04 已在现有 `headless:accept-cancel-1104` 上按以上阻塞方式完成代验收，原始工具详情已核对。它证明显式 headless 的调用超时与后续使用，不代替日常 live profile 的授权及恢复验收。

## 9. 主动停止、副作用次数与后续调用

先准备独立会话，再提交长等待：

```text
只使用 headless:manual-cancel-check，reset:true，进入 https://example.com/，设置 window.__laCancelMarker='manual-cancel-check' 和 window.__laCancelEffect=0，打印 tabs() 并停止。不要访问其他会话。
```

```text
只执行一次 browser_exec，session 为 headless:manual-cancel-check，timeout=180。先执行 js('window.__laCancelEffect += 1; ({marker:window.__laCancelMarker,effect:window.__laCancelEffect})')，再执行 js('new Promise(() => {})')。不要自动重试、导航或重置。
```

操作：确认前置调用已经开始后点击客户端停止，再发送独立读取：

```text
继续使用 headless:manual-cancel-check，reset:false，只读取 js('({marker:window.__laCancelMarker,effect:window.__laCancelEffect})') 和 tabs()。不要重放上一条脚本。
```

预期：停止返回 `context canceled`，保留停止前的输出；后续同 target 可继续，marker 为 `manual-cancel-check`，effect 为 1。停止早于脚本开始时 effect 可能为 0，该轮只证明排队或启动取消，不能作为执行中取消通过。

2026-11-04，最终桌面构建已完成执行中取消：180 秒 timeout 的调用在 19.74 秒返回 `context canceled`，保留 `cancel-final-2`；后续 target 保持 `FD62F6BB8AFD0F622230A0DCE2CDAE0B`，读数为 `marker=reset-v2,count=1,effect=1,cancelEffect=1`。

## 10. 真实 WebUI 集成

该项必须由当前源码 WebUI 发起，桌面 1442 页和自动化供应商替身不能代替。桌面与 WebUI 选择同一验收客户端的 agent，使用实际 `RightCode` / `gpt-6.1-sol`。令牌只通过客户端复制按钮输入登录页，不向模型提供，不写入截图、文档或日志。

1. 在验收客户端“设置 → Remote → Gateway 连接”确认当前连接。原端口 50052 被其他进程占用时，可临时使用 47443，等桌面显示“已连接 (v2)”；不停止占用进程。记录原端口，结束后恢复。
2. 从任务 LiveAgent worktree 启动当前 WebUI：

   ```powershell
   $env:npm_config_proxy_api = 'http://127.0.0.1:47443'
   pnpm --dir crates/agent-gateway/web dev --host 127.0.0.1 --port 47444 --strictPort
   ```

3. 在受支持且已获授权的浏览器打开 `http://127.0.0.1:47444`，使用客户端复制的令牌登录。核对连接到的确是本任务验收客户端，选择真实供应商并新建会话。
4. 从 WebUI 重复场景 6 的同名模式隔离、场景 8 的超时及场景 9 的主动取消，展开每次原始工具结果，确认 session、target、计数与部分输出。另在独立会话执行 `reset:true`，确认新 target 后普通调用仍复用它，新脚本执行一次。
5. 在桌面找到相应会话，确认用户消息、工具调用、错误或取消状态一致。刷新 WebUI 再检查相同状态；成功响应、错误、取消和重连后的消息不能重复或丢失。测试结束后恢复原 Gateway 端口并停止本次 WebUI 服务。

本轮现场：临时 Gateway 47443 已连接，WebUI 47444 的 Vite 已 ready。浏览器导航因 Cua `protected_resource_scope_invalid`（要求 explicit session，但会话由宿主管理）拒绝，未完成登录或上述交互；不得以服务 ready 记录为通过。已恢复端口 50052，重开设置确认保存；47443 与 47444 已停止监听。日常 Edge profile 授权与真实扩展 repin 仍须分别完成，独立浏览器不代替这两项。

## 自动化专用场景

下列场景通过实际 CDP 协议或受控协议 fixture 注入，无法伪装成人工直接触发：

| 场景 | 触发方式 | 预期 |
|---|---|---|
| 显式重置 | `TestSessionDoFresh*` 与 `TestBrowserExecReset*`，固定原目标后模拟 repin；分别省略 reset、设置 false/true，并在原脚本占锁时让重置超时或取消 | 普通调用不换页；显式重置在同一锁内关闭、重新接入并执行一次；等待取消和 Close 失败均保留旧绑定 |
| 真实扩展重连 | `TestExtensionRealChrome`，测试自有 Chromium 加载临时扩展，通过 `DoFresh` 释放并重新连接 relay | 用户浏览器未关闭，原 pin 页及测试专属 cookie 页面内容保留，重新打开与新脚本各一次 |
| 同名跨模式 profile | `TestManagedModeIsolation`，两个驱动各使用 default/shared 名称，交替设置和读取标记，并读取浏览器版本 UA | dedicated/headless 页面互不覆盖，headless 实际运行无头浏览器 |
| 端点地址别名 | `TestPreflightReviewLiveRegistryEndpointAliases`，四种驱动组合以相同地址、localhost 别名和 query 连接同一 Chrome browser UUID | 同一原 target 只能被一个 session 占用 |
| 调用前 chromedp detach | `TestPreflightReviewChromedpDetachBeforeCall` | 及时重新 attach 原 target，原文档变量保留 |
| 执行中 detach 或关页 | `TestPreflightReviewInFlightTargetLoss`，两个驱动在本地计数页 POST 后 detach 当前 session 或关闭原 target | 在调用 deadline 之前返回明确 session/target 错误，部分输出保留，回调和副作用均仅一次 |
| 真实页面 session 失效 | `TestRealSessionReattachesOriginalTargetAfterDetach` 对测试自有 Chrome 执行 detach | 下次调用在执行前 attach 原 target，新 sessionID，原文档保留 |
| 已有副作用再失效 | `TestRealSessionInterruptedActionsAreNotReplayed` 先向本地计数页 POST，再 detach 或关闭测试 CDP 连接 | 计数为 1，返回部分输出与中断提示，无脚本重放 |
| 初始化 attach 失败 | `TestSessionKeepsBoundTargetAfterStartupAttachFailure` 与 `TestExtensionKeepsTargetAfterInitialAttachFailure` | 保留 backend/target，不重新建命名页，不因 repin 改目标 |
| 两驱动恢复 | `TestRod*`、`TestChromedpRecovery*` | 同 endpoint/target，有限恢复、可取消，关闭 target 不换页 |
| 目标占用与并发 | `TestLiveTarget*` | named→default 和跨驱动均隔离，32 个并发 claim 仅一个成功 |
| 切页失败保留当前页 | `TestChromedpRecoveryFailedSwitchRetainsCurrentTarget`、`TestRodFailedSwitchThroughSessionRetainsCurrentTarget`，在 `Session.Do` 内让候选页在 attach 时关闭或不存在 | 后续调用仍能操作原页，原页归属保留，候选页归属释放 |
| 销毁目标中断预检 | `TestRodDestroyedTargetInterruptsHealthCheck`、`TestRodClosedDuringAttachNormalizesError`，保持健康检查未响应再发送销毁事件 | 不新增短超时，返回 `ErrTargetClosed`，不执行脚本 |
| 自有浏览器关闭后重启 | `TestRealSessionBrowserRestartKeepsOriginalIdentity` 关闭测试自有 headless Chrome，再用临时新 profile 启动另一实例 | 旧 session 不跟随新 endpoint/target，两次调用的脚本与副作用计数均为 0；日常浏览器同 profile 重启仍须人工验收 |
| 双驱动基础行为 | `TestDriverParity` 在指定的自有 headless Chrome 上验证十项操作 | Rod/chromedp 的导航、求值、信息、无障碍树、点击、截图、填写、滚动、等待元素、标签页均通过；任一失败即测试失败 |

执行 Go 命令统一从 LiveAgent worktree 经 mise 指定 K-brain 所需的受管理工具链：

```powershell
$env:GOTOOLCHAIN = 'local'
$env:LIVEAGENT_HOME = Join-Path $PWD '.liveagent\browser-tests'
$env:K_BRAIN_HOME = $env:LIVEAGENT_HOME
$env:ROD_BROWSER_BIN = 'C:\Users\AlphaCat\AppData\Roaming\rod\browser\chromium-1321438\chrome.exe'
mise exec go@1.27.0 -- go -C ../kbrain test ./internal/browser -run '^Test(RealSession|DriverParity$|E2EHeadless$|E2ELiveAttach$)' -count=2 -v -timeout=180s
```

实际结果与未运行项记录在同目录 `2026-11-03-browser-live-session.md`。用户已授权确认验收条件后直接提交、推送和创建 PR；原生授权及尚未通过的验收仍需完成或明确记录阻塞。
